// evaluate-care-signal-watches
// ----------------------------------------------------------------------------
// Service-role-only edge function. Triggered every 4 hours by pg_cron.
// Walks every active care_signal_watch and decides whether to fire.
//
// Auth: Authorization header MUST be `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`.
//       (verify_jwt: false at the gateway; we re-check the bearer here.)
//
// On fire:
//   1. Insert into care_signal_watch_fires with notification_status = 'queued'
//   2. Check user's quiet_hours_enabled / quiet_hours_start / quiet_hours_end
//      \u2014 if inside quiet hours, mark fire as 'suppressed_quiet_hours' and
//      do NOT send. Next run will pick it up if still relevant.
//   3. Otherwise send email via Brevo (port 465, hello@getwellet.com FROM,
//      same pattern as the rest of the email stack).
//   4. Update fire row with sent_at + status, bump watch.fire_count and
//      last_fired_at.
//
// What this function will NOT do:
//   - Interpret data clinically. It compares numbers to user-set thresholds.
//   - Send notifications during the user's quiet hours.
//   - Re-fire on the same source event (idempotency via trigger_value).
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SMTP_HOST = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
// Hardcoded 465 (implicit TLS). 587 + tls:true breaks denomailer 1.6.
const SMTP_PORT = 465;
const SMTP_USER = Deno.env.get("BREVO_SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("BREVO_SMTP_KEY") || "";
const FROM_ADDRESS = "Wellet <hello@getwellet.com>";

// HK type names we read for wearable watches.
const HK_RESTING_HR = "HKQuantityTypeIdentifierRestingHeartRate";
const HK_STEPS = "HKQuantityTypeIdentifierStepCount";
const HK_SLEEP_HOURS = "HKCategoryTypeIdentifierSleepAnalysis";

// Per-type minimum hours between fires (rate limit).
const FIRE_COOLDOWN_HOURS: Record<string, number> = {
  resting_hr_sustained_above: 24,
  resting_hr_above_baseline: 24,
  daily_steps_below: 24,
  sleep_duration_below: 24,
  wearable_silence: 24,
  refill_gap: 24,
  pcp_visit_gap: 24 * 7, // weekly is plenty
  new_record_arrived: 0, // every new record can fire
};

// Watch types whose underlying data isn't wired up yet. Evaluator skips
// these gracefully so a stale row in the DB doesn't break a run.
const NOT_YET_IMPLEMENTED = new Set([
  "appointment_changed",
  "new_care_team_member",
]);

interface Watch {
  id: string;
  user_id: string;
  person_id: string;
  watch_type: string;
  parameters: Record<string, unknown>;
  description: string;
  last_fired_at: string | null;
}

interface PersonRow {
  id: string;
  name: string;
}

interface UserPrefs {
  email: string;
  quiet_hours_enabled: boolean;
  quiet_start: string; // 'HH:MM'
  quiet_end: string;   // 'HH:MM'
  timezone: string | null;
}

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method_not_allowed", { status: 405 });
  }
  // Service-role gate
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${SERVICE_ROLE}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  }

  const startedAt = new Date().toISOString();
  const stats = { evaluated: 0, fired: 0, suppressed: 0, errored: 0, skipped: 0 };

  try {
    const { data: watches, error: wErr } = await admin
      .from("care_signal_watches")
      .select("id, user_id, person_id, watch_type, parameters, description, last_fired_at")
      .eq("active", true)
      .is("paused_at", null);
    if (wErr) throw wErr;

    for (const w of (watches || []) as Watch[]) {
      stats.evaluated++;
      try {
        if (NOT_YET_IMPLEMENTED.has(w.watch_type)) {
          stats.skipped++;
          continue;
        }

        // Per-type cooldown
        const cooldownHrs = FIRE_COOLDOWN_HOURS[w.watch_type] ?? 24;
        if (cooldownHrs > 0 && w.last_fired_at) {
          const since = (Date.now() - new Date(w.last_fired_at).getTime()) / 3_600_000;
          if (since < cooldownHrs) {
            stats.skipped++;
            continue;
          }
        }

        const decision = await evaluateWatch(w);
        if (!decision.fire) continue;

        // Idempotency: skip if we already fired on this exact trigger
        if (decision.dedupKey) {
          const { data: existing } = await admin
            .from("care_signal_watch_fires")
            .select("id")
            .eq("watch_id", w.id)
            .eq("trigger_value->>dedupKey", decision.dedupKey)
            .limit(1);
          if (existing && existing.length > 0) {
            stats.skipped++;
            continue;
          }
        }

        const fired = await fireWatch(w, decision);
        if (fired === "sent") stats.fired++;
        else if (fired === "suppressed") stats.suppressed++;
      } catch (perWatchErr) {
        console.error("[evaluator] watch failed", w.id, perWatchErr);
        stats.errored++;
      }
    }

    return new Response(JSON.stringify({ ok: true, startedAt, stats }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[evaluator] fatal", e);
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});

// ---------- Per-type evaluators ----------

interface FireDecision {
  fire: boolean;
  dedupKey?: string;          // unique-per-trigger key, for idempotency
  triggerValue?: Record<string, unknown>;
  factualBody?: string;       // plain-language fact, no interpretation
}

async function evaluateWatch(w: Watch): Promise<FireDecision> {
  switch (w.watch_type) {
    case "new_record_arrived":   return await evalNewRecordArrived(w);
    case "wearable_silence":     return await evalWearableSilence(w);
    case "resting_hr_sustained_above": return await evalRestingHrSustained(w);
    case "resting_hr_above_baseline":  return await evalRestingHrBaseline(w);
    case "daily_steps_below":    return await evalDailyStepsBelow(w);
    case "sleep_duration_below": return await evalSleepBelow(w);
    case "refill_gap":           return await evalRefillGap(w);
    case "pcp_visit_gap":        return await evalPcpVisitGap(w);
    default:
      return { fire: false };
  }
}

// --- new_record_arrived ---
// Fires once per new record (lab, visit, imaging, discharge, medication,
// immunization) since the watch's last_fired_at. Uses created_at on the
// underlying tables. Deduplicates per source-row id.
async function evalNewRecordArrived(w: Watch): Promise<FireDecision> {
  const kinds = (w.parameters.kinds as string[]) || ["lab", "visit", "imaging", "discharge"];
  const since = w.last_fired_at || new Date(Date.now() - 14 * 24 * 3_600_000).toISOString();

  // Map "kinds" the user picked to (table, type-filter, label).
  const queries: Array<Promise<{ kind: string; row: any } | null>> = [];

  if (kinds.includes("lab")) {
    queries.push((async () => {
      const { data } = await admin
        .from("lab_results")
        .select("id, test_name, created_at")
        .eq("person_id", w.person_id)
        .gt("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);
      return data && data[0] ? { kind: "lab result", row: data[0] } : null;
    })());
  }
  if (kinds.includes("medication")) {
    queries.push((async () => {
      const { data } = await admin
        .from("medications")
        .select("id, name, created_at")
        .eq("person_id", w.person_id)
        .gt("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);
      return data && data[0] ? { kind: "medication", row: data[0] } : null;
    })());
  }
  if (kinds.some((k) => ["visit", "imaging", "discharge"].includes(k))) {
    // health_events covers visits, imaging, discharge (event_type values).
    const wantedEventTypes = kinds.filter((k) =>
      ["visit", "imaging", "discharge"].includes(k)
    );
    queries.push((async () => {
      const { data } = await admin
        .from("health_events")
        .select("id, event_type, title, created_at")
        .eq("person_id", w.person_id)
        .in("event_type", wantedEventTypes)
        .gt("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1);
      return data && data[0]
        ? { kind: data[0].event_type || "record", row: data[0] }
        : null;
    })());
  }

  const results = (await Promise.all(queries)).filter(Boolean) as Array<{ kind: string; row: any }>;
  if (results.length === 0) return { fire: false };

  // Pick the most recent across kinds
  results.sort((a, b) => new Date(b.row.created_at).getTime() - new Date(a.row.created_at).getTime());
  const top = results[0];
  // Pull a human label off the row so the timeline chip can say
  // "Hemoglobin A1c" instead of just "New lab result".
  const recordLabel: string =
    (top.row.test_name as string | undefined) ||
    (top.row.name as string | undefined) ||
    (top.row.title as string | undefined) ||
    "";

  return {
    fire: true,
    dedupKey: `record:${top.row.id}`,
    triggerValue: {
      dedupKey: `record:${top.row.id}`,
      kind: top.kind,
      record_id: top.row.id,
      record_label: recordLabel,
      arrived_at: top.row.created_at,
    },
    // Factual only — no value, no flag, no interpretation.
    factualBody: recordLabel
      ? `${recordLabel} just landed in the chart.`
      : `A new ${top.kind} just arrived in the chart.`,
  };
}

// --- wearable_silence ---
// Fires when the most recent terra_connections.last_data_at is older than
// silence_days. Dedupes per-day (we don't want to spam if it's been dead a
// week).
async function evalWearableSilence(w: Watch): Promise<FireDecision> {
  const silenceDays = Number(w.parameters.silence_days) || 2;
  const { data: conns } = await admin
    .from("terra_connections")
    .select("provider, last_data_at, status")
    .eq("person_id", w.person_id)
    .eq("status", "active");
  if (!conns || conns.length === 0) return { fire: false };

  // Use the most-recent last_data_at across all active connections.
  let latest: { provider: string; last_data_at: string | null } | null = null;
  for (const c of conns) {
    if (!latest) latest = c;
    else if ((c.last_data_at || "") > (latest.last_data_at || "")) latest = c;
  }
  if (!latest || !latest.last_data_at) return { fire: false }; // never connected, not "gone silent"

  const ageDays = (Date.now() - new Date(latest.last_data_at).getTime()) / (24 * 3_600_000);
  if (ageDays < silenceDays) return { fire: false };

  const today = new Date().toISOString().slice(0, 10);
  return {
    fire: true,
    dedupKey: `wearable_silent:${today}`,
    triggerValue: {
      dedupKey: `wearable_silent:${today}`,
      provider: latest.provider,
      last_data_at: latest.last_data_at,
      age_days: Math.round(ageDays * 10) / 10,
    },
    factualBody: `${latest.provider} hasn't sent any data in ${Math.floor(ageDays)} days. The watch may be off, dead, or not syncing. You asked to be notified about this.`,
  };
}

// --- resting_hr_sustained_above ---
// Fires when daily-avg resting HR has been > threshold every day for the
// last `window_days`. Dedupes per-end-date so a fresh crossing is required.
async function evalRestingHrSustained(w: Watch): Promise<FireDecision> {
  const threshold = Number(w.parameters.threshold_bpm);
  const windowDays = Number(w.parameters.window_days);
  if (!threshold || !windowDays) return { fire: false };

  const since = new Date(Date.now() - (windowDays + 1) * 24 * 3_600_000).toISOString();
  const { data: rows } = await admin
    .from("wearable_observations")
    .select("value, start_at")
    .eq("person_id", w.person_id)
    .eq("hk_type", HK_RESTING_HR)
    .gte("start_at", since)
    .order("start_at", { ascending: true });
  if (!rows || rows.length === 0) return { fire: false };

  const dailyAvg = bucketDailyAvg(rows as Array<{ value: number; start_at: string }>);
  const lastN = lastNDays(dailyAvg, windowDays);
  if (lastN.length < windowDays) return { fire: false };
  if (!lastN.every((d) => d.avg > threshold)) return { fire: false };

  const endDate = lastN[lastN.length - 1].date;
  return {
    fire: true,
    dedupKey: `hr_sustained:${endDate}:${threshold}:${windowDays}`,
    triggerValue: {
      dedupKey: `hr_sustained:${endDate}:${threshold}:${windowDays}`,
      threshold_bpm: threshold,
      window_days: windowDays,
      daily_averages: lastN,
    },
    factualBody: `Resting heart rate has been above ${threshold} bpm every day for ${windowDays} days. You asked Wellet to notice this.`,
  };
}

// --- resting_hr_above_baseline ---
// Fires when daily-avg resting HR has been > (baseline_avg + delta) every
// day for window_days. Baseline = mean of the prior baseline_window_days
// (excluding the recent window).
async function evalRestingHrBaseline(w: Watch): Promise<FireDecision> {
  const delta = Number(w.parameters.delta_bpm);
  const baselineDays = Number(w.parameters.baseline_window_days) || 30;
  const windowDays = Number(w.parameters.window_days);
  if (!delta || !windowDays) return { fire: false };

  const totalDays = baselineDays + windowDays + 1;
  const since = new Date(Date.now() - totalDays * 24 * 3_600_000).toISOString();
  const { data: rows } = await admin
    .from("wearable_observations")
    .select("value, start_at")
    .eq("person_id", w.person_id)
    .eq("hk_type", HK_RESTING_HR)
    .gte("start_at", since)
    .order("start_at", { ascending: true });
  if (!rows || rows.length === 0) return { fire: false };

  const allDaily = bucketDailyAvg(rows as Array<{ value: number; start_at: string }>);
  if (allDaily.length < baselineDays + windowDays) return { fire: false };

  const baselineSlice = allDaily.slice(-(baselineDays + windowDays), -windowDays);
  const recentSlice = allDaily.slice(-windowDays);

  const baselineMean = baselineSlice.reduce((s, d) => s + d.avg, 0) / baselineSlice.length;
  const threshold = baselineMean + delta;
  if (!recentSlice.every((d) => d.avg > threshold)) return { fire: false };

  const endDate = recentSlice[recentSlice.length - 1].date;
  return {
    fire: true,
    dedupKey: `hr_baseline:${endDate}:${delta}`,
    triggerValue: {
      dedupKey: `hr_baseline:${endDate}:${delta}`,
      baseline_mean: Math.round(baselineMean * 10) / 10,
      delta_bpm: delta,
      threshold: Math.round(threshold * 10) / 10,
      recent_days: recentSlice,
    },
    factualBody: `Resting heart rate has been more than ${delta} bpm above the ${baselineDays}-day average for ${windowDays} days. You asked Wellet to notice this.`,
  };
}

// --- daily_steps_below ---
async function evalDailyStepsBelow(w: Watch): Promise<FireDecision> {
  const threshold = Number(w.parameters.threshold_steps);
  const windowDays = Number(w.parameters.window_days);
  if (threshold === undefined || !windowDays) return { fire: false };

  const since = new Date(Date.now() - (windowDays + 1) * 24 * 3_600_000).toISOString();
  const { data: rows } = await admin
    .from("wearable_observations")
    .select("value, start_at")
    .eq("person_id", w.person_id)
    .eq("hk_type", HK_STEPS)
    .gte("start_at", since)
    .order("start_at", { ascending: true });
  if (!rows || rows.length === 0) return { fire: false };

  // Steps roll up by SUM, not avg.
  const dailySum = bucketDailySum(rows as Array<{ value: number; start_at: string }>);
  const lastN = lastNDays(dailySum, windowDays);
  if (lastN.length < windowDays) return { fire: false };
  if (!lastN.every((d) => d.avg < threshold)) return { fire: false }; // 'avg' carries sum here

  const endDate = lastN[lastN.length - 1].date;
  return {
    fire: true,
    dedupKey: `steps_below:${endDate}:${threshold}`,
    triggerValue: {
      dedupKey: `steps_below:${endDate}:${threshold}`,
      threshold_steps: threshold,
      daily_steps: lastN,
    },
    factualBody: `Daily steps stayed below ${threshold} for ${windowDays} days in a row. You asked Wellet to notice this.`,
  };
}

// --- sleep_duration_below ---
async function evalSleepBelow(w: Watch): Promise<FireDecision> {
  const thresholdHrs = Number(w.parameters.threshold_hours);
  const windowNights = Number(w.parameters.window_nights);
  if (thresholdHrs === undefined || !windowNights) return { fire: false };

  const since = new Date(Date.now() - (windowNights + 1) * 24 * 3_600_000).toISOString();
  // Sleep is stored as duration in seconds (or minutes — varies by source).
  // We assume the iOS bridge writes value in HOURS for sleep records to
  // match the unit field. Re-check when wearable_observations has data.
  const { data: rows } = await admin
    .from("wearable_observations")
    .select("value, start_at, end_at, unit")
    .eq("person_id", w.person_id)
    .eq("hk_type", HK_SLEEP_HOURS)
    .gte("start_at", since)
    .order("start_at", { ascending: true });
  if (!rows || rows.length === 0) return { fire: false };

  // Bucket by night-of-sleep (use end_at's date).
  const byNight: Record<string, number> = {};
  for (const r of rows as Array<{ value: number; end_at: string; unit: string }>) {
    const d = (r.end_at || "").slice(0, 10);
    const hours = (r.unit || "").toLowerCase().startsWith("h")
      ? r.value
      : (r.unit || "").toLowerCase().startsWith("min")
        ? r.value / 60
        : r.value / 3600; // assume seconds
    byNight[d] = (byNight[d] || 0) + hours;
  }
  const sortedNights = Object.entries(byNight).sort(([a], [b]) => a.localeCompare(b));
  const lastN = sortedNights.slice(-windowNights);
  if (lastN.length < windowNights) return { fire: false };
  if (!lastN.every(([_, hrs]) => hrs < thresholdHrs)) return { fire: false };

  const endDate = lastN[lastN.length - 1][0];
  return {
    fire: true,
    dedupKey: `sleep_below:${endDate}:${thresholdHrs}`,
    triggerValue: {
      dedupKey: `sleep_below:${endDate}:${thresholdHrs}`,
      threshold_hours: thresholdHrs,
      nights: lastN.map(([d, h]) => ({ date: d, hours: Math.round(h * 10) / 10 })),
    },
    factualBody: `Sleep was under ${thresholdHrs} hours for ${windowNights} nights in a row. You asked Wellet to notice this.`,
  };
}

// --- refill_gap ---
// Approximation: fires if the medication name appears in `medications` with
// `active=true` and there's been no medication row updated/created for that
// med name in the last (typical_refill_days + grace_days). For v1 we use
// 30 + grace_days as the typical refill window.
async function evalRefillGap(w: Watch): Promise<FireDecision> {
  const medName = String(w.parameters.medication_name || "").trim();
  const grace = Number(w.parameters.grace_days) || 3;
  if (!medName) return { fire: false };

  const cutoff = new Date(Date.now() - (30 + grace) * 24 * 3_600_000).toISOString();
  const { data: meds } = await admin
    .from("medications")
    .select("id, name, created_at, start_date, active")
    .eq("person_id", w.person_id)
    .eq("active", true)
    .ilike("name", `%${medName}%`);
  if (!meds || meds.length === 0) return { fire: false };

  const recent = meds.find((m) => m.created_at && m.created_at > cutoff);
  if (recent) return { fire: false }; // saw a fresh row, no gap

  // Use the most-recent created_at as the "last refill" proxy.
  const last = meds.reduce((acc, m) =>
    !acc || (m.created_at || "") > (acc.created_at || "") ? m : acc, meds[0]);
  if (!last.created_at) return { fire: false };

  const daysSince = Math.floor(
    (Date.now() - new Date(last.created_at).getTime()) / (24 * 3_600_000),
  );
  return {
    fire: true,
    dedupKey: `refill:${last.id}:${new Date().toISOString().slice(0, 10)}`,
    triggerValue: {
      dedupKey: `refill:${last.id}:${new Date().toISOString().slice(0, 10)}`,
      medication: last.name,
      last_seen: last.created_at,
      days_since: daysSince,
    },
    factualBody: `It's been ${daysSince} days since ${last.name} was last seen in their chart. You asked Wellet to notice refill gaps. (Wellet doesn't know whether they actually took it \u2014 only what's on file.)`,
  };
}

// --- pcp_visit_gap ---
async function evalPcpVisitGap(w: Watch): Promise<FireDecision> {
  const months = Number(w.parameters.months) || 6;
  const cutoff = new Date(Date.now() - months * 30 * 24 * 3_600_000).toISOString();

  const { data: visits } = await admin
    .from("health_events")
    .select("id, event_date, title")
    .eq("person_id", w.person_id)
    .eq("event_type", "visit")
    .order("event_date", { ascending: false })
    .limit(1);
  const last = visits && visits[0];
  if (!last) {
    // Never had a visit — fire once a week so we don't spam.
    const weekKey = `pcp:never:${new Date().toISOString().slice(0, 10).slice(0, 7)}`;
    return {
      fire: true,
      dedupKey: weekKey,
      triggerValue: { dedupKey: weekKey, months_threshold: months },
      factualBody: `No primary care visits are on file. You asked Wellet to notice if it's been ${months}+ months.`,
    };
  }

  if ((last.event_date || "") > cutoff) return { fire: false };
  const daysSince = Math.floor(
    (Date.now() - new Date(last.event_date).getTime()) / (24 * 3_600_000),
  );
  const monthlyKey = new Date().toISOString().slice(0, 7); // YYYY-MM
  return {
    fire: true,
    dedupKey: `pcp:gap:${last.id}:${monthlyKey}`,
    triggerValue: {
      dedupKey: `pcp:gap:${last.id}:${monthlyKey}`,
      last_visit: last.event_date,
      days_since: daysSince,
      threshold_months: months,
    },
    factualBody: `It's been ${daysSince} days since the last primary care visit on file. You asked Wellet to notice if it's been ${months}+ months.`,
  };
}

// ---------- Helpers ----------

function bucketDailyAvg(rows: Array<{ value: number; start_at: string }>) {
  const byDay: Record<string, { sum: number; n: number }> = {};
  for (const r of rows) {
    const d = (r.start_at || "").slice(0, 10);
    if (!byDay[d]) byDay[d] = { sum: 0, n: 0 };
    byDay[d].sum += Number(r.value);
    byDay[d].n += 1;
  }
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, avg: Math.round((v.sum / v.n) * 10) / 10 }));
}

function bucketDailySum(rows: Array<{ value: number; start_at: string }>) {
  const byDay: Record<string, number> = {};
  for (const r of rows) {
    const d = (r.start_at || "").slice(0, 10);
    byDay[d] = (byDay[d] || 0) + Number(r.value);
  }
  return Object.entries(byDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, sum]) => ({ date, avg: Math.round(sum) })); // 'avg' = sum here
}

