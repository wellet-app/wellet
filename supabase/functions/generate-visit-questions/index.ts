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
    // AI vendor + keys are owned by ../_shared/azureOpenAI.ts. PHI-touching
    // calls route through Azure OpenAI (BAA-covered) with phi:true.

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

    // Fetch health events from the last 90 days
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const { data: events } = await supabaseClient
      .from("health_events")
      .select("*")
      .eq("person_id", person_id)
      .gte("event_date", ninetyDaysAgo.toISOString())
      .order("event_date", { ascending: false });

    // Build context for the AI prompt
    let context = `Patient: ${person.name}\n`;
    if (person.date_of_birth) {
      const dob = new Date(person.date_of_birth);
      const age = Math.floor(
        (Date.now() - dob.getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      );
      context += `Age: ${age}\n`;
    }
    if (person.conditions) context += `Active conditions: ${person.conditions}\n`;
    if (person.allergies) context += `Allergies: ${person.allergies}\n`;

    if (meds && meds.length > 0) {
      context += "\nActive medications:\n";
      meds.forEach((m: any) => {
        context += `- ${m.name}`;
        if (m.dose) context += ` ${m.dose}`;
        if (m.frequency) context += ` ${m.frequency}`;
        context += "\n";
      });
    }

    if (events && events.length > 0) {
      context += "\nRecent health events (last 90 days):\n";
      events.forEach((e: any) => {
        const d = new Date(e.event_date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        context += `- [${d}] ${e.event_type}: ${e.title}`;
        if (e.description) context += ` — ${e.description}`;
        if (e.notes) context += ` (${e.notes})`;
        context += "\n";
      });
    }

    // PHI: caregiver-side question generation from the loved one's meds,
    // conditions, and recent events. phi:true engages the adapter's
    // assertVendorAllowedForPhi guardrail — Azure OpenAI under BAA only.
    let raw: string;
    try {
      const result = await aiChat({
        model: "gpt-4o-mini",
        temperature: 0.4,
        max_tokens: 500,
        phi: true,
        messages: [
          {
            role: "system",
            content: `You are a helpful health assistant for family caregivers. Based on the patient data provided, generate 3-5 thoughtful questions that a caregiver should ask the doctor at the next appointment.

Rules:
- Questions should be specific and relevant to the patient's current health data
- Reference specific medications, conditions, or recent events when appropriate
- Focus on actionable topics: medication changes, test results, symptom management, preventive care
- Use plain, non-medical language that a family caregiver would use
- Do NOT diagnose or suggest treatments
- Return ONLY a JSON array of strings, no other text
- Example format: ["Question one?", "Question two?", "Question three?"]`,
          },
          {
            role: "user",
            content: `Generate doctor visit questions for this patient:\n\n${context}`,
          },
        ],
      });
      raw = result.content || "[]";
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

    // Parse the JSON array from the response
    let questions: string[];
    try {
      questions = JSON.parse(raw);
      if (!Array.isArray(questions)) questions = [];
    } catch {
      // Try to extract JSON array from the response text
      const match = raw.match(/\[[\s\S]*\]/);
      if (match) {
        try {
          questions = JSON.parse(match[0]);
        } catch {
          questions = [];
        }
      } else {
        questions = [];
      }
    }

    return new Response(JSON.stringify({ questions }), {
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
