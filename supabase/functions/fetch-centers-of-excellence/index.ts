// ============================================================================
// fetch-centers-of-excellence/index.ts v1 — 2026-05-17
// Tile 3 — Centers of Excellence
// Fetches curated JSON from mywellet.com/data/centers-of-excellence.json,
// performs longest-prefix ICD-10 match, haversine sort, returns top 5.
//
// Cloned from fetch-clinical-trials/index.ts (b3b331c) per template.
// Changes vs. template:
//   - CACHE_SOURCE = "centers_of_excellence_tile"
//   - fetchAndFilterCenters() replaces fetchFromRegistry()
//   - Module-level centersCache for cold-start lifetime caching
//   - Haversine sort, top-5 return, 30-day TTL
//   - Body: { condition_code, condition_text, person_id, hospital_id }
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─── CORS ───────────────────────────────────────────────────────────────────────────

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
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin)
      ? origin
      : "",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// ─── HOSPITAL SEED MAP (same as clinical-trials template) ──────────────────────

interface HospitalSeed {
  pattern: RegExp;
  lat: number;
  lng: number;
  name: string;
}
const HOSPITAL_SEEDS: HospitalSeed[] = [
  { pattern: /duke/i, lat: 35.9994, lng: -78.9382, name: "Duke (Durham, NC)" },
  {
    pattern: /unc/i,
    lat: 35.9101,
    lng: -79.0489,
    name: "UNC (Chapel Hill, NC)",
  },
  {
    pattern: /wakemed/i,
    lat: 35.7796,
    lng: -78.6382,
    name: "WakeMed (Raleigh, NC)",
  },
  {
    pattern: /wakeforest/i,
    lat: 36.0997,
    lng: -80.2444,
    name: "Wake Forest (Winston-Salem, NC)",
  },
  {
    pattern: /missionhealth/i,
    lat: 35.5851,
    lng: -82.5468,
    name: "Mission Health (Asheville, NC)",
  },
];
const DEFAULT_COORDS = { lat: 35.5851, lng: -82.5468 };

function resolveCoords(hospitalHint?: string): { lat: number; lng: number } {
  if (!hospitalHint) return DEFAULT_COORDS;
  for (const seed of HOSPITAL_SEEDS) {
    if (seed.pattern.test(hospitalHint)) return { lat: seed.lat, lng: seed.lng };
  }
  return DEFAULT_COORDS;
}

// ─── SENSITIVE CODE SKIP-LIST (same as template) ─────────────────────────────

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

