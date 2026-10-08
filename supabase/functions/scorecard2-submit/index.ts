// scorecard2-submit v2
//
// Public endpoint for the "Caregiver Reimbursement Scorecard" at
// getwellet.com/scorecard2. v2 adds: locality-aware PCAFC tiers, GUIDE age-gating
// + Medicare Advantage warning, 11-state Medicaid SFC matrix with spouse rules,
// NFCSP as first-class match for 60+, NC-specific programs (Project C.A.R.E.,
// Lifespan Respite), and hospital→state derivation.
//
// Gateway config: verify_jwt = false. Public form.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const FROM_ADDRESS = "Wellet <hello@getwellet.com>";

// ---- Validation ----

const VALID_AGE_BANDS = new Set([
  "under_60", "60_69", "70_79", "80_89", "90_plus", "prefer_not_say",
]);

const VALID_CONDITIONS = new Set([
  "diabetes", "heart", "cancer", "dementia", "kidney", "lung",
  "mental_health", "mobility", "multiple", "none_known", "prefer_not_say",
]);

const VALID_TOOLS = new Set([
  "mychart", "another_portal", "paper_notes", "spreadsheet", "memory", "shared_doc",
]);

const VALID_WORRIES = new Set([
  "missing_something", "medication_changes", "appointment_chaos",
  "multiple_doctors", "declining_changes", "other",
]);

const VALID_COVERAGE = new Set([
  "medicare", "medicaid", "veteran", "private", "marketplace", "none", "unsure",
]);

const VALID_ADL = new Set([
  "none", "1_2", "3_plus", "supervision", "unsure",
]);

