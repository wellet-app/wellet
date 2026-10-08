// ============================================================================
// fetch-clinical-trials/index.ts v2
// Trials Tile v1 — surfaces recruiting studies from ClinicalTrials.gov
// Fix v2: removed unsupported filter.locn.country param; added query.locn.
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

interface HospitalSeed { pattern: RegExp; lat: number; lng: number; name: string; }
const HOSPITAL_SEEDS: HospitalSeed[] = [
  { pattern: /duke/i,          lat: 35.9994, lng: -78.9382, name: "Duke (Durham, NC)" },
  { pattern: /unc/i,           lat: 35.9101, lng: -79.0489, name: "UNC (Chapel Hill, NC)" },
  { pattern: /wakemed/i,       lat: 35.7796, lng: -78.6382, name: "WakeMed (Raleigh, NC)" },
  { pattern: /wakeforest/i,    lat: 36.0997, lng: -80.2444, name: "Wake Forest (Winston-Salem, NC)" },
  { pattern: /missionhealth/i, lat: 35.5851, lng: -82.5468, name: "Mission Health (Asheville, NC)" },
];
const DEFAULT_COORDS = { lat: 35.5851, lng: -82.5468 };

function resolveCoords(hospitalHint?: string): { lat: number; lng: number } {
  if (!hospitalHint) return DEFAULT_COORDS;
  for (const seed of HOSPITAL_SEEDS) {
    if (seed.pattern.test(hospitalHint)) return { lat: seed.lat, lng: seed.lng };
  }
  return DEFAULT_COORDS;
}

const SENSITIVE_Z_RANGE = { min: 31, max: 37 };
function isSensitiveCode(icd10: string): boolean {
  if (!icd10) return false;
  const c = icd10.toUpperCase().trim();
  if (c.charAt(0) === "F") return true;
  if (c.charAt(0) === "O") return true;
  for (const prefix of ["B20", "B21", "B22", "B23", "B24"]) {
    if (c.startsWith(prefix)) return true;
  }
  if (c.startsWith("Z21")) return true;
  const zMatch = c.match(/^Z(\d{2})/);
  if (zMatch) {
    const n = parseInt(zMatch[1], 10);
    if (n >= SENSITIVE_Z_RANGE.min && n <= SENSITIVE_Z_RANGE.max) return true;
  }
  return false;
}

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function jsonResp(body: unknown, status: number, cors: Record<string, string>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

interface TrialRecord {
  nct_id: string;
  title: string;
  sponsor: string;
  distance_miles: number | null;
  status: string;
  url: string;
}

const CACHE_SOURCE = "clinical_trials_tile";

async function cacheGet(admin: ReturnType<typeof createClient>, cacheKey: string) {
  try {
    const { data } = await admin.from("public_data_cache")
      .select("response, fetched_at, expires_at")
      .eq("source", CACHE_SOURCE).eq("cache_key", cacheKey).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as { trials: TrialRecord[]; fetched_at: string };
  } catch { return null; }
}

async function cachePut(admin: ReturnType<typeof createClient>, cacheKey: string, conditionText: string, lat: number, lng: number, radiusMiles: number, payload: { trials: TrialRecord[]; fetched_at: string }) {
  try {
    await admin.from("public_data_cache").upsert({
      source: CACHE_SOURCE,
      cache_key: cacheKey,
      query_meta: {
        condition_text: conditionText,
        lat: Math.round(lat * 100) / 100,
        lng: Math.round(lng * 100) / 100,
        radius_miles: radiusMiles,
        recruiting_status: "RECRUITING",
      },
      response: payload,
      fetched_at: payload.fetched_at,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    }, { onConflict: "source,cache_key" });
  } catch (err) {
    console.warn("[fetch-clinical-trials] cache write failed:", err);
  }
}

async function fetchFromRegistry(conditionText: string, lat: number, lng: number, radiusMiles: number, maxResults: number): Promise<TrialRecord[]> {
  const latR = Math.round(lat * 100) / 100;
  const lngR = Math.round(lng * 100) / 100;
  // ClinicalTrials.gov API v2 — verified valid params (2026-05-17)
  const params = new URLSearchParams({
    "query.cond": conditionText,
    "query.locn": "United States",
    "filter.overallStatus": "RECRUITING",
    "filter.geo": `distance(${latR},${lngR},${radiusMiles}mi)`,
    pageSize: String(Math.min(Math.max(maxResults, 1), 10)),
    format: "json",
    fields: ["NCTId","BriefTitle","LeadSponsorName","OverallStatus","LocationCity","LocationState"].join(","),
  });
  const url = `https://clinicaltrials.gov/api/v2/studies?${params.toString()}`;
  let studies: unknown[] = [];
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn("[fetch-clinical-trials] registry returned", resp.status, text.slice(0, 200));
      return [];
    }
    const j = await resp.json();
    studies = Array.isArray(j?.studies) ? j.studies : [];
  } catch (err) {
    console.warn("[fetch-clinical-trials] registry fetch failed:", err);
    return [];
  }
  return studies.slice(0, maxResults).map((s: any): TrialRecord => {
    const id: string = s?.protocolSection?.identificationModule?.nctId ?? "";
    const title: string = s?.protocolSection?.identificationModule?.briefTitle ?? "Untitled study";
    const sponsor: string = s?.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? "";
    return {
      nct_id: id,
      title,
      sponsor,
      distance_miles: null,
      status: "RECRUITING",
      url: id ? `https://clinicaltrials.gov/study/${id}` : "https://clinicaltrials.gov",
    };
  });
}

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  let body: { condition_code?: string; condition_text?: string; person_id?: string; hospital_id?: string; radius_miles?: number; max_results?: number; };
  try { body = await req.json(); } catch {
    return jsonResp({ trials: [], cached: false, fetched_at: new Date().toISOString(), error: "invalid_json" }, 200, cors);
  }

  const { condition_code = "", condition_text = "", hospital_id = "", radius_miles = 50, max_results = 10 } = body;
  const emptyResponse = () => ({ trials: [], cached: false, fetched_at: new Date().toISOString() });

  if (isSensitiveCode(condition_code)) return jsonResp(emptyResponse(), 200, cors);
  if (!condition_text || condition_text.trim().length < 2) {
    return jsonResp({ ...emptyResponse(), error: "missing_condition_text" }, 200, cors);
  }

  const { lat, lng } = resolveCoords(hospital_id || undefined);
  const latR = Math.round(lat * 100) / 100;
  const lngR = Math.round(lng * 100) / 100;
  const cappedRadius = Math.min(Math.max(radius_miles, 10), 100);
  const cappedMax = Math.min(Math.max(max_results, 1), 10);

  const cacheInput = `${condition_text.toLowerCase().trim()}|${latR}|${lngR}|${cappedRadius}|RECRUITING`;
  const cacheKey = await sha256(cacheInput);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp({ trials: cached.trials, cached: true, fetched_at: cached.fetched_at }, 200, cors);
  }

  const trials = await fetchFromRegistry(condition_text.trim(), lat, lng, cappedRadius, cappedMax);
  const fetchedAt = new Date().toISOString();
  const payload = { trials, fetched_at: fetchedAt };
  await cachePut(admin, cacheKey, condition_text.trim(), lat, lng, cappedRadius, payload);

  return jsonResp({ trials, cached: false, fetched_at: fetchedAt }, 200, cors);
});
