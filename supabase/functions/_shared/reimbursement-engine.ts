// Reimbursement program-generation engine.
//
// Ported verbatim from getwellet's scorecard2-submit v2
// (scorecard2_submit_v2.ts) so the in-app mywellet "reimbursements" edge
// function and the public marketing scorecard produce the SAME program set
// for the same merged input. The logic below is the single source of truth
// within this repo; the public endpoint lives in the getwellet repo and
// must be kept byte-for-byte identical to this engine when either changes.
//
// Decision (PR 1): we vendor the engine into mywellet rather than calling
// getwellet's function with mode:"in_app", because the engine has no I/O —
// it is pure functions over a ScorecardInput — and importing it locally
// keeps the in-app path JWT-verified inside our own gateway without a
// cross-origin server-to-server hop. See spec "Option A".

// ---- Types ----

export interface Program {
  id: string;
  name: string;
  amount: string;
  confidence: "high" | "medium" | "low";
  why: string[];
  caveats: string[];
  link: string;
  cta_label: string;
}

export interface Signal {
  id: string;
  title: string;
  why: string;
}

export interface ScorecardInput {
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

// ---- Validation sets (shared with the prefill resolver) ----

export const VALID_AGE_BANDS = new Set([
  "under_60", "60_69", "70_79", "80_89", "90_plus", "prefer_not_say",
]);

export const VALID_CONDITIONS = new Set([
  "diabetes", "heart", "cancer", "dementia", "kidney", "lung",
  "mental_health", "mobility", "multiple", "none_known", "prefer_not_say",
]);

export const VALID_TOOLS = new Set([
  "mychart", "another_portal", "paper_notes", "spreadsheet", "memory", "shared_doc",
]);

export const VALID_WORRIES = new Set([
  "missing_something", "medication_changes", "appointment_chaos",
  "multiple_doctors", "declining_changes", "other",
]);

export const VALID_COVERAGE = new Set([
  "medicare", "medicaid", "veteran", "private", "marketplace", "none", "unsure",
]);

export const VALID_ADL = new Set([
  "none", "1_2", "3_plus", "supervision", "unsure",
]);

export const VALID_ROLES = new Set([
  "primary", "shared", "distance", "professional", "other",
]);

// ---- Hospital -> state derivation ----
//
// Light-touch keyword match on the free-text hospital field. Used to gate
// state-specific programs (currently just NC). Returns 2-letter state code
// or null. Be conservative — false positives gate the user into wrong
// programs, which is worse than no match.

const HOSPITAL_STATE_HINTS: Array<[RegExp, string]> = [
  // NC
  [/\b(duke|unc|atrium|novant|wakemed|cone|cape\s*fear|carolinas?\s*health|cone\s*health|firsthealth|cherokee\s*indian|mountain\s*area|wilson\s*medical|vidant|cleveland\s*regional|charlotte\s*radiology|wake\s*forest\s*baptist)\b/i, "NC"],
  // VA (state, not Veterans)
  [/\b(inova|valley\s*health|sentara|carilion|virginia\s*hospital|chesapeake\s*regional)\b/i, "VA"],
  // GA
  [/\b(emory|piedmont|wellstar|northside\s*atlanta|grady|augusta\s*university)\b/i, "GA"],
  // OH
  [/\b(cleveland\s*clinic|metrohealth|ohiohealth|university\s*hospitals\s*cleveland|mount\s*carmel|nationwide\s*children)\b/i, "OH"],
  // IN
  [/\b(indiana\s*university\s*health|iu\s*health|community\s*health\s*indiana|franciscan\s*indiana|parkview)\b/i, "IN"],
  // LA
  [/\b(ochsner|tulane|baton\s*rouge\s*general|louisiana\s*state\s*university\s*health)\b/i, "LA"],
  // MA
  [/\b(mass\s*general|mgh|brigham|tufts\s*medical|boston\s*medical|baystate|umass\s*memorial|lahey)\b/i, "MA"],
  // MO
  [/\b(barnes\s*jewish|bjc|mercy\s*missouri|university\s*of\s*missouri\s*health|cox\s*health|st\s*luke'?s\s*kansas\s*city)\b/i, "MO"],
  // NV
  [/\b(university\s*medical\s*center\s*of\s*southern\s*nevada|sunrise\s*hospital|valley\s*hospital\s*las\s*vegas|renown)\b/i, "NV"],
  // RI
  [/\b(rhode\s*island\s*hospital|miriam\s*hospital|landmark\s*medical|kent\s*hospital)\b/i, "RI"],
  // SD
  [/\b(sanford\s*sioux\s*falls|avera\s*mckennan|monument\s*health)\b/i, "SD"],
  // CT
  [/\b(yale\s*new\s*haven|hartford\s*hospital|connecticut\s*children|stamford\s*hospital)\b/i, "CT"],
];

const SFC_STATES = new Set([
  "CT", "GA", "IN", "LA", "MA", "MO", "NV", "NC", "OH", "RI", "SD",
]);

const SFC_SPOUSE_ELIGIBLE = new Set(["IN", "LA", "MO", "NV", "NC", "OH", "SD"]);

const SFC_STATE_DETAILS: Record<string, { name: string; rate: string }> = {
  CT: { name: "Connecticut Adult Family Living",       rate: "~$40–$60/day" },
  GA: { name: "Georgia Structured Family Caregiving",  rate: "~$80/day" },
  IN: { name: "Indiana Structured Family Caregiving",  rate: "~$40–$70/day" },
  LA: { name: "Louisiana Monitored In-Home Caregiving",rate: "~$40–$65/day" },
  MA: { name: "Massachusetts Adult Foster Care",       rate: "~$40–$70/day" },
  MO: { name: "Missouri Structured Family Caregiving", rate: "~$67/day (caregiver share)" },
  NV: { name: "Nevada Structured Family Caregiving",   rate: "~$40–$70/day" },
  NC: { name: "North Carolina Coordinated Caregiving (CAP/DA)", rate: "~$55–$85/day" },
  OH: { name: "Ohio Structured Family Caregiving",     rate: "~$40–$70/day" },
  RI: { name: "Rhode Island RIte @ Home",              rate: "~$40–$65/day" },
  SD: { name: "South Dakota Structured Family Caregiving", rate: "~$81–$113/day tiered" },
};

export function deriveState(hospital: string | null): string | null {
  if (!hospital) return null;
  for (const [re, st] of HOSPITAL_STATE_HINTS) {
    if (re.test(hospital)) return st;
  }
  return null;
}

// ---- Program generation ----

function isAge60Plus(band: string): boolean {
  return band === "60_69" || band === "70_79" || band === "80_89" || band === "90_plus";
}

function isAge65Plus(band: string): boolean {
  // age_band is the loved one — 65+ is reasonable proxy for 70_79+.
  // 60_69 contains both <65 and 65+; we treat it as ambiguous and include
  // them for GUIDE since most Medicare beneficiaries are 65+.
  return band === "70_79" || band === "80_89" || band === "90_plus" || band === "60_69";
}

export function generatePrograms(input: ScorecardInput): Program[] {
  const programs: Program[] = [];
  const coverage = new Set(input.coverage || []);
  const conditions = new Set(input.conditions || []);
  const adl = input.adl_level || "unsure";
  const heavyAdl = adl === "1_2" || adl === "3_plus" || adl === "supervision";
  const veryHeavyAdl = adl === "3_plus" || adl === "supervision";
  const state = input.state;
  const role = input.caregiver_role;
  const age = input.loved_one_age_band;

  // ---------- VA PCAFC ----------
  if (coverage.has("veteran") && heavyAdl) {
    const tier = veryHeavyAdl ? 2 : 1;
    const amount = tier === 2
      ? "Up to ~$3,034–$3,500/mo (Level 2)"
      : "Up to ~$1,896–$2,200/mo (Level 1)";
    const why = [
      "Your loved one is a veteran with VA-enrolled health care",
      veryHeavyAdl
        ? "They need supervision or help with 3+ activities of daily living — this typically triggers Level 2"
        : "They need help with 1–2 activities of daily living — this typically triggers Level 1",
    ];
    if (role === "primary" || role === "shared") {
      why.push("You're the primary or shared caregiver — PCAFC requires a designated Primary Family Caregiver");
    }
    programs.push({
      id: "pcafc",
      name: "VA PCAFC (Program of Comprehensive Assistance for Family Caregivers)",
      amount,
      confidence: veryHeavyAdl ? "high" : "medium",
      why,
      caveats: [
        "Veteran must have a 70%+ service-connected disability rating",
        "Stipend is tax-free; amount varies by tier and your zip's OPM GS-4 locality rate",
        "Includes CHAMPVA health insurance and mental-health support for the caregiver",
        "Application: 6–16 weeks to first payment (retroactive to eligibility date)",
      ],
      link: "https://www.va.gov/family-and-caregiver-benefits/health-and-disability/comprehensive-assistance-for-family-caregivers/",
      cta_label: "See if you qualify for PCAFC",
    });
  } else if (coverage.has("veteran")) {
    programs.push({
      id: "pcafc_general",
      name: "VA Caregiver Support (PGCSS)",
      amount: "Training, respite, peer support — no stipend",
      confidence: "medium",
      why: [
        "Your loved one has VA coverage",
        "The VA's Program of General Caregiver Support Services covers caregivers who don't meet PCAFC's 70% threshold",
      ],
      caveats: [
        "Less paperwork than PCAFC; no monthly stipend",
        "Includes Building Better Caregivers online course and caregiver support coordinator",
      ],
      link: "https://www.caregiver.va.gov/",
      cta_label: "Explore VA caregiver support",
    });
  }

  // ---------- CMS GUIDE ----------
  if (coverage.has("medicare") && conditions.has("dementia") && isAge65Plus(age)) {
    programs.push({
      id: "guide",
      name: "CMS GUIDE (Guiding an Improved Dementia Experience)",
      amount: "$2,500/yr respite + monthly care management for the practice",
      confidence: "high",
      why: [
        "Your loved one has Medicare and a dementia diagnosis",
        "GUIDE is built specifically for dementia families and their unpaid caregivers",
        "320+ participating organizations across 47 states as of May 2026",
      ],
      caveats: [
        "Requires Original Medicare (Parts A & B) — Medicare Advantage enrollees are NOT eligible",
        "Must be enrolled with a GUIDE-participating practice — see the CMS map",
        "Memory-care unit residents are excluded as of July 2026",
        "Respite is paid to a respite provider, not to you directly",
      ],
      link: "https://www.cms.gov/priorities/innovation/innovation-models/guide",
      cta_label: "Find a GUIDE-participating practice",
    });
  }

  // ---------- Medicaid SFC ----------
  if (coverage.has("medicaid") && veryHeavyAdl) {
    if (state && SFC_STATES.has(state)) {
      const det = SFC_STATE_DETAILS[state];
      const spouseOk = SFC_SPOUSE_ELIGIBLE.has(state);
      const why = [
        "Your loved one has Medicaid coverage",
        veryHeavyAdl ? "They need ≥3 ADLs or continuous supervision — SFC requires nursing-home-level need" : "They need significant ADL support",
        `${state} is one of 11 states with a Structured Family Caregiving waiver`,
      ];
      programs.push({
        id: "medicaid_sfc",
        name: det.name,
        amount: `${det.rate} (paid to caregiver in the home)`,
        confidence: "high",
        why,
        caveats: [
          "Caregiver and loved one typically must live in the same home",
          spouseOk
            ? `${state} permits a spouse to be the paid caregiver`
            : `${state} does NOT permit a spouse to be the paid caregiver`,
          "Daily rate is paid; first payment usually 30–60 days after enrollment",
          "Administered by Careforth (formerly Seniorlink) in most states",
        ],
        link: "https://careforth.com/structured-family-caregiving/",
        cta_label: "Apply for SFC in your state",
      });
    } else {
      // Medicaid + heavy ADL but state is unknown / not in SFC-11
      programs.push({
        id: "medicaid_sfc_general",
        name: "Medicaid Structured Family Caregiving (SFC)",
        amount: "~$40–$113/day depending on state",
        confidence: "medium",
        why: [
          "Your loved one has Medicaid coverage",
          "They need ≥3 ADLs or continuous supervision",
          "11 states currently run SFC: CT, GA, IN, LA, MA, MO, NV, NC, OH, RI, SD",
        ],
        caveats: [
          "Available only in: CT, GA, IN, LA, MA, MO, NV, NC, OH, RI, SD",
          "If you're not in one of those states, check your state's HCBS waivers — most have a self-directed option",
          "Caregiver and loved one typically must live in the same home",
        ],
        link: "https://careforth.com/structured-family-caregiving/",
        cta_label: "Check if your state has SFC",
      });
    }
  } else if (coverage.has("medicaid")) {
    programs.push({
      id: "medicaid_general",
      name: "Medicaid Self-Directed HCBS Waivers",
      amount: "Varies — many states pay family caregivers directly",
      confidence: "medium",
      why: [
        "Your loved one has Medicaid coverage",
        "Most states run at least one Home and Community-Based Services waiver",
        "Self-directed options often let family be paid as the caregiver",
      ],
      caveats: [
        "Each state has different waivers, waitlists, and rules",
        "Spouse eligibility varies — many states still exclude spouses",
      ],
      link: "https://www.medicaid.gov/medicaid/home-community-based-services/index.html",
      cta_label: "Find your state's HCBS waivers",
    });
  }

  // ---------- Medicare CTS (caregiver training) ----------
  if (coverage.has("medicare")) {
    const hasCareSignal = heavyAdl || conditions.size > 0;
    if (hasCareSignal) {
      programs.push({
        id: "cts",
        name: "Medicare Caregiver Training (G0541–G0543)",
        amount: "~$52 first 30 min; ~20% coinsurance applies",
        confidence: heavyAdl ? "high" : "medium",
        why: [
          "Your loved one has Medicare",
          conditions.size > 0
            ? "They have at least one chronic condition that benefits from structured caregiver training"
            : "They need ongoing care support",
          "G0541–G0543 codes activated January 2025 — any physician, NP, PT, OT or SLP can bill",
        ],
        caveats: [
          "Family pays ~20% coinsurance per session (~$10) unless covered by a Medigap or Medicare Advantage plan",
          "Must be ordered and documented in your loved one's care plan",
          "No prior authorization required",
        ],
        link: "https://www.cms.gov/medicare/payment/fee-schedules/physician",
        cta_label: "Ask your clinician to schedule CTS",
      });
    }
  }

  // ---------- NFCSP (first-class match for 60+) ----------
  if (isAge60Plus(age)) {
    programs.push({
      id: "nfcsp",
      name: "National Family Caregiver Support Program (NFCSP)",
      amount: "Respite vouchers + supplies, typically $500–$2,500/yr",
      confidence: heavyAdl ? "high" : "medium",
      why: [
        "Your loved one is 60 or older",
        "NFCSP is the federal respite and support program for caregivers of older adults",
        "FY2026 appropriation: $209M, delivered through ~650 local Area Agencies on Aging",
      ],
      caveats: [
        "Not a cash payment — services, vouchers, supplies, and counseling",
        "Funded first-come-first-served; some AAAs have waitlists",
        "Apply through your local AAA — eldercare.acl.gov or 1-800-677-1116",
      ],
      link: "https://eldercare.acl.gov/Public/Index.aspx",
      cta_label: "Find your local Area Agency on Aging",
    });
  }

  // ---------- NC state-specific (if state derived to NC) ----------
  if (state === "NC") {
    // Project C.A.R.E. — dementia-only, non-Medicaid
    if (conditions.has("dementia") && !coverage.has("medicaid")) {
      programs.push({
        id: "nc_project_care",
        name: "NC Project C.A.R.E. (Caregiver Alternatives to Running on Empty)",
        amount: "Up to $1,500/yr (3 × $500 respite vouchers)",
        confidence: "high",
        why: [
          "Your loved one is in North Carolina and has a dementia diagnosis",
          "Project C.A.R.E. is 100% NC-state-funded — built for the non-Medicaid gap population",
        ],
        caveats: [
          "Dementia diagnosis required",
          "Vouchers are reimbursement-based — you pay the respite provider first, then submit receipts",
          "Apply through the NC Division of Aging and Adult Services",
        ],
        link: "https://www.ncdhhs.gov/divisions/aging/services-elderly-and-individuals-disabilities/project-care",
        cta_label: "Apply for Project C.A.R.E.",
      });
    }

    // NC Lifespan Respite — any age, any condition
    programs.push({
      id: "nc_lifespan_respite",
      name: "NC Lifespan Respite Voucher Program",
      amount: "Up to $750/yr reimbursement",
      confidence: "medium",
      why: [
        "Your loved one is in North Carolina",
        "Lifespan Respite covers any care need at any age (not limited to seniors or a specific diagnosis)",
      ],
      caveats: [
        "Reimbursement-based — you pay for respite care first, then submit receipts",
        "Funds run out each fiscal year — apply early in the cycle (July onward)",
        "Administered through the NC Lifespan Respite Project at the ARC of NC",
      ],
      link: "https://www.arcnc.org/services/lifespan-respite",
      cta_label: "Apply for Lifespan Respite vouchers",
    });
  }

  // ---------- Private/marketplace caregiver benefits ----------
  if ((coverage.has("private") || coverage.has("marketplace")) && heavyAdl) {
    programs.push({
      id: "private_caregiver_benefits",
      name: "Private insurance + employer caregiver benefits",
      amount: "Varies — respite hours, navigation, sometimes cash",
      confidence: "low",
      why: [
        "Your loved one has private or marketplace coverage",
        "Many employer plans now include eldercare benefits (Cariloop, Wellthy, Homethrive)",
      ],
      caveats: [
        "Coverage varies widely — check the benefits handbook or HR portal",
        "Often delivered as a third-party navigator, not a direct payment",
      ],
      link: "https://www.kff.org/medicare/issue-brief/private-insurance-caregiver-benefits/",
      cta_label: "Check your plan's eldercare benefits",
    });
  }

  // ---------- Fallback: if nothing matched, still give them NFCSP ----------
  if (programs.length === 0) {
    programs.push({
      id: "aaa_respite",
      name: "Local Area Agency on Aging (AAA) respite + family caregiver supports",
      amount: "Varies — typically $500–$2,500 per family per year",
      confidence: "medium",
      why: [
        "Every county in the US has an Area Agency on Aging",
        "Most AAAs administer respite vouchers and caregiver supports for any age or condition",
      ],
      caveats: [
        "Funding is limited and often awarded first-come-first-served",
        "Grants are typically one-time, not ongoing monthly payments",
      ],
      link: "https://eldercare.acl.gov/Public/Index.aspx",
      cta_label: "Find your local AAA",
    });
  }

  // Order: highest dollar value first (PCAFC, SFC, GUIDE) — preserve
  // insertion order which already matches that, then cap at 5.
  return programs.slice(0, 5);
}

export function generateSignals(input: ScorecardInput): Signal[] {
  const signals: Signal[] = [];
  const conditions = new Set(input.conditions || []);

  signals.push({
    id: "witness",
    title: "A second pair of eyes on every appointment",
    why:
      "While you handle the paperwork for reimbursement programs, Wellet " +
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
