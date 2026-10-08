import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const MAX_RESPONSES = 20;

const ALLOWED_ORIGINS = new Set([
  "https://getwellet.com",
  "https://www.getwellet.com",
  "https://mywellet.com",
  "https://www.mywellet.com",
  "http://localhost:3000",
  "http://localhost:4000",
  "http://localhost:8080",
]);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://getwellet.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const ENUM: Record<string, Set<string>> = {
  relationship: new Set(["daughter", "son", "spouse", "other_family", "friend", "other"]),
  living_arrangement: new Set(["same_home", "nearby", "same_region", "different_state", "long_distance"]),
  caregiving_duration: new Set(["under_6mo", "6mo_2yr", "2yr_5yr", "over_5yr"]),
  condition_area: new Set(["dementia", "cardiac", "cancer", "multiple_chronic", "recovery", "general_aging", "other", "prefer_not_say"]),
  urbanicity: new Set(["major_city", "suburb", "small_town", "rural", "not_sure"]),
  num_hospital_systems: new Set(["one", "two", "three_four", "five_plus", "dont_know"]),
  last_info_search_difficulty: new Set(["today", "this_week", "this_month", "over_month", "never"]),
  knew_about_programs: new Set(["yes_looked", "yes_heard", "no_idea"]),
  incentive_choice: new Set(["nac", "aarp", "alz", "other_org", "amazon"]),
};

function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.length > max ? t.substring(0, max) : t;
}

function validEnum(field: string, v: unknown): string | null {
  if (typeof v !== "string") return null;
  const set = ENUM[field];
  return set && set.has(v) ? v : null;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers });
  }

  const is_active_caregiver = body.is_active_caregiver === true;
  const email = clip(body.email, 320);
  const followup_optin = body.followup_optin === true;

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return new Response(JSON.stringify({ error: "invalid_email" }), { status: 400, headers });
  }
  if (typeof body.followup_optin !== "boolean") {
    return new Response(JSON.stringify({ error: "missing_followup_optin" }), { status: 400, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const ipRaw =
    req.headers.get("cf-connecting-ip") ||
    req.headers.get("x-real-ip") ||
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    null;
  const ipCountry = req.headers.get("cf-ipcountry") || null;

  // Global cap: survey closes once MAX_RESPONSES rows exist.
  {
    const { count } = await sb
      .from("acl_caregiver_survey_responses")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) >= MAX_RESPONSES) {
      return new Response(JSON.stringify({ error: "survey_full" }), { status: 403, headers });
    }
  }

  // One submission per email, permanently (case-insensitive).
  {
    const { data: dup } = await sb
      .from("acl_caregiver_survey_responses")
      .select("id")
      .ilike("email", email)
      .limit(1);
    if (dup && dup.length > 0) {
      return new Response(JSON.stringify({ error: "already_submitted" }), { status: 409, headers });
    }
  }

  // Soft IP burst limit (unchanged): no more than 3 attempts/hour from one IP.
  if (ipRaw) {
    const { count } = await sb
      .from("acl_caregiver_survey_responses")
      .select("id", { count: "exact", head: true })
      .eq("ip_address", ipRaw)
      .gte("created_at", new Date(Date.now() - 60 * 60 * 1000).toISOString());
    if ((count ?? 0) >= 3) {
      return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429, headers });
    }
  }

  let challenge_ranking: unknown = null;
  if (Array.isArray(body.challenge_ranking)) {
    challenge_ranking = body.challenge_ranking
      .filter((x: unknown) => typeof x === "string")
      .slice(0, 12);
  }

  const row = {
    is_active_caregiver,
    relationship: validEnum("relationship", body.relationship),
    living_arrangement: validEnum("living_arrangement", body.living_arrangement),
    caregiving_duration: validEnum("caregiving_duration", body.caregiving_duration),
    condition_area: validEnum("condition_area", body.condition_area),
    state_us: clip(body.state_us, 4),
    urbanicity: validEnum("urbanicity", body.urbanicity),
    one_thing_to_remove: clip(body.one_thing_to_remove, 600),
    num_hospital_systems: validEnum("num_hospital_systems", body.num_hospital_systems),
    last_info_search_difficulty: validEnum("last_info_search_difficulty", body.last_info_search_difficulty),
    challenge_ranking,
    tools_tried: clip(body.tools_tried, 1200),
    knew_about_programs: validEnum("knew_about_programs", body.knew_about_programs),
    programs_lookup_story: clip(body.programs_lookup_story, 600),
    recent_appointment_story: clip(body.recent_appointment_story, 1200),
    trust_requirements: clip(body.trust_requirements, 1200),
    email,
    followup_optin,
    incentive_choice: validEnum("incentive_choice", body.incentive_choice),
    additional_notes: clip(body.additional_notes, 600),
    ip_address: ipRaw,
    ip_country: ipCountry,
    user_agent: clip(body.user_agent, 500),
  };

  const { data, error } = await sb
    .from("acl_caregiver_survey_responses")
    .insert(row)
    .select("id")
    .single();

  if (error) {
    // Map DB-level guards (unique email index, cap trigger) hit on a race
    // to clean client responses instead of a generic 500.
    const msg = `${error.message ?? ""} ${(error as { details?: string }).details ?? ""}`.toLowerCase();
    if (error.code === "23505" || msg.includes("uidx_acl_survey_email_lower")) {
      return new Response(JSON.stringify({ error: "already_submitted" }), { status: 409, headers });
    }
    if (msg.includes("acl_survey_full")) {
      return new Response(JSON.stringify({ error: "survey_full" }), { status: 403, headers });
    }
    console.error("acl_survey_insert_error", error);
    return new Response(JSON.stringify({ error: "insert_failed" }), { status: 500, headers });
  }

  return new Response(JSON.stringify({ ok: true, id: data.id }), { status: 200, headers });
});
