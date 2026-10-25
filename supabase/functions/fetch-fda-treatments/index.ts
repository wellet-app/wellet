// ============================================================================
// fetch-fda-treatments/index.ts — Tile 2 of 5 · FDA-approved treatments
// Surfaces FDA-approved drug labels from openFDA drug/label endpoint.
// Cloned from fetch-clinical-trials/index.ts (shipped 2026-05-17).
//
// API: https://api.fda.gov/drug/label.json
//   search=indications_and_usage:"{condition_text}"&limit=10
// Dedupe by normalized generic_name (strips salt suffixes).
// Cache TTL: 7 days (FDA labels change rarely).
// Cache source: fda_treatments_tile
// Cache key: sha256(condition_text.toLowerCase().trim() + "|v1|fda")
//
// Response shape: { treatments: FDATreatment[], cached: boolean, fetched_at: string }
//
// BRIGHT LINES:
//   - No eligibility / recommendation / match language anywhere
//   - Verbatim FDA label data only — no LLM post-processing
//   - Tap-out always to DailyMed (canonical public source)
//   - Sensitive-code skip-list enforced server-side
//   - Silent fail everywhere — empty results, never throw to client
// ============================================================================

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sensitive-code skip-list (identical to fetch-clinical-trials)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface FDATreatment {
  brand_name: string;   // brand name (title-cased); falls back to generic
  generic_name: string; // active ingredient (title-cased)
  manufacturer: string; // labeler/manufacturer name (empty string if unavailable)
  set_id: string;       // openFDA set_id (UUID); used to build DailyMed URL
  url: string;          // DailyMed lookup URL, or FDA DAF fallback
}

interface CachePayload {
  treatments: FDATreatment[];
  fetched_at: string;
}

// ---------------------------------------------------------------------------
// Cache constants + TTL
// ---------------------------------------------------------------------------

const CACHE_SOURCE = "fda_treatments_tile";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---------------------------------------------------------------------------
// Cache get / put (identical structure to fetch-clinical-trials)
// ---------------------------------------------------------------------------

async function cacheGet(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
): Promise<CachePayload | null> {
  try {
    const { data } = await admin
      .from("public_data_cache")
      .select("response, fetched_at, expires_at")
      .eq("source", CACHE_SOURCE)
      .eq("cache_key", cacheKey)
      .maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as CachePayload;
  } catch {
    return null;
  }
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  conditionText: string,
  payload: CachePayload,
): Promise<void> {
  try {
    await admin.from("public_data_cache").upsert(
      {
        source: CACHE_SOURCE,
        cache_key: cacheKey,
        query_meta: { condition_text: conditionText },
        response: payload,
        fetched_at: payload.fetched_at,
        expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "source,cache_key" },
    );
  } catch (err) {
    console.warn("[fetch-fda-treatments] cache write failed:", err);
  }
}

// ---------------------------------------------------------------------------
// SPDE fallback parser
//
// Some openFDA records lack the openfda.{brand_name,generic_name} block.
// In those cases we parse spl_product_data_elements[0], which follows the
// FDA SPL format: "BRAND_NAME generic_name ingredient ingredient ..."
//
// Rules:
//   1. If words[0] == words[1] (case-insensitive) → brand = generic = words[0]
//      (e.g. "HYDROXYUREA HYDROXYUREA D&C YELLOW..." → Hydroxyurea / Hydroxyurea)
//   2. Otherwise brand = words[0]; scan forward (first 20 words only) for the
//      first all-lowercase alphabetic word (length >= 5) not in the excipient
//      skip list → that word = generic.
//      (e.g. "SPRYCEL dasatinib dasatinib crsc..." → Sprycel / Dasatinib)
//   3. Fallback: brand = generic = words[0].
//
// This is best-effort. Entries that still produce junk are filtered out by
// the empty-generic guard before dedup.
// ---------------------------------------------------------------------------

const EXCIPIENT_SKIP: Set<string> = new Set([
  "capsule","tablet","solution","injection","powder","suspension","cream",
  "opaque","green","blue","red","yellow","white","clear","film","coated",
  "extended","release","delayed","immediate","modified","controlled",
  "sodium","potassium","chloride","citrate","oxide","dioxide","sulfate",
  "stearate","lactose","cellulose","gelatin","silicon","titanium","magnesium",
  "anhydrous","croscarmellose","microcrystalline","polyethylene","glycol",
  "hydroxypropyl","methylcellulose","crospovidone","povidone","talc",
  "wax","acid","ferric","aluminum","ferrosoferric",
  "shaped","biconvex","round","oblong","oval","scored","color","colour",
]);

function parseSpdeSafe(spde: string): [string, string] {
  if (!spde) return ["", ""];
  const words = spde.split(/\s+/);
  if (!words.length) return ["", ""];

  // Rule 1: first two words identical → brand = generic = first word
  if (words.length >= 2 && words[0].toLowerCase() === words[1].toLowerCase()) {
    return [titleCase(words[0]), titleCase(words[0])];
  }

  const brand = titleCase(words[0]);

  // Rule 2: scan first 20 words for lowercase alphabetic word not in excipient list
  const scanLimit = Math.min(words.length, 20);
  for (let i = 1; i < scanLimit; i++) {
    const w = words[i];
    const stripped = w.replace(/-/g, "").replace(/,/g, "");
    if (
      stripped.match(/^[a-z]+$/) &&
      stripped.length >= 5 &&
      !EXCIPIENT_SKIP.has(stripped.toLowerCase())
    ) {
      return [brand, titleCase(w)];
    }
  }

  // Rule 3: fallback
  return [brand, brand];
}

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Generic-name normaliser for dedup key
//
// "Imatinib Mesylate" and "Imatinib" refer to the same active ingredient.
// We strip common pharmaceutical salt/ester suffixes from the key so they
// collapse to the same dedup bucket. We keep the ORIGINAL generic_name in
// the output — only the key is normalised.
// ---------------------------------------------------------------------------

