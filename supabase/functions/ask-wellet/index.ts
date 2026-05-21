// ask-wellet v25 — omniscient + watch-proposal + multi-turn + classification
//
// Two request paths:
//   1. Default ("answer" mode): pulls all known data sources, builds a
//      sectioned context, and asks Perplexity Sonar for a caregiver-facing
//      answer.
//
//      Voice v1 BDB additions (May 20, 2026):
//        - Accepts optional body.history: [{role, content}, ...] for
//          multi-turn conversations.
//        - Returns body.classification: 'lookup' | 'observation' | 'prep' | 'other'
//          so the UI knows whether to surface the soft save chip.
//        - Backward compatible: missing history = single-turn, missing
//          classification (e.g. for very old clients) still works.
//
//      Returns { answer, model, live_ehr, classification }.
//
//   2. Watch mode (body.mode === 'watch'): the caregiver is trying to set up
//      a Care Signals notification ("notify me when..."). We translate their
//      free text into a structured watch_proposal JSON the UI can confirm and
//      then POST to create-care-signal-watch.
//        Returns { kind:'watch_proposal', watch_type, parameters,
//                  description, confidence, reason? } on success, or
//                { kind:'watch_rejected', reason } when the ask is clinical or
//                outside the v1 watch types.
//
// HARD REJECTS in watch mode (must never become a watch):
//   - Lab values / lab thresholds ("notify me if her A1c goes above 7")
//   - Dosing / med-error questions ("alert me if she takes the wrong dose")
//   - Diagnoses / clinical state claims
//   - Anything that asks Wellet to interpret what something means clinically
//
// Voice rules (enforced both in this prompt and the answer prompt):
//   - Forbidden: track / tracks / tracking / monitor / keep tabs on
//   - Use: notices, watches for, follows, reads, stays on top of
//   - Use "loved one" / "family member" / "the person you care for", never "parent"
//
// v1 supported watch_types (must match create-care-signal-watch ALLOWED_TYPES exactly):
//
//   Wearable / behavior:
//   - resting_hr_sustained_above   { threshold_bpm: 30-220, window_days: 1-14 }
//   - resting_hr_above_baseline    { delta_bpm: 1-80, baseline_window_days: 7-90, window_days: 1-14 }
//   - daily_steps_below            { threshold_steps: 0-50000, window_days: 1-14 }
//   - sleep_duration_below         { threshold_hours: 0-16, window_nights: 1-14 }
//   - wearable_silence             { silence_days: 1-30 }
//   - refill_gap                   { medication_name: string, grace_days: 0-30 }
//   - pcp_visit_gap                { months: 1-36 }
//
//   EHR record arrival:
//   - new_record_arrived           { kinds: subset of [lab,visit,imaging,discharge,medication,immunization] }
//
//   NOT YET AVAILABLE (reject these even if asked — table doesn't exist yet):
//   - new_care_team_member, appointment_changed
//
// Anything that doesn't cleanly map to one of these → kind:'watch_rejected'.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChat } from "../_shared/azureOpenAI.ts";

// 2026-05-21: ask-wellet now routes through the central AI vendor adapter
// (../_shared/azureOpenAI.ts) instead of calling Perplexity directly. This
// closes a real posture gap: the main "answer" path ships the loved one's
// full clinical record into the prompt, which is PHI and must run on a
// BAA-covered vendor (Azure OpenAI). The watch-mode path stays on Sonar by
// setting phi:false — it only sees the loved one's first name, a UI chip,
// and the caregiver's own free-text request. The adapter's phi guardrail
// will throw if Sonar is ever attempted with phi:true.
//
// Vendor selection is governed by WELLET_AI_VENDOR (default "azure").
// The legacy getPerplexityApiKey() helper has been removed — all auth lives
// in the adapter now.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function formatContextChip(ctx: any): string {
  if (!ctx) return '';
  if (typeof ctx === 'string') return ctx;
  try {
    const parts: string[] = [];
    if (ctx.kind) parts.push(`type: ${ctx.kind}`);
    if (ctx.metric) parts.push(`metric: ${ctx.metric}`);
    if (ctx.name) parts.push(`name: ${ctx.name}`);
    if (ctx.value !== undefined && ctx.value !== null && ctx.value !== '') parts.push(`value: ${ctx.value}`);
    if (ctx.unit) parts.push(`unit: ${ctx.unit}`);
    if (ctx.range) parts.push(`reference range: ${ctx.range}`);
    if (ctx.status) parts.push(`status: ${ctx.status}`);
    if (ctx.date) parts.push(`date: ${ctx.date}`);
    if (ctx.note) parts.push(`note: ${ctx.note}`);
    return parts.join(' | ');
  } catch (_e) {
    try { return JSON.stringify(ctx); } catch { return ''; }
  }
}

function dateOnly(d: any): string {
  if (!d) return 'unknown';
  const s = String(d);
  return s.includes('T') ? s.split('T')[0] : s;
}

function decodeJwtSub(hdr: string): string | null {
  try {
    const tok = hdr.replace(/^bearer\s+/i, '').trim();
    const parts = tok.split('.');
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = b64.length % 4 ? '='.repeat(4 - (b64.length % 4)) : '';
    const json = atob(b64 + pad);
    const claims = JSON.parse(json);
    return claims.sub || null;
  } catch (_e) { return null; }
}

// ----------------------------------------------------------------------
// WATCH MODE
// ----------------------------------------------------------------------

const WATCH_TYPES = [
  'resting_hr_sustained_above',
  'resting_hr_above_baseline',
  'daily_steps_below',
  'sleep_duration_below',
  'wearable_silence',
  'refill_gap',
  'pcp_visit_gap',
  'new_record_arrived',
] as const;

type WatchType = typeof WATCH_TYPES[number];

// Types the SQL enum allows but the v1 evaluator can't yet act on. If the
// model proposes one of these, we convert to a friendly rejection.
const NOT_YET_AVAILABLE_TYPES = new Set([
  'new_care_team_member',
  'appointment_changed',
]);

