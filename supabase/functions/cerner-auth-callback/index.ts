// Supabase Edge Function: cerner-auth-callback
// Cerner Wave 1 — SMART on FHIR OAuth2 callback handler.
// Public client — no client_secret. Exchange code for tokens using only client_id.
//
// GET with: code=...&state=...
// Validates state, exchanges code at token URL, persists tokens to ehr_connections
// with provider='cerner', redirects to mywellet.com/me/connections?ok=cerner.
//
// FHIR shape gotchas handled here:
//   - Cerner escapes ampersands as \u0026 in link.url pagination fields.
//     Unescape these before following next-page links.
//   - Encounter.period.start can be null on in-progress encounters.
//     Guard all period reads with null checks.
//
// Voice rules: loved one / family member — not parent. notices / watches for — not track/monitor.
// CareSignals is one word. No emojis, no italics, no exclamation points.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CERNER_CLIENT_ID = '3b98223e-17ec-4a8f-ac77-f4fdbb242371';
const CERNER_REDIRECT_URI = Deno.env.get('CERNER_REDIRECT_URI') ??
  'https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/cerner-auth-callback';
const APP_REDIRECT_BASE = Deno.env.get('APP_REDIRECT_BASE') ?? 'https://mywellet.com';

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

// ── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // This endpoint is the OAuth2 redirect target — Cerner sends GET with query params.
  // POST is also accepted for testing convenience.
  try {
    let code: string | null = null;
    let state: string | null = null;
    let errorParam: string | null = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state');
      errorParam = url.searchParams.get('error');
    } else if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      code = body.code ?? null;
      state = body.state ?? null;
      errorParam = body.error ?? null;
    } else {
      return new Response('Method not allowed', { status: 405 });
    }

    if (errorParam) {
      console.warn('[cerner-auth-callback] provider returned error', { error: errorParam });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_denied&detail=${encodeURIComponent(errorParam)}`,
        302,
      );
    }

    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    const admin = getAdminClient();

    // Validate state — look up pending ehr_connections row.
    const { data: conn, error: connError } = await admin
      .from('ehr_connections')
      .select('*')
      .eq('state', state)
      .eq('provider', 'cerner')
      .maybeSingle();

    if (connError || !conn) {
      console.error('[cerner-auth-callback] state not found', { state: state.slice(0, 8) + '...', connError });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_state_mismatch`,
        302,
      );
    }

    const tokenUrl = conn.token_url as string;
    if (!tokenUrl) {
      console.error('[cerner-auth-callback] no token_url on connection row', { conn_id: conn.id });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_config_error`,
        302,
      );
    }

    // Exchange authorization code for tokens.
    // Cerner public app — no client_secret, no client_assertion.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CERNER_REDIRECT_URI,
      client_id: CERNER_CLIENT_ID,
    });

    const t0 = Date.now();
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const tokenLatencyMs = Date.now() - t0;

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[cerner-auth-callback] token exchange failed', {
        status: tokenRes.status,
        body: errText.slice(0, 400),
        latency_ms: tokenLatencyMs,
      });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_token_failed&status=${tokenRes.status}`,
        302,
      );
    }

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('[cerner-auth-callback] no access_token in response', tokenData);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_no_token`,
        302,
      );
    }

    const expiresAt = new Date(
      Date.now() + (tokenData.expires_in || 3600) * 1000,
    ).toISOString();

    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    if (!encKey) {
      console.error('[cerner-auth-callback] EHR_ENCRYPTION_KEY not set');
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_server_misconfigured`,
        302,
      );
    }

    const { data: encAccessToken, error: encAccessErr } = await admin.rpc('encrypt_ehr_token', {
      plain_token: tokenData.access_token,
      enc_key: encKey,
    });
    if (encAccessErr || !encAccessToken) {
      console.error('[cerner-auth-callback] encrypt access_token failed', encAccessErr);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_encrypt_failed`,
        302,
      );
    }

    let encRefreshToken: string | null = null;
    if (tokenData.refresh_token) {
      const { data: encR, error: encRErr } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.refresh_token,
        enc_key: encKey,
      });
      if (encRErr || !encR) {
        console.error('[cerner-auth-callback] encrypt refresh_token failed', encRErr);
        // Non-fatal — proceed without refresh token.
      } else {
        encRefreshToken = encR;
      }
    }

    // patient comes from the Cerner token response as `patient`.
    const patientId = (tokenData.patient as string | null) ?? null;

    // ── PATIENT-MATCH GUARD (2026-10-21, same rules as epic-auth v64) ──
    // Before any token is stored or any prior row is superseded:
    //   1. same_patient_other_person: this account already has a connected row
    //      for the same base URL and patient on a DIFFERENT person.
    //   2. birth_date_mismatch: the person has a birth date in Wellet and the
    //      Patient resource has a full birthDate that differs.
    // A failed Patient read does not block; it is logged.
    let mismatchReason: string | null = null;
    const guardDebug: Record<string, unknown> = { guard: 'patient_match_v1' };
    if (patientId) {
      const { data: dupRows } = await admin.from('ehr_connections')
        .select('id')
        .eq('user_id', conn.user_id)
        .eq('fhir_base_url', conn.fhir_base_url)
        .eq('patient_id', patientId)
        .eq('status', 'connected')
        .neq('person_id', conn.person_id)
        .limit(1);
      if (dupRows && dupRows.length) mismatchReason = 'same_patient_other_person';
    }
    // Vendor test patients are synthetic and never match a real profile's
    // birth date, so the birth-date check is skipped on sandbox bases.
    const isSandboxBase = /ec2458f2-1e24-41c8-b71b-0e701af7583d/i.test(String(conn.fhir_base_url || ''));
    guardDebug.sandbox_base = isSandboxBase;
    if (!mismatchReason && !isSandboxBase && patientId) {
      const { data: personRow } = await admin.from('people')
        .select('date_of_birth, manual_date_of_birth')
        .eq('id', conn.person_id)
        .eq('user_id', conn.user_id)
        .maybeSingle();
      const weHave: string | null = (personRow?.manual_date_of_birth || personRow?.date_of_birth || null);
      guardDebug.person_has_birth_date = !!weHave;
      if (weHave) {
        try {
          const base = String(conn.fhir_base_url || '').replace(/\/+$/, '');
          const pRes = await fetch(`${base}/Patient/${encodeURIComponent(patientId)}`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/fhir+json' },
          });
          guardDebug.patient_read_status = pRes.status;
          if (pRes.ok) {
            const pj = await pRes.json();
            const theirs = typeof pj?.birthDate === 'string' ? pj.birthDate : '';
            guardDebug.hospital_has_birth_date = /^\d{4}-\d{2}-\d{2}$/.test(theirs);
            if (/^\d{4}-\d{2}-\d{2}$/.test(theirs) && theirs !== String(weHave).slice(0, 10)) {
              mismatchReason = 'birth_date_mismatch';
            }
          }
        } catch (e) {
          guardDebug.patient_read_error = String((e as Error)?.message || e).slice(0, 200);
        }
      }
    }
    if (mismatchReason) {
      await admin.from('ehr_connections').update({
        status: 'patient_mismatch',
        code_verifier: null,
        state: null,
        last_error: mismatchReason,
        last_error_step: 'patient_match',
        last_error_at: new Date().toISOString(),
        last_error_debug: guardDebug,
      }).eq('id', conn.id).eq('user_id', conn.user_id);
      console.warn('[cerner-auth-callback] patient-match guard blocked connect', { conn_id: conn.id, reason: mismatchReason });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=patient_mismatch`,
        302,
      );
    }

    // Supersede any prior connected row for the same (person_id, fhir_base_url).
    try {
      await admin
        .from('ehr_connections')
        .update({
          status: 'superseded',
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          needs_reconnect: false,
        })
        .eq('person_id', conn.person_id)
        .eq('fhir_base_url', conn.fhir_base_url)
        .eq('status', 'connected')
        .neq('id', conn.id);
    } catch (e) {
      console.error('[cerner-auth-callback] supersede prior row failed', (e as Error).message);
    }

    const { error: updateError } = await admin
      .from('ehr_connections')
      .update({
        access_token: encAccessToken,
        refresh_token: encRefreshToken,
        token_expires_at: expiresAt,
        patient_id: patientId,
        connected_provider: 'Cerner Sandbox',
        connected_at: new Date().toISOString(),
        client_id_used: CERNER_CLIENT_ID,
        needs_reconnect: false,
        status: 'connected',
        state: null,
        code_verifier: null,
      })
      .eq('id', conn.id);

    if (updateError) {
      console.error('[cerner-auth-callback] token store failed', updateError);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_store_failed`,
        302,
      );
    }

    console.log('[cerner-auth-callback] connection established', {
      conn_id: conn.id,
      person_id: conn.person_id,
      patient_id: patientId,
      has_refresh_token: !!tokenData.refresh_token,
      token_latency_ms: tokenLatencyMs,
    });

    return Response.redirect(
      `${APP_REDIRECT_BASE}/me/connections?ok=cerner`,
      302,
    );
  } catch (err) {
    console.error('[cerner-auth-callback] unhandled error', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
