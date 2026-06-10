// reimbursements (mywellet) — in-app Reimbursements surface
//
// JWT-verified endpoint that powers the in-app Reimbursements view. For a
// given loved one (person_id) it:
//   1. Verifies the caller via their JWT and confirms they own the person.
//   2. Loads people + active ehr_connections + the caller's care-circle
//      role, and runs the prefill resolver to derive what we can from the
//      chart/profile.
//   3. Merges the caregiver's partial_input over the derived values and
//      records per-field provenance.
//   4. Runs the SAME generatePrograms() / generateSignals() engine the
//      public scorecard uses (vendored in _shared/reimbursement-engine.ts).
//   5. Upserts reimbursement_assessments for that person_id (one row each).
//   6. Returns { programs, signals, prefilled_fields, asked_fields,
//      assessment_id }.
//
// Two request shapes:
//   - "prefill" (partial_input absent/empty, or mode:"prefill"): resolve
//     what we can, DO NOT persist results, return prefilled_fields +
//     asked_fields so the client can show the question flow. Programs are
//     returned too (best-effort against the prefill) but not saved.
//   - "submit" (full merged input): resolve + generate + upsert + return.
//
// Gateway config: verify_jwt = true. There is no public/anon path here —
// the public marketing scorecard stays in the getwellet repo's
// scorecard2-submit (verify_jwt = false). See spec "Option A".

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import {
  generatePrograms,
  generateSignals,
} from "../_shared/reimbursement-engine.ts";
import {
  EhrConnectionRow,
  PartialInput,
  PersonRow,
  resolvePrefill,
} from "../_shared/reimbursement-prefill.ts";

// Decode the JWT "sub" claim without verifying the signature. The gateway
// has already verified the JWT (verify_jwt = true); we only need the sub to
// cross-check ownership on the service-role fallback path.
function decodeJwtSub(hdr: string): string | null {
  try {
    const tok = hdr.replace(/^bearer\s+/i, "").trim();
    const parts = tok.split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const claims = JSON.parse(atob(b64 + pad));
    return claims.sub || null;
  } catch (_e) {
    return null;
  }
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400, cors);
  }

  const personId = typeof body.person_id === "string" ? body.person_id : null;
  if (!personId) return json({ error: "person_id is required" }, 400, cors);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
    return json({ error: "Missing Authorization header" }, 401, cors);
  }
  const jwtSub = decodeJwtSub(authHeader);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "Server configuration error" }, 500, cors);
  }

  // RLS-scoped client (the caller) for ownership-respecting reads, plus a
  // service-role client for the upsert and cross-table reads.
  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
  });

  // Confirm the caller owns this person. RLS read first; service-role
  // fallback only when the JWT sub matches the row's user_id.
  let { data: person } = await userClient
    .from("people")
    .select("id, user_id, date_of_birth, conditions, insurance_info")
    .eq("id", personId)
    .maybeSingle();
  if (!person && jwtSub) {
    const { data: adminPerson } = await admin
      .from("people")
      .select("id, user_id, date_of_birth, conditions, insurance_info")
      .eq("id", personId)
      .maybeSingle();
    if (adminPerson && adminPerson.user_id === jwtSub) person = adminPerson;
  }
  if (!person) return json({ error: "Person not found" }, 404, cors);

  const userId = person.user_id as string;

  // Load active EHR connections + the caller's care-circle role in parallel.
  const [ehrRes, ccRes, ccCountRes] = await Promise.all([
    admin
      .from("ehr_connections")
      .select("hospital_name, connected_provider, provider, status")
      .eq("person_id", personId),
    admin
      .from("care_circle_members")
      .select("role")
      .eq("person_id", personId)
      .eq("user_id", userId)
      .maybeSingle(),
    admin
      .from("care_circle_members")
      .select("id", { count: "exact", head: true })
      .eq("person_id", personId),
  ]);

  const ehrConnections = (ehrRes.data || []) as EhrConnectionRow[];
  const careCircleRole = (ccRes.data?.role as string | undefined) ?? null;
  const soleCareCircleMember = (ccCountRes.count ?? 0) <= 1;

  const rawPartial = (body.partial_input && typeof body.partial_input === "object")
    ? (body.partial_input as PartialInput)
    : {};

  const resolved = resolvePrefill(
    {
      person: person as PersonRow,
      ehrConnections,
      careCircleRole,
      soleCareCircleMember,
    },
    rawPartial,
  );

  const programs = generatePrograms(resolved.input);
  const signals = generateSignals(resolved.input);

  // A "prefill" request — no answers yet — returns the resolved fields and
  // what we still need to ask, WITHOUT persisting. Treat an explicit
  // mode:"prefill" or an empty partial_input as prefill.
  const explicitMode = typeof body.mode === "string" ? body.mode : null;
  const hasAnswers = Object.keys(rawPartial || {}).some((k) => {
    const v = (rawPartial as Record<string, unknown>)[k];
    return Array.isArray(v) ? v.length > 0 : v != null && v !== "";
  });
  const isPrefill = explicitMode === "prefill" || (!explicitMode && !hasAnswers);

  if (isPrefill) {
    return json({
      mode: "prefill",
      programs,
      signals,
      prefilled_fields: resolved.prefilled_fields,
      asked_fields: resolved.asked_fields,
      input_provenance: resolved.provenance,
      assessment_id: null,
    }, 200, cors);
  }

  // Submit path: upsert the assessment. assessed_at is bumped so the
  // stale_at trigger re-arms the 90-day window and needs_refresh resets.
  const now = new Date().toISOString();
  const row = {
    person_id: personId,
    user_id: userId,
    loved_one_age_band: resolved.input.loved_one_age_band,
    conditions: resolved.input.conditions,
    current_tools: resolved.input.current_tools,
    biggest_worry: resolved.input.biggest_worry,
    coverage: resolved.input.coverage,
    adl_level: resolved.input.adl_level,
    hospital_system: resolved.input.hospital_system,
    caregiver_role: resolved.input.caregiver_role,
    state: resolved.input.state,
    result_programs: programs,
    result_signals: signals,
    input_provenance: resolved.provenance,
    assessed_at: now,
    needs_refresh: false,
  };

  const { data: upserted, error: upsertErr } = await admin
    .from("reimbursement_assessments")
    .upsert(row, { onConflict: "person_id" })
    .select("id")
    .single();

  if (upsertErr) {
    console.error("reimbursements upsert error", upsertErr);
    return json({ error: "Could not save your assessment" }, 500, cors);
  }

  return json({
    mode: "submit",
    programs,
    signals,
    prefilled_fields: resolved.prefilled_fields,
    asked_fields: resolved.asked_fields,
    input_provenance: resolved.provenance,
    assessment_id: upserted.id,
  }, 200, cors);
});
