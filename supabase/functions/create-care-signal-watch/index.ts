// create-care-signal-watch
// ----------------------------------------------------------------------------
// Creates a Care Signals "Notify me" watch for the calling user.
//
// Auth: user JWT (verify_jwt: false at the gateway because Supabase's new
// asymmetric JWTs trip the HS256 verifier; we re-validate via anonClient).
//
// Body shape:
//   {
//     person_id: uuid,                 // required, must belong to caller
//     watch_type: <enum>,              // see ALLOWED_TYPES below
//     parameters: {...},               // type-specific, validated below
//     description: string,             // plain-language echo, max 200 chars
//     created_via?: 'ask_wellet' | 'onboarding_default' | 'suggestion'
//   }
//
// What this function will NOT do:
//   - Create watches on lab values, medication doses, or diagnoses
//   - Pick default thresholds for the user
//   - Allow free-form watch_type values
// ----------------------------------------------------------------------------

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// Mirrors the SQL CHECK constraint. Behaviors + wearables only at launch.
const ALLOWED_TYPES = new Set([
  "resting_hr_sustained_above",
  "resting_hr_above_baseline",
  "daily_steps_below",
  "sleep_duration_below",
  "wearable_silence",
  "refill_gap",
  "pcp_visit_gap",
  "new_care_team_member",
  "new_record_arrived",
  "appointment_changed",
]);

// v1 cutoff: types where the underlying data table doesn't exist yet. The
// SQL enum still allows them so we don't have to migrate when those features
// land — we just refuse new watches at the API layer until then.
const NOT_YET_AVAILABLE_TYPES = new Set([
  "appointment_changed",     // no appointments table yet
  "new_care_team_member",    // no care_team table yet
]);

const ALLOWED_CREATED_VIA = new Set([
  "ask_wellet",
  "onboarding_default",
  "suggestion",
]);

// Soft cap to keep the evaluator bounded. Per (user, person).
const MAX_WATCHES_PER_PERSON = 20;

interface ValidationResult {
  ok: boolean;
  error?: string;
  cleanParams?: Record<string, unknown>;
}

// ---------- Per-type parameter validators ----------
// Each validator returns a CLEANED parameters object. We never trust the
// client's shape verbatim — only the keys we expect get through.

