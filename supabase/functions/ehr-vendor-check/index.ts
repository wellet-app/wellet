// supabase/functions/ehr-vendor-check/index.ts
//
// 2026-05-21 — EHR Vendor Pre-Check
//
// Given a hospital or health-system name, returns which EHR vendor it uses
// and whether Wellet can connect to it today. Used by the hospital picker
// (when search returns no Epic match) and by the "Tell us about your
// hospital" request form (to give the user a useful answer before they hit
// Send).
//
// Source cascade:
//   1. Cache (public.hospital_vendor_lookups, 30 day TTL)
//   2. Epic R4 endpoint bundle (https://open.epic.com/Endpoints/R4)
//      via existing epic-endpoints edge function (already cached server-side)
//      Plus the activation allowlist for "Wellet is wired to connect".
//   3. Hard-coded blocked list (Kaiser, VA-via-Epic — known to refuse 3rd-party FHIR)
//   4. Perplexity Sonar — answers "what EHR vendor does <hospital> use" for
//      everything Epic doesn't claim, with citations attached for auditability.
//
// Buckets returned in `vendor_guess`:
//   epic_activated      — on Epic AND Wellet is wired to connect
//   epic_not_activated  — on Epic, but Wellet hasn't activated this org yet
//   epic_blocked        — on Epic, but vendor blocks 3rd-party FHIR (Kaiser, VA)
//   cerner | meditech | athena | nextgen | allscripts | other
//   unknown             — couldn't determine
//
// All non-PHI. Cache table has RLS on for authenticated SELECT; writes are
// service-role via this function only.
//
// Auth: verify_jwt=true. The function reads the JWT to confirm an authed
// user but doesn't bind results to user_id.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// PERPLEXITY_API_KEY is stored in Vault, not as a function env var. Fall back
// to the get_vault_secret RPC (same pattern as ask-wellet).
let _cachedPerplexityKey: string | null = null;
async function getPerplexityApiKey(): Promise<string> {
  const envKey = Deno.env.get("PERPLEXITY_API_KEY");
  if (envKey) return envKey;
  if (_cachedPerplexityKey) return _cachedPerplexityKey;
  try {
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const { data, error } = await adminClient.rpc("get_vault_secret", {
      secret_name: "PERPLEXITY_API_KEY",
    });
    if (error || !data) {
      console.warn("[ehr-vendor-check] vault fetch failed", error?.message);
      return "";
    }
    _cachedPerplexityKey = String(data);
    return _cachedPerplexityKey;
  } catch (e) {
    console.warn("[ehr-vendor-check] vault fetch threw", e);
    return "";
  }
}

// 30-day cache TTL on confirmed vendor data. Unknown/low-confidence rows
// expire faster (7 days) so we re-query Sonar in case the hospital migrated.
const CACHE_TTL_DAYS_CONFIRMED = 30;
const CACHE_TTL_DAYS_UNKNOWN = 7;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Activation allowlist (must match assets/wellet.js ACTIVATED_FHIR_URLS) ──
// Hard-coded here because the edge function can't import the web bundle.
// Source of truth lives in the picker; keep these two lists in sync when we
// activate a new Epic org. Normalized: lowercase, trailing slash stripped.
// MUST stay in sync with ACTIVATED_FHIR_URLS in assets/wellet.js. Lowercase,
// trailing-slash stripped. After 2026-05-21 smoke test we discovered the
// previous list had drifted from the picker (Mount Sinai, MSK, NYP, NYU were
// all wrong) — every hospital was missing the activated bucket. Now matched
// exactly to the picker's source-of-truth list.
// Note: each Epic-connected health system can have multiple FHIR endpoints in
// Epic's bundle (e.g. Duke has both fhir.dukehealth.org AND health-apis.duke.edu).
// We include every URL that points to an org we've activated, so that if Epic's
// bundle matches one variant but the picker uses another, we still resolve to
// epic_activated. Keep the picker's URL FIRST in the comment per org.
const ACTIVATED_EPIC_FHIR_URLS: Set<string> = new Set([
  // Duke Health (prod) — picker uses fhir.dukehealth.org, bundle has health-apis.duke.edu
  "https://fhir.dukehealth.org/r4",
  "https://health-apis.duke.edu/fhir/api/fhir/r4",
  // NewYork-Presbyterian / Columbia / Weill Cornell (shared instance)
  "https://epicproxy-pub.et1089.epichosted.com/fhirproxy/api/fhir/r4",
  // NYU Langone
  "https://epicfhir.nyumc.org/fhirprd/api/fhir/r4",
  // Mount Sinai NYC
  "https://epicsoapproxyprd.mountsinai.org/fhir-prd/api/fhir/r4",
  // Montefiore
  "https://soapepic.montefiore.org/fhirproxyprd/api/fhir/r4",
  // Memorial Sloan Kettering
  "https://epicproxy.et1353.epichosted.com/apiproxyprd/api/fhir/r4",
  // Hospital for Special Surgery
  "https://epicproxy.et0927.epichosted.com/fhirproxy/api/fhir/r4",
]);

