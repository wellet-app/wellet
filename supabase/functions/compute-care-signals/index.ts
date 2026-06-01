// compute-care-signals v1 — EHR-only AI-surfaced patterns
//
// Deterministic detectors (no LLM) that scan a loved one's health_events,
// medications, and lab_results, then upsert rows into public.care_signals.
// Idempotent on (person_id, pattern_key) so re-runs don't duplicate.
//
// Invoked four ways:
//   1. On-demand from the app: POST { person_id } with user JWT
//   2. Fire-and-forget from fetch-ehr-data after a successful sync
//   3. Hourly pg_cron for any person who has had an EHR write in the last 4h
//   4. Manual backfill: POST { person_id, force: true } with service role
//
// Returns: { ok, person_id, considered, inserted, updated, by_type }
//
// Voice rules (locked):
//   - "loved one" / "family member", never "parent"
//   - "notices" / "watches for", never "track"/"monitor"
//   - "may" / "appears to", never absolute claims
//   - No emojis, italics, or exclamation points

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

interface CareSignalRow {
  person_id: string;
  owner_user_id: string;
  signal_type: string;
  pattern_key: string;
  noticed_at: string;            // when the pattern was computed
  noticed_event_at: string;      // anchor date the pattern points to
  window_start: string;
  window_end: string;
  headline: string;
  body: string;
  evidence_jsonb: Record<string, unknown>;
  severity: 'notice' | 'attention' | 'urgent';
  status: 'active';
  display_eyebrow?: string;
  display_evidence_rows?: unknown;
  display_metric_tiles?: unknown;
}

// ---------- helpers ----------
function parseRange(range: string | null): { lo: number | null; hi: number | null } {
  if (!range) return { lo: null, hi: null };
  // Accept formats: "7 - 52 U/L", "<5", ">200", "3.5 - 5.2 g/dL"
  const m = range.match(/(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)/);
  if (m) return { lo: parseFloat(m[1]), hi: parseFloat(m[2]) };
  const lt = range.match(/<\s*(-?\d+(?:\.\d+)?)/);
  if (lt) return { lo: null, hi: parseFloat(lt[1]) };
  const gt = range.match(/>\s*(-?\d+(?:\.\d+)?)/);
  if (gt) return { lo: parseFloat(gt[1]), hi: null };
  return { lo: null, hi: null };
}

