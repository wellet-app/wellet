// ============================================================================
// fetch-advocacy-groups/index.ts v1 — Tile 4 · Patient-Advocacy Groups
// Serves patient advocacy groups from curated JSON, keyed by ICD-10 prefix.
// Cloned from fetch-clinical-trials/index.ts v2.
//
// Differences from Centers tile:
//   - No geography filtering — advocacy orgs serve nationally (US)
//   - Body: { condition_code, condition_text, person_id } — no hospital_id
//   - Longest-prefix match on groups_by_icd10_prefix keys
//   - Return up to 5 orgs (or all if fewer than 5)
//   - Cache TTL: 30 days
//   - Response: { groups: AdvocacyGroup[], cached, fetched_at }
//
// Data file: https://mywellet.com/data/advocacy-groups.json
//   (repo path: /wellet/data/advocacy-groups.json)
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

// ── Sensitive-code skip-list (identical across all tiles) ───────────────────
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

// ── Helpers (identical across all tiles) ───────────────────────────────────
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

// ── Domain types ───────────────────────────────────────────────────────────────────────
interface AdvocacyGroup {
  name: string;
  tagline: string;
  phone: string | null;
  url: string;
}

interface AdvocacyGroupsData {
  version: string;
  groups_by_icd10_prefix: Record<string, AdvocacyGroup[]>;
}

// ── Cache source constant ───────────────────────────────────────────────────────────
const CACHE_SOURCE = "advocacy_groups_tile";
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// ── Data URL — serves from repo's /data/ folder ───────────────────────────────
const DATA_URL = "https://mywellet.com/data/advocacy-groups.json";

// ── Cache helpers (identical structure to other tiles) ──────────────────────
async function cacheGet(admin: ReturnType<typeof createClient>, cacheKey: string) {
  try {
    const { data } = await admin.from("public_data_cache")
      .select("response, fetched_at, expires_at")
      .eq("source", CACHE_SOURCE).eq("cache_key", cacheKey).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as { groups: AdvocacyGroup[]; fetched_at: string };
  } catch { return null; }
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  conditionCode: string,
  conditionText: string,
  payload: { groups: AdvocacyGroup[]; fetched_at: string },
) {
  try {
    await admin.from("public_data_cache").upsert({
      source: CACHE_SOURCE,
      cache_key: cacheKey,
      query_meta: {
        condition_code: conditionCode,
        condition_text: conditionText,
      },
      response: payload,
      fetched_at: payload.fetched_at,
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: "source,cache_key" });
  } catch (err) {
    console.warn("[fetch-advocacy-groups] cache write failed:", err);
  }
}

// ── Longest-prefix match ────────────────────────────────────────────────────────────────
// Given a condition code like "C92.10" and a key set like ["C92", "C", ...],
// returns the matching groups for the longest matching prefix, or [].
function matchGroups(
  conditionCode: string,
  data: AdvocacyGroupsData,
): AdvocacyGroup[] {
  const code = conditionCode.toUpperCase().replace(/\s/g, "");
  const keys = Object.keys(data.groups_by_icd10_prefix);

  // Sort keys longest-first so first match wins
  const sorted = keys.slice().sort((a, b) => b.length - a.length);

  for (const key of sorted) {
    if (code.startsWith(key.toUpperCase())) {
      return data.groups_by_icd10_prefix[key] || [];
    }
  }
  return [];
}

// ── Fetch curated JSON from static host ───────────────────────────────────────
async function fetchAdvocacyData(): Promise<AdvocacyGroupsData | null> {
  try {
    const resp = await fetch(DATA_URL, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) {
      console.warn("[fetch-advocacy-groups] data fetch returned", resp.status);
      return null;
    }
    return await resp.json() as AdvocacyGroupsData;
  } catch (err) {
    console.warn("[fetch-advocacy-groups] data fetch failed:", err);
    return null;
  }
}

// ── Main handler ───────────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  let body: { condition_code?: string; condition_text?: string; person_id?: string };
  try { body = await req.json(); } catch {
    return jsonResp({ groups: [], cached: false, fetched_at: new Date().toISOString(), error: "invalid_json" }, 200, cors);
  }

  const { condition_code = "", condition_text = "", person_id = "" } = body;
  const emptyResponse = () => ({ groups: [], cached: false, fetched_at: new Date().toISOString() });

  // Sensitive-code skip-list — uniform suppression
  if (isSensitiveCode(condition_code)) return jsonResp(emptyResponse(), 200, cors);

  if (!condition_code || condition_code.trim().length < 1) {
    return jsonResp({ ...emptyResponse(), error: "missing_condition_code" }, 200, cors);
  }

  // Cache key: lowercased condition code only (groups are not geo-sensitive)
  const cacheInput = condition_code.toLowerCase().trim() + "|advocacy|v1";
  const cacheKey = await sha256(cacheInput);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cache hit
  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp({ groups: cached.groups, cached: true, fetched_at: cached.fetched_at }, 200, cors);
  }

  // Cache miss — fetch curated JSON and filter
  const data = await fetchAdvocacyData();
  if (!data) return jsonResp(emptyResponse(), 200, cors);

  const allGroups = matchGroups(condition_code.trim(), data);
  const MAX_GROUPS = 5;
  const groups: AdvocacyGroup[] = allGroups.slice(0, MAX_GROUPS).map((g) => ({
    name: g.name,
    tagline: g.tagline,
    phone: g.phone ?? null,
    url: g.url,
  }));

  const fetchedAt = new Date().toISOString();
  const payload = { groups, fetched_at: fetchedAt };
  await cachePut(admin, cacheKey, condition_code.trim(), condition_text.trim(), payload);

  return jsonResp({ groups, cached: false, fetched_at: fetchedAt }, 200, cors);
});
