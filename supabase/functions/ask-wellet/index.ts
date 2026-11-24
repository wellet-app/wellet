// ask-wellet v49 — a loved one's shared Apple Health, when they allowed it.
//
//   Not own profile: APPLE HEALTH includes only rows that came through an
//   active sharing link whose sharer turned on "Let Ask Wellet use what I
//   share" (person_data_links.ai_allowed_at set). Rows with no link_id
//   (older uploads) are never read for a loved one. Needs
//   include_shared_apple_health: true as well, which only clients showing
//   the v3 permission wording send.
//
// ask-wellet v48 — own profile (is_self) answers say "you" and "your".
//
// ask-wellet v41 — Apple Health only with consent; honest live_ehr.
//
//   include_apple_health: true   adds the APPLE HEALTH section. Opt-in per
//     request because the privacy policy (2026-11-13) and the iOS AI
//     permission sheet said Apple Health readings are never sent to an AI
//     service. Only a client that has shown the updated permission wording
//     sends this flag. Absent or false: Apple Health is not read at all.
//     Own profile (people.is_self) only for now: a loved one's readings
//     come through a sharing link whose screens don't mention AI.
//   live_ehr   true only when the record sent to the model includes rows
//     that came from a connected health system (Epic, Cerner, VA, ...).
//     v39/v40 returned true whenever the person existed, so every answer
//     showed "Connected health system".
//   apple_health   true when the APPLE HEALTH section had data.
//
// ask-wellet v40 — reads Apple Health (wearable_observations) as well as
// the chart. v39 never read that table, so Ask Wellet said "the chart
// doesn't mention Apple Health" even with samples on file. See appleHealth.ts.
//
// ask-wellet v39 — person-centric rewrite, Azure GPT-4o, real schema
//
// Replaces v25/v38 which queried a fossil hospital-ICU schema (patients,
// patient_vitals, patient_medications, patient_diagnoses, patient_notes,
// contacts, care_plans). None of those tables exist in production. Every
// request returned 400.
//
// Client contract (UNCHANGED — see wellet.js:21881-21912):
//
//   Answer mode (default):
//     Request:  { question, person_id, context?, history?: [{role,content}],
//                 conversation_id? }
//     Response: { answer, model, live_ehr, classification, conversation_id }
//                 classification ∈ "lookup" | "observation" | "prep" | "other"
//
//   Watch mode (mode === "watch"):
//     Request:  { mode: "watch", text, person_id, context? }
//     Response: { kind: "watch_proposal", watch_type, parameters,
//                 description, confidence, reason? }
//             | { kind: "watch_rejected", reason }
//
// Backward compat: legacy clients sending `patient_id` still work — we accept
// either key. New clients should send `person_id`.
//
// Schema (real, person-centric):
//   people:           id, user_id, name, date_of_birth, relationship,
//                     situation, is_self, conditions (text), allergies (text),
//                     primary_doctor, care_status
//   medications:      id, person_id, name, dose, frequency, prescriber,
//                     start_date, end_date, active, source, ehr_system
//   vitals:           id, person_id, vital_type, value, unit, effective_date,
//                     loinc_code, source
//   lab_results:      id, person_id, test_name, value, unit, reference_range,
//                     status, effective_date, loinc_code, category
//   allergies:        id, person_id, substance, reaction, severity,
//                     clinical_status, onset_date
//   medication_logs:  id, medication_id, person_id, taken_at, status, notes
//   documents:        id, person_id, file_name, document_type,
//                     extracted_events (jsonb), uploaded_at
//
// Voice + accuracy rules: see system prompt. Wellet COO hard rules apply —
// no "track / monitor / surveillance / alerts / HIPAA-compliant claim /
// earn / guaranteed", say "loved one" not "parent", and never let the model
// invent clinical facts. Chart data is authoritative; for anything not in
// the chart, say so.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createClient,
  SupabaseClient,
} from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { aiChat } from "./azureOpenAI.ts";
import { meterAi, jwtSub } from "./meter.ts";
import { buildAppleHealthSection, fetchAppleHealth } from "./appleHealth.ts";
import type { AppleHealthData } from "./appleHealth.ts";
import { countLastHour, isPaused, PAUSE_MESSAGE, pauseThreshold } from "./pause.ts";