// ─── HELPERS ──────────────────────────────────────────────────────────────────────────

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function jsonResp(
  body: unknown,
  status: number,
  cors: Record<string, string>
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

// ─── HAVERSINE ────────────────────────────────────────────────────────────────────────────

function haversinemiles(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 3958.8; // Earth radius in miles
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── TYPES ──────────────────────────────────────────────────────────────────────────────

interface CenterEntry {
  name: string;
  designation: string;
  city: string;
  state: string;
  lat: number;
  lng: number;
  url: string;
  last_reviewed: string;
}

interface CenterRecord {
  name: string;
  designation: string;
  city: string;
  state: string;
  distance_miles: number;
  url: string;
}

interface CentersPayload {
  centers: CenterRecord[];
  fetched_at: string;
}

interface CuratedJSON {
  version: string;
  centers_by_icd10_prefix: Record<string, CenterEntry[]>;
}

// ─── MODULE-LEVEL CACHE (cold-start lifetime, avoids repeated fetches) ──────────

let _centersCache: CuratedJSON | null = null;

async function fetchCuratedJSON(): Promise<CuratedJSON | null> {
  if (_centersCache) return _centersCache;
  try {
    const resp = await fetch(
      "https://mywellet.com/data/centers-of-excellence.json",
      { signal: AbortSignal.timeout(4000) }
    );
    if (!resp.ok) {
      console.warn(
        "[fetch-centers-of-excellence] curated JSON returned",
        resp.status
      );
      return null;
    }
    const data = (await resp.json()) as CuratedJSON;
    _centersCache = data;
    return data;
  } catch (err) {
    console.warn("[fetch-centers-of-excellence] curated JSON fetch failed:", err);
    return null;
  }
}

// ─── LONGEST-PREFIX MATCH ─────────────────────────────────────────────────────────────

function longestPrefixMatch(
  conditionCode: string,
  prefixMap: Record<string, CenterEntry[]>
): CenterEntry[] | null {
  // Normalize: uppercase, strip whitespace
  const code = conditionCode.toUpperCase().trim();
  // Try full code, then chop one char at a time
  for (let len = code.length; len >= 1; len--) {
    const prefix = code.slice(0, len);
    if (prefixMap[prefix] && prefixMap[prefix].length > 0) {
      return prefixMap[prefix];
    }
  }
  return null;
}

// ─── MAIN FETCH/FILTER ────────────────────────────────────────────────────────────────────────

async function fetchAndFilterCenters(
  conditionCode: string,
  personLat: number,
  personLng: number
): Promise<CenterRecord[]> {
  const data = await fetchCuratedJSON();
  if (!data || !data.centers_by_icd10_prefix) return [];

  const entries = longestPrefixMatch(
    conditionCode,
    data.centers_by_icd10_prefix
  );
  if (!entries || entries.length === 0) return [];

  const withDistance: CenterRecord[] = entries.map((e) => ({
    name: e.name,
    designation: e.designation,
    city: e.city,
    state: e.state,
    distance_miles: Math.round(
      haversinemiles(personLat, personLng, e.lat, e.lng)
    ),
    url: e.url,
  }));

  // Sort by distance ascending, return top 5
  withDistance.sort((a, b) => a.distance_miles - b.distance_miles);
  return withDistance.slice(0, 5);
}

// ─── CACHE LAYER ─────────────────────────────────────────────────────────────────────────

const CACHE_SOURCE = "centers_of_excellence_tile";
const CACHE_TTL_DAYS = 30;

async function cacheGet(
  admin: ReturnType<typeof createClient>,
  cacheKey: string
): Promise<CentersPayload | null> {
  try {
    const { data } = await admin
      .from("public_data_cache")
      .select("response, fetched_at, expires_at")
      .eq("source", CACHE_SOURCE)
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as CentersPayload;
  } catch {
    return null;
  }
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  conditionCode: string,
  lat: number,
  lng: number,
  payload: CentersPayload
) {
  try {
    await admin.from("public_data_cache").upsert(
      {
        source: CACHE_SOURCE,
        cache_key: cacheKey,
        query_meta: {
          condition_code: conditionCode.toUpperCase().trim(),
          lat: Math.round(lat * 100) / 100,
          lng: Math.round(lng * 100) / 100,
        },
        response: payload,
        fetched_at: payload.fetched_at,
        expires_at: new Date(
          Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000
        ).toISOString(),
      },
      { onConflict: "source,cache_key" }
    );
  } catch (err) {
    console.warn("[fetch-centers-of-excellence] cache write failed:", err);
  }
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS")
    return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST")
    return jsonResp({ error: "method_not_allowed" }, 405, cors);

  let body: {
    condition_code?: string;
    condition_text?: string;
    person_id?: string;
    hospital_id?: string;
  };

  try {
    body = await req.json();
  } catch {
    return jsonResp(
      {
        centers: [],
        cached: false,
        fetched_at: new Date().toISOString(),
        error: "invalid_json",
      },
      200,
      cors
    );
  }

  const {
    condition_code = "",
    condition_text = "",
    hospital_id = "",
  } = body;

  const emptyResponse = () => ({
    centers: [] as CenterRecord[],
    cached: false,
    fetched_at: new Date().toISOString(),
  });

  // Sensitive-code skip-list — server-side gate
  if (isSensitiveCode(condition_code))
    return jsonResp(emptyResponse(), 200, cors);

  if (!condition_code || condition_code.trim().length < 1)
    return jsonResp(
      { ...emptyResponse(), error: "missing_condition_code" },
      200,
      cors
    );

  const { lat, lng } = resolveCoords(hospital_id || undefined);
  const latR = Math.round(lat * 100) / 100;
  const lngR = Math.round(lng * 100) / 100;

  // Cache key: code (uppercased) + rounded coords
  const cacheInput = `${condition_code.toUpperCase().trim()}|${latR}|${lngR}`;
  const cacheKey = await sha256(cacheInput);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp(
      { centers: cached.centers, cached: true, fetched_at: cached.fetched_at },
      200,
      cors
    );
  }

  const centers = await fetchAndFilterCenters(condition_code, lat, lng);
  const fetchedAt = new Date().toISOString();
  const payload: CentersPayload = { centers, fetched_at: fetchedAt };

  await cachePut(admin, cacheKey, condition_code, lat, lng, payload);

  return jsonResp({ centers, cached: false, fetched_at: fetchedAt }, 200, cors);
});
