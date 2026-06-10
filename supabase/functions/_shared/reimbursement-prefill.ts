// Reimbursement prefill resolver.
//
// Pure functions that derive ScorecardInput fields from the loved-one
// record (people row), active EHR connections, and the caregiver's
// care-circle role — then merge the caregiver's just-answered partial_input
// on top. Records per-field provenance ("ehr" | "user" | "inferred" |
// "asked") so the UI can show "we filled this from the chart" vs "you told
// us", and so we know which fields still need to be asked.
//
// No I/O here — the edge function fetches the rows and passes them in. That
// keeps this unit-testable against fixtures with no Supabase client.
//
// PR 1 scope (per spec): conditions come from people.conditions free text +
// manual user confirmation. ICD-10 / chart problem-list mapping is PR 2.

import {
  deriveState,
  ScorecardInput,
  VALID_ADL,
  VALID_AGE_BANDS,
  VALID_CONDITIONS,
  VALID_COVERAGE,
  VALID_ROLES,
  VALID_TOOLS,
  VALID_WORRIES,
} from "./reimbursement-engine.ts";

export type Provenance = "ehr" | "user" | "inferred" | "asked";

export interface PersonRow {
  id: string;
  date_of_birth?: string | null;
  conditions?: string | null;      // free-text
  insurance_info?: string | null;  // free-text
}

export interface EhrConnectionRow {
  hospital_name?: string | null;
  connected_provider?: string | null;
  provider?: string | null;
  status?: string | null;
}

export interface ResolverContext {
  person: PersonRow;
  ehrConnections: EhrConnectionRow[];
  careCircleRole?: string | null;     // care_circle_members.role for this user
  soleCareCircleMember?: boolean;     // user is the only care-circle member
}

export interface PartialInput {
  loved_one_age_band?: string | null;
  conditions?: string[] | null;
  current_tools?: string[] | null;
  biggest_worry?: string | null;
  coverage?: string[] | null;
  adl_level?: string | null;
  hospital_system?: string | null;
  caregiver_role?: string | null;
  state?: string | null;
}

export interface ResolveResult {
  input: ScorecardInput;
  provenance: Record<string, Provenance>;
  prefilled_fields: string[];  // fields we filled from chart/profile (not asked)
  asked_fields: string[];      // fields we still need the caregiver to answer
}

// ---- Field-level derivation helpers ----

// people.date_of_birth (YYYY-MM-DD) -> age band enum.
export function ageBandFromDob(dob: string | null | undefined): string | null {
  if (!dob) return null;
  const birth = new Date(dob);
  if (isNaN(birth.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const m = now.getMonth() - birth.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < birth.getDate())) age--;
  if (age < 60) return "under_60";
  if (age <= 69) return "60_69";
  if (age <= 79) return "70_79";
  if (age <= 89) return "80_89";
  return "90_plus";
}

// people.conditions free text -> subset of the 11-value condition enum.
// Conservative keyword match; the UI always lets the caregiver add/remove.
const CONDITION_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(diabet|a1c|insulin)\b/i, "diabetes"],
  [/\b(heart|cardiac|chf|afib|coronary|hypertension|high blood pressure)\b/i, "heart"],
  [/\b(cancer|oncolog|tumor|chemo|carcinoma|lymphoma|leukemia)\b/i, "cancer"],
  [/\b(dementia|alzheimer|cognitive|memory loss)\b/i, "dementia"],
  [/\b(kidney|renal|ckd|dialysis|egfr)\b/i, "kidney"],
  [/\b(lung|copd|pulmonary|asthma|emphysema)\b/i, "lung"],
  [/\b(depress|anxiety|mental health|bipolar|psych)\b/i, "mental_health"],
  [/\b(mobility|fall|walker|wheelchair|gait|fracture)\b/i, "mobility"],
];

export function conditionsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [re, slug] of CONDITION_KEYWORDS) {
    if (re.test(text)) found.add(slug);
  }
  const arr = Array.from(found);
  // If we matched 3+ distinct conditions, the v2 engine prefers "multiple".
  if (arr.length >= 3) return ["multiple"];
  return arr;
}

// people.insurance_info free text -> subset of the coverage enum.
const COVERAGE_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(veteran|va\b|tricare|champva|military)\b/i, "veteran"],
  [/\bmedicaid\b/i, "medicaid"],
  [/\bmedicare\b/i, "medicare"],
  [/\b(marketplace|aca|obamacare|healthcare\.gov)\b/i, "marketplace"],
  [/\b(blue cross|aetna|cigna|united\s*health|humana|kaiser|private|employer)\b/i, "private"],
];

export function coverageFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const found = new Set<string>();
  for (const [re, slug] of COVERAGE_KEYWORDS) {
    if (re.test(text)) found.add(slug);
  }
  return Array.from(found);
}

// Active EHR connections -> a single hospital_system label for state
// derivation. Prefer an explicit hospital_name; fall back to the provider.
export function hospitalFromConnections(conns: EhrConnectionRow[]): string | null {
  const active = (conns || []).filter((c) => !c.status || c.status === "connected");
  for (const c of active) {
    const label = c.hospital_name || c.connected_provider || c.provider;
    if (label && label.trim()) return label.trim();
  }
  return null;
}

