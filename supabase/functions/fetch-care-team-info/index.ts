// ============================================================================
// fetch-care-team-info  ·  v1  ·  2026-05-13
// ----------------------------------------------------------------------------
// Single edge function backing the "What your care team might not tell you"
// chip section on Condition detail pages.
//
// One endpoint, six bullet intents:
//   - trials              · ClinicalTrials.gov API v2
//   - fda_treatments      · openFDA drugs@FDA (indication search)
//   - centers             · Supabase curated table
//   - advocacy            · Supabase curated table
//   - research            · PubMed E-utilities (systematic reviews + major trials)
//   - second_opinion      · static framing + tap-out list
//
// All sources are public-registry. No PHI is sent outbound. Responses are
// shared-cached for 24h in public_data_cache (keyed by normalized query hash)
// so we don't hammer external APIs.
//
// Skip-list (no PHI safety): the EDGE FUNCTION does not filter sensitive
// conditions. That's the client's job (renderCareTeamChipSection on
// the wellet.js side). This fn just answers the question it's asked.
//
// Voice: "notices" / "watches for" / "loved one". Never track/monitor.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// CORS helper (inlined from _shared/cors.ts to keep this function deployable
// as a single-file edge fn). Mirrors the shared version exactly.
const ALLOWED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
  "https://getwellet.com",
  "https://www.getwellet.com",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];
