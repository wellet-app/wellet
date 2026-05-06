// scorecard-submit
//
// Public endpoint for the "What Wellet Would Notice For You" scorecard
// at getwellet.com/scorecard. Persists the 6 caregiver answers, the
// generated signals, and (if provided + consented) the email address.
//
// When email is captured, optionally fires off:
//   - A magic-link email so they can finish onboarding in mywellet
//   - A Brevo transactional email with the personalized result
//
// Gateway config: verify_jwt = false. This is a public form.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const FROM_ADDRESS = "Wellet <hello@mywellet.com>";

// ---- Validation helpers ----

const VALID_AGE_BANDS = new Set([
  "under_60",
  "60_69",
  "70_79",
  "80_89",
  "90_plus",
  "prefer_not_say",
]);

const VALID_CONDITIONS = new Set([
  "diabetes",
  "heart",
  "cancer",
  "dementia",
  "kidney",
  "lung",
  "mental_health",
  "mobility",
  "multiple",
  "none_known",
  "prefer_not_say",
]);

const VALID_TOOLS = new Set([
  "mychart",
  "another_portal",
  "paper_notes",
  "spreadsheet",
  "memory",
  "shared_doc",
]);

const VALID_WORRIES = new Set([
  "missing_something",
  "medication_changes",
  "appointment_chaos",
  "multiple_doctors",
  "declining_changes",
  "other",
]);

const VALID_ROLES = new Set([
  "primary",
  "shared",
  "distance",
  "professional",
  "other",
]);

function trim(s: unknown, max = 200): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.substring(0, max) : t;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function escHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---- Signal generation (deterministic mapping) ----
//
// Voice rules: never "track/monitor/keep tabs on". Use "notices",
// "watches for", "follows", "reads", "stays on top of". Never "parent" —
// always "loved one" / "family member". No clinical-state claims.
// No medical-error finding.

interface Signal {
  id: string;
  title: string;
  why: string;
}

interface ScorecardInput {
  loved_one_age_band: string;
  conditions: string[];
  current_tools: string[];
  biggest_worry: string;
  hospital_system: string | null;
  caregiver_role: string;
}