const RECORD_KINDS = ['lab', 'visit', 'imaging', 'discharge', 'medication', 'immunization'] as const;

// Pre-LLM clinical-safety check. We catch the obvious dangerous shapes before
// even spending a Perplexity call. The LLM has the same instructions as a
// belt-and-suspenders second layer.
function preflightClinicalReject(text: string): string | null {
  const t = (text || '').toLowerCase();
  if (!t.trim()) return 'empty_request';

  // Lab value thresholds — "if X goes above/below N", "if level over/under N"
  if (/\b(a1c|hba1c|hemoglobin|glucose|cholesterol|ldl|hdl|triglycerides|tsh|creatinine|bun|sodium|potassium|inr|psa|wbc|rbc|platelets|hematocrit|bnp|troponin|ferritin|vitamin\s*d|crp|esr|alt|ast|alkaline|bilirubin|egfr|microalbumin)\b/.test(t)) {
    if (/\b(above|over|below|under|exceed|higher than|lower than|greater than|less than|>|<|drops? to|rises? to|hits?|reaches?|threshold)\b/.test(t) || /\b\d/.test(t)) {
      return 'clinical_lab_threshold';
    }
  }

  // Dosing / medication-error asks
  if (/\b(wrong dose|missed dose|miss(?:ed|es|ing)? (?:a|the|her|his|their) (?:dose|pill|medication)|double dose|skipped (?:a|the|her|his) (?:dose|pill)|overdose|underdose|takes? too much|takes? too little|incorrect dose|med(?:ication)? error|drug interaction|adverse reaction|contraindication)\b/.test(t)) {
    return 'clinical_dosing';
  }

  // Vitals thresholds — same "above/below N" pattern.
  // NOTE: resting heart rate is intentionally allowed (it's a behavioral wearable signal, not a clinical threshold).
  // We only flag heart-rate phrasing when it's clearly clinical / emergency framing.
  if (/\b(blood pressure|\bbp\b|spo2|oxygen saturation|temperature|fever|weight|blood sugar|glucose level)\b/.test(t)) {
    if (/\b(above|over|below|under|exceed|higher than|lower than|greater than|less than|>|<|drops? to|rises? to|hits?|reaches?|threshold)\b/.test(t) || /\b\d{2,}\b/.test(t)) {
      return 'clinical_vital_threshold';
    }
  }
  // Heart-rate emergency framing — only reject when it sounds like real-time / clinical alerting.
  if (/\b(heart rate|pulse|hr)\b/.test(t) && /\b(emergency|abnormal|dangerous|unsafe|alert me immediately|right away|real ?time|tachycardia|bradycardia|arrhythmia|afib|fibrillation)\b/.test(t)) {
    return 'clinical_vital_threshold';
  }

  // Diagnosis / clinical state asks
  if (/\b(diagnose|diagnosis|diagnosed with|has cancer|infection|sepsis|stroke|heart attack|getting worse|deteriorat|declin(?:e|ing)|symptom of|sign of)\b/.test(t)) {
    return 'clinical_diagnosis';
  }

  return null;
}

function watchTypeListForPrompt(): string {
  return [
    '- resting_hr_sustained_above: resting heart rate stays above a threshold for several days.',
    '    parameters: { threshold_bpm: integer 30-220, window_days: integer 1-14 (default 3) }',
    '- resting_hr_above_baseline: resting heart rate runs higher than the loved one\'s usual baseline.',
    '    parameters: { delta_bpm: integer 1-80 (default 7), baseline_window_days: integer 7-90 (default 30), window_days: integer 1-14 (default 3) }',
    '- daily_steps_below: daily step count stays below a threshold for several days.',
    '    parameters: { threshold_steps: integer 0-50000, window_days: integer 1-14 (default 3) }',
    '- sleep_duration_below: nightly sleep stays under a threshold for several nights.',
    '    parameters: { threshold_hours: number 0-16, window_nights: integer 1-14 (default 3) }',
    '- wearable_silence: the wearable hasn\'t synced in N days (could mean it\'s off the wrist).',
    '    parameters: { silence_days: integer 1-30 (default 3) }',
    '- refill_gap: a known medication hasn\'t been refilled within its expected window.',
    '    parameters: { medication_name: string, grace_days: integer 0-30 (default 3) }',
    '- pcp_visit_gap: it\'s been more than N months since a primary-care visit.',
    '    parameters: { months: integer 1-36 (default 12) }',
    '- new_record_arrived: any new clinical record syncs from the EHR (catch-all for chart updates).',
    '    parameters: { kinds: array of strings, each one of ["lab","visit","imaging","discharge","medication","immunization"]; default ["lab","visit","imaging","discharge"] }',
  ].join('\n');
}