// Known Epic-but-blocked health systems. Even though they're technically on
// Epic, they refuse 3rd-party SMART-on-FHIR connections. Wellet cannot
// connect to these via Epic ever; the user needs an alternate path.
const EPIC_BLOCKED_PATTERNS: Array<{ pattern: RegExp; label: string; note: string }> = [
  {
    pattern: /\bkaiser( permanente)?\b/i,
    label: "kaiser_blocked",
    note: "Kaiser Permanente is on Epic but blocks third-party FHIR connections. Wellet cannot connect to Kaiser today. You can export your visit summary PDF from kp.org and upload it instead.",
  },
  {
    pattern: /\b(va|veterans? affairs|veterans? administration|va health|veterans? health)\b/i,
    label: "va_blocked",
    note: "The VA is on Epic (Millennium for newer rollouts, Vista for older) but uses its own Lighthouse FHIR API, separate from Epic's standard SMART flow. Wellet is working on a VA path; meanwhile you can upload your visit summary from My HealtheVet.",
  },
];

// Direct vendor signals we recognize at a glance (used to short-circuit Sonar).
const DIRECT_VENDOR_HINTS: Array<{ pattern: RegExp; vendor: string }> = [
  { pattern: /\bcerner\b/i, vendor: "cerner" },
  { pattern: /\boracle (health|cerner)\b/i, vendor: "cerner" },
  { pattern: /\bmeditech\b/i, vendor: "meditech" },
  { pattern: /\bathena(health)?\b/i, vendor: "athena" },
  { pattern: /\bnextgen\b/i, vendor: "nextgen" },
  { pattern: /\ballscripts\b/i, vendor: "allscripts" },
  { pattern: /\beclinicalworks\b/i, vendor: "eclinicalworks" },
];

function normalizeHospitalName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normFhirUrl(u: string): string {
  return String(u || "").trim().toLowerCase().replace(/\/+$/, "");
}

// ─── Epic bundle helpers ────────────────────────────────────────────────────

interface EpicEndpoint {
  name: string;
  fhirBaseUrl: string;
  city?: string;
  state?: string;
}

// Cached across invocations within a warm worker.
let _epicEndpointsCache: EpicEndpoint[] | null = null;
let _epicEndpointsCachedAt = 0;
const EPIC_BUNDLE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