function parseValue(v: string | null): number | null {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function daysBetween(a: string | Date, b: string | Date): number {
  const ta = new Date(a).getTime();
  const tb = new Date(b).getTime();
  if (isNaN(ta) || isNaN(tb)) return NaN;
  return Math.abs(ta - tb) / 86400000;
}

function ymd(d: string | Date): string {
  return new Date(d).toISOString().slice(0, 10);
}

// First name extractor: "Cheryl Roberts Harris" -> "Cheryl"; "Mom" -> "Mom"
function firstName(full: string | null | undefined): string {
  if (!full) return 'your loved one';
  const t = String(full).trim();
  if (!t) return 'your loved one';
  return t.split(/\s+/)[0];
}

// ---------- main handler ----------
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'POST only' }), { status: 405, headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const person_id: string | undefined = body?.person_id;
    const force: boolean = !!body?.force;
    if (!person_id) {
      return new Response(JSON.stringify({ error: 'person_id required' }), { status: 400, headers: corsHeaders });
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const authHeader = req.headers.get('Authorization') ?? '';

    // Owner check: either valid user JWT for this person, OR service-role.
    // We always use service-role for the actual writes so RLS doesn't bite.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: personRow, error: personErr } = await admin
      .from('people')
      .select('id, name, user_id')
      .eq('id', person_id)
      .maybeSingle();

    if (personErr || !personRow) {
      return new Response(JSON.stringify({ error: 'person not found' }), { status: 404, headers: corsHeaders });
    }

    // If called with a user JWT, require it to match person.user_id.
    if (!force && authHeader && !authHeader.includes(SERVICE_ROLE)) {
      try {
        const userClient = createClient(SUPABASE_URL, ANON_KEY, {
          global: { headers: { Authorization: authHeader } },
        });
        const { data: ures } = await userClient.auth.getUser();
        if (!ures?.user || ures.user.id !== personRow.user_id) {
          return new Response(JSON.stringify({ error: 'not owner' }), { status: 403, headers: corsHeaders });
        }
      } catch (_e) {
        // fall through: service-role path can still operate
      }
    }

    const owner_user_id = personRow.user_id as string;
    const personName = firstName(personRow.name);

    // ---------- load EHR data ----------
    const [evRes, medRes, labRes] = await Promise.all([
      admin
        .from('health_events')
        .select('id, event_type, event_date, title, notes, encounter_class_display, encounter_service_provider, created_at')
        .eq('person_id', person_id)
        .order('event_date', { ascending: false })
        .limit(2000),
      admin
        .from('medications')
        .select('id, name, start_date, end_date, active, prescriber, created_at')
        .eq('person_id', person_id)
        .order('start_date', { ascending: false })
        .limit(500),
      admin
        .from('lab_results')
        .select('id, test_name, value, unit, reference_range, effective_date, loinc_code')
        .eq('person_id', person_id)
        .order('effective_date', { ascending: false })
        .limit(1000),
    ]);

    const events = evRes.data ?? [];
    const meds = medRes.data ?? [];
    const labs = labRes.data ?? [];

    const considered = events.length + meds.length + labs.length;
    const signals: CareSignalRow[] = [];

    const nowIso = new Date().toISOString();

    // ---------- detector 1: medication refill cadence ----------
    // Group refill notes by 30-day clusters; flag when there are 3+ refills
    // in the last 90 days (regardless of which medication — at this stage
    // refills come through as undifferentiated 'note' rows titled "Refill").
    try {
      const refills = events.filter((e) =>
        e.event_type === 'note' &&
        typeof e.title === 'string' &&
        /refill/i.test(e.title || '')
      );
      const last90 = refills.filter((e) => daysBetween(e.event_date, nowIso) <= 90);
      if (last90.length >= 3) {
        const anchor = last90[0].event_date;
        const headline = `${personName} has had ${last90.length} medication refills in the last 90 days`;
        const body =
          `Wellet noticed ${last90.length} refill notes between ${ymd(last90[last90.length - 1].event_date)} ` +
          `and ${ymd(last90[0].event_date)}. This may be a normal cadence, or it may be worth checking ` +
          `whether any prescriptions are running short between visits.`;
        signals.push({
          person_id, owner_user_id,
          signal_type: 'med_refill_cadence',
          pattern_key: `med_refill_cadence_${ymd(anchor)}_${last90.length}`,
          noticed_at: nowIso,
          noticed_event_at: anchor,
          window_start: last90[last90.length - 1].event_date,
          window_end: anchor,
          headline,
          body,
          evidence_jsonb: { count: last90.length, sample_ids: last90.slice(0, 6).map((r) => r.id) },
          severity: 'notice',
          status: 'active',
          display_eyebrow: 'Medication pattern',
        });
      }
    } catch (e) {
      console.warn('[compute-care-signals] med_refill_cadence skipped:', String(e));
    }

    // ---------- detector 2: recurring condition across recent visits ----------
    // Same condition title coded at 3+ visits in the last 12 months.
    try {
      const conds = events.filter((e) => e.event_type === 'condition' && e.title);
      const byTitle = new Map<string, typeof events>();
      for (const c of conds) {
        const k = String(c.title).trim().toLowerCase();
        if (!byTitle.has(k)) byTitle.set(k, []);
        byTitle.get(k)!.push(c);
      }
      for (const [k, rows] of byTitle.entries()) {
        const recent = rows.filter((r) => daysBetween(r.event_date, nowIso) <= 365);
        if (recent.length >= 3) {
          recent.sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());
          const anchor = recent[0].event_date;
          const display = recent[0].title; // preserve original casing
          const headline = `${display} has come up at ${recent.length} recent visits`;
          const body =
            `Wellet noticed ${display.toLowerCase()} on ${recent.length} of ${personName}'s visit records ` +
            `since ${ymd(recent[recent.length - 1].event_date)}. This may be worth bringing up at the next visit ` +
            `to see whether the plan is still working.`;
          signals.push({
            person_id, owner_user_id,
            signal_type: 'condition_recurrence',
            pattern_key: `condition_recurrence_${k.replace(/[^a-z0-9]+/g, '_').slice(0, 60)}`,
            noticed_at: nowIso,
            noticed_event_at: anchor,
            window_start: recent[recent.length - 1].event_date,
            window_end: anchor,
            headline,
            body,
            evidence_jsonb: { condition: display, count: recent.length, sample_ids: recent.slice(0, 6).map((r) => r.id) },
            severity: 'notice',
            status: 'active',
            display_eyebrow: 'Condition pattern',
          });
        }
      }
    } catch (e) {
      console.warn('[compute-care-signals] condition_recurrence skipped:', String(e));
    }

    // ---------- detector 3: new condition in last 30 days ----------
    // Condition title that does NOT appear before the last 30 days.
    try {
      const conds = events.filter((e) => e.event_type === 'condition' && e.title);
      const last30 = conds.filter((c) => daysBetween(c.event_date, nowIso) <= 30);
      const seenBefore = new Set(
        conds
          .filter((c) => daysBetween(c.event_date, nowIso) > 30)
          .map((c) => String(c.title).trim().toLowerCase())
      );
      const trulyNew = last30.filter((c) => !seenBefore.has(String(c.title).trim().toLowerCase()));
      // Dedupe by title within last30 (same condition coded twice in 30d still one signal)
      const seenInWindow = new Set<string>();
      for (const c of trulyNew) {
        const k = String(c.title).trim().toLowerCase();
        if (seenInWindow.has(k)) continue;
        seenInWindow.add(k);
        const headline = `${c.title} is a new condition on ${personName}'s chart`;
        const body =
          `Wellet noticed ${String(c.title).toLowerCase()} appeared for the first time on ${ymd(c.event_date)} ` +
          `${c.encounter_service_provider ? `at ${c.encounter_service_provider}` : ''}. ` +
          `Newly coded conditions sometimes reflect a recent visit's notes — worth confirming what it refers to.`;
        signals.push({
          person_id, owner_user_id,
          signal_type: 'new_condition',
          pattern_key: `new_condition_${k.replace(/[^a-z0-9]+/g, '_').slice(0, 60)}_${ymd(c.event_date)}`,
          noticed_at: nowIso,
          noticed_event_at: c.event_date,
          window_start: c.event_date,
          window_end: nowIso,
          headline,
          body,
          evidence_jsonb: { condition: c.title, event_id: c.id, provider: c.encounter_service_provider ?? null },
          severity: 'attention',
          status: 'active',
          display_eyebrow: 'New condition',
        });
      }
    } catch (e) {
      console.warn('[compute-care-signals] new_condition skipped:', String(e));
    }

    // ---------- detector 4: visit frequency change ----------
    // Compare visits in last 90d vs prior 90-180d.
    try {
      const visits = events.filter((e) => e.event_type === 'visit');
      const last90 = visits.filter((v) => daysBetween(v.event_date, nowIso) <= 90);
      const prior90 = visits.filter((v) => {
        const d = daysBetween(v.event_date, nowIso);
        return d > 90 && d <= 180;
      });
      if (last90.length >= 3 && last90.length >= prior90.length + 2) {
        const anchor = last90[0].event_date;
        const headline = `${personName} has had more visits than usual recently`;
        const body =
          `Wellet noticed ${last90.length} visits in the last 90 days, compared to ${prior90.length} in the 90 days before that. ` +
          `This may reflect a new workup, a flare, or just catch-up appointments — worth checking whether the pace is sustainable.`;
        signals.push({
          person_id, owner_user_id,
          signal_type: 'visit_frequency_change',
          pattern_key: `visit_frequency_change_${ymd(anchor)}`,
          noticed_at: nowIso,
          noticed_event_at: anchor,
          window_start: last90[last90.length - 1].event_date,
          window_end: anchor,
          headline,
          body,
          evidence_jsonb: { last_90d: last90.length, prior_90d: prior90.length, sample_ids: last90.slice(0, 6).map((r) => r.id) },
          severity: 'notice',
          status: 'active',
          display_eyebrow: 'Visit cadence',
        });
      }
    } catch (e) {
      console.warn('[compute-care-signals] visit_frequency_change skipped:', String(e));
    }

    // ---------- detector 5: lab trend / recovery / out-of-range ----------
    // For each LOINC with 2+ values, look at the most recent vs the previous.
    try {
      const byLoinc = new Map<string, typeof labs>();
      for (const l of labs) {
        if (!l.loinc_code || !l.test_name) continue;
        const v = parseValue(l.value);
        if (v == null) continue;
        const k = l.loinc_code;
        if (!byLoinc.has(k)) byLoinc.set(k, []);
        byLoinc.get(k)!.push(l);
      }
      for (const [loinc, rows] of byLoinc.entries()) {
        rows.sort((a, b) => new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime());
        if (rows.length < 2) continue;
        const latest = rows[0];
        const prev = rows[1];
        const latestVal = parseValue(latest.value)!;
        const prevVal = parseValue(prev.value)!;
        const { lo, hi } = parseRange(latest.reference_range);
        const latestOut = (lo != null && latestVal < lo) || (hi != null && latestVal > hi);
        const prevOut = (lo != null && prevVal < lo) || (hi != null && prevVal > hi);

        // a) recovery: prev was out of range, latest is in range
        if (prevOut && !latestOut) {
          const headline = `${personName}'s ${latest.test_name} is back in range`;
          const body =
            `Wellet noticed ${latest.test_name} was ${prevVal} ${latest.unit ?? ''} on ${ymd(prev.effective_date)} ` +
            `(out of range ${latest.reference_range ?? ''}) and is now ${latestVal} ${latest.unit ?? ''} on ` +
            `${ymd(latest.effective_date)}. Worth noting at the next visit.`;
          signals.push({
            person_id, owner_user_id,
            signal_type: 'lab_recovery',
            pattern_key: `lab_recovery_${loinc}_${ymd(latest.effective_date)}`,
            noticed_at: nowIso,
            noticed_event_at: latest.effective_date,
            window_start: prev.effective_date,
            window_end: latest.effective_date,
            headline,
            body,
            evidence_jsonb: {
              loinc_code: loinc,
              test_name: latest.test_name,
              latest: { value: latest.value, date: latest.effective_date },
              previous: { value: prev.value, date: prev.effective_date },
              reference_range: latest.reference_range,
            },
            severity: 'notice',
            status: 'active',
            display_eyebrow: 'Lab recovery',
          });
          continue;
        }

        // b) out-of-range: latest is out of range
        if (latestOut) {
          const direction = (hi != null && latestVal > hi) ? 'high' : 'low';
          const headline = `${personName}'s ${latest.test_name} is ${direction === 'high' ? 'above' : 'below'} the reference range`;
          const body =
            `Wellet noticed the most recent ${latest.test_name} was ${latestVal} ${latest.unit ?? ''} on ` +
            `${ymd(latest.effective_date)} (reference: ${latest.reference_range ?? 'n/a'}). ` +
            `Worth checking what the clinician's plan is.`;
          signals.push({
            person_id, owner_user_id,
            signal_type: 'lab_out_of_range',
            pattern_key: `lab_out_of_range_${loinc}_${ymd(latest.effective_date)}`,
            noticed_at: nowIso,
            noticed_event_at: latest.effective_date,
            window_start: latest.effective_date,
            window_end: latest.effective_date,
            headline,
            body,
            evidence_jsonb: {
              loinc_code: loinc,
              test_name: latest.test_name,
              latest: { value: latest.value, date: latest.effective_date },
              previous: { value: prev.value, date: prev.effective_date },
              reference_range: latest.reference_range,
              direction,
            },
            severity: direction === 'high' ? 'attention' : 'notice',
            status: 'active',
            display_eyebrow: 'Lab out of range',
          });
          continue;
        }

        // c) trend: 3+ values, consistent direction, change >= 15% from oldest of last 3
        if (rows.length >= 3) {
          const last3 = rows.slice(0, 3); // newest first
          const v0 = parseValue(last3[2].value)!;
          const v1 = parseValue(last3[1].value)!;
          const v2 = parseValue(last3[0].value)!;
          if ([v0, v1, v2].every(Number.isFinite) && v0 !== 0) {
            const monotone = (v2 > v1 && v1 > v0) || (v2 < v1 && v1 < v0);
            const pct = Math.abs((v2 - v0) / v0) * 100;
            if (monotone && pct >= 15) {
              const dir = v2 > v0 ? 'up' : 'down';
              const headline = `${personName}'s ${latest.test_name} has been trending ${dir}`;
              const body =
                `Wellet noticed ${latest.test_name} went from ${v0} on ${ymd(last3[2].effective_date)} ` +
                `to ${v1} on ${ymd(last3[1].effective_date)} to ${v2} ${latest.unit ?? ''} on ${ymd(last3[0].effective_date)} ` +
                `(reference: ${latest.reference_range ?? 'n/a'}). The values are still in range, but the direction is worth noting.`;
              signals.push({
                person_id, owner_user_id,
                signal_type: 'lab_trend',
                pattern_key: `lab_trend_${loinc}_${dir}_${ymd(latest.effective_date)}`,
                noticed_at: nowIso,
                noticed_event_at: latest.effective_date,
                window_start: last3[2].effective_date,
                window_end: latest.effective_date,
                headline,
                body,
                evidence_jsonb: {
                  loinc_code: loinc,
                  test_name: latest.test_name,
                  values: last3.map((r) => ({ value: r.value, date: r.effective_date })).reverse(),
                  reference_range: latest.reference_range,
                  direction: dir,
                  pct_change: Math.round(pct * 10) / 10,
                },
                severity: 'notice',
                status: 'active',
                display_eyebrow: 'Lab trend',
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn('[compute-care-signals] lab detectors skipped:', String(e));
    }

    // ---------- detector 6: new medication cluster ----------
    // 2+ new medications started within a 14-day window in the last 60 days.
    try {
      const recentMeds = meds.filter((m) => {
        if (!m.start_date) return false;
        return daysBetween(m.start_date, nowIso) <= 60;
      });
      if (recentMeds.length >= 2) {
        recentMeds.sort((a, b) => new Date(b.start_date!).getTime() - new Date(a.start_date!).getTime());
        const head = recentMeds[0];
        // count meds within 14 days of head
        const cluster = recentMeds.filter((m) => daysBetween(m.start_date!, head.start_date!) <= 14);
        if (cluster.length >= 2) {
          const headline = `${cluster.length} new medications started for ${personName}`;
          const body =
            `Wellet noticed ${cluster.length} new prescriptions in a ${Math.max(1, Math.round(daysBetween(cluster[cluster.length - 1].start_date!, head.start_date!)))}-day window ending ${ymd(head.start_date!)}: ` +
            `${cluster.map((m) => m.name).filter(Boolean).join(', ')}. ` +
            `New medication clusters are worth watching — side effects can compound.`;
          signals.push({
            person_id, owner_user_id,
            signal_type: 'med_cluster_added',
            pattern_key: `med_cluster_${ymd(cluster[cluster.length - 1].start_date!)}_${ymd(head.start_date!)}`,
            noticed_at: nowIso,
            noticed_event_at: head.start_date!,
            window_start: cluster[cluster.length - 1].start_date!,
            window_end: head.start_date!,
            headline,
            body,
            evidence_jsonb: { count: cluster.length, names: cluster.map((m) => m.name) },
            severity: 'attention',
            status: 'active',
            display_eyebrow: 'New medications',
          });
        }
      }
    } catch (e) {
      console.warn('[compute-care-signals] med_cluster_added skipped:', String(e));
    }

    // ---------- upsert ----------
    let inserted = 0;
    let updated = 0;
    const byType: Record<string, number> = {};

    if (signals.length > 0) {
      // Use upsert with onConflict so re-runs are idempotent. We don't bump
      // noticed_at on existing rows (that would push old signals to the top of
      // the list every hour); only fields the user hasn't acted on get
      // refreshed via a conditional WHERE. Simpler: insert with onConflict do
      // nothing, then for keys that already existed we leave the row alone.
      const { data: upserted, error: upErr } = await admin
        .from('care_signals')
        .upsert(signals, { onConflict: 'person_id,pattern_key', ignoreDuplicates: true })
        .select('id, pattern_key, signal_type');

      if (upErr) {
        console.error('[compute-care-signals] upsert error:', upErr.message);
        return new Response(JSON.stringify({ error: 'upsert failed', details: upErr.message }), {
          status: 500, headers: corsHeaders,
        });
      }

      inserted = upserted?.length ?? 0;
      updated = signals.length - inserted;
      for (const s of signals) byType[s.signal_type] = (byType[s.signal_type] ?? 0) + 1;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        person_id,
        considered,
        candidates: signals.length,
        inserted,
        skipped_existing: updated,
        by_type: byType,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('[compute-care-signals] fatal:', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500, headers: corsHeaders,
    });
  }
});
