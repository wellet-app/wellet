// summarize-visit v12 — Azure OpenAI migration (BAA-covered PHI path)
//
// PHI surface: HIGH. The context block contains:
//   • Patient name (or "displayName")
//   • Visit date, type, status, location, reason
//   • Provider names
//   • Medications active at the visit (name, dose, frequency)
//   • Labs and vitals from the visit window (test name, value, unit, date)
//
// Behavior changes vs v11:
//   • Vendor:  OpenAI direct  →  Azure OpenAI (BAA-covered)
//   • Model name still "gpt-4o-mini" (routes to gpt-4o until mini quota lands)
//   • Response shape unchanged: {summary: string}
//   • Adds ai_vendor + function_version to response for audit
//
// Voice prompt is byte-identical. Visit summary feel is preserved.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { aiChat } from "../_shared/azureOpenAI.ts";

const VERSION = "12";

function getAdminClient() {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) return null;
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return user;
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  console.log(`[summarize-visit v${VERSION}] vendor=${Deno.env.get("WELLET_AI_VENDOR") ?? "azure"}`);

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) return jsonResponse({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const { person_id, visit, medications, observations, person_name } = body;
    if (!person_id) return jsonResponse({ error: "person_id is required" }, 400);
    if (!visit || typeof visit !== "object") {
      return jsonResponse({ error: "visit is required" }, 400);
    }

    const admin = getAdminClient();

    const { data: person, error: personErr } = await admin.from("people")
      .select("id, name, user_id")
      .eq("id", person_id)
      .eq("user_id", user.id)
      .single();
    if (personErr || !person) {
      return jsonResponse({ error: "Person not found" }, 404);
    }

    const displayName = person_name || person.name || "the person you care for";
    const visitDate = visit.start_date
      ? new Date(visit.start_date).toLocaleDateString("en-US", {
          month: "long", day: "numeric", year: "numeric",
        })
      : "an unspecified date";

    let ctx = `Visit on ${visitDate}\n`;
    if (visit.name) ctx += `Type: ${visit.name}\n`;
    if (visit.status) ctx += `Status: ${visit.status}\n`;
    if (visit.location) ctx += `Location: ${visit.location}\n`;
    if (visit.reason) ctx += `Reason: ${visit.reason}\n`;
    if (Array.isArray(visit.providers) && visit.providers.length) {
      const names = visit.providers.map((p: { name?: string }) => p.name).filter(Boolean);
      if (names.length) ctx += `Providers: ${names.join(", ")}\n`;
    }

    const medList = Array.isArray(medications) ? medications.slice(0, 20) : [];
    if (medList.length) {
      ctx += `\nMedications active around this visit:\n`;
      for (const m of medList) {
        let line = `- ${m.name || "Medication"}`;
        if (m.dose) line += ` ${m.dose}`;
        if (m.frequency) line += ` ${m.frequency}`;
        ctx += line + "\n";
      }
    }

    const obsList = Array.isArray(observations) ? observations.slice(0, 25) : [];
    if (obsList.length) {
      ctx += `\nLabs and vitals from this visit window:\n`;
      for (const o of obsList) {
        const value = o.value != null ? `${o.value}${o.unit ? " " + o.unit : ""}` : "";
        const when = o.effective_date
          ? new Date(o.effective_date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
          : "";
        ctx += `- ${o.name || "Observation"}${value ? ": " + value : ""}${when ? " (" + when + ")" : ""}\n`;
      }
    }

    // ── Voice prompt — UNCHANGED from v11 ──
    const systemPrompt = `You are writing a calm, plain-language visit summary for a family caregiver. Your voice is supportive, clear, and never clinical.

Hard rules:
- Write 2 to 4 short sentences. No bullet points. No headings.
- Use plain English. Avoid medical jargon; if a medical term is necessary, briefly explain it.
- Refer to the patient as "${displayName}" or "they". Never use "parent".
- Never flag medication errors, dosing issues, or clinician mistakes. Wellet helps coordinate care; it does not audit it.
- Never diagnose, never recommend treatment, never say "you should". Describe only what happened and what was discussed.
- Do NOT use the words "track", "tracks", "tracking", "monitor", or "keep tabs on". Prefer "notices", "watches for", "follows", "reads", "stays on top of".
- If the data is thin, write a shorter summary that stays accurate. Never invent details.
- Do not include a closing sign-off or a follow-up question.`;

    const userPrompt = `Write the visit summary from this data:\n\n${ctx}`;

    let summary = "";
    let aiVendor = "";
    let aiModel = "";

    try {
      const res = await aiChat({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 260,
        temperature: 0.3,
        phi: true, // visit context contains med names + lab values + provider names — BAA required
      });
      summary = (res.content || "").trim();
      aiVendor = res.vendor;
      aiModel = res.model;
      console.log(`[summarize-visit v${VERSION}] aiChat (${res.vendor}/${res.model}) → ${summary.length} chars`);
    } catch (aiErr) {
      console.error(`[summarize-visit v${VERSION}] AI call failed:`, aiErr);
      return jsonResponse({ error: "AI summary failed", details: String(aiErr) }, 502);
    }

    if (!summary) return jsonResponse({ error: "Empty summary" }, 502);

    return jsonResponse({
      summary,
      model: aiModel,
      ai_vendor: aiVendor,
      function_version: VERSION,
    });

  } catch (err) {
    console.error(`[summarize-visit v${VERSION}] error:`, err);
    return jsonResponse({ error: (err as Error).message || "Internal server error" }, 500);
  }
});