const VERSION = "41";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ──────────────────────────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────────────────────────
type MessageRole = "system" | "user" | "assistant";

interface HistoryMessage {
  role: MessageRole;
  content: string;
}

interface RequestBody {
  question?: string;
  text?: string; // watch-mode alias
  person_id?: string;
  patient_id?: string; // legacy alias
  mode?: "answer" | "watch";
  history?: HistoryMessage[];
  context?: string;
  conversation_id?: string;
  include_apple_health?: boolean;
  include_shared_apple_health?: boolean;
}

interface WatchProposal {
  kind: "watch_proposal";
  watch_type: string;
  parameters: Record<string, unknown>;
  description: string;
  confidence: number;
  reason?: string;
}

interface WatchRejected {
  kind: "watch_rejected";
  reason: string;
}

interface PersonData {
  person: Record<string, unknown>;
  meds: Record<string, unknown>[];
  vitals: Record<string, unknown>[];
  labs: Record<string, unknown>[];
  allergies: Record<string, unknown>[];
  medLogs: Record<string, unknown>[];
  documents: Record<string, unknown>[];
  appleHealth: AppleHealthData;
  appleHealthRequested: boolean;
  liveEhr: boolean;
}

// ──────────────────────────────────────────────────────────────────────────────
// Data fetch
// ──────────────────────────────────────────────────────────────────────────────
// Sources that mean "came from a connected health system". Manual entry,
// document extraction, Terra and Apple Health are not.
const EHR_SOURCES = new Set(["ehr", "epic", "cerner", "oracle", "oracle_cerner", "va", "va_lighthouse", "oneup", "1up", "fhir"]);

function fromHealthSystem(row: Record<string, unknown>): boolean {
  if (row.ehr_system) return true;
  const src = String(row.source ?? "").toLowerCase();
  return EHR_SOURCES.has(src);
}