const SALT_SUFFIX_RE =
  /\s+(hydrochloride|mesylate|sodium|potassium|acetate|sulfate|phosphate|maleate|fumarate|tartrate|citrate|gluconate|bromide|chloride|hcl|bitartrate|besylate|tosylate|oxalate|succinate|malate|lactate|glucuronate)(\s+.*)?$/i;

function normalizeGenericKey(generic: string): string {
  return generic.toLowerCase().trim().replace(SALT_SUFFIX_RE, "").trim();
}

// ---------------------------------------------------------------------------
// openFDA fetch + parse
// ---------------------------------------------------------------------------

async function fetchFromRegistry(
  conditionText: string,
  maxResults: number,
): Promise<FDATreatment[]> {
  const encoded = encodeURIComponent(`"${conditionText}"`);
  const url = `https://api.fda.gov/drug/label.json?search=indications_and_usage:${encoded}&limit=20`;

  let rawResults: unknown[] = [];
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      console.warn(
        "[fetch-fda-treatments] openFDA returned",
        resp.status,
        text.slice(0, 200),
      );
      return [];
    }
    const j = await resp.json();
    rawResults = Array.isArray(j?.results) ? j.results : [];
  } catch (err) {
    console.warn("[fetch-fda-treatments] openFDA fetch failed:", err);
    return [];
  }

  const treatments: FDATreatment[] = [];
  const seen = new Map<string, boolean>(); // normalizedKey → true

  for (const r of rawResults) {
    if (treatments.length >= maxResults) break;

    const entry = r as Record<string, unknown>;
    const openfda = (entry.openfda as Record<string, string[]>) ?? {};
    const brandList: string[] = openfda.brand_name ?? [];
    const genericList: string[] = openfda.generic_name ?? [];
    const mfrList: string[] = openfda.manufacturer_name ?? [];
    const appList: string[] = openfda.application_number ?? [];
    const setId: string = (entry.set_id as string) ?? "";

    let brand: string;
    let generic: string;
    let manufacturer: string;

    if (genericList.length > 0) {
      // Prefer openfda block when available
      generic = titleCase(genericList[0]);
      brand = brandList.length > 0 ? titleCase(brandList[0]) : generic;
      manufacturer = mfrList.length > 0 ? mfrList[0] : "";
    } else {
      // Fallback: parse spl_product_data_elements
      const spdeArr = entry.spl_product_data_elements as string[] | undefined;
      const spde = Array.isArray(spdeArr) && spdeArr.length > 0 ? spdeArr[0] : "";
      [brand, generic] = parseSpdeSafe(spde);
      manufacturer = "";
    }

    // Skip if we still can't identify the drug
    if (!generic) continue;

    // Dedupe by normalised generic key
    const key = normalizeGenericKey(generic);
    if (seen.has(key)) continue;
    seen.set(key, true);

    // Build URL: DailyMed if set_id available, FDA DAF if application_number, else fallback
    let tapUrl: string;
    if (setId) {
      tapUrl = `https://dailymed.nlm.nih.gov/dailymed/lookup.cfm?setid=${setId}`;
    } else if (appList.length > 0) {
      tapUrl = `https://www.accessdata.fda.gov/scripts/cder/daf/index.cfm?event=overview.process&ApplNo=${appList[0]}`;
    } else {
      tapUrl = "https://www.fda.gov/drugs";
    }

    treatments.push({
      brand_name: brand || generic,
      generic_name: generic,
      manufacturer,
      set_id: setId,
      url: tapUrl,
    });
  }

  return treatments;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== "POST") {
    return jsonResp({ error: "method_not_allowed" }, 405, cors);
  }

  // Parse request body
  let body: {
    condition_code?: string;
    condition_text?: string;
    person_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResp(
      { treatments: [], cached: false, fetched_at: new Date().toISOString(), error: "invalid_json" },
      200,
      cors,
    );
  }

  const { condition_code = "", condition_text = "" } = body;
  const emptyResponse = () => ({
    treatments: [] as FDATreatment[],
    cached: false,
    fetched_at: new Date().toISOString(),
  });

  // Server-side sensitive-code gate
  if (isSensitiveCode(condition_code)) {
    return jsonResp(emptyResponse(), 200, cors);
  }

  // Validate condition_text
  if (!condition_text || condition_text.trim().length < 2) {
    return jsonResp({ ...emptyResponse(), error: "missing_condition_text" }, 200, cors);
  }

  // Cache key
  const normalizedText = condition_text.toLowerCase().trim();
  const cacheInput = `${normalizedText}|v1|fda`;
  const cacheKey = await sha256(cacheInput);

  // Supabase admin client
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  // Cache hit
  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp(
      { treatments: cached.treatments, cached: true, fetched_at: cached.fetched_at },
      200,
      cors,
    );
  }

  // Cache miss → fetch from openFDA
  const MAX_TREATMENTS = 5;
  const treatments = await fetchFromRegistry(condition_text.trim(), MAX_TREATMENTS);
  const fetchedAt = new Date().toISOString();
  const payload: CachePayload = { treatments, fetched_at: fetchedAt };

  await cachePut(admin, cacheKey, condition_text.trim(), payload);

  return jsonResp({ treatments, cached: false, fetched_at: fetchedAt }, 200, cors);
});