function generateSignals(input: ScorecardInput): Signal[] {
  const signals: Signal[] = [];
  const conditions = new Set(input.conditions || []);
  const tools = new Set(input.current_tools || []);

  // Worry-driven signal (always include the one matching their primary worry)
  const worryMap: Record<string, Signal> = {
    missing_something: {
      id: "witness",
      title: "A second pair of eyes on every appointment",
      why:
        "Wellet reads the chart so you don't have to remember what was said. " +
        "When notes change between visits, Wellet notices.",
    },
    medication_changes: {
      id: "med_changes",
      title: "Watches for medication changes",
      why:
        "When a new prescription is added, a dose changes, or a medication " +
        "is stopped, Wellet surfaces it in plain English. We don't catch " +
        "errors — we just make sure you see what changed.",
    },
    appointment_chaos: {
      id: "appointments",
      title: "Stays on top of appointments and follow-ups",
      why:
        "Past visits, upcoming appointments, and the questions to ask — all " +
        "in one place, organized for the person doing the caring.",
    },
    multiple_doctors: {
      id: "care_team",
      title: "One view of the whole care team",
      why:
        "When your loved one sees five doctors across three systems, Wellet " +
        "pulls them together so you can see who said what, when.",
    },
    declining_changes: {
      id: "patterns",
      title: "Notices small shifts before they become big ones",
      why:
        "Wellet follows trends quietly in the background — labs, vitals, " +
        "patterns in the notes — so a change that takes weeks to surface " +
        "doesn't get lost.",
    },
    other: {
      id: "witness",
      title: "A witness system for the caring you already do",
      why:
        "Wellet reads your loved one's records and surfaces what matters. " +
        "You stay the caregiver — Wellet just makes sure nothing falls " +
        "through the cracks.",
    },
  };
  signals.push(worryMap[input.biggest_worry] || worryMap.other);

  // Tool-driven signal (always meets them where they are)
  if (tools.has("memory")) {
    signals.push({
      id: "from_memory",
      title: "You're holding it all in your head — Wellet can hold some of it",
      why:
        "Most caregivers we talk to remember more than they realize. Wellet " +
        "imports your loved one's records once and keeps the timeline so you " +
        "don't have to.",
    });
  } else if (tools.has("paper_notes") || tools.has("spreadsheet")) {
    signals.push({
      id: "beyond_notes",
      title: "Your notes, but they update themselves",
      why:
        "If you've kept a notebook or a spreadsheet, you already know what " +
        "matters. Wellet imports the same kind of detail directly from the " +
        "chart, and keeps it current as new visits happen.",
    });
  } else if (tools.has("mychart") || tools.has("another_portal")) {
    signals.push({
      id: "beyond_portal",
      title: "Everything from MyChart, plus the stuff MyChart hides",
      why:
        "Wellet connects through the same secure pipe MyChart uses, then " +
        "translates clinical language into something readable, and surfaces " +
        "patterns the portal doesn't show you.",
    });
  }

  // Condition-driven signal (top one wins)
  const conditionMap: Array<[string, Signal]> = [
    ["dementia", {
      id: "dementia_witness",
      title: "Notices the things you can't see day-to-day",
      why:
        "Cognitive change is small until it isn't. Wellet reads the visit " +
        "notes for shifts in language, mood, and assessments — so a slow " +
        "trend doesn't surprise you at the next appointment.",
    }],
    ["cancer", {
      id: "cancer_signals",
      title: "Reads the labs and the visit notes side by side",
      why:
        "Treatment changes, lab trends, scan reports — all of it in one " +
        "place, so you walk into the next oncology appointment knowing what " +
        "to ask.",
    }],
    ["heart", {
      id: "heart_signals",
      title: "Watches for changes in the things cardiology cares about",
      why:
        "Blood pressure trends, medication adjustments, recent ECG or echo " +
        "results — Wellet surfaces them the way a cardiology coordinator " +
        "would, in plain language.",
    }],
    ["diabetes", {
      id: "diabetes_signals",
      title: "Follows the numbers so you don't have to",
      why:
        "A1c, glucose patterns, medication changes, kidney function — Wellet " +
        "reads them out of the chart and shows you the trend, not just the " +
        "latest result.",
    }],
    ["kidney", {
      id: "kidney_signals",
      title: "Reads kidney labs and what they mean",
      why:
        "Creatinine, eGFR, electrolytes — Wellet shows you the trend over " +
        "time and flags when a number is moving in the wrong direction.",
    }],
    ["lung", {
      id: "lung_signals",
      title: "Stays on top of pulmonary follow-ups",
      why:
        "Spirometry, oxygen, exacerbations, medication tweaks — Wellet pulls " +
        "the relevant pieces forward so you know what's changed since the " +
        "last visit.",
    }],
    ["mental_health", {
      id: "mh_signals",
      title: "Reads behavioral health notes with the same care",
      why:
        "Medication changes, appointment cadence, screening scores — all " +
        "surfaced so the people doing the caring can see the picture.",
    }],
    ["mobility", {
      id: "mobility_signals",
      title: "Notices mobility, falls, and PT progress",
      why:
        "Wellet pulls falls, ER visits, PT/OT notes, and assistive-device " +
        "orders into one timeline, so you can see how things are trending.",
    }],
    ["multiple", {
      id: "multiple_conditions",
      title: "Carries the complexity for you",
      why:
        "Multiple conditions means multiple doctors, multiple medications, " +
        "and a lot to remember. Wellet pulls everything into one view that " +
        "respects how much you're already holding.",
    }],
  ];
  for (const [c, sig] of conditionMap) {
    if (conditions.has(c)) {
      signals.push(sig);
      break;
    }
  }

  // Role-driven signal
  if (input.caregiver_role === "distance") {
    signals.push({
      id: "distance",
      title: "Built for caring from far away",
      why:
        "When you can't be there in person, Wellet gives you the same " +
        "visibility a local caregiver has. Records, appointments, and " +
        "what's changed — all without depending on a phone call.",
    });
  } else if (input.caregiver_role === "shared") {
    signals.push({
      id: "shared",
      title: "Shareable with the people caring alongside you",
      why:
        "Wellet Connect lets siblings, partners, and other family see the " +
        "same picture you see, so the caring isn't all on one set of " +
        "shoulders.",
    });
  }

  // Hospital-driven signal (only if it's something we have an integration for)
  if (input.hospital_system) {
    const h = input.hospital_system.toLowerCase();
    if (h.includes("duke")) {
      signals.push({
        id: "duke",
        title: "Already connects to Duke Health",
        why:
          "Wellet's MyChart connection to Duke Health is live today. Sign " +
          "in with your MyChart credentials and your loved one's records " +
          "are imported in seconds.",
      });
    } else if (h.includes("va") || h.includes("veterans")) {
      signals.push({
        id: "va",
        title: "Built with VA caregivers in mind",
        why:
          "Wellet supports VA records imports (Blue Button) and treats them " +
          "the same as MyChart data — same view, same timeline, same care.",
      });
    } else if (
      h.includes("epic") || h.includes("mychart") || h.includes("unc") ||
      h.includes("kaiser") || h.includes("mayo") || h.includes("cleveland")
    ) {
      signals.push({
        id: "epic_network",
        title: `Connects to ${input.hospital_system} through MyChart`,
        why:
          "If your loved one's hospital uses MyChart, Wellet connects to it " +
          "the same way the patient does — securely, and only with their " +
          "permission.",
      });
    }
  }

  // Cap at 5 signals
  return signals.slice(0, 5);
}