function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ---------------------------------------------------------------- helpers ---

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResp(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function decodeJwtSub(authHeader: string): string | null {
  try {
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const payload = token.split(".")[1];
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const parsed = JSON.parse(json);
    return parsed?.sub ?? null;
  } catch {
    return null;
  }
}

// Hospital lat/lng seed map. Used when the client doesn't pass coordinates
// but we have a hospital hint from ehr_connections.fhir_base_url.
const HOSPITAL_SEEDS: Array<{ pattern: RegExp; lat: number; lng: number; name: string }> = [
  { pattern: /duke/i,         lat: 35.9994, lng: -78.9382, name: "Duke (Durham, NC)" },
  { pattern: /unc/i,          lat: 35.9101, lng: -79.0489, name: "UNC (Chapel Hill, NC)" },
  { pattern: /wakemed/i,      lat: 35.7796, lng: -78.6382, name: "WakeMed (Raleigh, NC)" },
  { pattern: /wakeforest/i,   lat: 36.0997, lng: -80.2444, name: "Wake Forest (Winston-Salem, NC)" },
  { pattern: /missionhealth/i,lat: 35.5851, lng: -82.5468, name: "Mission Health (Asheville, NC)" },
];

function seedHospitalCoords(hint?: string): { lat: number; lng: number; name: string } | null {
  if (!hint) return null;
  for (const seed of HOSPITAL_SEEDS) {
    if (seed.pattern.test(hint)) return { lat: seed.lat, lng: seed.lng, name: seed.name };
  }
  return null;
}

// Normalize a condition string for matching the curated tables.
function normalizeCondition(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[.,;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Cache helpers ---

interface CacheLookup {
  source: string;
  cache_key: string;
}

async function cacheGet(admin: ReturnType<typeof createClient>, lookup: CacheLookup): Promise<unknown | null> {
  const { data } = await admin
    .from("public_data_cache")
    .select("response, expires_at")
    .eq("source", lookup.source)
    .eq("cache_key", lookup.cache_key)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;
  return data.response;
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  lookup: CacheLookup,
  response: unknown,
  query_meta: Record<string, unknown> = {},
): Promise<void> {
  await admin.from("public_data_cache").upsert(
    {
      source: lookup.source,
      cache_key: lookup.cache_key,
      query_meta,
      response,
      fetched_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    },
    { onConflict: "source,cache_key" },
  );
}

// ---------------------------------------------------------------- intents ---

// 1. TRIALS — ClinicalTrials.gov API v2
async function intentTrials(
  admin: ReturnType<typeof createClient>,
  conditionText: string,
  lat: number | null,
  lng: number | null,
  radiusMiles: number,
  maxResults: number,
): Promise<unknown> {
  const cond = normalizeCondition(conditionText);
  const latR = lat != null ? Math.round(lat * 100) / 100 : null;
  const lngR = lng != null ? Math.round(lng * 100) / 100 : null;
  const cacheKey = await sha256(`trials|${cond}|${latR ?? "x"}|${lngR ?? "x"}|${radiusMiles}|${maxResults}`);
  const cached = await cacheGet(admin, { source: "clinical_trials", cache_key: cacheKey });
  if (cached) return { ...(cached as Record<string, unknown>), cached: true };

  const params = new URLSearchParams({
    "query.cond": cond,
    "filter.overallStatus": "RECRUITING",
    pageSize: String(Math.min(Math.max(maxResults, 1), 20)),
    format: "json",
    fields: "NCTId,BriefTitle,OfficialTitle,LeadSponsorName,OverallStatus,LocationFacility,LocationCity,LocationState,LocationGeoPoint",
  });
  if (lat != null && lng != null) {
    params.set("filter.geo", `distance(${lat},${lng},${radiusMiles}mi)`);
  }
  const url = `https://clinicaltrials.gov/api/v2/studies?${params.toString()}`;

  let trials: unknown[] = [];
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const j = await resp.json();
      const studies = j?.studies || [];
      trials = studies.slice(0, maxResults).map((s: any) => {
        const id = s?.protocolSection?.identificationModule?.nctId || "";
        const title = s?.protocolSection?.identificationModule?.briefTitle || "Untitled study";
        const sponsor = s?.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name || "";
        const locs = s?.protocolSection?.contactsLocationsModule?.locations || [];
        const firstLoc = locs[0] || {};
        const facility = firstLoc?.facility || "";
        const city = firstLoc?.city || "";
        const state = firstLoc?.state || "";
        return {
          nct_id: id,
          title,
          sponsor,
          facility,
          location: [city, state].filter(Boolean).join(", "),
          status: "RECRUITING",
          url: id ? `https://clinicaltrials.gov/study/${id}` : "https://clinicaltrials.gov",
        };
      });
    }
  } catch (err) {
    console.warn("[fetch-care-team-info] trials fetch failed:", err);
  }

  const response = { trials, count: trials.length, fetched_at: new Date().toISOString() };
  await cachePut(admin, { source: "clinical_trials", cache_key: cacheKey }, response, { conditionText, latR, lngR, radiusMiles });
  return { ...response, cached: false };
}

// 2. FDA_TREATMENTS — openFDA drugs@FDA
async function intentFdaTreatments(
  admin: ReturnType<typeof createClient>,
  conditionText: string,
  maxResults: number,
): Promise<unknown> {
  const cond = normalizeCondition(conditionText);
  const cacheKey = await sha256(`fda|${cond}|${maxResults}`);
  const cached = await cacheGet(admin, { source: "openfda", cache_key: cacheKey });
  if (cached) return { ...(cached as Record<string, unknown>), cached: true };

  // openFDA: search drug labels by indications_and_usage; group by brand_name.
  // This is intentionally loose — we don't want to claim "approved FOR this
  // condition" with FDA-level rigor. We want to surface drugs whose label
  // mentions the condition, then defer to the FDA label for the truth.
  const search = `indications_and_usage:"${cond.replace(/"/g, "")}"`;
  const url = `https://api.fda.gov/drug/label.json?search=${encodeURIComponent(search)}&limit=${Math.min(maxResults, 25)}`;

  let treatments: unknown[] = [];
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const j = await resp.json();
      const results = j?.results || [];
      // Dedupe by brand_name, keep first occurrence.
      const seen = new Set<string>();
      for (const r of results) {
        const brand = (r?.openfda?.brand_name?.[0] || "").trim();
        const generic = (r?.openfda?.generic_name?.[0] || "").trim();
        const route = (r?.openfda?.route?.[0] || "").toLowerCase();
        const appNum = r?.openfda?.application_number?.[0] || "";
        const labelUrl = appNum
          ? `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appNum.replace(/^[A-Za-z]+/, "")}`
          : "https://www.accessdata.fda.gov/scripts/cder/daf/";
        const key = (brand || generic).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        treatments.push({
          brand_name: brand || null,
          generic_name: generic || null,
          route: route || null,
          application_number: appNum || null,
          label_url: labelUrl,
        });
        if (treatments.length >= maxResults) break;
      }
    }
  } catch (err) {
    console.warn("[fetch-care-team-info] openFDA fetch failed:", err);
  }

  const response = { treatments, count: treatments.length, fetched_at: new Date().toISOString() };
  await cachePut(admin, { source: "openfda", cache_key: cacheKey }, response, { conditionText });
  return { ...response, cached: false };
}

