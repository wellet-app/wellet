import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { aiChat } from "../_shared/azureOpenAI.ts";

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // AI vendor + keys are now owned by ../_shared/azureOpenAI.ts. This
    // function no longer reads OPENAI_API_KEY directly — Azure OpenAI
    // (BAA-covered) is the default vendor and the adapter enforces it for
    // phi:true calls.

    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "No authorization header" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseClient = createClient(supabaseUrl, supabaseServiceKey);
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );

    // Verify the user
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { person_id } = await req.json();
    if (!person_id) {
      return new Response(JSON.stringify({ error: "person_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch person profile
    const { data: person } = await supabaseClient
      .from("people")
      .select("*")
      .eq("id", person_id)
      .eq("user_id", user.id)
      .single();

    if (!person) {
      return new Response(JSON.stringify({ error: "Person not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Fetch active medications
    const { data: meds } = await supabaseClient
      .from("medications")
      .select("*")
      .eq("person_id", person_id)
      .eq("active", true)
      .order("created_at", { ascending: true });

    // Fetch allergies from the dedicated table. This is separate from the
    // free-text `person.allergies` profile field — EHR-sourced allergies
    // live in the `allergies` table and must be folded into the brief, or
    // the ER-facing section will say "None reported" even when Duke
    // returned a Penicillin entry.
    const { data: allergies } = await supabaseClient
      .from("allergies")
      .select("*")
      .eq("person_id", person_id)
      .order("created_at", { ascending: true });

    // Fetch health events from the last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const { data: events } = await supabaseClient
      .from("health_events")
      .select("*")
      .eq("person_id", person_id)
      .gte("event_date", twelveMonthsAgo.toISOString())
      .order("event_date", { ascending: false });

    // Conditions show up in health_events with event_type='condition'. Same
    // for visits / immunizations / diagnostic reports. We feed the full
    // recent set to the model and let it organize.

    // Fetch most-recent lab results (cap at 30 to keep token use bounded).
    // Only the last 12 months so we don't resurface stale panels.
    const { data: labs } = await supabaseClient
      .from("lab_results")
      .select("test_name, value, unit, reference_range, effective_date")
      .eq("person_id", person_id)
      .gte("effective_date", twelveMonthsAgo.toISOString())
      .order("effective_date", { ascending: false })
      .limit(30);

    // Fetch care circle members
    const { data: careCircle } = await supabaseClient
      .from("care_circle_members")
      .select("*")
      .eq("person_id", person_id)
      .order("created_at", { ascending: true });

    // Check if there's enough data to generate a meaningful summary
    const hasProfile = person.date_of_birth || person.allergies || person.conditions;
    const hasMeds = meds && meds.length > 0;
    const hasAllergies = allergies && allergies.length > 0;
    const hasEvents = events && events.length > 0;
    const hasLabs = labs && labs.length > 0;

    if (!hasProfile && !hasMeds && !hasAllergies && !hasEvents && !hasLabs) {
      return new Response(JSON.stringify({ empty: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Build context for the AI prompt
    let context = `Patient: ${person.name}\n`;
    if (person.date_of_birth) {
      const dob = new Date(person.date_of_birth);
      const age = Math.floor(
        (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      );
      context += `DOB: ${dob.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
      })} (Age ${age})\n`;
    }
    if (person.blood_type) context += `Blood type: ${person.blood_type}\n`;
    // Free-text profile allergies are legacy — EHR-sourced list below is
    // the source of truth when present.
    if (person.allergies) context += `Allergies (profile): ${person.allergies}\n`;
    if (person.conditions) context += `Active conditions (profile): ${person.conditions}\n`;
    if (person.primary_doctor)
      context += `Primary doctor: ${person.primary_doctor}\n`;
    if (person.insurance_info)
      context += `Insurance: ${person.insurance_info}\n`;

    // Emergency contacts
    if (person.emergency_contact_name) {
      context += `Emergency contact: ${person.emergency_contact_name}`;
      if (person.emergency_contact_phone)
        context += ` (${person.emergency_contact_phone})`;
      context += "\n";
    }
    if (careCircle && careCircle.length > 0) {
      context += "\nCare circle:\n";
      careCircle.forEach((m: any) => {
        context += `- ${m.member_name} (${m.role})`;
        if (m.phone) context += ` ${m.phone}`;
        context += "\n";
      });
    }

    if (meds && meds.length > 0) {
      context += "\nActive medications:\n";
      meds.forEach((m: any) => {
        context += `- ${m.name}`;
        if (m.dose) context += ` ${m.dose}`;
        if (m.frequency) context += ` ${m.frequency}`;
        context += "\n";
      });
    }

    // EHR-sourced allergies — the MEDICATIONS and ALLERGIES sections are the
    // two most safety-critical blocks in an ER, so we list these explicitly
    // with reaction + severity when available.
    if (allergies && allergies.length > 0) {
      context += "\nAllergies (EHR):\n";
      allergies.forEach((a: any) => {
        context += `- ${a.substance}`;
        if (a.severity) context += ` (${a.severity})`;
        if (a.reaction) context += ` — reaction: ${a.reaction}`;
        context += "\n";
      });
    }

    if (events && events.length > 0) {
      // Group by event_type so the prompt makes it easy for the model to
      // separate CONDITIONS from RECENT PROCEDURES in the output.
      const byType: Record<string, any[]> = {};
      events.forEach((e: any) => {
        const t = e.event_type || "other";
        (byType[t] = byType[t] || []).push(e);
      });
      // Conditions first (not date-bounded for severity — chronic conditions
      // are still relevant even if recorded > 12 months ago, but we already
      // filtered on event_date for the whole pull, so this is what we have).
      const typeOrder = ["condition", "diagnostic_report", "visit", "immunization"];
      for (const t of typeOrder) {
        const rows = byType[t];
        if (!rows || rows.length === 0) continue;
        const label = t === "diagnostic_report" ? "Diagnostic reports" : t.charAt(0).toUpperCase() + t.slice(1) + "s";
        context += `\n${label} (last 12 months):\n`;
        // Cap each list to keep the prompt compact — full dataset can exceed
        // 500 rows, which blows the token budget and buries the ER-critical
        // fields. 20 per category is enough for a summary.
        rows.slice(0, 20).forEach((e: any) => {
          const d = new Date(e.event_date).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
          });
          context += `- [${d}] ${e.title}`;
          if (e.notes) context += ` — ${e.notes}`;
          context += "\n";
        });
        if (rows.length > 20) context += `  (… and ${rows.length - 20} more ${label.toLowerCase()})\n`;
      }
    }

    // Recent labs — only include if we have room; list the 10 most recent
    // to keep the ER brief tight. The model is instructed to only surface
    // lab results when clinically relevant.
    if (labs && labs.length > 0) {
      context += "\nRecent lab results:\n";
      labs.slice(0, 10).forEach((l: any) => {
        const d = l.effective_date
          ? new Date(l.effective_date).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
            })
          : "";
        context += `- [${d}] ${l.test_name}`;
        if (l.value) context += `: ${l.value}`;
        if (l.unit) context += ` ${l.unit}`;
        if (l.reference_range) context += ` (ref ${l.reference_range})`;
        context += "\n";
      });
    }

    // Call the Azure OpenAI adapter. phi:true forces BAA-covered routing —
    // the adapter's assertVendorAllowedForPhi guardrail will throw if
    // anything but azure (or another BAA-eligible vendor) is configured.
    let summary: string;
    try {
      const result = await aiChat({
        model: "gpt-4o-mini",
        temperature: 0.3,
        // Bumped from 800 — the brief now folds in EHR-sourced allergies,
        // conditions, diagnostic reports, visits, and a short lab list, and
        // 800 was truncating mid-RECENT PROCEDURES once we had real data.
        max_tokens: 1200,
        phi: true,
        messages: [
          {
            role: "system",
            content: `You are a medical summary assistant for an emergency room context. Generate a concise, highly readable emergency brief from the patient data provided. This will be shown on a phone screen to ER staff.

Format rules:
- Use plain text only, no markdown formatting
- Start with the most critical info: allergies, current medications, active conditions
- Include any recent surgeries or procedures from events (last 12 months)
- Mention emergency contacts and primary care physician
- Be factual and concise — every word matters in an ER
- Do NOT include speculative information or medical advice
- Do NOT diagnose or suggest treatments
- Keep it under 300 words
- Use clear section headers like ALLERGIES:, MEDICATIONS:, CONDITIONS:, RECENT PROCEDURES:, CONTACTS:
- List medications with dosages on separate lines
- If a documented allergy in the data is relevant to a medication that is also in the data, restate the allergy in the ALLERGIES section verbatim. Do not infer new allergy/medication conflicts from training knowledge.

Clinical-judgment guardrails (STRICT):
- Do NOT flag drug interactions. Wellet does not perform pharmacovigilance — leave clinical judgment to the care team.
- Do NOT flag dosing errors, contraindications, or medication mistakes.
- Do NOT introduce any medication, condition, allergy, dose, date, or contact that is not present verbatim in the data provided. If a field is missing, omit the section or write "Not on file."
- Never invent ICD-10, CPT, HCPCS, or NDC codes. Only include codes that appear in the data.
- You are not a doctor. Frame everything as a transcription of what is recorded, not as medical advice.`,
          },
          {
            role: "user",
            content: `Generate an emergency brief for this patient:\n\n${context}`,
          },
        ],
      });
      summary = result.content || "Unable to generate summary.";
    } catch (aiErr) {
      console.error("Azure OpenAI error:", aiErr);
      return new Response(
        JSON.stringify({ error: "AI generation failed" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    return new Response(JSON.stringify({ summary }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Function error:", err);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