function validateParams(watchType: string, raw: unknown): ValidationResult {
  const p = (raw && typeof raw === "object") ? raw as Record<string, unknown> : {};
  const num = (k: string) => typeof p[k] === "number" && Number.isFinite(p[k] as number) ? (p[k] as number) : null;
  const str = (k: string) => typeof p[k] === "string" ? (p[k] as string).slice(0, 200) : null;
  const arr = (k: string) => Array.isArray(p[k]) ? (p[k] as unknown[]) : null;

  switch (watchType) {
    case "resting_hr_sustained_above": {
      const t = num("threshold_bpm");
      const w = num("window_days");
      if (t === null || t < 30 || t > 220) return { ok: false, error: "threshold_bpm must be a number between 30 and 220" };
      if (w === null || w < 1 || w > 14) return { ok: false, error: "window_days must be 1-14" };
      return { ok: true, cleanParams: { threshold_bpm: t, window_days: w } };
    }
    case "resting_hr_above_baseline": {
      const d = num("delta_bpm");
      const b = num("baseline_window_days") ?? 30;
      const w = num("window_days");
      if (d === null || d < 1 || d > 80) return { ok: false, error: "delta_bpm must be 1-80" };
      if (b < 7 || b > 90) return { ok: false, error: "baseline_window_days must be 7-90" };
      if (w === null || w < 1 || w > 14) return { ok: false, error: "window_days must be 1-14" };
      return { ok: true, cleanParams: { delta_bpm: d, baseline_window_days: b, window_days: w } };
    }
    case "daily_steps_below": {
      const t = num("threshold_steps");
      const w = num("window_days");
      if (t === null || t < 0 || t > 50000) return { ok: false, error: "threshold_steps must be 0-50000" };
      if (w === null || w < 1 || w > 14) return { ok: false, error: "window_days must be 1-14" };
      return { ok: true, cleanParams: { threshold_steps: t, window_days: w } };
    }
    case "sleep_duration_below": {
      const t = num("threshold_hours");
      const w = num("window_nights");
      if (t === null || t < 0 || t > 16) return { ok: false, error: "threshold_hours must be 0-16" };
      if (w === null || w < 1 || w > 14) return { ok: false, error: "window_nights must be 1-14" };
      return { ok: true, cleanParams: { threshold_hours: t, window_nights: w } };
    }
    case "wearable_silence": {
      const d = num("silence_days");
      if (d === null || d < 1 || d > 30) return { ok: false, error: "silence_days must be 1-30" };
      return { ok: true, cleanParams: { silence_days: d } };
    }
    case "refill_gap": {
      const m = str("medication_name");
      const g = num("grace_days") ?? 3;
      if (!m) return { ok: false, error: "medication_name is required" };
      if (g < 0 || g > 30) return { ok: false, error: "grace_days must be 0-30" };
      return { ok: true, cleanParams: { medication_name: m, grace_days: g } };
    }
    case "pcp_visit_gap": {
      const m = num("months");
      if (m === null || m < 1 || m > 36) return { ok: false, error: "months must be 1-36" };
      return { ok: true, cleanParams: { months: m } };
    }
    case "new_care_team_member": {
      // No parameters needed.
      return { ok: true, cleanParams: {} };
    }
    case "new_record_arrived": {
      const k = arr("kinds");
      const allowed = new Set(["lab", "visit", "imaging", "discharge", "medication", "immunization"]);
      let kinds: string[] = ["lab", "visit", "imaging", "discharge"];
      if (k) {
        kinds = (k as unknown[])
          .filter((x): x is string => typeof x === "string" && allowed.has(x))
          .slice(0, 6);
        if (kinds.length === 0) return { ok: false, error: "kinds must contain at least one valid value" };
      }
      return { ok: true, cleanParams: { kinds } };
    }
    case "appointment_changed": {
      const c = arr("change_types");
      const allowed = new Set(["scheduled", "rescheduled", "cancelled"]);
      let changeTypes: string[] = ["rescheduled", "cancelled"];
      if (c) {
        changeTypes = (c as unknown[])
          .filter((x): x is string => typeof x === "string" && allowed.has(x))
          .slice(0, 3);
        if (changeTypes.length === 0) return { ok: false, error: "change_types must contain at least one valid value" };
      }
      return { ok: true, cleanParams: { change_types: changeTypes } };
    }
    default:
      return { ok: false, error: "unknown watch_type" };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Authorization required" }, 401);

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const personId = typeof body.person_id === "string" ? body.person_id : null;
    const watchType = typeof body.watch_type === "string" ? body.watch_type : null;
    const description = typeof body.description === "string" ? body.description.trim().slice(0, 200) : "";
    const createdVia = typeof body.created_via === "string" && ALLOWED_CREATED_VIA.has(body.created_via)
      ? body.created_via
      : "ask_wellet";

    if (!personId) return json({ error: "person_id is required" }, 400);
    if (!watchType || !ALLOWED_TYPES.has(watchType)) {
      return json({ error: "invalid or missing watch_type" }, 400);
    }
    if (NOT_YET_AVAILABLE_TYPES.has(watchType)) {
      return json({
        error: "watch_type_not_yet_available",
        message: "This watch type isn't available yet. We'll let you know when it's ready.",
      }, 400);
    }
    if (!description) return json({ error: "description is required" }, 400);

    // Validate parameters per-type. This is the gate that keeps clinical
    // watches out and refuses missing/garbage thresholds.
    const validation = validateParams(watchType, body.parameters);
    if (!validation.ok) return json({ error: validation.error }, 400);

    const admin = createClient(supabaseUrl, serviceKey);

    // Verify the person belongs to the calling user (defense in depth on top
    // of RLS). We use the admin client here because we want a clear 403 if
    // the user is trying to attach a watch to someone else's person.
    const { data: person, error: personErr } = await admin
      .from("people")
      .select("id, user_id, name")
      .eq("id", personId)
      .maybeSingle();

    if (personErr) return json({ error: "could not load person" }, 500);
    if (!person) return json({ error: "person not found" }, 404);
    if (person.user_id !== user.id) return json({ error: "forbidden" }, 403);

    // Soft cap
    const { count } = await admin
      .from("care_signal_watches")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("person_id", personId)
      .eq("active", true);
    if (count !== null && count >= MAX_WATCHES_PER_PERSON) {
      return json({
        error: `max ${MAX_WATCHES_PER_PERSON} active watches per person reached`,
      }, 400);
    }

    const { data: inserted, error: insertErr } = await admin
      .from("care_signal_watches")
      .insert({
        user_id: user.id,
        person_id: personId,
        watch_type: watchType,
        parameters: validation.cleanParams,
        description,
        created_via: createdVia,
        active: true,
      })
      .select("id, watch_type, parameters, description, active, created_at")
      .single();

    if (insertErr) {
      console.error("[create-care-signal-watch] insert failed", insertErr);
      return json({ error: "could not create watch" }, 500);
    }

    return json({ success: true, watch: inserted });
  } catch (e) {
    console.error("[create-care-signal-watch] unexpected", e);
    return json({ error: "internal_error" }, 500);
  }
});