const WATCH_SYSTEM_PROMPT = `You are Wellet's "watch proposer". The caregiver wants Wellet to notice when something specific happens with their loved one's health data. Your job: turn their free-text request into a STRICT JSON watch_proposal that the app will confirm with them before saving.

Voice rules (STRICT — these apply to your description text):
- Forbidden words: "track", "tracks", "tracking", "monitor", "monitoring", "keep tabs on"
- Use instead: "notices", "watches for", "follows", "reads", "stays on top of"
- Use "loved one", "family member", or "the person you care for" — NEVER "parent"

CLINICAL SAFETY (HARD STOP — return kind:"watch_rejected"):
- Lab value thresholds (e.g., "tell me if her A1c goes above 7")
- Dosing / med-error questions (e.g., "alert me if she takes the wrong dose", "missed dose")
- Blood pressure / vitals thresholds (e.g., "if BP over 140")
- Diagnoses or clinical state ("if she's getting worse", "if it's a stroke")
- Anything asking Wellet to interpret what something means clinically

Wellet helps coordinate care, not find medical errors. Leave clinical judgment to the care team.

Note on resting heart rate: it's a behavioral / wearable signal here, NOT a clinical threshold. If a caregiver asks Wellet to notice when resting heart rate runs high (e.g., "if her resting heart rate stays above 90 for a few days") that IS allowed via resting_hr_sustained_above. Active heart rate, real-time alerts, or anything framed as "abnormal" / "dangerous" / "emergency" is NOT allowed — reject.

If the request is unsafe, return:
{ "kind": "watch_rejected", "reason": "<one short caregiver-facing sentence that redirects to the care team without alarm>" }

If the request IS safe and maps to one of the supported watch_types below, return:
{
  "kind": "watch_proposal",
  "watch_type": "<one of the supported types EXACTLY>",
  "parameters": { ... },
  "description": "<one short caregiver-facing sentence describing what Wellet will notice>",
  "confidence": <0.0-1.0>
}

Supported watch_types (use these exact strings — anything else will be rejected):
${watchTypeListForPrompt()}

Mapping rules:
- Heart rate card / "resting HR stays above N" → resting_hr_sustained_above (use the number they said for threshold_bpm; default window_days=3)
- "resting HR is running higher than usual" / "above her baseline" → resting_hr_above_baseline (default delta_bpm=7, baseline_window_days=30, window_days=3)
- Steps card / "if she's barely moving" / "under N steps" → daily_steps_below (use number for threshold_steps or default 2000; window_days=3)
- Sleep card / "sleeping less than N hours" → sleep_duration_below (threshold_hours from request or default 5; window_nights=3)
- "watch hasn't synced" / "no wearable data in days" → wearable_silence (silence_days from request or default 3)
- "refill gap" / "hasn't refilled X" → refill_gap (medication_name required from the text; grace_days default 3)
- "hasn't seen primary doctor in N months" → pcp_visit_gap (months from request or default 12)
- "any new record" / "new lab" / "new visit note" / "new imaging" → new_record_arrived (set kinds to match what they asked about, e.g. ["lab"] or ["imaging","visit"]; default if unspecified ["lab","visit","imaging","discharge"])

NOT-YET-AVAILABLE (must REJECT with a kind, gentle reason):
- New care-team member / new doctor added → reject: "Wellet will notice care-team changes soon — that watch isn't ready yet."
- Appointment changes / cancellations / reschedules → reject: "Wellet will notice appointment changes soon — that watch isn't ready yet."
- SpO2 / oxygen saturation → reject: "Wellet doesn't yet have an SpO2 watch. The app shows your loved one's daily readings if you'd like to share them with the care team."
- HRV / heart-rate variability → reject: "Wellet doesn't yet have an HRV watch. The app shows daily HRV if you'd like to share it with the care team."

Description sentence:
- Start with "Wellet will notice" or "Wellet will let you know"
- Use the loved one's first name if it's provided in the user message
- One sentence, plain, no medical interpretation, no thresholds repeated as percentages or rates

Output ONLY the JSON object. No prose, no markdown fences, no explanation.`;

interface WatchProposal {
  kind: 'watch_proposal';
  watch_type: WatchType;
  parameters: Record<string, unknown>;
  description: string;
  confidence: number;
}
interface WatchRejected {
  kind: 'watch_rejected';
  reason: string;
}

function rejectionMessage(code: string): string {
  switch (code) {
    case 'empty_request':
      return "Tell Wellet what you'd like it to notice — for example, \"let me know when a new record arrives.\"";
    case 'clinical_lab_threshold':
      return "Wellet can let you know when new lab documents arrive, but it doesn't watch lab values or thresholds — that's a conversation for the care team.";
    case 'clinical_dosing':
      return "Wellet helps coordinate care, not catch medication errors — that one belongs with the care team.";
    case 'clinical_vital_threshold':
      return "Wellet doesn't watch vital-sign thresholds. The app shows daily readings you can share with the care team if something feels off.";
    case 'clinical_diagnosis':
      return "Wellet doesn't interpret what a change might mean clinically. If something feels worrying, the care team is the right place to ask.";
    default:
      return "Wellet can't set this up as a watch yet. New records, appointments, care-team changes, medications, visit notes, diagnostic reports, immunizations, and allergy changes are all available.";
  }
}

function safeParseJson(text: string): any | null {
  if (!text) return null;
  // Strip code fences if the model wrapped output despite instructions
  const cleaned = text.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  try { return JSON.parse(cleaned); } catch (_e) {}
  // Try to find the first {...} block
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (_e) {}
  }
  return null;
}

// Clamp a number into [min, max]; returns def if not finite.
function clampNum(v: unknown, min: number, max: number, def: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}
function clampInt(v: unknown, min: number, max: number, def: number): number {
  return Math.round(clampNum(v, min, max, def));
}