// 3. CENTERS — Supabase curated table
async function intentCenters(
  admin: ReturnType<typeof createClient>,
  conditionText: string,
  maxResults: number,
): Promise<unknown> {
  const cond = normalizeCondition(conditionText);
  // Try direct match on condition_key first, then alias match.
  const { data: directMatches } = await admin
    .from("condition_centers_of_excellence")
    .select("center_name, hospital_system, specialty, city, state, website, designation")
    .eq("condition_key", cond)
    .limit(maxResults);

  let rows = directMatches || [];

  if (rows.length === 0) {
    // Fall back to alias match (substring inside any alias entry).
    const { data: aliasMatches } = await admin
      .from("condition_centers_of_excellence")
      .select("center_name, hospital_system, specialty, city, state, website, designation, condition_aliases")
      .ilike("condition_key", `%${cond.split(" ")[0]}%`)
      .limit(maxResults);
    rows = aliasMatches || [];
  }

  return { centers: rows, count: rows.length };
}

// 4. ADVOCACY — Supabase curated table
async function intentAdvocacy(
  admin: ReturnType<typeof createClient>,
  conditionText: string,
  maxResults: number,
): Promise<unknown> {
  const cond = normalizeCondition(conditionText);
  const { data: rows } = await admin
    .from("condition_advocacy_groups")
    .select("group_name, mission_short, website, type")
    .eq("condition_key", cond)
    .limit(maxResults);

  let final = rows || [];
  if (final.length === 0) {
    const { data: fallback } = await admin
      .from("condition_advocacy_groups")
      .select("group_name, mission_short, website, type")
      .ilike("condition_key", `%${cond.split(" ")[0]}%`)
      .limit(maxResults);
    final = fallback || [];
  }

  return { groups: final, count: final.length };
}

// 5. RESEARCH — PubMed E-utilities
async function intentResearch(
  admin: ReturnType<typeof createClient>,
  conditionText: string,
  maxResults: number,
): Promise<unknown> {
  const cond = normalizeCondition(conditionText);
  const cacheKey = await sha256(`pubmed|${cond}|${maxResults}`);
  const cached = await cacheGet(admin, { source: "pubmed", cache_key: cacheKey });
  if (cached) return { ...(cached as Record<string, unknown>), cached: true };

  // Strategy: esearch for systematic reviews + major trials, last 3 years.
  // Term construction: "<cond>" AND (systematic[sb] OR Clinical Trial[ptyp])
  // sorted by recency, return top N PMIDs, then esummary to enrich.
  const term = `${cond} AND (systematic[sb] OR "Clinical Trial"[ptyp]) AND ("last 3 years"[PDat])`;
  const esearchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(term)}&sort=date&retmode=json&retmax=${Math.min(maxResults, 10)}`;

  let articles: unknown[] = [];
  try {
    const esearch = await fetch(esearchUrl, { signal: AbortSignal.timeout(5000) });
    if (esearch.ok) {
      const ej = await esearch.json();
      const ids: string[] = ej?.esearchresult?.idlist || [];
      if (ids.length > 0) {
        const esummaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(",")}&retmode=json`;
        const esum = await fetch(esummaryUrl, { signal: AbortSignal.timeout(5000) });
        if (esum.ok) {
          const sj = await esum.json();
          const result = sj?.result || {};
          articles = ids.map((id) => {
            const r = result[id] || {};
            const authors = (r.authors || []).slice(0, 3).map((a: any) => a.name).filter(Boolean);
            return {
              pmid: id,
              title: r.title || "",
              journal: r.fulljournalname || r.source || "",
              pub_date: r.pubdate || "",
              authors,
              url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
            };
          });
        }
      }
    }
  } catch (err) {
    console.warn("[fetch-care-team-info] PubMed fetch failed:", err);
  }

  const response = { articles, count: articles.length, fetched_at: new Date().toISOString() };
  await cachePut(admin, { source: "pubmed", cache_key: cacheKey }, response, { conditionText });
  return { ...response, cached: false };
}

