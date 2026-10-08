// Supabase Edge Function: background-ehr-sync (v3 — Wellet)
// Accepts sb_secret_* service-role key OR legacy JWT. Deployed with verify_jwt=false.
// v3 (2026-05-27): fix verifyOtp type — Supabase tightened magic-link OTP semantics;
// admin-minted hashed_tokens must be redeemed with type: 'email', not 'magiclink'.
// Root cause of fleet-wide silent stale outage 2026-05-27.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CADENCE_FLOOR_MIN = 60;
const CADENCE_CEILING_MIN = 1440;
const NO_CHANGE_THRESHOLD = 7;
const ERROR_BACKOFF_MIN = 60;
const RECONNECT_BACKOFF_MIN = 1440;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function clamp(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, n)); }
function countSignature(rc: Record<string, unknown> | null | undefined): string {
  if (!rc) return '';
  const keys = ['visits','allergies','care_team','conditions','medications','observations','immunizations','diagnostic_reports'];
  return keys.map((k) => `${k}:${(rc[k] as number | undefined) ?? 0}`).join('|');
}
// Auth (2026-10-08 fix): never trust a token's claims without verifying it.
// The previous version accepted any three-part token whose payload said
// role=service_role, with no signature check. Now a token must either equal
// the function's own service key exactly, or be accepted by Supabase Auth's
// admin endpoint, which only succeeds for a genuine service-role key.
// A verified token is cached for this instance so the hourly batch makes one
// verification call, not one per schedule.
const verifiedTokens = new Set<string>();

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (serviceKey && timingSafeEqual(token, serviceKey)) return true;
  if (verifiedTokens.has(token)) return true;
  const supabaseUrl = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/$/, '');
  if (!supabaseUrl) return false;
  try {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    if (res.status === 200) { verifiedTokens.add(token); return true; }
    return false;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonResponse({ ok: false, detail: 'method_not_allowed' }, 405);
  if (!(await isAuthorized(req))) return jsonResponse({ ok: false, detail: 'unauthorized' }, 401);

  const t0 = Date.now();
  let body: { schedule_id?: string; person_id?: string; ehr_connection_id?: string };
  try { body = await req.json(); } catch { return jsonResponse({ ok: false, detail: 'invalid_json' }, 400); }
  const { schedule_id, person_id, ehr_connection_id } = body;
  if (!schedule_id || !person_id || !ehr_connection_id) {
    return jsonResponse({ ok: false, detail: 'missing_required_fields' }, 400);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: sched, error: schedErr } = await admin.from('ehr_sync_schedule')
    .select('id, person_id, ehr_connection_id, cadence_minutes, consecutive_no_change, paused_until_app_open')
    .eq('id', schedule_id).maybeSingle();
  if (schedErr || !sched) { console.warn('[bg] schedule_not_found', { schedule_id, schedErr }); return jsonResponse({ ok: false, detail: 'schedule_not_found' }, 404); }
  // Binding check (2026-10-08 fix): the schedule row is the source of truth.
  // Refuse a request whose person or connection does not match it, so a caller
  // cannot point one connection's records at a different person.
  if (sched.person_id !== person_id || sched.ehr_connection_id !== ehr_connection_id) {
    console.warn('[bg] binding_mismatch', { schedule_id });
    return jsonResponse({ ok: false, detail: 'binding_mismatch' }, 409);
  }
  if (sched.paused_until_app_open) return jsonResponse({ ok: true, outcome: 'paused_inactive', cadence_minutes: sched.cadence_minutes });

  const { data: conn, error: connErr } = await admin.from('ehr_connections')
    .select('id, user_id, person_id, status, needs_reconnect, hospital_name, fhir_base_url')
    .eq('id', ehr_connection_id).maybeSingle();
  if (connErr || !conn) return jsonResponse({ ok: false, detail: 'connection_not_found' }, 404);
  if (conn.status !== 'connected' || conn.needs_reconnect) {
    const next = new Date(Date.now() + RECONNECT_BACKOFF_MIN * 60_000).toISOString();
    await admin.from('ehr_sync_schedule').update({ next_run_at: next, last_outcome: 'error', last_run_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', schedule_id);
    return jsonResponse({ ok: true, outcome: 'error', cadence_minutes: sched.cadence_minutes, next_run_at: next, detail: 'needs_reconnect' });
  }
  if (!conn.user_id) return jsonResponse({ ok: false, detail: 'connection_missing_user_id' }, 500);
  if (conn.person_id !== person_id) {
    console.warn('[bg] connection_person_mismatch', { schedule_id, ehr_connection_id });
    return jsonResponse({ ok: false, detail: 'binding_mismatch' }, 409);
  }

  const { data: baselineRow } = await admin.from('ehr_sync_log')
    .select('result_counts').eq('person_id', person_id).eq('status', 200)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  const baselineSig = countSignature(baselineRow?.result_counts as Record<string, unknown> | null);

  let userJwt: string | null = null;
  let innerError: string | null = null;
  try {
    const { data: userResp, error: userErr } = await admin.auth.admin.getUserById(conn.user_id);
    if (userErr || !userResp?.user?.email) {
      innerError = `user_lookup_failed_${userErr?.message ?? 'no_email'}`;
    } else {
      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: 'magiclink', email: userResp.user.email });
      if (linkErr || !linkData?.properties?.hashed_token) {
        innerError = `generate_link_failed_${linkErr?.message ?? 'no_token'}`;
      } else {
        const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { auth: { autoRefreshToken: false, persistSession: false } });
        const { data: verifyData, error: verifyErr } = await userClient.auth.verifyOtp({ token_hash: linkData.properties.hashed_token, type: 'email' });
        if (verifyErr || !verifyData?.session?.access_token) {
          innerError = `verify_otp_failed_${verifyErr?.message ?? 'no_session'}`;
        } else {
          userJwt = verifyData.session.access_token;
        }
      }
    }
  } catch (e) {
    innerError = `impersonation_exception_${(e as Error).message}`;
    console.error('[bg] impersonation threw', e);
  }

  let innerOk = false;
  let innerCounts: Record<string, unknown> | null = null;
  if (userJwt) {
    const innerUrl = `${supabaseUrl.replace(/\/$/, '')}/functions/v1/fetch-ehr-data`;
    try {
      const res = await fetch(innerUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${userJwt}`, 'X-Wellet-Triggered-By': 'background' },
        body: JSON.stringify({ person_id, ehr_connection_id }),
      });
      if (!res.ok) {
        innerError = `inner_http_${res.status}`;
        const txt = await res.text();
        console.error('[bg] inner call failed', { status: res.status, body: txt.slice(0, 400) });
      } else {
        const json = await res.json();
        const diag = json?._diagnostic as Record<string, unknown> | undefined;
        innerCounts = (diag?.result_counts as Record<string, unknown>) ?? null;
        innerOk = true;
      }
    } catch (e) {
      innerError = `inner_exception_${(e as Error).message}`;
      console.error('[bg] inner call threw', e);
    }
  }

  if (innerOk) {
    try {
      const { data: latest } = await admin.from('ehr_sync_log').select('id').eq('person_id', person_id).order('created_at', { ascending: false }).limit(1).maybeSingle();
      if (latest?.id) await admin.from('ehr_sync_log').update({ triggered_by: 'background' }).eq('id', latest.id);
    } catch (e) { console.warn('[bg] triggered_by stamp failed', e); }
  }

  let outcome: 'fresh_data' | 'no_change' | 'error';
  let nextCadence = sched.cadence_minutes;
  let nextNoChange = sched.consecutive_no_change;
  if (!innerOk) {
    outcome = 'error';
  } else {
    const newSig = countSignature(innerCounts);
    if (newSig === baselineSig && baselineSig !== '') {
      outcome = 'no_change';
      nextNoChange = sched.consecutive_no_change + 1;
      if (nextNoChange >= NO_CHANGE_THRESHOLD) nextCadence = clamp(sched.cadence_minutes * 2, CADENCE_FLOOR_MIN, CADENCE_CEILING_MIN);
    } else {
      outcome = 'fresh_data';
      nextNoChange = 0;
      nextCadence = clamp(Math.floor(sched.cadence_minutes / 2), CADENCE_FLOOR_MIN, CADENCE_CEILING_MIN);
    }
  }

  const nextRunMinutes = outcome === 'error' ? ERROR_BACKOFF_MIN : nextCadence;
  const nextRunAt = new Date(Date.now() + nextRunMinutes * 60_000).toISOString();
  const nowIso = new Date().toISOString();
  const { error: updErr } = await admin.from('ehr_sync_schedule').update({
    cadence_minutes: nextCadence, consecutive_no_change: nextNoChange,
    last_outcome: outcome, last_run_at: nowIso, next_run_at: nextRunAt, updated_at: nowIso,
  }).eq('id', schedule_id);
  if (updErr) console.error('[bg] schedule update failed', updErr);

  console.log('[bg] done', { schedule_id, person_id, ehr_connection_id, outcome, baseline_sig: baselineSig, new_sig: countSignature(innerCounts), cadence_minutes: nextCadence, next_run_at: nextRunAt, duration_ms: Date.now() - t0, inner_error: innerError });

  return jsonResponse({ ok: true, outcome, cadence_minutes: nextCadence, next_run_at: nextRunAt, detail: innerError });
});