// care_circle_members.role (primary|secondary|emergency) -> scorecard role
// enum (primary|shared|distance|professional|other). "secondary" maps to
// "shared"; "emergency" has no scorecard analogue so we still ask.
export function caregiverRoleFromCareCircle(
  role: string | null | undefined,
  soleMember: boolean | undefined,
): string | null {
  if (soleMember) return "primary";
  if (!role) return null;
  if (role === "primary") return "primary";
  if (role === "secondary") return "shared";
  return null;
}

// ---- Top-level resolver ----

function pickArray(partial: string[] | null | undefined, valid: Set<string>): string[] | null {
  if (!Array.isArray(partial)) return null;
  const cleaned = partial
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v && valid.has(v));
  return cleaned.length ? cleaned : (partial.length ? [] : null);
}

function pickScalar(partial: string | null | undefined, valid: Set<string>): string | null {
  if (typeof partial !== "string") return null;
  const t = partial.trim();
  return t && valid.has(t) ? t : null;
}

// Resolve all 9 fields. The caregiver's partial_input always wins (provenance
// "user"); otherwise we derive from chart/profile (provenance "ehr"/"inferred")
// or leave the field empty and mark it "asked".
export function resolvePrefill(
  ctx: ResolverContext,
  partial: PartialInput,
): ResolveResult {
  const provenance: Record<string, Provenance> = {};
  const prefilled: string[] = [];
  const asked: string[] = [];

  // age band: dob -> ask
  let ageBand = pickScalar(partial.loved_one_age_band, VALID_AGE_BANDS);
  if (ageBand) { provenance.loved_one_age_band = "user"; }
  else {
    ageBand = ageBandFromDob(ctx.person.date_of_birth);
    if (ageBand) { provenance.loved_one_age_band = "ehr"; prefilled.push("loved_one_age_band"); }
    else { asked.push("loved_one_age_band"); }
  }

  // conditions: user -> people.conditions text -> ask
  let conditions = pickArray(partial.conditions, VALID_CONDITIONS);
  if (conditions) { provenance.conditions = "user"; }
  else {
    conditions = conditionsFromText(ctx.person.conditions);
    if (conditions.length) { provenance.conditions = "ehr"; prefilled.push("conditions"); }
    else { conditions = []; asked.push("conditions"); }
  }

  // current_tools: always ask
  let tools = pickArray(partial.current_tools, VALID_TOOLS);
  if (tools) { provenance.current_tools = "user"; }
  else { tools = []; asked.push("current_tools"); }

  // biggest_worry: always ask
  let worry = pickScalar(partial.biggest_worry, VALID_WORRIES);
  if (worry) { provenance.biggest_worry = "user"; }
  else { asked.push("biggest_worry"); }

  // coverage: user -> insurance_info text (inferred, confirm) -> ask
  let coverage = pickArray(partial.coverage, VALID_COVERAGE);
  if (coverage) { provenance.coverage = "user"; }
  else {
    coverage = coverageFromText(ctx.person.insurance_info);
    if (coverage.length) { provenance.coverage = "inferred"; prefilled.push("coverage"); }
    else { coverage = []; asked.push("coverage"); }
  }

  // adl_level: always ask
  let adl = pickScalar(partial.adl_level, VALID_ADL);
  if (adl) { provenance.adl_level = "user"; }
  else { asked.push("adl_level"); }

  // hospital_system: user -> ehr_connections -> ask
  let hospital: string | null = (typeof partial.hospital_system === "string" && partial.hospital_system.trim())
    ? partial.hospital_system.trim().substring(0, 100)
    : null;
  if (hospital) { provenance.hospital_system = "user"; }
  else {
    hospital = hospitalFromConnections(ctx.ehrConnections);
    if (hospital) { provenance.hospital_system = "ehr"; prefilled.push("hospital_system"); }
    else { asked.push("hospital_system"); }
  }

  // caregiver_role: user -> care_circle_members.role -> ask
  let role = pickScalar(partial.caregiver_role, VALID_ROLES);
  if (role) { provenance.caregiver_role = "user"; }
  else {
    role = caregiverRoleFromCareCircle(ctx.careCircleRole, ctx.soleCareCircleMember);
    if (role) { provenance.caregiver_role = ctx.soleCareCircleMember ? "inferred" : "ehr"; prefilled.push("caregiver_role"); }
    else { asked.push("caregiver_role"); }
  }

  // state: user -> derived from hospital_system -> ask
  let state: string | null = (typeof partial.state === "string" && partial.state.trim())
    ? partial.state.trim().toUpperCase().substring(0, 2)
    : null;
  if (state) { provenance.state = "user"; }
  else {
    state = deriveState(hospital);
    if (state) { provenance.state = "inferred"; prefilled.push("state"); }
    else { asked.push("state"); }
  }

  const input: ScorecardInput = {
    loved_one_age_band: ageBand || "prefer_not_say",
    conditions: conditions || [],
    current_tools: tools || [],
    biggest_worry: worry || "other",
    coverage: coverage || [],
    adl_level: adl || "unsure",
    hospital_system: hospital,
    caregiver_role: role || "other",
    state,
  };

  return { input, provenance, prefilled_fields: prefilled, asked_fields: asked };
}