// 6. SECOND_OPINION — static framing + tap-out list
function intentSecondOpinion(): unknown {
  // Hardcoded, deliberately small. The voice is Wellet's, not marketing.
  // Each link is a well-established academic-medicine remote second-opinion
  // program. No financial relationship; same tap-out pattern as other bullets.
  return {
    framing:
      "A second opinion can confirm a diagnosis, surface treatment options the first team didn't mention, or just give you confidence in the path forward. Most major academic centers offer remote second-opinion programs where they review records and send a written report.",
    when_to_consider: [
      "A new serious diagnosis where the treatment plan is consequential.",
      "A condition that is rare or has multiple treatment paths.",
      "When something the care team said doesn't sit right.",
      "Before a major procedure, surgery, or starting a long-term medication.",
    ],
    programs: [
      {
        name: "Cleveland Clinic · MyConsult",
        description: "Online medical second opinion service. Records review by a Cleveland Clinic specialist, written report back.",
        url: "https://my.clevelandclinic.org/online-services/myconsult",
      },
      {
        name: "Mayo Clinic · Express Care Online (records-based)",
        description: "Mayo's online second-opinion option for many conditions.",
        url: "https://www.mayoclinic.org/online-services",
      },
      {
        name: "Johns Hopkins · Inquire Online (Outside Consultation)",
        description: "Records-based second opinions from Johns Hopkins specialists.",
        url: "https://www.hopkinsmedicine.org/the-johns-hopkins-second-opinion-program",
      },
    ],
    how_to_prepare: [
      "Use Wellet's Share button to package recent visits, labs, and imaging into a shareable bundle.",
      "Write down your three biggest questions before the appointment.",
      "Bring a family member or friend who can take notes while you focus on the conversation.",
    ],
  };
}

// ---------------------------------------------------------------- server ----

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: cors });
  }

  try {
    const body = await req.json();
    const intent = String(body?.intent || "").toLowerCase();
    const conditionText = String(body?.condition_text || "").trim();
    const icd10 = String(body?.icd10 || "").trim().toUpperCase();
    const personId = body?.person_id;
    const hospitalHint = body?.hospital_hint || null;
    const maxResults = Math.min(Math.max(parseInt(body?.max_results, 10) || 5, 1), 10);

    if (!intent) return jsonResp({ error: "intent required" }, 400, cors);
    if (!conditionText && intent !== "second_opinion") {
      return jsonResp({ error: "condition_text required" }, 400, cors);
    }

    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader.toLowerCase().startsWith("bearer ")) {
      return jsonResp({ error: "Missing Authorization header" }, 401, cors);
    }
    const jwtSub = decodeJwtSub(authHeader);
    if (!jwtSub) return jsonResp({ error: "Invalid token" }, 401, cors);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // For geo-aware intents (trials), derive coords from request or hospital hint.
    let lat: number | null = typeof body?.lat === "number" ? body.lat : null;
    let lng: number | null = typeof body?.lng === "number" ? body.lng : null;
    if ((lat == null || lng == null) && hospitalHint) {
      const seed = seedHospitalCoords(String(hospitalHint));
      if (seed) {
        lat = seed.lat;
        lng = seed.lng;
      }
    }
    const radiusMiles = Math.min(Math.max(parseInt(body?.radius_miles, 10) || 100, 10), 500);

    let data: unknown;
    switch (intent) {
      case "trials":
        data = await intentTrials(admin, conditionText, lat, lng, radiusMiles, maxResults);
        break;
      case "fda_treatments":
        data = await intentFdaTreatments(admin, conditionText, maxResults);
        break;
      case "centers":
        data = await intentCenters(admin, conditionText, maxResults);
        break;
      case "advocacy":
        data = await intentAdvocacy(admin, conditionText, maxResults);
        break;
      case "research":
        data = await intentResearch(admin, conditionText, maxResults);
        break;
      case "second_opinion":
        data = intentSecondOpinion();
        break;
      default:
        return jsonResp({ error: `Unknown intent: ${intent}` }, 400, cors);
    }

    return jsonResp(
      {
        intent,
        condition_text: conditionText,
        icd10: icd10 || null,
        data,
        person_id: personId || null,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error("[fetch-care-team-info] error:", err);
    return jsonResp({ error: "Internal error", details: String(err) }, 500, cors);
  }
});