// ---- Main handler ----

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Validate the 6 inputs
  const ageBand = trim(body.loved_one_age_band, 30);
  if (!ageBand || !VALID_AGE_BANDS.has(ageBand)) {
    return new Response(
      JSON.stringify({ error: "Invalid age band" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const rawConditions = Array.isArray(body.conditions) ? body.conditions : [];
  const conditions = rawConditions
    .map((c) => trim(c, 30))
    .filter((c): c is string => c !== null && VALID_CONDITIONS.has(c));

  const rawTools = Array.isArray(body.current_tools) ? body.current_tools : [];
  const currentTools = rawTools
    .map((c) => trim(c, 30))
    .filter((c): c is string => c !== null && VALID_TOOLS.has(c));

  const worry = trim(body.biggest_worry, 30);
  if (!worry || !VALID_WORRIES.has(worry)) {
    return new Response(
      JSON.stringify({ error: "Invalid worry" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const role = trim(body.caregiver_role, 30);
  if (!role || !VALID_ROLES.has(role)) {
    return new Response(
      JSON.stringify({ error: "Invalid role" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  const hospital = trim(body.hospital_system, 100); // optional / free-text-ish

  // Optional email + consent
  const email = trim(body.email, 254);
  const emailConsent = body.email_consent === true;
  if (email && !isValidEmail(email)) {
    return new Response(
      JSON.stringify({ error: "Invalid email" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // Attribution
  const utmSource = trim(body.utm_source, 100);
  const utmMedium = trim(body.utm_medium, 100);
  const utmCampaign = trim(body.utm_campaign, 100);
  const referrer = trim(body.referrer, 500);
  const userAgent = req.headers.get("User-Agent")?.substring(0, 500) || null;

  // Generate signals
  const input: ScorecardInput = {
    loved_one_age_band: ageBand,
    conditions,
    current_tools: currentTools,
    biggest_worry: worry,
    hospital_system: hospital,
    caregiver_role: role,
  };
  const signals = generateSignals(input);

  // Persist
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "Server configuration error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const insertRow = {
    loved_one_age_band: ageBand,
    conditions,
    current_tools: currentTools,
    biggest_worry: worry,
    hospital_system: hospital,
    caregiver_role: role,
    email: email && emailConsent ? email : null,
    email_consent: emailConsent,
    result_signals: signals,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    referrer,
    user_agent: userAgent,
    email_captured_at: email && emailConsent ? new Date().toISOString() : null,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("scorecard_responses")
    .insert(insertRow)
    .select("id")
    .single();

  if (insertErr) {
    console.error("scorecard insert error", insertErr);
    return new Response(
      JSON.stringify({ error: "Could not save your responses" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  // If email + consent: send a personalized result email via Brevo SMTP.
  // Best-effort — don't fail the request if SMTP errors. Hard-cap at 12s
  // so a hung SMTP socket can't take down the whole request.
  if (email && emailConsent) {
    const sendWithTimeout = async () => {
      const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
      const smtpPort = parseInt(Deno.env.get("BREVO_SMTP_PORT") || "587", 10);
      const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
      const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";
      if (smtpUser && smtpPass) {
        const client = new SMTPClient({
          connection: {
            hostname: smtpHost,
            port: smtpPort,
            tls: true,
            auth: { username: smtpUser, password: smtpPass },
          },
        });
        const signalsHtml = signals.map((s) =>
          `<div style="margin: 24px 0; padding: 20px; background: #f7f5f1; border-radius: 12px;">
             <h3 style="margin: 0 0 8px 0; font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 20px; color: #2d3a35;">${escHtml(s.title)}</h3>
             <p style="margin: 0; font-family: 'DM Sans', system-ui, sans-serif; font-size: 15px; line-height: 1.55; color: #4a5550;">${escHtml(s.why)}</p>
           </div>`
        ).join("");
        await client.send({
          from: FROM_ADDRESS,
          to: email,
          subject: "What Wellet would notice for you",
          html:
            `<div style="max-width: 600px; margin: 0 auto; font-family: 'DM Sans', system-ui, sans-serif; color: #2d3a35;">
               <h1 style="font-family: 'Fraunces', Georgia, serif; font-weight: 400; font-size: 32px; line-height: 1.2;">Here's what Wellet would notice for you.</h1>
               <p style="font-size: 16px; line-height: 1.6;">Based on what you shared, here are five things Wellet would do quietly in the background while you keep doing the caring.</p>
               ${signalsHtml}
               <div style="margin: 32px 0; text-align: center;">
                 <a href="https://mywellet.com/?utm_source=scorecard&amp;utm_medium=email" style="display: inline-block; background: #608F7C; color: white; padding: 14px 28px; text-decoration: none; border-radius: 8px; font-weight: 500;">Try Wellet</a>
               </div>
               <p style="font-size: 13px; line-height: 1.6; color: #768078; margin-top: 32px;">You're receiving this because you asked for your scorecard at getwellet.com. If that wasn't you, you can ignore this email and we won't send you another.</p>
             </div>`,
        });
        await client.close();
        await supabase
          .from("scorecard_responses")
          .update({ brevo_synced_at: new Date().toISOString() })
          .eq("id", inserted.id);
      }
    };
    try {
      await Promise.race([
        sendWithTimeout(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("smtp timeout")), 12000)),
      ]);
    } catch (smtpErr) {
      console.error("scorecard email send failed (non-fatal)", smtpErr);
    }
  }

  return new Response(
    JSON.stringify({
      id: inserted.id,
      signals,
      email_sent: !!(email && emailConsent),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
