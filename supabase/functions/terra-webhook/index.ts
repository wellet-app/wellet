/**
 * terra-webhook — receives health data pushes from Terra API.
 *
 * Terra calls this endpoint directly (no user JWT).
 * Authentication is via HMAC-SHA256 signature in the `terra-signature` header.
 *
 * Payload types handled:
 *   - activity: steps, distance, calories, exercise time → health_events
 *   - body: weight, body fat, height → vitals
 *   - daily: resting HR, HRV, SpO2, steps summary → vitals + health_events
 *   - sleep: sleep stages, duration → health_events
 *   - auth events: user_auth, deauth → terra_connections status updates
 *
 * All data is mapped to Wellet's existing vitals + health_events tables
 * with source='terra' and ehr_system='terra_{provider}'.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const encoder = new TextEncoder();

// ── HMAC Verification ───────────────────────────────────────────────────────

async function verifyTerraSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader || !secret) return false;

  // Parse header: t=<timestamp>,v1=<signature>
  const parts: Record<string, string> = {};
  for (const pair of signatureHeader.split(",")) {
    const [key, val] = pair.split("=", 2);
    if (key && val) parts[key.trim()] = val.trim();
  }

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Check timestamp freshness (5 minute tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  // Compute expected HMAC
  const signedPayload = timestamp + "." + rawBody;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ── Unit Conversions ────────────────────────────────────────────────────────

function kgToLb(kg: number): number {
  return Math.round(kg * 2.20462 * 10) / 10;
}

function metersToMi(m: number): number {
  return Math.round((m / 1609.344) * 10) / 10;
}

function secondsToHm(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return h + "h " + m + "m";
  return m + " min";
}

// ── Data Mapping ────────────────────────────────────────────────────────────

interface VitalRow {
  person_id: string;
  vital_type: string;
  value: string;
  unit: string;
  effective_date: string;
  loinc_code: string | null;
  source: string;
  export_job_id: null;
}

interface EventRow {
  person_id: string;
  event_type: string;
  title: string;
  event_date: string;
  source: string;
  ehr_system: string;
  export_job_id: null;
}

function mapDailyData(
  data: Record<string, unknown>,
  personId: string,
  provider: string,
): { vitals: VitalRow[]; events: EventRow[] } {
  const vitals: VitalRow[] = [];
  const events: EventRow[] = [];
  const date = (data.metadata as Record<string, string>)?.start_time ||
    new Date().toISOString();
  const ehrSystem = "terra_" + provider;

  // Heart rate
  const hrData = data.heart_rate_data as Record<string, unknown> | undefined;
  if (hrData) {
    const summary = hrData.summary as Record<string, number> | undefined;
    if (summary?.avg_hr_bpm) {
      vitals.push({
        person_id: personId,
        vital_type: "Heart Rate",
        value: String(Math.round(summary.avg_hr_bpm)),
        unit: "bpm",
        effective_date: date,
        loinc_code: "8867-4",
        source: "terra",
        export_job_id: null,
      });
    }
    if (summary?.resting_hr_bpm) {
      vitals.push({
        person_id: personId,
        vital_type: "Resting Heart Rate",
        value: String(Math.round(summary.resting_hr_bpm)),
        unit: "bpm",
        effective_date: date,
        loinc_code: "40443-4",
        source: "terra",
        export_job_id: null,
      });
    }
  }

  // HRV
  const hrvData = data.heart_rate_variability_data as Record<string, unknown> | undefined;
  if (hrvData) {
    const hrvSummary = hrvData.summary as Record<string, number> | undefined;
    if (hrvSummary?.avg_hrv_sdnn) {
      vitals.push({
        person_id: personId,
        vital_type: "HRV (SDNN)",
        value: String(Math.round(hrvSummary.avg_hrv_sdnn)),
        unit: "ms",
        effective_date: date,
        loinc_code: null,
        source: "terra",
        export_job_id: null,
      });
    }
  }

  // SpO2
  const oxyData = data.oxygen_data as Record<string, unknown> | undefined;
  if (oxyData) {
    const avgSat = (oxyData as Record<string, number>).avg_saturation_percentage;
    if (avgSat && avgSat > 0) {
      vitals.push({
        person_id: personId,
        vital_type: "SpO2",
        value: String(Math.round(avgSat)),
        unit: "%",
        effective_date: date,
        loinc_code: "2708-6",
        source: "terra",
        export_job_id: null,
      });
    }
  }

  // Steps
  const steps = data.steps as number | undefined;
  if (steps && steps > 0) {
    events.push({
      person_id: personId,
      event_type: "activity",
      title: "Steps: " + Math.round(steps) + " steps",
      event_date: date,
      source: "terra",
      ehr_system: ehrSystem,
      export_job_id: null,
    });
  }

  // Distance
  const distData = data.distance_data as Record<string, unknown> | undefined;
  if (distData) {
    const distSummary = distData.summary as Record<string, number> | undefined;
    const meters = distSummary?.distance_meters;
    if (meters && meters > 0) {
      events.push({
        person_id: personId,
        event_type: "activity",
        title: "Distance: " + metersToMi(meters) + " mi",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }
  }

  // Calories
  const calData = data.calories_data as Record<string, unknown> | undefined;
  if (calData) {
    const netCal = (calData as Record<string, number>).net_activity_calories;
    if (netCal && netCal > 0) {
      events.push({
        person_id: personId,
        event_type: "activity",
        title: "Active Calories: " + Math.round(netCal) + " kcal",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }
  }

  return { vitals, events };
}

function mapBodyData(
  data: Record<string, unknown>,
  personId: string,
  _provider: string,
): { vitals: VitalRow[] } {
  const vitals: VitalRow[] = [];
  const date = (data.metadata as Record<string, string>)?.start_time ||
    new Date().toISOString();

  const weightKg = data.weight_kg as number | undefined;
  if (weightKg && weightKg > 0) {
    vitals.push({
      person_id: personId,
      vital_type: "Weight",
      value: String(kgToLb(weightKg)),
      unit: "lb",
      effective_date: date,
      loinc_code: "29463-7",
      source: "terra",
      export_job_id: null,
    });
  }

  return { vitals };
}

function mapSleepData(
  data: Record<string, unknown>,
  personId: string,
  provider: string,
): { events: EventRow[] } {
  const events: EventRow[] = [];
  const date = (data.metadata as Record<string, string>)?.start_time ||
    new Date().toISOString();
  const ehrSystem = "terra_" + provider;

  // Total sleep duration
  const sleepDurations = data.sleep_durations_data as Record<string, unknown> | undefined;
  if (sleepDurations) {
    const asleep = sleepDurations.asleep as Record<string, number> | undefined;
    const other = sleepDurations.other as Record<string, number> | undefined;

    // Total duration
    const totalSeconds = (asleep?.duration_asleep_state_seconds || 0) +
      (asleep?.duration_deep_sleep_state_seconds || 0) +
      (asleep?.duration_REM_sleep_state_seconds || 0) +
      (asleep?.duration_light_sleep_state_seconds || 0);

    if (totalSeconds > 0) {
      events.push({
        person_id: personId,
        event_type: "sleep",
        title: "Sleep (" + secondsToHm(totalSeconds) + ")",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }

    // Individual stages
    if (asleep?.duration_deep_sleep_state_seconds && asleep.duration_deep_sleep_state_seconds > 0) {
      events.push({
        person_id: personId,
        event_type: "sleep",
        title: "Deep Sleep (" + secondsToHm(asleep.duration_deep_sleep_state_seconds) + ")",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }
    if (asleep?.duration_REM_sleep_state_seconds && asleep.duration_REM_sleep_state_seconds > 0) {
      events.push({
        person_id: personId,
        event_type: "sleep",
        title: "REM Sleep (" + secondsToHm(asleep.duration_REM_sleep_state_seconds) + ")",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }

    // Awake time
    if (other?.duration_awake_state_seconds && other.duration_awake_state_seconds > 0) {
      events.push({
        person_id: personId,
        event_type: "sleep",
        title: "Awake (" + secondsToHm(other.duration_awake_state_seconds) + ")",
        event_date: date,
        source: "terra",
        ehr_system: ehrSystem,
        export_job_id: null,
      });
    }
  }

  return { events };
}

function mapActivityData(
  data: Record<string, unknown>,
  personId: string,
  provider: string,
): { vitals: VitalRow[]; events: EventRow[] } {
  const vitals: VitalRow[] = [];
  const events: EventRow[] = [];
  const metadata = data.metadata as Record<string, string> | undefined;
  const date = metadata?.start_time || new Date().toISOString();
  const ehrSystem = "terra_" + provider;
  const activityName = metadata?.name || "Workout";

  // Duration
  const activeDurations = data.active_durations_data as Record<string, number> | undefined;
  const activitySeconds = activeDurations?.activity_seconds || 0;
  const durationStr = activitySeconds > 0 ? " (" + secondsToHm(activitySeconds) + ")" : "";

  // Calories
  const calData = data.calories_data as Record<string, number> | undefined;
  const calories = calData?.net_activity_calories || 0;
  const calStr = calories > 0 ? " · " + Math.round(calories) + " kcal" : "";

  // Distance
  const distData = data.distance_data as Record<string, unknown> | undefined;
  const distSummary = distData?.summary as Record<string, number> | undefined;
  const meters = distSummary?.distance_meters || 0;
  const distStr = meters > 0 ? " · " + metersToMi(meters) + " mi" : "";

  events.push({
    person_id: personId,
    event_type: "workout",
    title: activityName + durationStr + calStr + distStr,
    event_date: date,
    source: "terra",
    ehr_system: ehrSystem,
    export_job_id: null,
  });

  // Heart rate during workout
  const hrData = data.heart_rate_data as Record<string, unknown> | undefined;
  if (hrData) {
    const hrSummary = hrData.summary as Record<string, number> | undefined;
    if (hrSummary?.avg_hr_bpm) {
      vitals.push({
        person_id: personId,
        vital_type: "Heart Rate",
        value: String(Math.round(hrSummary.avg_hr_bpm)),
        unit: "bpm",
        effective_date: date,
        loinc_code: "8867-4",
        source: "terra",
        export_job_id: null,
      });
    }
  }

  return { vitals, events };
}

// ── Main Handler ────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "terra-signature, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const webhookSecret = Deno.env.get("TERRA_WEBHOOK_SECRET");
  if (!webhookSecret) {
    console.error("TERRA_WEBHOOK_SECRET not configured");
    return new Response(JSON.stringify({ error: "Server misconfigured" }), { status: 500 });
  }

  // Read raw body for HMAC verification
  const rawBody = await req.text();

  // Verify HMAC signature
  const sigHeader = req.headers.get("terra-signature") || "";
  const verified = await verifyTerraSignature(rawBody, sigHeader, webhookSecret);
  if (!verified) {
    console.warn("Terra webhook: HMAC verification failed");
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const payloadType = payload.type as string;

  // ── Auth events ─────────────────────────────────────────────────────────
  if (payloadType === "user_reauth") {
    // User reconnected — update status
    const terraUserId = (payload.user as Record<string, string>)?.user_id;
    if (terraUserId) {
      await db
        .from("terra_connections")
        .update({ status: "active", disconnected_at: null })
        .eq("terra_user_id", terraUserId);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  if (payloadType === "deauth" || payloadType === "auth_revoked") {
    const terraUserId = (payload.user as Record<string, string>)?.user_id;
    if (terraUserId) {
      await db
        .from("terra_connections")
        .update({ status: "disconnected", disconnected_at: new Date().toISOString() })
        .eq("terra_user_id", terraUserId);
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  // ── Data events ─────────────────────────────────────────────────────────
  // Look up connection to find person_id
  const user = payload.user as Record<string, string> | undefined;
  const terraUserId = user?.user_id;
  const provider = user?.provider || "unknown";

  if (!terraUserId) {
    console.warn("Terra webhook: no user_id in payload");
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  const { data: conn } = await db
    .from("terra_connections")
    .select("person_id")
    .eq("terra_user_id", terraUserId)
    .eq("status", "active")
    .single();

  if (!conn) {
    console.warn("Terra webhook: no active connection for terra_user_id=" + terraUserId);
    return new Response(JSON.stringify({ success: true }), { status: 200 });
  }

  const personId = conn.person_id;
  let allVitals: VitalRow[] = [];
  let allEvents: EventRow[] = [];

  // Process data array (Terra sends array of data objects)
  const dataArray = (payload.data || []) as Record<string, unknown>[];
  for (const item of dataArray) {
    if (payloadType === "daily" || payloadType === "daily_summary") {
      const result = mapDailyData(item, personId, provider);
      allVitals.push(...result.vitals);
      allEvents.push(...result.events);
    } else if (payloadType === "body") {
      const result = mapBodyData(item, personId, provider);
      allVitals.push(...result.vitals);
    } else if (payloadType === "sleep") {
      const result = mapSleepData(item, personId, provider);
      allEvents.push(...result.events);
    } else if (payloadType === "activity" || payloadType === "workout") {
      const result = mapActivityData(item, personId, provider);
      allVitals.push(...result.vitals);
      allEvents.push(...result.events);
    }
  }

  // Batch insert vitals
  if (allVitals.length > 0) {
    const { error: vErr } = await db.from("vitals").insert(allVitals);
    if (vErr) console.error("Terra webhook: vitals insert error:", vErr.message);
  }

  // Batch insert health events
  if (allEvents.length > 0) {
    const { error: eErr } = await db.from("health_events").insert(allEvents);
    if (eErr) console.error("Terra webhook: health_events insert error:", eErr.message);
  }

  // Update last_data_at on the connection
  await db
    .from("terra_connections")
    .update({ last_data_at: new Date().toISOString() })
    .eq("terra_user_id", terraUserId);

  console.log(
    `Terra webhook: ${payloadType} for ${provider} user=${terraUserId} → ${allVitals.length} vitals, ${allEvents.length} events`,
  );

  return new Response(
    JSON.stringify({
      success: true,
      vitals_stored: allVitals.length,
      events_stored: allEvents.length,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
