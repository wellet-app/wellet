// fire-medication-reminders
// ----------------------------------------------------------------------------
// Service-role-only edge function. Triggered every 1 minute by pg_cron.
// Walks every active medication_reminder and decides whether to fire for the
// current minute window. On fire, fans out to every accepted circle member via
// push (placeholder — APNs integration is Phase 7.1) and SMS (Twilio).
//
// Auth: Authorization header MUST be `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`.
//       (verify_jwt: false at the gateway; we re-check the bearer here.)
//
// Reminder schema:
//   medication_reminders.reminder_times jsonb — array of "HH:MM" strings, e.g.
//     ["08:00", "20:00"]. Times are interpreted in the loved one's local zone,
//     which we read off people.timezone (falls back to America/New_York).
//   medication_reminders.active boolean — false means skip.
//
// What this function does each minute:
//   1. Pull all active reminders + their medication + person.
//   2. For each (reminder, time-string) pair, compute today's scheduled UTC
//      timestamp in the person's timezone. If it falls inside the current
//      minute window [now - 30s, now + 30s), it's a candidate to fire.
//   3. Try to INSERT into reminder_fired_events with (reminder_id,
//      scheduled_for, escalated=false). UNIQUE constraint makes this
//      idempotent — if the row already exists, we silently skip.
//   4. If the insert succeeded, fan out to every accepted circle member
//      (push + SMS).
//   5. Separately, run a missed-dose escalation pass: for every fired event
//      ~30 minutes old where no medication_log row exists in the window
//      [scheduled_for - 5m, now], INSERT a second fired_events row with
//      escalated=true and re-fan-out with escalated copy.
//
// What this function will NOT do:
//   - Send during quiet hours (v1: not honored; Phase 7.1 will add this).
//   - Refire if the cron double-runs (UNIQUE constraint catches it).
//   - Push to APNs in v1 — we use Supabase Realtime + in-app for now and
//     rely on SMS for the loud channel. APNs is Phase 7.1.
//   - Decide clinical facts. It only sends what the reminder schedule says.
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_MESSAGING_SERVICE_SID =
  Deno.env.get("TWILIO_MESSAGING_SERVICE_SID") || "";

const ESCALATION_MINUTES = 30; // Phase 7 v1 global default
const WINDOW_HALF_WIDTH_MS = 30 * 1000; // ±30s around "now"

// E.164 validation matching twilio-send-sms.
function normalizeE164(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null;
  return trimmed;
}

// Compute today's scheduled UTC instant for an "HH:MM" in a given IANA zone.
// Returns null on malformed input.
function scheduledUtcForLocalTime(
  hhmm: string,
  zone: string,
  nowUtc: Date,
): Date | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;

  // Determine the local Y/M/D in the target zone for "now".
  // Intl gives us the parts; we reconstruct a UTC instant by trial: start
  // with the naive UTC equivalent, then correct for zone offset at that
  // instant. Two iterations is enough for any IANA zone (DST corner cases
  // included).
  const localParts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(nowUtc);
  const yyyy = Number(localParts.find((p) => p.type === "year")?.value);
  const mm = Number(localParts.find((p) => p.type === "month")?.value);
  const dd = Number(localParts.find((p) => p.type === "day")?.value);
  if (!yyyy || !mm || !dd) return null;

  let guess = new Date(
    Date.UTC(yyyy, mm - 1, dd, hour, minute, 0, 0),
  );
  for (let i = 0; i < 2; i++) {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(guess);
    const gh = Number(fmt.find((p) => p.type === "hour")?.value);
    const gm = Number(fmt.find((p) => p.type === "minute")?.value);
    const diffMin = (hour - gh) * 60 + (minute - gm);
    if (diffMin === 0) break;
    guess = new Date(guess.getTime() + diffMin * 60 * 1000);
  }
  return guess;
}

// Format a friendly time like "8:00 AM" in a zone.
function fmtLocalTime(d: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
}

async function sendSms(to: string, body: string): Promise<{ ok: boolean; error?: string }> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_MESSAGING_SERVICE_SID) {
    return { ok: false, error: "twilio env missing" };
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const form = new URLSearchParams({
    To: to,
    MessagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
    Body: body,
  });
  const auth = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      return { ok: false, error: `twilio ${res.status}: ${txt.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// Compose the SMS body. Voice rule (Wellet COO): never "alert" or "monitor".
// Use "due" or "hasn't been logged."
function composeBody(opts: {
  medName: string;
  dose: string | null;
  personName: string;
  localTimeStr: string;
  escalated: boolean;
}): string {
  const dose = opts.dose ? ` ${opts.dose}` : "";
  if (opts.escalated) {
    return `Wellet · ${opts.personName}'s ${opts.medName}${dose} hasn't been logged yet (due ${opts.localTimeStr}). Log it: https://app.getwellet.com/meds`;
  }
  return `Wellet · ${opts.personName}'s ${opts.medName}${dose} is due at ${opts.localTimeStr}. Log it when done: https://app.getwellet.com/meds`;
}