async function fetchPersonData(
  supabase: SupabaseClient,
  personId: string,
  includeAppleHealth: boolean,
  includeShared = false,
): Promise<PersonData> {
  const [
    personRes,
    medsRes,
    vitalsRes,
    labsRes,
    allergiesRes,
    medLogsRes,
    documentsRes,
  ] = await Promise.all([
    supabase
      .from("people")
      .select(
        "id, user_id, name, date_of_birth, relationship, situation, is_self, conditions, allergies, primary_doctor, care_status, apple_health_last_sync_at",
      )
      .eq("id", personId)
      .maybeSingle(),
    supabase
      .from("medications")
      .select(
        "id, name, dose, frequency, prescriber, start_date, end_date, active, source, ehr_system",
      )
      .eq("person_id", personId)
      .eq("active", true)
      .order("start_date", { ascending: false })
      .limit(60),
    supabase
      .from("vitals")
      .select("vital_type, value, unit, effective_date, source")
      .eq("person_id", personId)
      .order("effective_date", { ascending: false })
      .limit(40),
    supabase
      .from("lab_results")
      .select(
        "test_name, value, unit, reference_range, status, effective_date, category, source",
      )
      .eq("person_id", personId)
      .order("effective_date", { ascending: false })
      .limit(40),
    supabase
      .from("allergies")
      .select("substance, reaction, severity, clinical_status, onset_date, source")
      .eq("person_id", personId)
      .limit(20),
    supabase
      .from("medication_logs")
      .select("medication_id, taken_at, status, notes")
      .eq("person_id", personId)
      .order("taken_at", { ascending: false })
      .limit(20),
    supabase
      .from("documents")
      .select("file_name, document_type, extracted_events, uploaded_at")
      .eq("person_id", personId)
      .order("uploaded_at", { ascending: false })
      .limit(15),
  ]);

  // Own profile: the caregiver's own readings. A loved one: only what came
  // through a sharing link whose sharer allowed Ask Wellet (v49).
  const isSelf = personRes.data?.is_self === true;
  let allowedLinkIds: string[] | undefined;
  if (includeAppleHealth && includeShared && personRes.data && !isSelf) {
    const { data: links, error: linkErr } = await supabase
      .from("person_data_links")
      .select("id")
      .eq("person_id", personId)
      .is("revoked_at", null)
      .not("ai_allowed_at", "is", null);
    if (linkErr) console.warn("sharing links read failed:", linkErr.message);
    allowedLinkIds = (links ?? []).map((l: { id: string }) => l.id);
  }
  const appleHealthAllowed = includeAppleHealth &&
    (isSelf || (allowedLinkIds?.length ?? 0) > 0);
  const appleHealth = personRes.data && appleHealthAllowed
    ? await fetchAppleHealth(
      supabase,
      personId,
      (personRes.data.apple_health_last_sync_at as string | null) ?? null,
      new Date(),
      isSelf ? undefined : allowedLinkIds,
    )
    : { summaries: [], lastSyncAt: null };

  return {
    person: personRes.data ?? {},
    meds: medsRes.data ?? [],
    vitals: vitalsRes.data ?? [],
    labs: labsRes.data ?? [],
    allergies: allergiesRes.data ?? [],
    medLogs: medLogsRes.data ?? [],
    documents: documentsRes.data ?? [],
    appleHealth,
    appleHealthRequested: appleHealthAllowed,
    liveEhr: [
      ...(medsRes.data ?? []),
      ...(vitalsRes.data ?? []),
      ...(labsRes.data ?? []).slice(0, 20),
      ...(allergiesRes.data ?? []),
    ].some((row) => fromHealthSystem(row as Record<string, unknown>)),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Context builder — caregiver-facing, person-centric
// ──────────────────────────────────────────────────────────────────────────────
function fmtDate(d: unknown): string {
  if (!d) return "unknown";
  try {
    return new Date(d as string).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return String(d);
  }
}

function buildPersonContext(data: PersonData): string {
  const sections: string[] = [];
  const p = data.person;

  // Person
  if (p && Object.keys(p).length) {
    const rel = p.is_self ? "self" : (p.relationship as string) ?? "loved one";
    const lines = [
      `Name: ${p.name ?? "unknown"}`,
      `Date of birth: ${fmtDate(p.date_of_birth)}`,
      `Relationship to caregiver: ${rel}`,
    ];
    if (p.situation) lines.push(`Situation: ${p.situation}`);
    if (p.care_status) lines.push(`Care status: ${p.care_status}`);
    if (p.primary_doctor) lines.push(`Primary doctor: ${p.primary_doctor}`);
    if (p.conditions) lines.push(`Conditions on file: ${p.conditions}`);
    if (p.allergies) lines.push(`Allergies on file (free text): ${p.allergies}`);
    sections.push(`PERSON:\n${lines.join("\n")}`);
  } else {
    sections.push(`PERSON:\n(no person record found for this id)`);
  }

  // Structured allergies
  if (data.allergies.length) {
    const rows = data.allergies.map(
      (a) =>
        `  - ${a.substance ?? "unknown"}: ${a.reaction ?? "reaction unknown"} (severity: ${a.severity ?? "unknown"}, status: ${a.clinical_status ?? "unknown"}, since: ${fmtDate(a.onset_date)})`,
    );
    sections.push(`ALLERGIES (structured):\n${rows.join("\n")}`);
  }

  // Active medications
  if (data.meds.length) {
    const rows = data.meds.map(
      (m) =>
        `  - ${m.name ?? "unknown"} ${m.dose ?? ""} ${m.frequency ?? ""} (prescriber: ${m.prescriber ?? "unknown"}, since: ${fmtDate(m.start_date)}, source: ${m.source ?? m.ehr_system ?? "unknown"})`,
    );
    sections.push(`ACTIVE MEDICATIONS (${data.meds.length}):\n${rows.join("\n")}`);
  }

  // Recent vitals (group by type, newest first)
  if (data.vitals.length) {
    const byType: Record<string, Record<string, unknown>[]> = {};
    for (const v of data.vitals) {
      const t = String(v.vital_type ?? "unknown");
      (byType[t] ??= []).push(v);
    }
    const blocks = Object.entries(byType).map(([type, rows]) => {
      const top = rows.slice(0, 5).map(
        (v) =>
          `    ${fmtDate(v.effective_date)}: ${v.value ?? "--"} ${v.unit ?? ""}`.trimEnd(),
      );
      return `  ${type}:\n${top.join("\n")}`;
    });
    sections.push(`RECENT VITALS (newest first, top 5 per type):\n${blocks.join("\n")}`);
  }

  // Recent labs
  if (data.labs.length) {
    const rows = data.labs.slice(0, 20).map((l) => {
      const ref = l.reference_range ? ` ref ${l.reference_range}` : "";
      const status = l.status ? ` [${l.status}]` : "";
      return `  - ${fmtDate(l.effective_date)} ${l.test_name ?? "unknown"}: ${l.value ?? "--"} ${l.unit ?? ""}${ref}${status}`;
    });
    sections.push(`RECENT LAB RESULTS (newest first, top 20):\n${rows.join("\n")}`);
  }

  // Medication logs (caregiver check-ins)
  if (data.medLogs.length) {
    const rows = data.medLogs.slice(0, 10).map(
      (l) =>
        `  - ${fmtDate(l.taken_at)}: ${l.status ?? "logged"}${l.notes ? ` — ${String(l.notes).slice(0, 120)}` : ""}`,
    );
    sections.push(`RECENT MEDICATION LOGS:\n${rows.join("\n")}`);
  }

  // Documents (extracted events surface as light signals)
  if (data.documents.length) {
    const rows = data.documents.slice(0, 10).map((d) => {
      const events = Array.isArray(d.extracted_events)
        ? (d.extracted_events as unknown[]).length
        : 0;
      return `  - ${fmtDate(d.uploaded_at)} ${d.document_type ?? "document"}: ${d.file_name ?? "unnamed"} (${events} extracted event${events === 1 ? "" : "s"})`;
    });
    sections.push(`DOCUMENTS ON FILE:\n${rows.join("\n")}`);
  }

  // Apple Health (phone and watch samples, rolled up by day)
  const appleHealth = buildAppleHealthSection(data.appleHealth);
  if (appleHealth) {
    sections.push(appleHealth);
  } else if (data.appleHealthRequested) {
    sections.push(`APPLE HEALTH:\n(no Apple Health data shared for this person in the last 30 days)`);
  } else {
    sections.push(`APPLE HEALTH:\n(not included. This version of Wellet does not send Apple Health readings to Ask Wellet. They can be seen in the Wellet app.)`);
  }

  return sections.join("\n\n");
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompts
// ──────────────────────────────────────────────────────────────────────────────
function buildAnswerPrompt(
  question: string,
  personContext: string,
  history: HistoryMessage[],
  extraContext: string | undefined,
  isSelf = false,
): { system: string; messages: HistoryMessage[] } {
  const selfRule = isSelf
    ? `
Who you're talking to (HARD):
- This is the user's own record, not a loved one's. Speak to them directly as "you" and "your": "your sleep," "your records," "your care team." Never refer to them in the third person, by name or as "she," "he," "her" or "his."
`
    : "";
  const system = `You are Wellet, an AI assistant that helps a family caregiver understand their loved one's medical record.
${selfRule}
Your answers are grounded in the data below. It has two parts: the medical record (people, medications, vitals, labs, allergies, documents) and, when shared, an APPLE HEALTH section with daily values from an iPhone or Apple Watch. Both are real data for this person. Never contradict them, never invent values that aren't there, and never speculate about clinical interpretation.

Apple Health rules:
- When the question is about Apple Health, a watch or phone, activity, steps, sleep, heart rate, blood oxygen, breathing, walking or falls, answer from the APPLE HEALTH section. Give the actual numbers and dates.
- Say it comes from Apple Health. Don't call it part of the medical chart, and don't call a watch reading a clinical measurement.
- Describe what the numbers show over time (for example, higher or lower than earlier in the month). Leave what it means medically to the care team.
- If the APPLE HEALTH section says no data was shared, say so and mention it can be connected in Wellet.
- If the APPLE HEALTH section says it was not included, say Ask Wellet can't see Apple Health readings yet, and that they show in the Wellet app. Don't say there is no Apple Health data.

Accuracy rules (HARD):
- If neither the record nor Apple Health contains the answer, say so plainly. "That isn't in the record" is a complete, correct answer.
- Never invent medication names, lab values, dosages, dates, or codes (ICD, CPT, LOINC, NDC).
- Distinguish: what the chart shows vs. what is inferred vs. what is unknown.
- For clinical interpretation (what a value "means," whether a dose is right, what a diagnosis implies), tell the caregiver to ask the care team directly.
- Never present a billing or eligibility claim as certain. Use "may," "likely," "worth confirming."

Voice rules (HARD):
- Forbidden words: track, tracks, tracking, monitor, monitoring, surveillance, keep tabs on, alerts (in a product sense), HIPAA compliant (as a claim), earn, guaranteed.
- Say "loved one," not "parent."
- Do not start sentences with "I will," "I'll," "I can," "I'm," "I've."
- Do not use the word "note" or "noted."
- Use contractions: don't, isn't, can't.
- No exclamation points, no emojis, American English.
- Plain language. If a medical term is needed, define it briefly.
- This may be read aloud. Avoid markdown, bullet points, numbered lists, headers, or code fences. Write in short sentences.

${extraContext ? `Additional context from the caregiver:\n${extraContext}\n\n` : ""}--- DATA ---
${personContext}
--- END DATA ---`;

  const messages: HistoryMessage[] = [];
  for (const msg of history) {
    if (msg.role === "user" || msg.role === "assistant") {
      messages.push({ role: msg.role, content: msg.content });
    }
  }
  messages.push({ role: "user", content: question });

  return { system, messages };
}

function buildWatchPrompt(question: string): {
  system: string;
  messages: HistoryMessage[];
} {
  const system = `You are Wellet's watch-request parser. A family caregiver is asking to be notified about something. Decide:

1. Can Wellet safely turn this into a passive notification?
2. If yes, emit a structured JSON watch_proposal.
3. If no, emit watch_rejected with a plain-English reason.

SUPPORTED WATCH TYPES (v1):

"vital_threshold" — fires when a vital reading crosses a numeric threshold.
  parameters: { vital: string, operator: "gt"|"lt"|"gte"|"lte", threshold: number, unit?: string }
  vital values: blood_pressure_systolic, blood_pressure_diastolic, heart_rate,
                temperature_f, temperature_c, oxygen_saturation, respiratory_rate,
                weight_kg, weight_lbs, pain_score
  example: "let me know if her heart rate goes above 100"

"vital_absence" — fires if no vitals have been recorded in N hours.
  parameters: { hours: number }
  example: "let me know if vitals haven't been recorded in 6 hours"

"new_medication" — fires when a new med is added or an existing one changes.
  parameters: {} (optionally: { medication_name: string })
  example: "let me know if a new medication is prescribed"

"new_document" — fires when a new document is uploaded.
  parameters: {} (optionally: { document_type: string })
  example: "let me know when a new visit summary is uploaded"

HARD REJECT — never turn these into a watch:
- Lab values or lab thresholds (A1c, glucose, creatinine, etc.)
- Dosing questions or med-error scenarios
- Diagnosis changes or clinical-state claims
- Anything requiring clinical interpretation
- Multi-condition logic ("notify me if X AND Y")
- Anything Wellet doesn't actually have data for

OUTPUT — return ONLY raw JSON, no markdown, no code fences, no commentary.

On success:
{"kind":"watch_proposal","watch_type":"<type>","parameters":{<params>},"description":"<one sentence>","confidence":<0.0-1.0>}

On reject:
{"kind":"watch_rejected","reason":"<one or two sentences, plain English, no jargon>"}

The description should be phrased as a confirmation to the caregiver, e.g.
  "You'll get a notification if her heart rate goes above 100 bpm."
  "You'll get a notification when a new medication is added."
`;

  return {
    system,
    messages: [{ role: "user", content: question }],
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// Classification (lookup / observation / prep / other)
// ──────────────────────────────────────────────────────────────────────────────
async function classifyQuestion(
  question: string,
  meterUserId?: string | null,
  meterPersonId?: string | null,
): Promise<"lookup" | "observation" | "prep" | "other"> {
  const system = `Classify the caregiver's question into one of four categories.

Categories:
- lookup: factual question about the chart, meds, vitals, labs, schedule. Examples: "what are her active medications", "when was his last A1c"
- observation: caregiver sharing an observation or concern. Examples: "she seems confused today", "he hasn't eaten since this morning"
- prep: caregiver preparing for an upcoming event. Examples: "her cardiology appointment is tomorrow, what should I ask", "we have a follow-up next week"
- other: everything else.

Return ONLY the category word — no punctuation, no explanation.`;

  try {
    const res = await aiChat({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: question },
      ],
      max_tokens: 4,
      temperature: 0,
      phi: false,
    });
    meterAi(res, { feature: "ask_classify", userId: meterUserId, personId: meterPersonId });
    const raw = res.content.trim().toLowerCase().replace(/[^a-z]/g, "");
    if (["lookup", "observation", "prep", "other"].includes(raw)) {
      return raw as "lookup" | "observation" | "prep" | "other";
    }
  } catch (e) {
    console.warn("classify failed:", (e as Error).message);
  }
  return "other";
}

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const body: RequestBody = await req.json();
    const mode = body.mode ?? "answer";

    // Accept person_id OR legacy patient_id
    const personId = body.person_id ?? body.patient_id;
    const meterUserId = jwtSub(authHeader);
    // Watch mode sends `text`; answer mode sends `question`
    const question = (body.question ?? body.text ?? "").trim();

    if (!question || !personId) {
      return new Response(
        JSON.stringify({
          error: "person_id (or patient_id) and question (or text) are required",
          received: {
            has_person_id: !!body.person_id,
            has_patient_id: !!body.patient_id,
            has_question: !!body.question,
            has_text: !!body.text,
            mode,
          },
        }),
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        },
      );
    }

    // Bot guard: pauses only far above what a person could ask in an hour.
    // There is no monthly cap. See pause.ts.
    const threshold = pauseThreshold(Deno.env.get("ASK_PAUSE_PER_HOUR"));
    if (isPaused(await countLastHour(meterUserId), threshold)) {
      console.warn("ask-wellet paused", { user: meterUserId, threshold });
      return new Response(
        JSON.stringify({ error: PAUSE_MESSAGE, code: "ask_paused", retry_after_minutes: 15 }),
        {
          status: 429,
          headers: { ...corsHeaders, "Content-Type": "application/json", "Retry-After": "900" },
        },
      );
    }

    // ─── WATCH MODE ──────────────────────────────────────────────────────────
    if (mode === "watch") {
      const { system, messages } = buildWatchPrompt(question);
      let watchResult: WatchProposal | WatchRejected;

      try {
        const res = await aiChat({
          model: "gpt-4o",
          messages: [
            { role: "system", content: system },
            ...messages,
          ],
          max_tokens: 400,
          temperature: 0.1,
          response_format: { type: "json_object" },
          phi: true,
        });
        meterAi(res, { feature: "ask_watch", userId: meterUserId, personId });
        const cleaned = res.content
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();
        watchResult = JSON.parse(cleaned) as WatchProposal | WatchRejected;
      } catch (e) {
        console.error("watch parse failed:", (e as Error).message);
        watchResult = {
          kind: "watch_rejected",
          reason: "Couldn't parse that request. Try rephrasing it more simply.",
        };
      }

      return new Response(JSON.stringify(watchResult), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ─── ANSWER MODE ─────────────────────────────────────────────────────────
    const data = await fetchPersonData(
      supabase,
      personId,
      body.include_apple_health === true,
      body.include_shared_apple_health === true,
    );
    const personContext = buildPersonContext(data);
    const { system, messages } = buildAnswerPrompt(
      question,
      personContext,
      body.history ?? [],
      body.context,
      data.person?.is_self === true,
    );

    const [aiResponse, classification] = await Promise.all([
      aiChat({
        model: "gpt-4o",
        messages: [
          { role: "system", content: system },
          ...messages,
        ],
        max_tokens: 600,
        temperature: 0.3,
        phi: true,
      }),
      classifyQuestion(question, meterUserId, personId),
    ]);
    meterAi(aiResponse, { feature: "ask", userId: meterUserId, personId });

    return new Response(
      JSON.stringify({
        answer: aiResponse.content,
        model: aiResponse.model ?? "gpt-4o",
        live_ehr: data.liveEhr,
        apple_health: data.appleHealth.summaries.length > 0,
        classification,
        conversation_id: body.conversation_id ?? null,
        version: VERSION,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err) {
    console.error("ask-wellet error:", err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  }
});
