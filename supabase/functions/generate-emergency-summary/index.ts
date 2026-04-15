import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const openaiKey = Deno.env.get("OPENAI_API_KEY")!;

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

    // Fetch health events from the last 12 months
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setFullYear(twelveMonthsAgo.getFullYear() - 1);
    const { data: events } = await supabaseClient
      .from("health_events")
      .select("*")
      .eq("person_id", person_id)
      .gte("event_date", twelveMonthsAgo.toISOString())
      .order("event_date", { ascending: false });

    // Fetch care circle members
    const { data: careCircle } = await supabaseClient
      .from("care_circle_members")
      .select("*")
      .eq("person_id", person_id)
      .order("created_at", { ascending: true });

    // Check if there's enough data to generate a meaningful summary
    const hasProfile = person.date_of_birth || person.allergies || person.conditions;
    const hasMeds = meds && meds.length > 0;
    const hasEvents = events && events.length > 0;

    if (!hasProfile && !hasMeds && !hasEvents) {
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
    if (person.allergies) context += `Allergies: ${person.allergies}\n`;
    if (person.conditions) context += `Active conditions: ${person.conditions}\n`;
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

    if (events && events.length > 0) {
      context += "\nRecent health events (last 12 months):\n";
      events.forEach((e: any) => {
        const d = new Date(e.event_date).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
        context += `- [${d}] ${e.event_type}: ${e.title}`;
        if (e.description) context += ` — ${e.description}`;
        context += "\n";
      });
    }

    // Call OpenAI to generate the emergency brief
    const aiResponse = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${openaiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.3,
          max_tokens: 800,
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
- Flag any critical drug interactions or allergy concerns prominently at the top`,
            },
            {
              role: "user",
              content: `Generate an emergency brief for this patient:\n\n${context}`,
            },
          ],
        }),
      }
    );

    if (!aiResponse.ok) {
      console.error("OpenAI error:", await aiResponse.text());
      return new Response(
        JSON.stringify({ error: "AI generation failed" }),
        {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const aiData = await aiResponse.json();
    const summary =
      aiData.choices?.[0]?.message?.content || "Unable to generate summary.";

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