interface CircleRecipient {
  user_id: string | null;
  member_name: string;
  phone: string | null;
  email: string | null;
}

async function loadCircleRecipients(
  supabase: any,
  personId: string,
): Promise<CircleRecipient[]> {
  // Accepted members.
  const { data: members, error } = await supabase
    .from("care_circle_members")
    .select("user_id, member_name, phone, email, status, invite_status")
    .eq("person_id", personId);
  if (error) {
    console.error("loadCircleRecipients members", error);
    return [];
  }
  const accepted = (members || []).filter((m: any) => {
    // Accept either explicit "accepted" or legacy invite_status='accepted'.
    return m.status === "accepted" || m.invite_status === "accepted";
  });
  // Also include the person's owner (people.user_id) — they're always in the circle.
  const { data: personRow } = await supabase
    .from("people")
    .select("user_id")
    .eq("id", personId)
    .maybeSingle();
  const ownerUserId = (personRow as any)?.user_id || null;
  let ownerRow: CircleRecipient | null = null;
  if (ownerUserId) {
    const { data: ownerAuth } = await supabase
      .from("auth.users" as any)
      .select("id, email, phone")
      .eq("id", ownerUserId)
      .maybeSingle()
      .then((r: any) => r, () => ({ data: null }));
    ownerRow = {
      user_id: ownerUserId,
      member_name: (ownerAuth as any)?.email?.split("@")?.[0] || "You",
      phone: (ownerAuth as any)?.phone || null,
      email: (ownerAuth as any)?.email || null,
    };
  }
  const out: CircleRecipient[] = accepted.map((m: any) => ({
    user_id: m.user_id || null,
    member_name: m.member_name || "Caregiver",
    phone: m.phone || null,
    email: m.email || null,
  }));
  if (ownerRow && !out.some((r) => r.user_id === ownerRow!.user_id)) {
    out.push(ownerRow);
  }
  return out;
}

interface ActiveReminder {
  id: string;
  user_id: string;
  person_id: string;
  medication_id: string;
  reminder_times: string[];
}

interface MedRow {
  id: string;
  name: string;
  dose: string | null;
}

interface PersonRow {
  id: string;
  user_id: string | null;
  timezone: string | null;
  first_name: string | null;
  nickname: string | null;
}

// We use `any` for the client type. The @supabase/supabase-js esm.sh build
// declares table names as `never` without a generated Database type, which
// flags every legitimate insert/update at type-check time. Runtime is fine.
async function firingPass(
  supabase: any,
  nowUtc: Date,
): Promise<{ fired: number; skipped_idempotent: number; errors: string[] }> {
  const errors: string[] = [];
  let fired = 0;
  let skipped = 0;

  const { data: reminders, error } = await supabase
    .from("medication_reminders")
    .select("id, user_id, person_id, medication_id, reminder_times, active")
    .eq("active", true);
  if (error) {
    errors.push("reminders fetch: " + error.message);
    return { fired, skipped_idempotent: skipped, errors };
  }

  if (!reminders || reminders.length === 0) {
    return { fired, skipped_idempotent: skipped, errors };
  }

  // Batch fetch meds and people.
  const medIds = Array.from(new Set(reminders.map((r: any) => r.medication_id).filter(Boolean)));
  const personIds = Array.from(new Set(reminders.map((r: any) => r.person_id).filter(Boolean)));
  const { data: meds } = await supabase
    .from("medications")
    .select("id, name, dose")
    .in("id", medIds);
  const { data: people } = await supabase
    .from("people")
    .select("id, user_id, timezone, first_name, nickname")
    .in("id", personIds);
  const medById = new Map<string, MedRow>((meds || []).map((m: any) => [m.id, m]));
  const personById = new Map<string, PersonRow>((people || []).map((p: any) => [p.id, p]));

  for (const r of reminders as ActiveReminder[]) {
    const med = medById.get(r.medication_id);
    const person = personById.get(r.person_id);
    if (!med || !person) continue;
    const zone = person.timezone || "America/New_York";
    const personName = person.nickname || person.first_name || "your loved one";
    const times: string[] = Array.isArray(r.reminder_times)
      ? r.reminder_times
      : [];

    for (const t of times) {
      const sched = scheduledUtcForLocalTime(t, zone, nowUtc);
      if (!sched) continue;
      const diffMs = sched.getTime() - nowUtc.getTime();
      if (Math.abs(diffMs) > WINDOW_HALF_WIDTH_MS) continue;

      // Try to claim this firing.
      const { error: insErr } = await supabase
        .from("reminder_fired_events")
        .insert({
          reminder_id: r.id,
          medication_id: r.medication_id,
          person_id: r.person_id,
          scheduled_for: sched.toISOString(),
          escalated: false,
        });
      if (insErr) {
        // Unique violation = already fired this minute → silent skip.
        if ((insErr as any).code === "23505") {
          skipped++;
          continue;
        }
        errors.push(`fired_events insert: ${insErr.message}`);
        continue;
      }

      // Fan out.
      const recipients = await loadCircleRecipients(supabase, r.person_id);
      const localTimeStr = fmtLocalTime(sched, zone);
      const body = composeBody({
        medName: med.name,
        dose: med.dose,
        personName,
        localTimeStr,
        escalated: false,
      });
      let smsCount = 0;
      for (const rec of recipients) {
        const phone = normalizeE164(rec.phone);
        if (!phone) continue;
        const res = await sendSms(phone, body);
        if (res.ok) smsCount++;
        else errors.push(`sms to ${phone.slice(0, 6)}…: ${res.error}`);
      }
      await supabase
        .from("reminder_fired_events")
        .update({
          recipients_count: recipients.length,
          channels: { sms: smsCount, push: 0 },
        })
        .eq("reminder_id", r.id)
        .eq("scheduled_for", sched.toISOString())
        .eq("escalated", false);
      fired++;
    }
  }
  return { fired, skipped_idempotent: skipped, errors };
}