function lastNDays<T extends { date: string }>(arr: T[], n: number): T[] {
  return arr.slice(-n);
}

// ---------- Notification delivery ----------

async function fireWatch(w: Watch, decision: FireDecision): Promise<"sent" | "suppressed" | "failed"> {
  // Insert fire row first as 'queued', then update after delivery.
  // Persist factualBody inside trigger_value so the Living Timeline card has a
  // ready-made human-readable body without re-running the rule. Mirrors what we
  // send by email.
  const tv: Record<string, unknown> = {
    ...(decision.triggerValue || {}),
  };
  if (decision.factualBody && tv.summary === undefined) {
    tv.summary = decision.factualBody;
  }
  const { data: fireRow, error: fireErr } = await admin
    .from("care_signal_watch_fires")
    .insert({
      watch_id: w.id,
      trigger_value: tv,
      notification_status: "queued",
      notification_channel: "email",
    })
    .select("id")
    .single();
  if (fireErr || !fireRow) {
    console.error("[evaluator] could not insert fire row", w.id, fireErr);
    return "failed";
  }

  const userPrefs = await loadUserPrefs(w.user_id);
  if (!userPrefs) return await markFire(fireRow.id, "failed", null, "could not load user prefs");

  // Quiet hours check
  if (userPrefs.quiet_hours_enabled && isInQuietHours(userPrefs)) {
    await markFire(fireRow.id, "suppressed_quiet_hours", null);
    return "suppressed";
  }

  const personName = await loadPersonName(w.person_id);
  const subject = `Wellet · ${personName} \u00b7 something you asked to notice`;
  const html = renderEmailHtml({
    personName,
    body: decision.factualBody || w.description,
    description: w.description,
    watchId: w.id,
  });
  const textBody = renderEmailText({
    personName,
    body: decision.factualBody || w.description,
    description: w.description,
  });

  if (!SMTP_USER || !SMTP_PASS) {
    return await markFire(fireRow.id, "failed", null, "SMTP not configured");
  }

  try {
    const client = new SMTPClient({
      connection: {
        hostname: SMTP_HOST,
        port: SMTP_PORT,
        tls: true,
        auth: { username: SMTP_USER, password: SMTP_PASS },
      },
    });
    await client.send({
      from: FROM_ADDRESS,
      to: userPrefs.email,
      subject,
      content: textBody,
      html,
    });
    await client.close();

    await markFire(fireRow.id, "sent", "email");
    // Bump watch counters
    await admin
      .from("care_signal_watches")
      .update({
        last_fired_at: new Date().toISOString(),
        fire_count: await getNextFireCount(w.id),
      })
      .eq("id", w.id);
    return "sent";
  } catch (e) {
    return await markFire(fireRow.id, "failed", "email", String(e));
  }
}