async function loadEpicEndpoints(): Promise<EpicEndpoint[]> {
  if (_epicEndpointsCache && Date.now() - _epicEndpointsCachedAt < EPIC_BUNDLE_TTL_MS) {
    return _epicEndpointsCache;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/epic-endpoints`, {
      headers: {
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: SUPABASE_SERVICE_ROLE_KEY,
      },
    });
    if (!res.ok) return _epicEndpointsCache ?? [];
    const body = await res.json();
    // 2026-05-21 v3 fix: the bundle is Epic's raw shape {Entries: [{OrganizationName,
    // FHIRPatientFacingURI}]}. Earlier this function expected {endpoints: [...]} or a
    // plain array of {name, fhirBaseUrl} and read 0 entries on every cold start, so
    // findEpicMatch always missed and everything fell through to Sonar (NYU Langone
    // bug). Now normalize to match assets/wellet.js's reader.
    const rawList: Array<Record<string, unknown>> = Array.isArray(body)
      ? (body as Array<Record<string, unknown>>)
      : (Array.isArray((body as { Entries?: unknown[] })?.Entries)
        ? ((body as { Entries: Array<Record<string, unknown>> }).Entries)
        : (Array.isArray((body as { endpoints?: unknown[] })?.endpoints)
          ? ((body as { endpoints: Array<Record<string, unknown>> }).endpoints)
          : []));
    const list: EpicEndpoint[] = rawList.map((e) => ({
      name: String(e.OrganizationName || e.Name || e.name || ""),
      fhirBaseUrl: String(
        e.FHIRPatientFacingURI || e.BaseURL || e.FHIRBaseUrl || e.fhirBaseUrl || ""
      ),
      city: typeof e.city === "string" ? (e.city as string) : undefined,
      state: typeof e.state === "string" ? (e.state as string) : undefined,
    })).filter((ep) => ep.name && ep.fhirBaseUrl);
    if (list.length > 0) {
      _epicEndpointsCache = list;
      _epicEndpointsCachedAt = Date.now();
    }
    return _epicEndpointsCache ?? [];
  } catch (_e) {
    return _epicEndpointsCache ?? [];
  }
}

// Common stopwords that appear in nearly every hospital name. Including them
// in the match score causes false positives like "Westchester Medical Center"
// → "University of Pittsburgh Medical Center" (matched on medical+center).
// 2026-05-21 fix: strip these before scoring; require at least one distinctive
// (non-stopword) token to match.
const HOSPITAL_STOPWORDS = new Set([
  "medical", "center", "centre", "hospital", "hospitals", "health", "healthcare",
  "system", "systems", "university", "of", "the", "and", "a", "an",
  "clinic", "clinics", "regional", "community", "memorial", "general",
  "medicine", "care", "services", "institute", "associates", "physicians",
  "group", "network", "st", "saint", "holy", "mercy",
]);

function findEpicMatch(hospitalName: string, endpoints: EpicEndpoint[]): EpicEndpoint | null {
  const q = normalizeHospitalName(hospitalName);
  if (!q) return null;
  // Exact-ish match: hospital name contains query as token-bounded substring.
  // We tokenize both sides so "Mount Sinai" matches "Mount Sinai Health System".
  const qTokensAll = q.split(" ").filter(Boolean);
  const qTokens = qTokensAll.filter((t) => t.length >= 2);
  if (qTokens.length === 0) return null;
  const qDistinctive = qTokens.filter((t) => !HOSPITAL_STOPWORDS.has(t));
  // If the user typed only stopwords (e.g. "medical center"), refuse to match —
  // not enough signal.
  if (qDistinctive.length === 0) return null;

  let best: { endpoint: EpicEndpoint; score: number; distinctiveHits: number } | null = null;
  for (const ep of endpoints) {
    const nameNorm = normalizeHospitalName(ep.name || "");
    if (!nameNorm) continue;
    let score = 0;
    let distinctiveHits = 0;
    for (const t of qTokens) {
      if (nameNorm.includes(t)) {
        score++;
        if (!HOSPITAL_STOPWORDS.has(t)) distinctiveHits++;
      }
    }
    // Must hit at least one DISTINCTIVE token (not just medical/center/etc).
    if (distinctiveHits === 0) continue;
    // Single-token query: any hit is fine, prefer shortest matching name.
    if (qTokens.length === 1 && score === 1) {
      if (!best || nameNorm.length < normalizeHospitalName(best.endpoint.name).length) {
        best = { endpoint: ep, score, distinctiveHits };
      }
      continue;
    }
    // Multi-token query: require ALL distinctive tokens to match, AND at least
    // 60% of total query tokens. This kills the Westchester → UPMC case (only
    // "westchester" is distinctive, must appear in the endpoint name).
    const distinctiveCoverage = qDistinctive.length === 0 ? 1 : distinctiveHits / qDistinctive.length;
    if (distinctiveCoverage >= 1 && score >= Math.ceil(qTokens.length * 0.6)) {
      if (!best || score > best.score || (score === best.score && distinctiveHits > best.distinctiveHits)) {
        best = { endpoint: ep, score, distinctiveHits };
      }
    }
  }
  return best ? best.endpoint : null;
}

// ─── Perplexity Sonar lookup ────────────────────────────────────────────────

interface SonarResult {
  vendor: string;
  blocked: boolean;
  confidence: "high" | "medium" | "low";
  note: string;
  citations: Array<{ url: string; title?: string }>;
  raw?: unknown;
}

async function sonarVendorLookup(
  hospitalName: string,
  city?: string,
  state?: string
): Promise<SonarResult | null> {
  const apiKey = await getPerplexityApiKey();
  if (!apiKey) {
    console.warn("[ehr-vendor-check] no Perplexity API key available");
    return null;
  }

  const loc = [city, state].filter(Boolean).join(", ");
  const where = loc ? ` in ${loc}` : "";
  const prompt =
    `Which electronic health record (EHR) system does ${hospitalName}${where} use ` +
    `for inpatient/outpatient clinical care? ` +
    `Answer ONLY with valid JSON matching this exact schema, no prose, no markdown fences:\n` +
    `{\n` +
    `  "vendor": "epic" | "cerner" | "meditech" | "athena" | "nextgen" | "allscripts" | "eclinicalworks" | "other" | "unknown",\n` +
    `  "confidence": "high" | "medium" | "low",\n` +
    `  "rationale": "one short sentence, 200 chars max, citing what you found"\n` +
    `}\n` +
    `Rules:\n` +
    `- "vendor" reflects the primary EHR for clinical care, not billing or HIE add-ons.\n` +
    `- "high" only if a recent (within 2 years) authoritative source names the vendor.\n` +
    `- "medium" if multiple older sources agree.\n` +
    `- "low" if the answer is inferred or only indirectly supported.\n` +
    `- "unknown" if you genuinely cannot tell — do not guess.\n`;

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          {
            role: "system",
            content:
              "You are a healthcare IT analyst. You answer with valid JSON only. You cite real, verifiable sources.",
          },
          { role: "user", content: prompt },
        ],
        // Keep deterministic + cheap.
        temperature: 0.1,
        max_tokens: 500,
      }),
    });
    if (!res.ok) {
      console.warn("[ehr-vendor-check] Sonar non-200", res.status, await res.text());
      return null;
    }
    const body = await res.json();
    const text: string = body?.choices?.[0]?.message?.content ?? "";
    const citations: Array<{ url: string; title?: string }> =
      (body?.citations || body?.search_results || []).map((c: any) =>
        typeof c === "string" ? { url: c } : { url: c.url, title: c.title }
      );

    // Strip code fences if Sonar ignored the no-fence instruction.
    const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    let parsed: any = null;
    try {
      parsed = JSON.parse(cleaned);
    } catch (_e) {
      // Try to find the first {...} JSON blob.
      const match = cleaned.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); } catch (_e2) {}
      }
    }
    if (!parsed || typeof parsed.vendor !== "string") {
      return {
        vendor: "unknown",
        blocked: false,
        confidence: "low",
        note: "Sonar returned an answer we couldn't parse.",
        citations,
        raw: body,
      };
    }
    return {
      vendor: String(parsed.vendor).toLowerCase(),
      blocked: false,
      confidence: ((["high", "medium", "low"].includes(parsed.confidence))
        ? parsed.confidence
        : "low") as "high" | "medium" | "low",
      note: String(parsed.rationale || "").slice(0, 280),
      citations,
      raw: body,
    };
  } catch (e) {
    console.error("[ehr-vendor-check] Sonar error", e);
    return null;
  }
}

// ─── Main handler ────────────────────────────────────────────────────────────

interface VendorResult {
  vendor_guess: string;
  vendor_confidence: "high" | "medium" | "low";
  vendor_source: "epic_bundle" | "allowlist" | "sonar" | "cache" | "direct_hint" | "blocked_list";
  vendor_blocked: boolean;
  matched_hospital?: string;
  matched_fhir_url?: string;
  note: string;
  citations?: Array<{ url: string; title?: string }>;
  via_perplexity: boolean;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  let body: any;
  try {
    body = await req.json();
  } catch (_e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const rawName: string = String(body?.hospital_name || "").trim();
  const city: string | null = body?.city ? String(body.city).trim() : null;
  const state: string | null = body?.state ? String(body.state).trim() : null;
  if (!rawName || rawName.length < 2) {
    return new Response(JSON.stringify({ error: "hospital_name is required (min 2 chars)" }), {
      status: 400,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  }

  const normalized = normalizeHospitalName(rawName);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // ─── 1. Cache hit ──
  try {
    const { data: cached } = await supabase
      .from("hospital_vendor_lookups")
      .select("*")
      .eq("hospital_name_normalized", normalized)
      .maybeSingle();
    if (cached) {
      const ageDays = (Date.now() - new Date(cached.last_looked_up_at).getTime()) / (1000 * 60 * 60 * 24);
      const isConfirmed = cached.vendor_guess !== "unknown" && cached.vendor_confidence !== "low";
      const ttl = isConfirmed ? CACHE_TTL_DAYS_CONFIRMED : CACHE_TTL_DAYS_UNKNOWN;
      if (ageDays < ttl) {
        // Bump lookup_count + last_looked_up_at so we know what's popular.
        await supabase
          .from("hospital_vendor_lookups")
          .update({
            lookup_count: (cached.lookup_count || 1) + 1,
            last_looked_up_at: new Date().toISOString(),
          })
          .eq("id", cached.id);

        const result: VendorResult = {
          vendor_guess: cached.vendor_guess,
          vendor_confidence: cached.vendor_confidence,
          vendor_source: "cache",
          vendor_blocked: !!cached.vendor_blocked,
          matched_hospital: (cached.payload as any)?.matched_hospital,
          matched_fhir_url: (cached.payload as any)?.matched_fhir_url,
          note: (cached.payload as any)?.note ?? "",
          citations: (cached.citations as any) ?? undefined,
          // Honor the *original* provenance for attribution UI.
          via_perplexity: cached.vendor_source === "sonar",
        };
        return new Response(JSON.stringify(result), {
          status: 200,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });
      }
    }
  } catch (e) {
    console.warn("[ehr-vendor-check] cache read failed", e);
    // Fall through — better to answer than to fail.
  }

  // ─── 2. Hard-coded blocked list ──
  for (const b of EPIC_BLOCKED_PATTERNS) {
    if (b.pattern.test(rawName)) {
      const result: VendorResult = {
        vendor_guess: b.label,
        vendor_confidence: "high",
        vendor_source: "blocked_list",
        vendor_blocked: true,
        note: b.note,
        via_perplexity: false,
      };
      await writeCache(supabase, normalized, rawName, city, state, result);
      return jsonResponse(result);
    }
  }

  // ─── 3. Direct vendor hint in the name itself (e.g. "Cerner test hospital") ──
  for (const hint of DIRECT_VENDOR_HINTS) {
    if (hint.pattern.test(rawName)) {
      const result: VendorResult = {
        vendor_guess: hint.vendor,
        vendor_confidence: "medium",
        vendor_source: "direct_hint",
        vendor_blocked: false,
        note: `The hospital name contains "${hint.vendor}" — Wellet doesn't connect to ${hint.vendor} directly yet, but you can upload your visit summary PDF.`,
        via_perplexity: false,
      };
      await writeCache(supabase, normalized, rawName, city, state, result);
      return jsonResponse(result);
    }
  }

  // ─── 4. Epic bundle match ──
  const endpoints = await loadEpicEndpoints();
  const epicMatch = findEpicMatch(rawName, endpoints);
  if (epicMatch) {
    const fhirNorm = normFhirUrl(epicMatch.fhirBaseUrl);
    const activated = ACTIVATED_EPIC_FHIR_URLS.has(fhirNorm);
    const result: VendorResult = {
      vendor_guess: activated ? "epic_activated" : "epic_not_activated",
      vendor_confidence: "high",
      vendor_source: "epic_bundle",
      vendor_blocked: false,
      matched_hospital: epicMatch.name,
      matched_fhir_url: epicMatch.fhirBaseUrl,
      note: activated
        ? `${epicMatch.name} is on Epic and Wellet is connected. Try the search again, or pick it from the list.`
        : `${epicMatch.name} is on Epic. Wellet needs to activate it on Epic's side first — usually 24-48 hours after we request it.`,
      via_perplexity: false,
    };
    await writeCache(supabase, normalized, rawName, city, state, result);
    return jsonResponse(result);
  }

  // ─── 5. Perplexity Sonar fallback ──
  const sonar = await sonarVendorLookup(rawName, city ?? undefined, state ?? undefined);
  if (!sonar) {
    const result: VendorResult = {
      vendor_guess: "unknown",
      vendor_confidence: "low",
      vendor_source: "sonar",
      vendor_blocked: false,
      note: "We couldn't determine which records system this hospital uses. Send us the details and we'll find out for you.",
      via_perplexity: false,
    };
    await writeCache(supabase, normalized, rawName, city, state, result);
    return jsonResponse(result);
  }

  const vendor = sonar.vendor;
  let bucket = vendor;
  // If Sonar says Epic, we trust it but mark as "not activated" since the Epic
  // bundle didn't match — likely a smaller affiliate Epic hasn't published.
  if (vendor === "epic") bucket = "epic_not_activated";

  const result: VendorResult = {
    vendor_guess: bucket,
    vendor_confidence: sonar.confidence,
    vendor_source: "sonar",
    vendor_blocked: false,
    note: composeSonarNote(rawName, bucket, sonar.note),
    citations: sonar.citations,
    via_perplexity: true,
  };
  await writeCache(supabase, normalized, rawName, city, state, result);
  return jsonResponse(result);
});