const VALID_ROLES = new Set([
  "primary", "shared", "distance", "professional", "other",
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

// ---- Hospital → state derivation ----

const HOSPITAL_STATE_HINTS: Array<[RegExp, string]> = [
  [/\b(duke|unc|atrium|novant|wakemed|cone|cape\s*fear|carolinas?\s*health|cone\s*health|firsthealth|cherokee\s*indian|mountain\s*area|wilson\s*medical|vidant|cleveland\s*regional|charlotte\s*radiology|wake\s*forest\s*baptist)\b/i, "NC"],
  [/\b(inova|valley\s*health|sentara|carilion|virginia\s*hospital|chesapeake\s*regional)\b/i, "VA"],
  [/\b(emory|piedmont|wellstar|northside\s*atlanta|grady|augusta\s*university)\b/i, "GA"],
  [/\b(cleveland\s*clinic|metrohealth|ohiohealth|university\s*hospitals\s*cleveland|mount\s*carmel|nationwide\s*children)\b/i, "OH"],
  [/\b(indiana\s*university\s*health|iu\s*health|community\s*health\s*indiana|franciscan\s*indiana|parkview)\b/i, "IN"],
  [/\b(ochsner|tulane|baton\s*rouge\s*general|louisiana\s*state\s*university\s*health)\b/i, "LA"],
  [/\b(mass\s*general|mgh|brigham|tufts\s*medical|boston\s*medical|baystate|umass\s*memorial|lahey)\b/i, "MA"],
  [/\b(barnes\s*jewish|bjc|mercy\s*missouri|university\s*of\s*missouri\s*health|cox\s*health|st\s*luke'?s\s*kansas\s*city)\b/i, "MO"],
  [/\b(university\s*medical\s*center\s*of\s*southern\s*nevada|sunrise\s*hospital|valley\s*hospital\s*las\s*vegas|renown)\b/i, "NV"],
  [/\b(rhode\s*island\s*hospital|miriam\s*hospital|landmark\s*medical|kent\s*hospital)\b/i, "RI"],
  [/\b(sanford\s*sioux\s*falls|avera\s*mckennan|monument\s*health)\b/i, "SD"],
  [/\b(yale\s*new\s*haven|hartford\s*hospital|connecticut\s*children|stamford\s*hospital)\b/i, "CT"],
];

const SFC_STATES = new Set(["CT","GA","IN","LA","MA","MO","NV","NC","OH","RI","SD"]);
const SFC_SPOUSE_ELIGIBLE = new Set(["IN","LA","MO","NV","NC","OH","SD"]);

const SFC_STATE_DETAILS: Record<string, { name: string; rate: string }> = {
  CT: { name: "Connecticut Adult Family Living",        rate: "~$40–$60/day" },
  GA: { name: "Georgia Structured Family Caregiving",   rate: "~$80/day" },
  IN: { name: "Indiana Structured Family Caregiving",   rate: "~$40–$70/day" },
  LA: { name: "Louisiana Monitored In-Home Caregiving", rate: "~$40–$65/day" },
  MA: { name: "Massachusetts Adult Foster Care",        rate: "~$40–$70/day" },
  MO: { name: "Missouri Structured Family Caregiving",  rate: "~$67/day (caregiver share)" },
  NV: { name: "Nevada Structured Family Caregiving",    rate: "~$40–$70/day" },
  NC: { name: "North Carolina Coordinated Caregiving (CAP/DA)", rate: "~$55–$85/day" },
  OH: { name: "Ohio Structured Family Caregiving",      rate: "~$40–$70/day" },
  RI: { name: "Rhode Island RIte @ Home",               rate: "~$40–$65/day" },
  SD: { name: "South Dakota Structured Family Caregiving", rate: "~$81–$113/day tiered" },
};

function deriveState(hospital: string | null): string | null {
  if (!hospital) return null;
  for (const [re, st] of HOSPITAL_STATE_HINTS) {
    if (re.test(hospital)) return st;
  }
  return null;
}

function isAge60Plus(band: string): boolean {
  return band === "60_69" || band === "70_79" || band === "80_89" || band === "90_plus";
}
function isAge65Plus(band: string): boolean {
  // We don't split 60_69 by 5-year granularity — treat 60_69 as plausibly 65+.
  return band === "60_69" || band === "70_79" || band === "80_89" || band === "90_plus";
}

// ---- Program generation ----
//
// Voice rules: "may qualify", "up to" — NEVER "earn" or "guaranteed".
// "loved one" / "family member" — NEVER "parent". CareSignals is one word.

interface Program {
  id: string;
  name: string;
  amount: string;
  confidence: "high" | "medium" | "low";
  why: string[];
  caveats: string[];
  link: string;
  cta_label: string;
}

interface ScorecardInput {
  loved_one_age_band: string;
  conditions: string[];
  current_tools: string[];
  biggest_worry: string;
  coverage: string[];
  adl_level: string;
  hospital_system: string | null;
  caregiver_role: string;
  state: string | null;
}

function generatePrograms(input: ScorecardInput): Program[] {
  const programs: Program[] = [];
  const coverage = new Set(input.coverage || []);
  const conditions = new Set(input.conditions || []);
  const adl = input.adl_level || "unsure";
  const heavyAdl = adl === "1_2" || adl === "3_plus" || adl === "supervision";
  const veryHeavyAdl = adl === "3_plus" || adl === "supervision";
  const state = input.state;
  const role = input.caregiver_role;
  const age = input.loved_one_age_band;

  // ---- PCAFC (locality-aware tier) ----
  if (coverage.has("veteran") && heavyAdl) {
    const tier = veryHeavyAdl ? 2 : 1;
    const amount = tier === 2
      ? "Up to ~$3,034–$3,500/mo (Level 2)"
      : "Up to ~$1,896–$2,200/mo (Level 1)";
    programs.push({
      id: "pcafc",
      name: "VA PCAFC (Program of Comprehensive Assistance for Family Caregivers)",
      amount,
      confidence: veryHeavyAdl ? "high" : "medium",
      why: [
        "Your loved one is a veteran with VA coverage",
        veryHeavyAdl
          ? "They need help with 3+ ADLs or supervision for safety — typical Level 2"
          : "They need help with 1–2 ADLs — typical Level 1",
        "Stipend is tied to the GS-4 Step 1 federal locality wage where the veteran lives",
      ],
      caveats: [
        "Veteran must have a 70%+ service-connected disability rating",
        "Caregiver must be a family member or live with the veteran",
        "Amount varies by geographic locality — dollar ranges above are 2026 estimates",
        "Legacy pre-2020 cohort remains protected through Sept 30, 2028",
      ],
      link: "https://www.caregiver.va.gov/support/New_CSP_Page.asp",
      cta_label: "See if you qualify for PCAFC",
    });
  } else if (coverage.has("veteran")) {
    programs.push({
      id: "pcafc_general",
      name: "VA Caregiver Support Program (PGCSS)",
      amount: "Training, respite, peer support — no stipend",
      confidence: "medium",
      why: [
        "Your loved one has VA coverage",
        "The VA offers caregiver support even when PCAFC's full stipend doesn't apply",
      ],
      caveats: [
        "Program of General Caregiver Support Services — lower bar than PCAFC",
        "Includes respite, training, and a peer support mentor program",
      ],
      link: "https://www.caregiver.va.gov/",
      cta_label: "Explore VA caregiver support",
    });
  }

  // ---- CMS GUIDE (age-gated 65+, MA disqualifier) ----
  if (coverage.has("medicare") && conditions.has("dementia") && isAge65Plus(age)) {
    programs.push({
      id: "guide",
      name: "CMS GUIDE (Guiding an Improved Dementia Experience)",
      amount: "$2,500/year respite + monthly care management",
      confidence: "high",
      why: [
        "Your loved one has Medicare coverage",
        "They have a dementia diagnosis and are age 65+",
        "GUIDE is built specifically for dementia families",
      ],
      caveats: [
        "Must be in traditional/Original Medicare — Medicare Advantage enrollment disqualifies",
        "Must be enrolled with a GUIDE-participating provider (~320 organizations in 47 states as of May 2026)",
        "Residents of long-term memory care facilities are excluded as of July 2026",
      ],
      link: "https://www.cms.gov/priorities/innovation/innovation-models/guide",
      cta_label: "Find a GUIDE provider near you",
    });
  }

  // ---- Medicaid SFC (11-state matrix, spouse rules) ----
  if (coverage.has("medicaid") && veryHeavyAdl) {
    if (state && SFC_STATES.has(state)) {
      const det = SFC_STATE_DETAILS[state];
      const spouseOk = SFC_SPOUSE_ELIGIBLE.has(state);
      const spouseNote = spouseOk
        ? "Spouses may serve as the paid caregiver in this state"
        : "Spouses are excluded from being the paid caregiver in this state (other family OK)";
      programs.push({
        id: "medicaid_sfc",
        name: det.name,
        amount: `${det.rate} (paid in home)`,
        confidence: "high",
        why: [
          "Your loved one has Medicaid coverage",
          "They need help with 3+ ADLs or supervision for safety",
          `${state} runs a structured family caregiving / adult foster care waiver`,
        ],
        caveats: [
          "Caregiver typically must live with the loved one",
          spouseNote,
          "Most states administer through a partner (e.g., Careforth) — enrollment is not instant",
        ],
        link: "https://www.medicaid.gov/medicaid/home-community-based-services/index.html",
        cta_label: "Check your state's SFC waiver",
      });
    } else {
      programs.push({
        id: "medicaid_sfc_general",
        name: "Medicaid Structured Family Caregiving (state-dependent)",
        amount: "~$40–$113/day (varies by state)",
        confidence: "medium",
        why: [
          "Your loved one has Medicaid coverage and needs heavy daily care",
          "SFC programs exist in 11 states (CT, GA, IN, LA, MA, MO, NV, NC, OH, RI, SD)",
        ],
        caveats: [
          "We couldn't confirm your state from the hospital you entered",
          "If you live in one of the 11 SFC states, this is likely a strong match",
          "Spouses are excluded as the paid caregiver in GA, CT, MA, RI",
        ],
        link: "https://www.medicaid.gov/medicaid/home-community-based-services/index.html",
        cta_label: "Check your state's waivers",
      });
    }
  } else if (coverage.has("medicaid")) {
    programs.push({
      id: "medicaid_general",
      name: "Medicaid Self-Directed Home & Community-Based Services",
      amount: "Varies — services, sometimes cash",
      confidence: "medium",
      why: [
        "Your loved one has Medicaid coverage",
        "Most states have at least one waiver that supports family caregivers",
      ],
      caveats: [
        "Self-directed waivers in many states let family be paid as the caregiver",
        "Eligibility and amounts vary widely by state",
      ],
      link: "https://www.medicaid.gov/medicaid/home-community-based-services/index.html",
      cta_label: "Find your state's waivers",
    });
  }

  // ---- Medicare Caregiver Training Services ----
  if (coverage.has("medicare")) {
    const hasCareSignal = heavyAdl || conditions.size > 0;
    if (hasCareSignal) {
      programs.push({
        id: "cts",
        name: "Medicare Caregiver Training Services (CTS)",
        amount: "~$52 per 30-min session (20% coinsurance ≈ $10)",
        confidence: heavyAdl ? "high" : "medium",
        why: [
          "Your loved one has Medicare coverage",
          conditions.size > 0
            ? "They have a chronic condition that benefits from a structured care plan"
            : "They need ongoing care support",
          "CTS lets the loved one's clinician bill Medicare for training the family caregiver",
        ],
        caveats: [
          "Codes G0541–G0543 active since Jan 1, 2025",
          "Must be ordered and billed by the loved one's primary clinician",
          "20% Part B coinsurance applies unless covered by a Medigap plan",
        ],
        link: "https://www.cms.gov/medicare/payment/fee-schedules/physician",
        cta_label: "Ask your clinician about CTS",
      });
    }
  }

  // ---- NFCSP (first-class for 60+) ----
  if (isAge60Plus(age)) {
    programs.push({
      id: "nfcsp",
      name: "National Family Caregiver Support Program (NFCSP)",
      amount: "Respite + supplies, typically $500–$2,500/yr per family",
      confidence: heavyAdl ? "high" : "medium",
      why: [
        "Your loved one is 60 or older",
        "NFCSP is federally funded and administered through ~650 local Area Agencies on Aging",
        "Available regardless of income or insurance type",
      ],
      caveats: [
        "Funding is limited — some AAAs maintain waitlists",
        "Benefits are usually services (respite, training, supplies), not direct cash to the caregiver",
        "Apply through your local AAA — use the Eldercare Locator below",
      ],
      link: "https://eldercare.acl.gov/",
      cta_label: "Find your local AAA",
    });
  }

  // ---- NC-specific programs ----
  if (state === "NC") {
    if (conditions.has("dementia") && !coverage.has("medicaid")) {
      programs.push({
        id: "nc_project_care",
        name: "NC Project C.A.R.E.",
        amount: "Up to $1,500/year (3 × $500 vouchers)",
        confidence: "high",
        why: [
          "Your loved one has a dementia diagnosis",
          "They are not on Medicaid (Project C.A.R.E. serves the non-Medicaid gap population)",
          "Your hospital system suggests you're in North Carolina",
        ],
        caveats: [
          "100% state-funded — funding can run out mid-year",
          "Three respite vouchers per year, $500 each",
          "Dementia diagnosis required",
        ],
        link: "https://www.ncdhhs.gov/divisions/aging-and-adult-services/project-care",
        cta_label: "Apply for Project C.A.R.E.",
      });
    }
    programs.push({
      id: "nc_lifespan_respite",
      name: "NC Lifespan Respite Voucher",
      amount: "Up to $750/year reimbursement",
      confidence: "medium",
      why: [
        "Your hospital system suggests you're in North Carolina",
        "Lifespan Respite is open to any age, any condition",
      ],
      caveats: [
        "Reimbursement after the fact — you pay first, submit receipts",
        "One voucher per family per year",
        "Funding can run out mid-year",
      ],
      link: "https://arccaregivers.org/programs/lifespan-respite/",
      cta_label: "Apply for NC Lifespan Respite",
    });
  }

  // ---- Private / marketplace ----
  if ((coverage.has("private") || coverage.has("marketplace")) && heavyAdl) {
    programs.push({
      id: "private_caregiver_benefits",
      name: "Private insurance caregiver benefits",
      amount: "Varies by plan — respite hours, care navigation",
      confidence: "low",
      why: [
        "Your loved one has private or marketplace coverage",
        "Some plans include caregiver navigation, respite, or behavioral health support",
      ],
      caveats: [
        "Coverage varies widely — check the plan's benefits handbook",
        "Many employer plans now include eldercare benefits (Cariloop, Wellthy, Homethrive)",
      ],
      link: "https://www.kff.org/medicare/issue-brief/private-insurance-caregiver-benefits/",
      cta_label: "Check your plan's eldercare benefits",
    });
  }

  // ---- Fallback ----
  if (programs.length === 0) {
    programs.push({
      id: "aaa_respite",
      name: "Local Area Agency on Aging (AAA) respite grants",
      amount: "Varies — typically $500–$2,500 per family per year",
      confidence: "medium",
      why: [
        "Every county in the US has an Area Agency on Aging",
        "Most AAAs administer the federal NFCSP",
      ],
      caveats: [
        "Funding is limited and often awarded first-come-first-served",
        "Grants are typically one-time, not ongoing monthly payments",
      ],
      link: "https://eldercare.acl.gov/",
      cta_label: "Find your local AAA",
    });
  }

  return programs.slice(0, 5);
}

interface Signal {
  id: string;
  title: string;
  why: string;
}

function generateSignals(input: ScorecardInput): Signal[] {
  const signals: Signal[] = [];
  const conditions = new Set(input.conditions || []);

  signals.push({
    id: "witness",
    title: "A second pair of eyes on every appointment",
    why:
      "While you focus on the paperwork for reimbursement programs, Wellet " +
      "reads the chart so you don't miss medication changes, follow-ups, or " +
      "slow shifts between visits.",
  });

  if (conditions.has("dementia")) {
    signals.push({
      id: "dementia_witness",
      title: "Notices the things you can't see day-to-day",
      why:
        "Cognitive change is small until it isn't. Wellet reads the visit " +
        "notes for shifts in language, mood, and assessments — so a slow " +
        "trend doesn't surprise you at the next appointment.",
    });
  } else if (conditions.has("heart") || conditions.has("diabetes") || conditions.has("kidney")) {
    signals.push({
      id: "labs_drift",
      title: "Watches the labs that matter",
      why:
        "A1c, eGFR, BNP — Wellet shows you the trend over months, not just " +
        "the last visit. Patterns surface before the next appointment.",
    });
  }

  if (input.caregiver_role === "distance") {
    signals.push({
      id: "distance",
      title: "Built for caring from far away",
      why:
        "When you can't be there in person, Wellet gives you the same " +
        "visibility a local caregiver has — without depending on a phone call.",
    });
  }

  return signals.slice(0, 3);
}

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

  const ageBand = trim(body.loved_one_age_band, 30);
  if (!ageBand || !VALID_AGE_BANDS.has(ageBand)) {
    return new Response(JSON.stringify({ error: "Invalid age band" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
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
    return new Response(JSON.stringify({ error: "Invalid worry" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const rawCoverage = Array.isArray(body.coverage) ? body.coverage : [];
  const coverage = rawCoverage
    .map((c) => trim(c, 30))
    .filter((c): c is string => c !== null && VALID_COVERAGE.has(c));

  const adl = trim(body.adl_level, 30);
  if (!adl || !VALID_ADL.has(adl)) {
    return new Response(JSON.stringify({ error: "Invalid ADL level" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const role = trim(body.caregiver_role, 30);
  if (!role || !VALID_ROLES.has(role)) {
    return new Response(JSON.stringify({ error: "Invalid role" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const hospital = trim(body.hospital_system, 100);
  const state = deriveState(hospital);

  const email = trim(body.email, 254);
  const emailConsent = body.email_consent === true;
  if (email && !isValidEmail(email)) {
    return new Response(JSON.stringify({ error: "Invalid email" }), {
      status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const utmSource = trim(body.utm_source, 100);
  const utmMedium = trim(body.utm_medium, 100);
  const utmCampaign = trim(body.utm_campaign, 100);
  const referrer = trim(body.referrer, 500);
  const userAgent = req.headers.get("User-Agent")?.substring(0, 500) || null;

  const input: ScorecardInput = {
    loved_one_age_band: ageBand,
    conditions,
    current_tools: currentTools,
    biggest_worry: worry,
    coverage,
    adl_level: adl,
    hospital_system: hospital,
    caregiver_role: role,
    state,
  };
  const programs = generatePrograms(input);
  const signals = generateSignals(input);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  if (!supabaseUrl || !serviceKey) {
    return new Response(JSON.stringify({ error: "Server configuration error" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const insertRow = {
    loved_one_age_band: ageBand,
    conditions,
    current_tools: currentTools,
    biggest_worry: worry,
    coverage,
    adl_level: adl,
    hospital_system: hospital,
    caregiver_role: role,
    email: email && emailConsent ? email : null,
    email_consent: emailConsent,
    result_programs: programs,
    result_signals: signals,
    utm_source: utmSource,
    utm_medium: utmMedium,
    utm_campaign: utmCampaign,
    referrer,
    user_agent: userAgent,
    email_captured_at: email && emailConsent ? new Date().toISOString() : null,
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("scorecard2_responses")
    .insert(insertRow)
    .select("id")
    .single();

  if (insertErr) {
    console.error("scorecard2 insert error", insertErr);
    return new Response(JSON.stringify({ error: "Could not save your responses" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  if (email && emailConsent) {
    const sendWithTimeout = async () => {
      const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
      const smtpPort = 465;
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
        const programsHtml = programs.map((p) =>
          `<div style="margin: 24px 0; padding: 20px; background: #f7f5f1; border-left: 4px solid #2d6a4f; border-radius: 8px;">
             <h3 style="margin: 0 0 6px 0; font-family: 'Fraunces', Georgia, serif; font-weight: 500; font-size: 20px; color: #2d3a35;">${escHtml(p.name)}</h3>
             <p style="margin: 0 0 12px 0; font-family: 'DM Sans', system-ui, sans-serif; font-size: 16px; font-weight: 600; color: #2d6a4f;">${escHtml(p.amount)}</p>
             <p style="margin: 0 0 8px 0; font-family: 'DM Sans', system-ui, sans-serif; font-size: 14px; line-height: 1.5; color: #4a5550;"><strong>Why we matched:</strong> ${p.why.map(escHtml).join("; ")}</p>
             <p style="margin: 0 0 12px 0; font-family: 'DM Sans', system-ui, sans-serif; font-size: 13px; line-height: 1.5; color: #6f7d6b;"><em>${p.caveats.map(escHtml).join(" · ")}</em></p>
             <a href="${escHtml(p.link)}" style="display: inline-block; color: #2d6a4f; font-weight: 600; font-size: 14px; text-decoration: none;">${escHtml(p.cta_label)} →</a>
           </div>`
        ).join("");
        const signalsHtml = signals.length
          ? `<div style="margin: 40px 0 24px 0; padding-top: 24px; border-top: 1px solid #e0e6dc;">
               <p style="margin: 0 0 16px 0; font-family: 'Fraunces', Georgia, serif; font-size: 22px; font-weight: 500; color: #2d3a35;">While you handle the paperwork, Wellet watches the chart.</p>
               ${signals.map((s) =>
                 `<div style="margin: 12px 0;">
                    <p style="margin: 0 0 4px 0; font-family: 'DM Sans', system-ui, sans-serif; font-weight: 600; font-size: 15px; color: #2d3a35;">${escHtml(s.title)}</p>
                    <p style="margin: 0; font-family: 'DM Sans', system-ui, sans-serif; font-size: 14px; line-height: 1.5; color: #4a5550;">${escHtml(s.why)}</p>
                  </div>`).join("")}
             </div>`
          : "";
        await client.send({
          from: FROM_ADDRESS,
          to: email,
          subject: "Programs your family may qualify for",
          content: "auto",
          html:
            `<div style="max-width: 640px; margin: 0 auto; font-family: 'DM Sans', system-ui, sans-serif; color: #2d3a35;">
               <h1 style="font-family: 'Fraunces', Georgia, serif; font-weight: 400; font-size: 30px; line-height: 1.2; margin: 0 0 12px 0;">Programs your family may qualify for</h1>
               <p style="font-size: 16px; line-height: 1.6; color: #4a5550;">Based on what you shared, here are the caregiver-pay programs we matched. Eligibility varies — this is a starting list, not a guarantee.</p>
               ${programsHtml}
               ${signalsHtml}
               <div style="margin: 40px 0; text-align: center;">
                 <a href="https://mywellet.com/?utm_source=scorecard2&amp;utm_medium=email" style="display: inline-block; background: #2d6a4f; color: white; padding: 14px 28px; text-decoration: none; border-radius: 999px; font-weight: 600; font-size: 16px;">Try Wellet</a>
               </div>
               <p style="font-size: 12px; line-height: 1.6; color: #768078; margin-top: 32px;">Wellet does not pay caregivers. We aggregate your loved one's health records and surface programs that may pay for the care you're already giving. You're receiving this because you asked for your reimbursement scorecard at getwellet.com.</p>
             </div>`,
        });
        await client.close();
        await supabase
          .from("scorecard2_responses")
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
      const msg = smtpErr instanceof Error ? smtpErr.message : String(smtpErr);
      console.error("scorecard2 email send failed (non-fatal)", msg);
      try {
        await supabase
          .from("scorecard2_responses")
          .update({ email_error: msg.substring(0, 500) })
          .eq("id", inserted.id);
      } catch (_) { /* ignore */ }
    }
  }

  return new Response(
    JSON.stringify({
      id: inserted.id,
      programs,
      signals,
      email_sent: !!(email && emailConsent),
    }),
    {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