async function markFire(
  fireId: string,
  status: string,
  channel: string | null,
  error?: string | null,
): Promise<"sent" | "suppressed" | "failed"> {
  await admin
    .from("care_signal_watch_fires")
    .update({
      notification_status: status,
      notification_channel: channel,
      notification_sent_at: status === "sent" ? new Date().toISOString() : null,
      error: error || null,
    })
    .eq("id", fireId);
  return status === "sent" ? "sent" : status === "suppressed_quiet_hours" ? "suppressed" : "failed";
}

async function getNextFireCount(watchId: string): Promise<number> {
  const { data } = await admin
    .from("care_signal_watches")
    .select("fire_count")
    .eq("id", watchId)
    .single();
  return ((data?.fire_count as number) || 0) + 1;
}

async function loadUserPrefs(userId: string): Promise<UserPrefs | null> {
  const { data: auser } = await admin.auth.admin.getUserById(userId);
  if (!auser?.user?.email) return null;
  const { data: prefs } = await admin
    .from("notification_preferences")
    .select("quiet_hours_enabled, quiet_hours_start, quiet_hours_end")
    .eq("user_id", userId)
    .maybeSingle();
  return {
    email: auser.user.email,
    quiet_hours_enabled: prefs?.quiet_hours_enabled ?? false,
    quiet_start: (prefs?.quiet_hours_start as string) || "22:00",
    quiet_end: (prefs?.quiet_hours_end as string) || "07:00",
    // Future: pull user.timezone if/when we capture it. v1 uses UTC.
    timezone: null,
  };
}

