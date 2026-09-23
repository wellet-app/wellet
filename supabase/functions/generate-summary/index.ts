// generate-summary v29, verbatim-extraction rewrite (accuracy hard rule)
//
// The v27/v28 flow asked GPT-4o to "synthesize" caregiver summaries from a
// structured context block. Audit on 2026-09-23 confirmed the failure mode
// Wellet's accuracy hard rule was written to prevent: the model produced
// bullets that were factually adjacent to the data but medically inferential
// ("slightly low" on an in-range ferritin, "holding steady" on a 10% eGFR
// drop the deterministic trend function classified as "down", "dose adjusted
// to 5 mg" inferred from two overlapping active rosuvastatin prescriptions).
//
// v29 changes the contract. The server now pre-computes a fixed set of
// caregiver-safe bullet strings (`derivedBullets`) from the same source rows
// v28 used, using deterministic logic, `computeLabTrends`, active-med row
// counts, visit records, wearable status. The model's only job is to (a)
// pick which of those bullets to include, (b) order them, and (c) write the
// Snapshot paragraph. It may NOT paraphrase a bullet, invent a new one, or
// add clinical interpretation. Prompt enforces this and the response is
// validated: any bullet not present verbatim in `derivedBullets` is dropped
// server-side before the row is written.
//
// PHI surface is unchanged (Azure OpenAI, BAA-covered path via aiChat with
// phi: true). Voice rules and the Snapshot format are unchanged. What is
// gone: the license to synthesize medical facts.
//
// Escape hatch: WELLET_AI_VENDOR=openai_direct (with
// WELLET_ALLOW_OPENAI_DIRECT_PHI=true) reverts to direct OpenAI without a
// redeploy. WELLET_AI_VENDOR=sonar will THROW at the adapter guardrail.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChat } from "../_shared/azureOpenAI.ts";

const VERSION = "29";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ── Trend helpers ───────────────────────────────────────────────────────────────