function validateWatchProposal(parsed: any): WatchProposal | WatchRejected | null {
  if (!parsed || typeof parsed !== 'object') return null;

  if (parsed.kind === 'watch_rejected') {
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
      ? parsed.reason.trim()
      : rejectionMessage('default');
    return { kind: 'watch_rejected', reason };
  }

  if (parsed.kind !== 'watch_proposal') return null;
  const wt = parsed.watch_type;
  if (typeof wt !== 'string') return null;

  // If the model picked a not-yet-available type, convert to friendly rejection
  if (NOT_YET_AVAILABLE_TYPES.has(wt)) {
    return {
      kind: 'watch_rejected',
      reason: "Wellet will notice that soon — the watch for this isn't ready yet.",
    };
  }

  if (!(WATCH_TYPES as readonly string[]).includes(wt)) return null;

  const rawParams: Record<string, unknown> =
    parsed.parameters && typeof parsed.parameters === 'object' && !Array.isArray(parsed.parameters)
      ? parsed.parameters as Record<string, unknown> : {};

  // Per-type parameter cleaning / defaults — MUST mirror create-care-signal-watch's validateParams.
  let cleanParams: Record<string, unknown> = {};
  switch (wt) {
    case 'resting_hr_sustained_above': {
      cleanParams = {
        threshold_bpm: clampInt(rawParams.threshold_bpm, 30, 220, 90),
        window_days: clampInt(rawParams.window_days, 1, 14, 3),
      };
      break;
    }
    case 'resting_hr_above_baseline': {
      cleanParams = {
        delta_bpm: clampInt(rawParams.delta_bpm, 1, 80, 7),
        baseline_window_days: clampInt(rawParams.baseline_window_days, 7, 90, 30),
        window_days: clampInt(rawParams.window_days, 1, 14, 3),
      };
      break;
    }
    case 'daily_steps_below': {
      cleanParams = {
        threshold_steps: clampInt(rawParams.threshold_steps, 0, 50000, 2000),
        window_days: clampInt(rawParams.window_days, 1, 14, 3),
      };
      break;
    }
    case 'sleep_duration_below': {
      cleanParams = {
        threshold_hours: clampNum(rawParams.threshold_hours, 0, 16, 5),
        window_nights: clampInt(rawParams.window_nights, 1, 14, 3),
      };
      break;
    }
    case 'wearable_silence': {
      cleanParams = { silence_days: clampInt(rawParams.silence_days, 1, 30, 3) };
      break;
    }
    case 'refill_gap': {
      const m = typeof rawParams.medication_name === 'string' ? rawParams.medication_name.trim().slice(0, 200) : '';
      if (!m) {
        // Without a med name we can't create the watch — surface as rejection so the UI prompts again
        return {
          kind: 'watch_rejected',
          reason: "Wellet needs to know which medication to watch. Try \"let me know if Mom's lisinopril hasn't been refilled.\"",
        };
      }
      cleanParams = { medication_name: m, grace_days: clampInt(rawParams.grace_days, 0, 30, 3) };
      break;
    }
    case 'pcp_visit_gap': {
      cleanParams = { months: clampInt(rawParams.months, 1, 36, 12) };
      break;
    }
    case 'new_record_arrived': {
      const allowed = new Set(RECORD_KINDS as readonly string[]);
      let kinds: string[] = ['lab', 'visit', 'imaging', 'discharge'];
      if (Array.isArray(rawParams.kinds)) {
        const filtered = (rawParams.kinds as unknown[])
          .filter((x): x is string => typeof x === 'string' && allowed.has(x))
          .slice(0, 6);
        if (filtered.length > 0) kinds = filtered;
      }
      cleanParams = { kinds };
      break;
    }
    default:
      return null;
  }

  let description = typeof parsed.description === 'string' ? parsed.description.trim() : '';
  // Defense-in-depth: strip forbidden voice words even if the model leaked them.
  description = description.replace(/\b(track(?:ing|s|ed)?|monitor(?:ing|s|ed)?|keep(?:ing)? tabs on)\b/gi, 'notices');
  description = description.replace(/\bparent(?:s|'s)?\b/gi, 'loved one');
  if (!description) description = 'Wellet will notice this and email you.';
  if (description.length > 200) description = description.slice(0, 200);

  let confidence = Number(parsed.confidence);
  if (!Number.isFinite(confidence)) confidence = 0.7;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return {
    kind: 'watch_proposal',
    watch_type: wt as WatchType,
    parameters: cleanParams,
    description,
    confidence,
  };
}

// ----------------------------------------------------------------------
// VOICE v1: CLASSIFICATION
//
// Decide whether this exchange is worth offering to save to the loved one's
// timeline. Cheap rule-based classifier (no second model call). Keyword sets
// are tuned for caregiver-voice patterns.
//
// - 'observation' = the caregiver noticed something about the loved one.
//                   These produce the soft save chip under the AI bubble.
//                   Examples: "Mom seemed confused tonight",
//                             "Dad refused his evening meds",
//                             "She was short of breath walking to the car".
//
// - 'prep'        = the caregiver is preparing for a future visit/event.
//                   These also produce the soft save chip.
//                   Examples: "What should I ask the cardiologist on Friday?",
//                             "Help me prep for Mom's appointment Tuesday".
//
// - 'lookup'      = factual question against existing data, no new info.
//                   No save chip.
//                   Examples: "What's Mom's current blood pressure med?",
//                             "When was her last A1c?".
//
// - 'other'       = greeting, smalltalk, unclear intent. No save chip.
//
// Heuristic order:
//   1. Strong observation cues in USER text → 'observation'
//   2. Strong prep cues in USER text → 'prep'
//   3. Pure lookup cues → 'lookup'
//   4. Default → 'other'
// ----------------------------------------------------------------------

function classifyExchange(userText: string, assistantText: string): 'lookup' | 'observation' | 'prep' | 'other' {
  const u = (userText || '').toLowerCase();
  const a = (assistantText || '').toLowerCase();

  if (!u.trim()) return 'other';

  // 1. OBSERVATION cues: the caregiver is reporting something they saw.
  // First-person verbs of perception + a referent to the loved one.
  const observationVerbs = /\b(noticed|noticing|saw|seemed|seems|felt|feels|complained|complaining|refused|refusing|forgot|forgetting|told me|said|fell|tripped|wandered|confused|disoriented|short of breath|out of breath|winded|dizzy|nauseous|dehydrated|swollen|swelling|tired|exhausted|sleeping|napping|sleepy|drowsy|agitated|anxious|withdrawn|crying|sad|down|low|happy|better|worse|brighter|sharper|slower|weaker|stronger|coughing|coughed|wheezing|sweating|shaking|trembling|fainted|passed out|skipped|missed|didn't take|wouldn't take|didn't eat|wouldn't eat|barely ate|wouldn't drink|didn't sleep|couldn't sleep)\b/;
  const referentToLovedOne = /\b(mom|mama|mother|dad|papa|father|grandma|grandpa|she|he|her|him|his|hers|aunt|uncle)\b/;
  if (observationVerbs.test(u) && referentToLovedOne.test(u)) return 'observation';
  // Also: "I noticed X" without an explicit pronoun — still an observation.
  if (/^(i|we)\s+(just\s+)?(noticed|saw|heard|felt|think|thought|realized|remembered)/.test(u.trim())) return 'observation';
  // Direct observation reports without "I noticed" prefix:
  if (/^(mom|dad|grandma|grandpa|she|he|her|him)\s+(was|is|seemed|seems|looked|looks|felt|feels|got|gets|did|didn't|won't|wouldn't|couldn't)/.test(u.trim())) return 'observation';

  // 2. PREP cues: future-tense planning for a visit/event.
  const prepCues = /\b(prep|prepare|preparing|getting ready|before (her|his|the|mom's|dad's) (appointment|visit|appt)|what (should|do) i (ask|bring|tell|say)|questions? (to|for) (ask|the|her|his)|on (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week)|appointment (is|on|tomorrow|next)|visit (is|on|tomorrow|next)|going to (the|her|his) (doctor|cardiologist|neurologist|specialist|appointment)|seeing (the|her|his) (doctor|cardiologist|neurologist|specialist))\b/;
  if (prepCues.test(u)) return 'prep';

  // 3. LOOKUP cues: clear data retrieval intent.
  const lookupCues = /^(what(?:'s| is)|when (was|did|is)|where (is|was)|who (is|are|prescribed)|how (much|many|often|long)|show me|tell me|list|find|did (she|he|mom|dad)|has (she|he|mom|dad)|is (she|he|mom|dad) (currently|still|on))/;
  if (lookupCues.test(u.trim())) return 'lookup';

  // 4. Fallback.
  // If the user message is very short and the AI gave a long factual answer,
  // treat it as lookup. Otherwise other.
  if (u.trim().length < 60 && a.length > 200) return 'lookup';
  return 'other';
}

async function handleWatchMode(opts: {
  text: string;
  context_hint: any;
  personName: string | null;
}): Promise<Response> {
  const text = (opts.text || '').toString();
  const reject = preflightClinicalReject(text);
  if (reject) {
    const body: WatchRejected = { kind: 'watch_rejected', reason: rejectionMessage(reject) };
    return new Response(
      JSON.stringify(body),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const chip = formatContextChip(opts.context_hint);
  const userParts: string[] = [];
  if (opts.personName) userParts.push(`Loved one's first name: ${opts.personName}`);
  if (chip) userParts.push(`Context the caregiver was looking at: ${chip}`);
  userParts.push(`Caregiver request: ${text}`);
  const userContent = userParts.join('\n');

  // Watch-mode routes through the shared AI adapter. We mark phi:false because
  // we only send the loved one's first name + a UI chip + the caregiver's
  // own request text — no clinical record. The adapter still honors
  // WELLET_AI_VENDOR for non-PHI calls; default is Azure with gpt-4o-mini.
  let content = '';
  try {
    const ai = await aiChat({
      phi: false,
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: WATCH_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
      ],
      max_tokens: 400,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    });
    content = ai.content || '';
  } catch (err) {
    console.error('ask-wellet watch-mode aiChat error:', err);
    const fallback: WatchRejected = {
      kind: 'watch_rejected',
      reason: "Wellet couldn't set that up just now. Try again, or pick from the suggestions.",
    };
    return new Response(
      JSON.stringify(fallback),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  const parsed = safeParseJson(content);
  const validated = validateWatchProposal(parsed);

  if (!validated) {
    console.warn('watch-mode: model output failed validation', { content: content.slice(0, 500) });
    const fallback: WatchRejected = {
      kind: 'watch_rejected',
      reason: "Wellet wasn't sure how to set that up. Try something like \"let me know when a new record arrives\" or \"tell me about upcoming appointments.\"",
    };
    return new Response(
      JSON.stringify(fallback),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }

  return new Response(
    JSON.stringify(validated),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
  );
}

// ----------------------------------------------------------------------
// SERVER
// ----------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const mode = body?.mode;
    const person_id = body?.person_id;
    const context_hint = body?.context;

    if (!person_id) {
      return new Response(
        JSON.stringify({ error: 'person_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const jwtSub = decodeJwtSub(authHeader);

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const supabase = createClient(
      SUPABASE_URL,
      Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      { global: { headers: { Authorization: authHeader } } }
    );
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // Look up the person (RLS first, service-role fallback after sub match).
    let { data: person, error: personErr } = await supabase
      .from('people').select('*').eq('id', person_id).maybeSingle();
    if (personErr) console.warn('person RLS lookup error:', personErr.message);
    if (!person && jwtSub) {
      const { data: adminPerson } = await admin
        .from('people').select('*').eq('id', person_id).maybeSingle();
      if (adminPerson && adminPerson.user_id === jwtSub) {
        person = adminPerson;
      }
    }
    if (!person) {
      return new Response(
        JSON.stringify({ error: 'Person not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ---------------- WATCH MODE ----------------
    if (mode === 'watch') {
      const text = (body?.text ?? body?.question ?? '').toString();
      const firstName = (person?.name || '').toString().split(/\s+/)[0] || null;
      console.log('ask-wellet v24 watch-mode request', { person_id, jwt_sub: jwtSub, text_len: text.length });
      return await handleWatchMode({ text, context_hint, personName: firstName });
    }

    // ---------------- ANSWER MODE (v23 behavior) ----------------
    const question = body?.question;
    if (!question) {
      return new Response(
        JSON.stringify({ error: 'question is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log('ask-wellet v25 answer-mode request', { person_id, jwt_sub: jwtSub });

    // Voice v1: prior turns of this conversation (optional).
    // Shape: [{role: 'user'|'assistant', content: string}, ...]
    // We cap at the last 10 turns to control token usage.
    const rawHistory = Array.isArray(body?.history) ? body.history : [];
    const history = rawHistory
      .filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      .slice(-10)
      .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, 4000) }));

    async function safeQuery(builderFn: (c: any) => any) {
      const { data, error } = await builderFn(supabase);
      if (error) console.warn('RLS read error:', error.message);
      if (data && data.length > 0) return data;
      const { data: adminData } = await builderFn(admin);
      return adminData || [];
    }

    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const twoYearsCutoff = twoYearsAgo.toISOString();

    const [
      events, meds, medLogs, labs, vitalsRows, allergyRows, checkIns,
      visitAttach, docs, ehrConnRows,
    ] = await Promise.all([
      safeQuery((c) => c.from('health_events')
        .select('event_type, event_date, title, notes, source')
        .eq('person_id', person_id)
        .order('event_date', { ascending: false })
        .limit(50)),
      safeQuery((c) => c.from('medications')
        .select('id, name, dose, frequency, prescriber, active, source')
        .eq('person_id', person_id)),
      safeQuery((c) => c.from('medication_logs')
        .select('medication_id, taken_at, status, notes, source')
        .eq('person_id', person_id)
        .order('taken_at', { ascending: false })
        .limit(30)),
      safeQuery((c) => c.from('lab_results')
        .select('test_name, value, unit, reference_range, status, effective_date, category, source')
        .eq('person_id', person_id)
        .gte('effective_date', twoYearsCutoff)
        .order('effective_date', { ascending: false })
        .limit(60)),
      safeQuery((c) => c.from('vitals')
        .select('vital_type, value, unit, effective_date, source')
        .eq('person_id', person_id)
        .gte('effective_date', twoYearsCutoff)
        .order('effective_date', { ascending: false })
        .limit(40)),
      safeQuery((c) => c.from('allergies')
        .select('substance, reaction, severity, clinical_status, onset_date, source')
        .eq('person_id', person_id)),
      safeQuery((c) => c.from('check_ins')
        .select('checked_in_at, mood, pain_level, sleep_quality, energy_level, appetite, notes')
        .eq('person_id', person_id)
        .order('checked_in_at', { ascending: false })
        .limit(14)),
      safeQuery((c) => c.from('visit_attachments')
        .select('file_name, kind, note, created_at, event_id, visit_ref')
        .eq('person_id', person_id)
        .order('created_at', { ascending: false })
        .limit(20)),
      safeQuery((c) => c.from('documents')
        .select('file_name, document_type, extracted_events, extraction_status')
        .eq('person_id', person_id)
        .eq('extraction_status', 'completed')),
      safeQuery((c) => c.from('ehr_connections')
        .select('id, provider, hospital_name, token_expires_at, needs_reconnect, last_synced_at')
        .eq('person_id', person_id)),
    ]);

    const now = Date.now();
    const liveConn = (ehrConnRows as any[]).find((r: any) =>
      !r.needs_reconnect &&
      r.token_expires_at && new Date(r.token_expires_at).getTime() > now
    );

    let liveEhr: any = null;
    if (liveConn) {
      try {
        const ctrl = new AbortController();
        const timeoutId = setTimeout(() => ctrl.abort(), 15000);
        const resp = await fetch(`${SUPABASE_URL}/functions/v1/fetch-ehr-data`, {
          method: 'POST',
          signal: ctrl.signal,
          headers: {
            'Content-Type': 'application/json',
            'Authorization': authHeader,
            'apikey': SERVICE_KEY,
          },
          body: JSON.stringify({ person_id }),
        });
        clearTimeout(timeoutId);
        if (resp.ok) {
          liveEhr = await resp.json();
        } else {
          const txt = await resp.text();
          console.warn('live EHR fetch non-ok', resp.status, txt.slice(0, 200));
        }
      } catch (e) {
        console.warn('live EHR fetch skipped:', String(e));
      }
    }

    const personAge = person.date_of_birth
      ? Math.floor((Date.now() - new Date(person.date_of_birth).getTime()) / 31557600000)
      : null;

    const sections: string[] = [];

    const demo: string[] = [`Name: ${person.name}`];
    if (person.relationship) demo.push(`Relationship to caregiver: ${person.relationship}`);
    if (personAge !== null) demo.push(`Age: ${personAge}`);
    if (person.date_of_birth) demo.push(`Date of birth: ${dateOnly(person.date_of_birth)}`);
    if (person.sex) demo.push(`Sex: ${person.sex}`);
    if (person.blood_type) demo.push(`Blood type: ${person.blood_type}`);
    if (person.primary_doctor) demo.push(`Primary doctor: ${person.primary_doctor}`);
    sections.push(`## Demographics\n${demo.map(d => `- ${d}`).join('\n')}`);

    if ((ehrConnRows as any[]).length > 0) {
      const connLines = (ehrConnRows as any[]).map((c) => {
        const expired = c.token_expires_at && new Date(c.token_expires_at).getTime() <= now;
        const state = c.needs_reconnect ? 'needs reconnect' : expired ? 'token expired' : 'active';
        const last = c.last_synced_at ? `, last synced ${dateOnly(c.last_synced_at)}` : '';
        return `- ${c.hospital_name || c.provider} (${state}${last})`;
      });
      sections.push(`## Connected records sources\n${connLines.join('\n')}`);
    }

    if (liveEhr) {
      const ls: string[] = [];
      if (liveEhr.patient?.name) ls.push(`- Matched patient: ${liveEhr.patient.name} (DOB ${liveEhr.patient.birth_date || 'unknown'})`);
      if (liveEhr.synced_at) ls.push(`- Fetched live at ${liveEhr.synced_at}`);
      sections.push(`## Live EHR snapshot (${liveEhr.provider || 'Epic MyChart'})\n${ls.join('\n')}`);

      if (liveEhr.conditions?.length > 0) {
        const top = liveEhr.conditions.slice(0, 25).map((c: any) =>
          `- ${c.name}${c.clinical_status ? ` (${c.clinical_status})` : ''}${c.onset_date ? `, onset ${dateOnly(c.onset_date)}` : ''}`
        );
        sections.push(`## Conditions (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.medications?.length > 0) {
        const top = liveEhr.medications.slice(0, 25).map((m: any) =>
          `- ${m.name}${m.dosage ? ` — ${m.dosage}` : ''}${m.prescriber_name ? `, prescriber ${m.prescriber_name}` : ''}`
        );
        sections.push(`## Active medications (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.allergies?.length > 0) {
        const top = liveEhr.allergies.slice(0, 20).map((a: any) =>
          `- ${a.name}${a.severity ? ` (${a.severity})` : ''}${a.reactions?.length ? ` — reactions: ${a.reactions.join(', ')}` : ''}`
        );
        sections.push(`## Allergies (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.observations?.length > 0) {
        const recent = liveEhr.observations.slice(0, 25).map((o: any) =>
          `- [${dateOnly(o.effective_date)}] ${o.name}: ${o.value}${o.unit ? ' ' + o.unit : ''}${o.reference_range ? ` (ref ${o.reference_range})` : ''}${o.status ? ` [${o.status}]` : ''}`
        );
        sections.push(`## Recent labs & vitals (from EHR)\n${recent.join('\n')}`);
      }
      if (liveEhr.immunizations?.length > 0) {
        const top = liveEhr.immunizations.slice(0, 15).map((i: any) =>
          `- ${i.name}${i.date ? ` on ${dateOnly(i.date)}` : ''}`
        );
        sections.push(`## Immunizations (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.diagnostic_reports?.length > 0) {
        const top = liveEhr.diagnostic_reports.slice(0, 15).map((d: any) =>
          `- [${dateOnly(d.effective_date)}] ${d.name}${d.category ? ` (${d.category})` : ''}${d.status ? ` — ${d.status}` : ''}`
        );
        sections.push(`## Diagnostic reports (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.visits?.length > 0) {
        const top = liveEhr.visits.slice(0, 20).map((v: any) =>
          `- [${dateOnly(v.start_date)}] ${v.name}${v.location ? ` at ${v.location}` : ''}${v.reason ? ` — ${v.reason}` : ''}${v.providers?.length ? ` with ${v.providers.map((p: any) => p.name).filter(Boolean).join(', ')}` : ''}`
        );
        sections.push(`## Recent visits (from EHR)\n${top.join('\n')}`);
      }
      if (liveEhr.care_team?.length > 0) {
        const top = liveEhr.care_team.slice(0, 15).map((p: any) =>
          `- ${p.name}${p.specialty ? `, ${p.specialty}` : ''}${p.role ? ` (${p.role})` : ''}${p.phones?.length ? ` — ${p.phones[0]}` : ''}`
        );
        sections.push(`## Care team (from EHR)\n${top.join('\n')}`);
      }
    }

    if ((meds as any[]).length > 0) {
      const active = (meds as any[]).filter((m: any) => m.active !== false);
      const inactive = (meds as any[]).filter((m: any) => m.active === false);
      if (active.length > 0) {
        sections.push(`## Caregiver-recorded medications\n${active.map((m: any) =>
          `- ${m.name}${m.dose ? ' ' + m.dose : ''}${m.frequency ? ', ' + m.frequency : ''}${m.prescriber ? `, prescriber ${m.prescriber}` : ''}`
        ).join('\n')}`);
      }
      if (inactive.length > 0) {
        sections.push(`## Past medications (caregiver-recorded)\n${inactive.map((m: any) => `- ${m.name}`).join('\n')}`);
      }
    }

    if ((medLogs as any[]).length > 0) {
      const medsById: Record<string, string> = {};
      for (const m of (meds as any[])) medsById[m.id] = m.name;
      const lines = (medLogs as any[]).slice(0, 20).map((l: any) => {
        const mname = medsById[l.medication_id] || 'medication';
        return `- [${dateOnly(l.taken_at)}] ${mname}: ${l.status || 'logged'}${l.notes ? ` — ${l.notes}` : ''}`;
      });
      sections.push(`## Recent medication check-ins\n${lines.join('\n')}`);
    }

    if ((labs as any[]).length > 0) {
      const lines = (labs as any[]).slice(0, 30).map((l: any) =>
        `- [${dateOnly(l.effective_date)}] ${l.test_name}: ${l.value}${l.unit ? ' ' + l.unit : ''}${l.reference_range ? ` (ref ${l.reference_range})` : ''}${l.status ? ` [${l.status}]` : ''}`
      );
      sections.push(`## Recent labs (stored)\n${lines.join('\n')}`);
    }

    if ((vitalsRows as any[]).length > 0) {
      const lines = (vitalsRows as any[]).slice(0, 25).map((v: any) =>
        `- [${dateOnly(v.effective_date)}] ${v.vital_type}: ${v.value}${v.unit ? ' ' + v.unit : ''}`
      );
      sections.push(`## Recent vitals (stored)\n${lines.join('\n')}`);
    }

    if ((allergyRows as any[]).length > 0) {
      const lines = (allergyRows as any[]).map((a: any) =>
        `- ${a.substance}${a.reaction ? ` — ${a.reaction}` : ''}${a.severity ? ` (${a.severity})` : ''}${a.clinical_status ? ` [${a.clinical_status}]` : ''}`
      );
      sections.push(`## Allergies (stored)\n${lines.join('\n')}`);
    }

    if (person.conditions) sections.push(`## Conditions (caregiver-noted)\n${person.conditions}`);
    if (person.allergies) sections.push(`## Allergies (caregiver-noted)\n${person.allergies}`);

    if ((events as any[]).length > 0) {
      const lines = (events as any[]).slice(0, 30).map((e: any) =>
        `- [${dateOnly(e.event_date)}] ${e.event_type}: ${e.title}${e.notes ? ' — ' + e.notes : ''}`
      );
      sections.push(`## Recent health events (caregiver-recorded)\n${lines.join('\n')}`);
    }

    if ((visitAttach as any[]).length > 0) {
      const lines = (visitAttach as any[]).map((a: any) =>
        `- [${dateOnly(a.created_at)}] ${a.kind || 'attachment'}: ${a.file_name}${a.note ? ` — ${a.note}` : ''}`
      );
      sections.push(`## Visit attachments\n${lines.join('\n')}`);
    }

    if ((checkIns as any[]).length > 0) {
      const lines = (checkIns as any[]).map((c: any) => {
        const fields = [
          c.mood && `mood ${c.mood}`,
          c.pain_level != null && `pain ${c.pain_level}`,
          c.sleep_quality && `sleep ${c.sleep_quality}`,
          c.energy_level && `energy ${c.energy_level}`,
          c.appetite && `appetite ${c.appetite}`,
        ].filter(Boolean).join(', ');
        return `- [${dateOnly(c.checked_in_at)}] ${fields}${c.notes ? ` — ${c.notes}` : ''}`;
      });
      sections.push(`## Recent caregiver check-ins\n${lines.join('\n')}`);
    }

    if ((docs as any[]).length > 0) {
      const lines: string[] = [];
      for (const d of (docs as any[])) {
        if (d.extracted_events?.summary) {
          lines.push(`- ${d.document_type || 'document'} (${d.file_name}): ${d.extracted_events.summary}`);
        }
        if (d.extracted_events?.items?.length > 0) {
          const items = d.extracted_events.items.slice(0, 5).map((i: any) =>
            `${i.type}: ${i.title}${i.detail ? ' - ' + i.detail : ''}`
          ).join('; ');
          lines.push(`  - Extracted items: ${items}`);
        }
      }
      if (lines.length > 0) sections.push(`## Uploaded documents\n${lines.join('\n')}`);
    }

    const context = sections.join('\n\n');

    const systemPrompt = `You are Wellet, a health companion for family caregivers. You answer questions about a care recipient's health based on the data their caregiver has recorded AND their live EHR data when available.

Voice & Behavior Design (based on BJ Fogg's Tiny Habits framework):
- Answer in plain, warm language a non-medical person can understand
- Be specific — reference actual data points (dates, medication names, values) when available
- If the data doesn't contain enough information to fully answer, say what you DO know and what's missing, then suggest where it might be found (uploaded records, a specific EHR connection, or the primary doctor)
- Never make up health information not present in the data
- Keep answers concise (2-4 sentences for simple questions, more for complex ones)
- If asked about trends or patterns, reference specific events and dates
- You are NOT a doctor — frame insights as observations from the recorded data, not medical advice
- If asked something dangerous or outside scope, gently redirect to their healthcare provider
- Do NOT flag dosing errors, drug interactions, or medication mistakes. Wellet helps coordinate care, not find medical errors — leave clinical judgment to the care team

CRITICAL — Never use shame as a prompt:
- NEVER say "missed dose", "non-compliant", "forgot medication", "failed to", "non-adherent", or "you need to be more consistent"
- NEVER communicate that a care recipient "forgot" something to either the caregiver or care recipient
- If a medication timing pattern has shifted, frame it as an observation with a tiny habit suggestion: "Lisinopril timing has been shifting around lately. If mornings are busy, some people find it easier to take it right after the first cup of coffee."
- Always anchor suggestions to existing behaviors ("after your morning coffee", "next to the coffee maker", "when you sit down for breakfast")
- Only mention pattern shifts if they persist 3+ days — a single missed day is noise, not a pattern

Voice constraints (STRICT):
- Forbidden words: "track", "tracks", "tracking", "monitor", "keep tabs on"
- Use instead: "notices", "watches for", "follows", "reads", "stays on top of"
- Use "loved one", "family member", or "the person you care for" — not "parent"

Stability Signals:
- When things are going well (medications on schedule, vitals stable, routines consistent), celebrate that explicitly: "Everything is looking steady" or "Routines are holding nicely"
- Treat stability as a positive state worth naming, not just an absence of problems
- This builds caregiver trust so they take Wellet seriously when a real concern arises

Framing:
- Always frame information to the caregiver, not pushed at the care recipient
- The caregiver decides whether and how to share insights with their loved one
- Use the care recipient's relationship name ("your dad", "Mom") when the relationship is known

Using the data below:
- The Demographics block is your first-class source of truth for age, sex, DOB, and relationship. Never ask the caregiver for those if present.
- When Live EHR sections are present, they reflect the care recipient's actual clinical record as of the timestamp shown. Prefer these for clinical facts (active medications, conditions, labs, visits, care team).
- Caregiver-recorded sections (medications, events, check-ins, documents) capture what the caregiver has personally observed or uploaded. Use them alongside EHR data to form a complete picture.
- If the question touches on something NOT in the data (for example no labs visible), say so clearly and point to where it might be found.

Here is the care recipient's complete record:

${context}`;

    const chip = formatContextChip(context_hint);
    const userContent = chip
      ? `The caregiver is asking about this specific item: ${chip}.\n\nQuestion: ${question}`
      : question;

    // Voice v1: build messages with optional multi-turn history sandwiched
    // between the (system + grounded context) and the new user question.
    const messages: any[] = [{ role: 'system', content: systemPrompt }];
    for (const m of history) messages.push(m);
    messages.push({ role: 'user', content: userContent });

    // PHI path. The grounded systemPrompt above contains the loved one's full
    // clinical record. We mark phi:true so the adapter's assertVendorAllowedForPhi
    // guardrail refuses to route this to Sonar or any non-BAA vendor — Azure
    // OpenAI (BAA-covered) is the only allowed destination today.
    let answer = 'I could not generate an answer. Please try again.';
    let modelUsed: string | undefined = undefined;
    try {
      const ai = await aiChat({
        phi: true,
        model: 'gpt-4o',
        messages,
        max_tokens: 1000,
        temperature: 0.3,
      });
      answer = ai.content || answer;
      modelUsed = ai.model;
    } catch (err) {
      console.error('ask-wellet PHI aiChat error:', err);
      return new Response(
        JSON.stringify({ error: 'AI service error', details: String(err) }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Voice v1: classify this exchange so the UI can decide whether to show
    // the soft save-to-timeline chip. Fast and best-effort: if the classifier
    // fails or the rules don't fire, default to 'lookup'.
    const classification = classifyExchange(question, answer);

    return new Response(
      JSON.stringify({ answer, model: modelUsed, live_ehr: !!liveEhr, classification }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('Ask Wellet v24 error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error', details: String(err) }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