async function loadPersonName(personId: string): Promise<string> {
  const { data } = await admin
    .from("people")
    .select("name")
    .eq("id", personId)
    .maybeSingle();
  return (data?.name as string) || "your loved one";
}

function isInQuietHours(prefs: UserPrefs): boolean {
  // v1: UTC comparison. Once we capture user timezone we'll convert. The
  // user's quiet hours are stored as "HH:MM" strings.
  const now = new Date();
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes();
  const [sH, sM] = prefs.quiet_start.split(":").map(Number);
  const [eH, eM] = prefs.quiet_end.split(":").map(Number);
  const start = sH * 60 + sM;
  const end = eH * 60 + eM;
  if (start === end) return false;
  if (start < end) return cur >= start && cur < end;
  // overnight wrap
  return cur >= start || cur < end;
}

// ---------- Email templates ----------
// Always factual. No interpretation. Always include "you asked me to notice
// this" + a stop-watching link.

function esc(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderEmailHtml({ personName, body, description, watchId }: {
  personName: string;
  body: string;
  description: string;
  watchId: string;
}): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:white;border-radius:16px;padding:32px 28px;">
      <div style="font-family:'DM Serif Display',Georgia,serif;font-size:22px;color:#608F7C;margin-bottom:8px;">Wellet</div>
      <div style="font-size:12px;color:#888;margin-bottom:22px;">Something you asked to notice \u00b7 ${esc(personName)}</div>
      <p style="font-size:16px;line-height:1.6;color:#333;margin:0 0 18px;">${esc(body)}</p>
      <div style="background:#F7F5F0;border-radius:10px;padding:12px 16px;margin:18px 0;font-size:13px;color:#6B6560;">
        Your watch: <em>${esc(description)}</em>
      </div>
      <p style="font-size:13px;color:#6B6560;line-height:1.6;margin:12px 0;">
        Wellet doesn't interpret what this means clinically. If anything's worrying you, the care team is the right place to ask.
      </p>
      <div style="margin-top:24px;">
        <a href="https://mywellet.com" style="display:inline-block;background:#608F7C;color:white;padding:10px 18px;border-radius:8px;text-decoration:none;font-size:14px;">Open Wellet</a>
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <div style="font-size:11px;color:#999;text-align:center;line-height:1.6;">
        You're receiving this because you asked Wellet to notice this.<br>
        <a href="https://mywellet.com/#settings/watches" style="color:#608F7C;text-decoration:none;">Manage your watches</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}

function renderEmailText({ personName, body, description }: {
  personName: string;
  body: string;
  description: string;
}): string {
  return `WELLET \u00b7 SOMETHING YOU ASKED TO NOTICE \u00b7 ${personName}

${body}

Your watch: ${description}

Wellet doesn't interpret what this means clinically. If anything's worrying you, the care team is the right place to ask.

Open Wellet: https://mywellet.com
Manage your watches: https://mywellet.com/#settings/watches`;
}