function parseLabNumeric(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = String(raw).trim().replace(/[,]/g, "");
  const match = cleaned.match(/^-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return Number.isFinite(n) ? n : null;
}

function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function daysBetween(aIso: string, bIso: string): number {
  return Math.round((new Date(aIso).getTime() - new Date(bIso).getTime()) / 86400000);
}

function computeLabTrends(labs: any[]): Array<{
  name: string; latest: string; latest_date: string | null;
  direction: "up" | "down" | "flat" | "unknown";
  delta_desc: string | null;
  is_recent: boolean;
}> {
  const byName = new Map<string, any[]>();
  for (const l of labs) {
    const key = (l.test_name || "").trim();
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(l);
  }
  const result: any[] = [];
  const now = Date.now();
  const thirtyDays = 30 * 86400000;
  for (const [name, arr] of byName) {
    arr.sort((a, b) => new Date(b.effective_date).getTime() - new Date(a.effective_date).getTime());
    const latest = arr[0];
    const prior = arr.find((r, i) => i > 0 && r.value !== latest.value);
    const latestNum = parseLabNumeric(latest.value);
    const priorNum = prior ? parseLabNumeric(prior.value) : null;
    let direction: "up" | "down" | "flat" | "unknown" = "unknown";
    let delta_desc: string | null = null;
    if (latestNum !== null && priorNum !== null) {
      const diff = latestNum - priorNum;
      const pct = priorNum !== 0 ? Math.abs(diff / priorNum) : 0;
      if (pct < 0.02) direction = "flat";
      else direction = diff > 0 ? "up" : "down";
      const priorDate = formatShortDate(prior!.effective_date);
      const unit = latest.unit ? " " + latest.unit : "";
      delta_desc = priorDate
        ? `${direction === "down" ? "down" : direction === "up" ? "up" : "steady"} from ${prior!.value}${unit} in ${priorDate}`
        : null;
    }
    const latestTime = new Date(latest.effective_date).getTime();
    const isRecent = Number.isFinite(latestTime) && (now - latestTime) <= thirtyDays;
    result.push({
      name,
      latest: `${latest.value}${latest.unit ? " " + latest.unit : ""}`,
      latest_date: formatShortDate(latest.effective_date),
      direction,
      delta_desc,
      is_recent: isRecent,
    });
  }
  return result;
}

// ── Verbatim-bullet guardrail ─────────────────────────────────────────────────
// Splits the model output on the "What's new" heading, keeps the Snapshot
// verbatim, and rewrites the bullet list so it contains only bullets that
// appear verbatim in the allowed list. Drops paraphrases, additions, and
// bullets with clinical adjectives the model may have leaked in.
function enforceVerbatimBullets(raw: string, allowed: string[]): string {
  const allowedSet = new Set(allowed.map((b) => b.trim()));
  const lower = raw.toLowerCase();
  const newsRegex = /what[\u2019']s\s+new[^:]*:/i;
  const match = lower.match(newsRegex);
  if (!match || match.index === undefined) {
    // No "What's new" heading, leave the raw text alone. The UI layer
    // renders it as one paragraph block per UpdateMeSummarySections.
    return raw;
  }

  const colonIndex = raw.indexOf(":", match.index);
  if (colonIndex < 0) return raw;

  const before = raw.slice(0, colonIndex + 1);
  const after = raw.slice(colonIndex + 1);

  const lines = after.split(/\r?\n/);
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Strip a leading "- " bullet marker if present.
    const bulletText = trimmed.replace(/^[-*\u2022]\s+/, "").trim();
    if (allowedSet.has(bulletText)) kept.push(`- ${bulletText}`);
  }

  if (kept.length === 0 && allowed.length > 0) {
    // Model produced only paraphrases or additions. Fall back to the full
    // deterministic list so the card is never blank when we have facts.
    for (const b of allowed) kept.push(`- ${b}`);
  } else if (kept.length === 0) {
    kept.push("- Nothing new to flag, routines are holding.");
  }

  return `${before}\n${kept.join("\n")}\n`;
}

function classifyWindow(sig: {
  recentVisitCount: number;
  newMedCount: number;
  recentLabCount: number;
  recentEventCount: number;
  recentCheckInCount: number;
  abnormalLabCount: number;
  trendingLabCount: number;
}): "quiet" | "active" | "attention" {
  if (sig.abnormalLabCount >= 2) return "attention";
  if (sig.newMedCount + sig.recentVisitCount >= 3) return "active";
  if (sig.newMedCount + sig.recentVisitCount + sig.recentLabCount + sig.trendingLabCount >= 2) return "active";
  return "quiet";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Env check on every cold start
  const envCheck = {
    vendor: Deno.env.get("WELLET_AI_VENDOR") ?? "azure",
    has_azure_endpoint: !!Deno.env.get("AZURE_OPENAI_ENDPOINT"),
    has_azure_key: !!Deno.env.get("AZURE_OPENAI_API_KEY"),
    chat_deployment: Deno.env.get("AZURE_OPENAI_DEPLOYMENT_GPT4O") ?? "(unset)",
  };
  console.log(`[generate-summary v${VERSION}] env_check`, JSON.stringify(envCheck));

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return new Response(
        JSON.stringify({ error: "Missing authorization" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { person_id, ehr_context } = await req.json();
    if (!person_id) {
      return new Response(
        JSON.stringify({ error: "person_id is required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { data: person } = await supabase.from("people").select("*").eq("id", person_id).single();
    if (!person) {
      return new Response(
        JSON.stringify({ error: "Person not found" }),
        { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── Pull data streams in parallel ──
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    const oneEightyDaysAgo = new Date(Date.now() - 180 * 86400000).toISOString();

    const [
      { data: events },
      { data: meds },
      { data: docs },
      { data: labs180d },
      { data: _vitals30d },
      { data: checkIns },
      { data: terra },
    ] = await Promise.all([
      supabase.from("health_events")
        .select("event_type, event_date, title, notes, source")
        .eq("person_id", person_id)
        .gte("event_date", thirtyDaysAgo)
        .order("event_date", { ascending: false })
        .limit(30),
      supabase.from("medications")
        .select("name, dose, frequency, prescriber, active, created_at")
        .eq("person_id", person_id)
        .eq("active", true),
      supabase.from("documents")
        .select("file_name, document_type, extracted_events, uploaded_at")
        .eq("person_id", person_id)
        .eq("extraction_status", "completed")
        .order("uploaded_at", { ascending: false })
        .limit(5),
      supabase.from("lab_results")
        .select("test_name, value, unit, reference_range, status, effective_date, loinc_code")
        .eq("person_id", person_id)
        .gte("effective_date", oneEightyDaysAgo)
        .order("effective_date", { ascending: false })
        .limit(200),
      supabase.from("vitals")
        .select("vital_type, value, unit, effective_date")
        .eq("person_id", person_id)
        .gte("effective_date", thirtyDaysAgo)
        .order("effective_date", { ascending: false })
        .limit(50),
      supabase.from("check_ins")
        .select("mood, pain_level, sleep_quality, energy_level, appetite, notes, checked_in_at")
        .eq("person_id", person_id)
        .gte("checked_in_at", thirtyDaysAgo)
        .order("checked_in_at", { ascending: false })
        .limit(30),
      supabase.from("terra_connections")
        .select("provider, status, last_data_at, connected_at")
        .eq("person_id", person_id),
    ]);

    const totalEvents = events?.length || 0;
    const totalMeds = meds?.length || 0;
    const totalDocs = docs?.length || 0;
    const totalLabs = labs180d?.length || 0;
    const totalCheckIns = checkIns?.length || 0;

    const ehrConditions = (ehr_context?.conditions || []) as any[];
    const ehrMeds = (ehr_context?.medications || []) as any[];
    const ehrVisits = (ehr_context?.visits || []) as any[];
    const ehrRecentLabs = (ehr_context?.recent_labs || []) as any[];

    const hasEhr = !!(
      ehrVisits.length || ehrMeds.length || ehrConditions.length || ehrRecentLabs.length
    );
    const hasAnyData = totalEvents || totalMeds || totalDocs || totalLabs || totalCheckIns || hasEhr;

    if (!hasAnyData) {
      return new Response(
        JSON.stringify({ summary: null, empty: true, event_count: 0, med_count: 0 }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const personAge = person.date_of_birth
      ? Math.floor((Date.now() - new Date(person.date_of_birth).getTime()) / 31557600000)
      : null;
    const firstName = (person.name || "").split(/\s+/)[0] || "your loved one";
    const relation = (person.relationship || "").toLowerCase();

    const combinedLabs = [
      ...(labs180d || []),
      ...ehrRecentLabs.map((l: any) => ({
        test_name: l.name,
        value: l.value,
        unit: l.unit || "",
        reference_range: l.reference_range,
        status: l.interpretation,
        effective_date: l.date,
        loinc_code: l.loinc_code || null,
      })),
    ];
    const trends = computeLabTrends(combinedLabs);
    const recentTrends = trends.filter((t) => t.is_recent);
    const trendingLabCount = trends.filter((t) => t.direction === "up" || t.direction === "down").length;

    const abnormalLabCount = (labs180d || []).filter((l: any) => {
      if (!l.effective_date) return false;
      const recent = Date.now() - new Date(l.effective_date).getTime() <= 30 * 86400000;
      const s = String(l.status || "").toLowerCase();
      return recent && (s.includes("high") || s.includes("low") || s.includes("abnormal"));
    }).length;

    const recentVisitCount = ehrVisits.filter((v: any) => v.is_recent).length;
    const newMedCount = ehrMeds.filter((m: any) => m.is_recent).length;
    const recentLabCount = recentTrends.length;

    const windowClass = classifyWindow({
      recentVisitCount,
      newMedCount,
      recentLabCount,
      recentEventCount: totalEvents,
      recentCheckInCount: totalCheckIns,
      abnormalLabCount,
      trendingLabCount,
    });

    const gaps: string[] = [];
    if (ehrVisits.length) {
      const lastVisit = ehrVisits
        .map((v: any) => v.start_date)
        .filter(Boolean)
        .sort()
        .reverse()[0];
      if (lastVisit) {
        const days = daysBetween(new Date().toISOString(), lastVisit);
        if (days > 180) {
          gaps.push(`It has been about ${Math.round(days / 30)} months since the last recorded visit (${formatShortDate(lastVisit)}).`);
        }
      }
    }
    const activeWearables = (terra || []).filter((t: any) => t.status === "connected" || t.status === "active");
    const wearableNote = activeWearables.length
      ? `Apple Health/wearable data is flowing (last update ${formatShortDate(activeWearables[0].last_data_at) || "recently"}).`
      : null;

    let context = `Care recipient first name: ${firstName}`;
    if (personAge) context += `, age ${personAge}`;
    if (relation) context += ` (${relation})`;
    if (person.conditions) context += `\nKnown conditions (user-entered): ${person.conditions}`;
    if (person.allergies) context += `\nAllergies (user-entered): ${person.allergies}`;

    context += `\n\nWINDOW CLASSIFICATION: ${windowClass.toUpperCase()}`;
    context += `\n(quiet = nothing material changed; active = multiple new events; attention = abnormal labs or cluster of changes)`;

    if (ehrConditions.length) {
      context += `\n\nActive problems (from ${ehr_context?.provider || "EHR"}):\n` + ehrConditions.slice(0, 10).map((c: any) =>
        `- ${c.name}${c.recorded_date ? " (since " + String(c.recorded_date).split("T")[0] + ")" : ""}`,
      ).join("\n");
    }

    if (meds && meds.length > 0) {
      context += "\n\nActive medications (Wellet records):\n" + meds.map((m: any) =>
        `- ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? ", " + m.frequency : ""}`,
      ).join("\n");
    }
    if (ehrMeds.length) {
      context += `\n\nActive medications (${ehr_context?.provider || "EHR"}):\n` + ehrMeds.slice(0, 12).map((m: any) =>
        `- ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? ", " + m.frequency : ""}${m.is_recent ? "  [NEW in last 30d]" : ""}`,
      ).join("\n");
    }

    if (ehrVisits.length) {
      const recentVisits = ehrVisits.filter((v: any) => v.is_recent).slice(0, 6);
      const olderVisits = ehrVisits.filter((v: any) => !v.is_recent).slice(0, 3);
      if (recentVisits.length) {
        context += `\n\nVisits in last 30 days:\n` + recentVisits.map((v: any) =>
          `- ${formatShortDate(v.start_date) || "recent"}: ${v.name || "Visit"}${v.reason ? ", " + v.reason : ""}${v.provider ? " with " + v.provider : ""}`,
        ).join("\n");
      }
      if (olderVisits.length) {
        context += `\n\nPrior visits:\n` + olderVisits.map((v: any) =>
          `- ${formatShortDate(v.start_date) || "earlier"}: ${v.name || "Visit"}${v.reason ? ", " + v.reason : ""}${v.provider ? " with " + v.provider : ""}`,
        ).join("\n");
      }
    }

    if (recentTrends.length) {
      context += `\n\nRecent labs with trend direction (last 30d):\n` + recentTrends.slice(0, 10).map((t) =>
        `- ${t.name}: ${t.latest}${t.latest_date ? " on " + t.latest_date : ""}${t.delta_desc ? ", " + t.delta_desc : ""}`,
      ).join("\n");
    }

    if (totalCheckIns > 0) {
      const last = checkIns![0];
      const summaryBits: string[] = [];
      if (last.mood) summaryBits.push(`mood: ${last.mood}`);
      if (last.sleep_quality) summaryBits.push(`sleep: ${last.sleep_quality}`);
      if (last.energy_level) summaryBits.push(`energy: ${last.energy_level}`);
      if (typeof last.pain_level === "number") summaryBits.push(`pain ${last.pain_level}/10`);
      if (summaryBits.length) {
        context += `\n\nMost recent caregiver check-in (${formatShortDate(last.checked_in_at)}): ${summaryBits.join(", ")}`;
      }
      if (totalCheckIns > 1) {
        context += ` · ${totalCheckIns} check-ins in the last 30 days`;
      }
    }

    if (wearableNote) context += `\n\nWearables: ${wearableNote}`;
    if (gaps.length) context += `\n\nCare gaps:\n- ${gaps.join("\n- ")}`;

    if (events && events.length > 0) {
      context += "\n\nRecent Wellet events:\n" + events.slice(0, 10).map((e: any) =>
        `- ${formatShortDate(e.event_date) || "recent"}: ${e.event_type}: ${e.title}${e.notes ? ", " + e.notes : ""}`,
      ).join("\n");
    }

    if (docs && docs.length > 0) {
      docs.forEach((d: any) => {
        if (d.extracted_events?.summary) {
          context += `\n\nFrom ${d.document_type || "document"} (${d.file_name}): ${d.extracted_events.summary}`;
        }
      });
    }

    // ── Derived bullets ────────────────────────────────────────────────
    // Every bullet the model is allowed to emit is pre-computed here from
    // source rows using deterministic logic. The model may pick and order
    // these, but may not paraphrase or invent new ones. A validation pass
    // after the model call drops anything not present verbatim.
    const derivedBullets: string[] = [];

    // Labs: direction comes from computeLabTrends, not from the model.
    for (const t of recentTrends.slice(0, 6)) {
      const dir = t.direction === "up"
        ? "up"
        : t.direction === "down"
          ? "down"
          : t.direction === "flat"
            ? "steady"
            : null;
      if (dir && t.delta_desc) {
        derivedBullets.push(`${t.name} ${t.latest} on ${t.latest_date || "recent date"}, ${t.delta_desc}.`);
      } else if (t.latest_date) {
        derivedBullets.push(`${t.name} ${t.latest} on ${t.latest_date}.`);
      } else {
        derivedBullets.push(`${t.name} ${t.latest}.`);
      }
    }

    // Visits: only source-authored fields (name, reason, provider, date).
    for (const v of ehrVisits.filter((v: any) => v.is_recent).slice(0, 4)) {
      const bits: string[] = [];
      bits.push(v.name || "Visit");
      if (v.start_date) bits.push(`on ${formatShortDate(v.start_date) || "recent date"}`);
      if (v.provider) bits.push(`with ${v.provider}`);
      if (v.reason) bits.push(`for ${v.reason}`);
      derivedBullets.push(`${bits.join(" ")}.`);
    }

    // Medications: NEW rows from EHR flagged is_recent, source-honest.
    for (const m of ehrMeds.filter((m: any) => m.is_recent).slice(0, 6)) {
      const parts = [m.name];
      if (m.dose) parts.push(m.dose);
      if (m.frequency) parts.push(m.frequency);
      derivedBullets.push(`New medication on file: ${parts.join(", ")}.`);
    }

    // Medication conflict surface: when two or more active rows share a
    // normalized generic name, surface it as a caregiver question rather
    // than resolving it as a "dose adjustment". This is exactly the
    // rosuvastatin failure mode from the 2026-09-23 audit.
    const activeByGeneric = new Map<string, any[]>();
    for (const m of (meds || [])) {
      const generic = String(m.name || "").trim().toLowerCase().split(/\s+/)[0];
      if (!generic) continue;
      if (!activeByGeneric.has(generic)) activeByGeneric.set(generic, []);
      activeByGeneric.get(generic)!.push(m);
    }
    for (const [generic, rows] of activeByGeneric) {
      if (rows.length < 2) continue;
      const summarized = rows.map((r: any) => {
        const dose = String(r.dose || "").match(/\d+\s*(mg|mcg|g|ml|iu|units?)/i)?.[0] || "unspecified dose";
        const who = r.prescriber ? ` from ${r.prescriber}` : "";
        return `${dose}${who}`;
      }).join(" and ");
      derivedBullets.push(
        `Two or more active ${generic} rows on file (${summarized}). Worth confirming which one is current.`,
      );
    }

    // Check-in facts: source values only, no adjectives beyond the ones
    // the caregiver typed themselves.
    if (totalCheckIns > 0) {
      const last = checkIns![0];
      const bits: string[] = [];
      if (last.mood) bits.push(`mood ${last.mood}`);
      if (last.sleep_quality) bits.push(`sleep ${last.sleep_quality}`);
      if (last.energy_level) bits.push(`energy ${last.energy_level}`);
      if (typeof last.pain_level === "number") bits.push(`pain ${last.pain_level}/10`);
      if (bits.length) {
        derivedBullets.push(
          `Caregiver check-in on ${formatShortDate(last.checked_in_at) || "recent date"}: ${bits.join(", ")}.`,
        );
      }
    }

    // Care-gap flag: already a deterministic string, safe verbatim.
    for (const g of gaps) derivedBullets.push(g);

    // ── Verbatim-selection prompt ──────────────────────────────────────
    // The model is a selector and orderer of derivedBullets plus the
    // author of the Snapshot paragraph. It is not permitted to invent,
    // paraphrase, or add clinical interpretation.
    const numberedBullets = derivedBullets
      .map((b, i) => `[${i + 1}] ${b}`)
      .join("\n");

    const systemPrompt = `You are Wellet, writing one short daily update for a family caregiver. Two roles only: write the Snapshot paragraph in Wellet's voice, and pick which of the pre-approved bullets to include in "What's new (last 30 days)".

HARD ACCURACY RULE, non-negotiable:
- The "What's new" bullets you emit must be copied VERBATIM from the numbered list below.
- You may reorder them. You may omit any that are not caregiver-relevant. You may NOT paraphrase, condense, split, merge, translate, or edit them.
- You may NOT invent a new bullet, even one that seems obviously true from context.
- If the numbered list is empty, write exactly one bullet: "Nothing new to flag, routines are holding."
- Do not add adjectives like "slightly," "mildly," "significantly," "concerning," "reassuring," "stable," "holding steady" to a numbered bullet. Take the bullet as-is or leave it out.
- Do not add clinical interpretation ("suggests," "likely," "confirms," "indicates," "consistent with"). Take the bullet as-is or leave it out.

SNAPSHOT PARAGRAPH, 2 to 4 sentences, Wellet voice:
- Opening sentence is a verdict-first statement of the state of things (e.g. "Steady month." / "A few things worth knowing." / "Active month with several visits.").
- 1 to 2 sentences of context: which health system is the main care context, which chronic conditions are the ongoing frame, general state of routines. Reference ${firstName} by first name.
- The Snapshot may NOT contain any lab values, medication doses, provider names beyond the primary system, or dates. Those live in the bullets.
- Second person, using ${firstName} or "loved one". Never "the patient", never "parent".
- No adjectives as a substitute for a finding ("doing well", "looking good").
- Forbidden words: track, tracks, tracking, monitor, keep tabs on, alert, surveillance. Use notices, watches for, follows, reads, stays on top of.

OUTPUT FORMAT, exactly this shape, plain text, no markdown, no bullets outside "What's new":

Snapshot:
[2 to 4 sentences per rules above]

What's new (last 30 days):
- [Bullet copied verbatim from the numbered list, one per line]
- [Additional bullets, verbatim, one per line]

RULES:
- Under 160 words total.
- No markdown bold, no headers other than the two labels shown.
- End "What's new" without a concluding sentence. No sign-off.
- If a numbered bullet contains language you were told is forbidden, still emit it verbatim; the server generated it and takes responsibility for its language.`;

    const userContent =
      `Write the update for ${firstName}. Use the context for the Snapshot only. For "What's new", pick verbatim from the numbered list.\n\n` +
      `WINDOW: ${windowClass.toUpperCase()}\n\n` +
      `CONTEXT (for Snapshot only, do not quote):\n${context}\n\n` +
      `NUMBERED BULLETS (source for "What's new", copy verbatim, do not edit):\n${numberedBullets || "(none)"}`;

    let summary = "";
    let aiVendor = "";
    let aiModel = "";
    let aiUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;

    try {
      const res = await aiChat({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
        max_tokens: 700,
        temperature: 0.2,
        phi: true, // caregiver summary derived from real medical history, BAA required
      });
      summary = res.content;
      aiVendor = res.vendor;
      aiModel = res.model;
      aiUsage = res.usage;

      // Verbatim-bullet guardrail. Anything after "What's new" that is not
      // an exact match for a derivedBullet is dropped. If the guardrail
      // drops everything and derivedBullets is non-empty, fall back to
      // the full derivedBullets list in order so the card is never blank.
      summary = enforceVerbatimBullets(summary, derivedBullets);

      console.log(
        `[generate-summary v${VERSION}] aiChat (${res.vendor}/${res.model}) returned ${summary.length} chars after guardrail, window=${windowClass}, bullets_offered=${derivedBullets.length}`,
      );
    } catch (aiErr) {
      console.error(`[generate-summary v${VERSION}] AI call failed:`, aiErr);
      return new Response(
        JSON.stringify({ error: "AI service error", details: String(aiErr) }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const dataHash = `e${totalEvents}m${totalMeds}d${totalDocs}l${totalLabs}c${totalCheckIns}h${hasEhr ? 1 : 0}w${windowClass[0]}`;

    // Best-effort cache. Record vendor/model so audit can prove BAA path.
    try {
      await supabase.from("update_me_summaries").upsert({
        person_id,
        summary_text: summary,
        data_hash: dataHash,
        generated_at: new Date().toISOString(),
        model: `${aiVendor}/${aiModel}`,
        event_count: totalEvents,
      }, { onConflict: "person_id" });
    } catch (_e) { /* noop */ }

    const sources = {
      ehr: hasEhr,
      ehr_provider: ehr_context?.provider || null,
      wearable: activeWearables.length > 0,
      wearable_provider: activeWearables[0]?.provider || null,
      check_ins: totalCheckIns > 0,
      labs: totalLabs > 0 || ehrRecentLabs.length > 0,
      events: totalEvents > 0,
      documents: totalDocs > 0,
    };

    return new Response(
      JSON.stringify({
        summary,
        window_class: windowClass,
        event_count: totalEvents,
        med_count: totalMeds,
        lab_count: totalLabs,
        check_in_count: totalCheckIns,
        has_ehr: hasEhr,
        sources,
        model: aiModel,
        ai_vendor: aiVendor,
        function_version: VERSION,
        data_hash: dataHash,
        usage: aiUsage,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`[generate-summary v${VERSION}] Generate summary error:`, err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