async function escalationPass(
  supabase: any,
  nowUtc: Date,
): Promise<{ escalated: number; errors: string[] }> {
  const errors: string[] = [];
  let escalated = 0;

  // Window: fired events that are ~30 minutes old and haven't been escalated.
  const windowEnd = new Date(nowUtc.getTime() - (ESCALATION_MINUTES - 1) * 60 * 1000);
  const windowStart = new Date(nowUtc.getTime() - (ESCALATION_MINUTES + 1) * 60 * 1000);

  const { data: candidates, error } = await supabase
    .from("reminder_fired_events")
    .select("id, reminder_id, medication_id, person_id, scheduled_for")
    .eq("escalated", false)
    .gte("scheduled_for", windowStart.toISOString())
    .lte("scheduled_for", windowEnd.toISOString());
  if (error) {
    errors.push("escalation candidates: " + error.message);
    return { escalated, errors };
  }
  if (!candidates || candidates.length === 0) {
    return { escalated, errors };
  }

  for (const c of candidates as any[]) {
    // Did anyone log a dose for this medication in the window
    // [scheduled_for - 5m, now]?
    const logStart = new Date(new Date(c.scheduled_for).getTime() - 5 * 60 * 1000);
    const { data: logs, error: logErr } = await supabase
      .from("medication_logs")
      .select("id")
      .eq("medication_id", c.medication_id)
      .gte("taken_at", logStart.toISOString())
      .lte("taken_at", nowUtc.toISOString())
      .limit(1);
    if (logErr) {
      errors.push("log lookup: " + logErr.message);
      continue;
    }
    if (logs && logs.length > 0) continue; // dose was logged → no escalation

    // Try to claim the escalation firing.
    const { error: insErr } = await supabase
      .from("reminder_fired_events")
      .insert({
        reminder_id: c.reminder_id,
        medication_id: c.medication_id,
        person_id: c.person_id,
        scheduled_for: c.scheduled_for,
        escalated: true,
      });
    if (insErr) {
      if ((insErr as any).code === "23505") continue; // already escalated
      errors.push("escalation insert: " + insErr.message);
      continue;
    }

    // Need med + person for body composition.
    const { data: med } = await supabase
      .from("medications")
      .select("id, name, dose")
      .eq("id", c.medication_id)
      .maybeSingle();
    const { data: person } = await supabase
      .from("people")
      .select("id, user_id, timezone, first_name, nickname")
      .eq("id", c.person_id)
      .maybeSingle();
    if (!med || !person) continue;
    const zone = (person as any).timezone || "America/New_York";
    const personName =
      (person as any).nickname || (person as any).first_name || "your loved one";
    const localTimeStr = fmtLocalTime(new Date(c.scheduled_for), zone);
    const body = composeBody({
      medName: (med as any).name,
      dose: (med as any).dose,
      personName,
      localTimeStr,
      escalated: true,
    });

    const recipients = await loadCircleRecipients(supabase, c.person_id);
    let smsCount = 0;
    for (const rec of recipients) {
      const phone = normalizeE164(rec.phone);
      if (!phone) continue;
      const res = await sendSms(phone, body);
      if (res.ok) smsCount++;
      else errors.push(`escalation sms: ${res.error}`);
    }
    await supabase
      .from("reminder_fired_events")
      .update({
        recipients_count: recipients.length,
        channels: { sms: smsCount, push: 0 },
      })
      .eq("reminder_id", c.reminder_id)
      .eq("scheduled_for", c.scheduled_for)
      .eq("escalated", true);
    escalated++;
  }
  return { escalated, errors };
}

Deno.serve(async (req) => {
  // Service-role-only.
  const auth = req.headers.get("Authorization") || "";
  if (auth !== `Bearer ${SERVICE_ROLE}`) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const nowUtc = new Date();
  const firing = await firingPass(supabase, nowUtc);
  const esc = await escalationPass(supabase, nowUtc);

  return new Response(
    JSON.stringify({
      now: nowUtc.toISOString(),
      fired: firing.fired,
      skipped_idempotent: firing.skipped_idempotent,
      escalated: esc.escalated,
      errors: [...firing.errors, ...esc.errors].slice(0, 20),
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    },
  );
});