function composeSonarNote(hospital: string, bucket: string, rationale: string): string {
  const base = rationale ? `${rationale} ` : "";
  switch (bucket) {
    case "epic_not_activated":
      return `${base}${hospital} appears to be on Epic. Wellet hasn't activated this org yet — send us the details and we'll start that on Epic's side.`;
    case "cerner":
      return `${base}${hospital} appears to be on Cerner (Oracle Health). Wellet can't pull records directly from Cerner yet — you can upload your visit summary PDF from the patient portal instead.`;
    case "meditech":
      return `${base}${hospital} appears to be on MEDITECH. Wellet doesn't connect to MEDITECH directly yet — you can upload your visit summary PDF from the patient portal.`;
    case "athena":
      return `${base}${hospital} appears to be on athenahealth. Wellet doesn't connect to athenahealth directly yet — upload your visit summary PDF and Wellet will read it the same way.`;
    case "nextgen":
    case "allscripts":
    case "eclinicalworks":
    case "other":
      return `${base}${hospital} appears to be on ${bucket}. Wellet doesn't connect to ${bucket} directly yet — you can upload your visit summary PDF.`;
    case "unknown":
      return `We couldn't determine which records system ${hospital} uses. Send us the details and we'll find out for you.`;
    default:
      return base.trim() || `Wellet is still checking ${hospital}.`;
  }
}

async function writeCache(
  supabase: ReturnType<typeof createClient>,
  normalized: string,
  raw: string,
  city: string | null,
  state: string | null,
  result: VendorResult
) {
  const payload = {
    matched_hospital: result.matched_hospital ?? null,
    matched_fhir_url: result.matched_fhir_url ?? null,
    note: result.note,
    via_perplexity: result.via_perplexity,
  };
  try {
    await supabase.from("hospital_vendor_lookups").upsert(
      {
        hospital_name_normalized: normalized,
        hospital_name_raw: raw,
        city,
        state,
        vendor_guess: result.vendor_guess,
        vendor_confidence: result.vendor_confidence,
        vendor_source: result.vendor_source === "cache" ? "sonar" : result.vendor_source,
        vendor_blocked: result.vendor_blocked,
        payload,
        citations: result.citations ?? null,
        last_looked_up_at: new Date().toISOString(),
      },
      { onConflict: "hospital_name_normalized" }
    );
  } catch (e) {
    console.warn("[ehr-vendor-check] cache write failed", e);
  }
}

function jsonResponse(result: VendorResult): Response {
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}
