// ============================================================================
// fetch-research-papers/index.ts v1 — Tile 5: Recent Research
// Surfaces recent PubMed reviews + meta-analyses for a given condition.
// Cloned from fetch-clinical-trials/index.ts v2 (2026-05-17).
//
// Changes from template:
//   - CACHE_SOURCE = "research_papers_tile"
//   - fetchFromRegistry calls NCBI ESearch then ESummary (two sequential calls)
//   - Response shape: { papers: ResearchPaper[], cached, fetched_at }
//   - No hospital seed / geography — cache key is condition-text-only
//   - TTL: 7 days
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
// Sensitive-code skip-list (identical to clinical-trials template)
// ---------------------------------------------------------------------------
const SENSITIVE_Z_RANGE = { min: 31, max: 37 };
function isSensitiveCode(icd10: string): boolean {
  if (!icd10) return false;
  const c = icd10.toUpperCase().trim();
  if (c.charAt(0) === "F") return true;  // Mental & behavioural
  if (c.charAt(0) === "O") return true;  // Pregnancy
  for (const prefix of ["B20", "B21", "B22", "B23", "B24"]) {
    if (c.startsWith(prefix)) return true;  // HIV
  }
  if (c.startsWith("Z21")) return true;  // Asymptomatic HIV
  const zMatch = c.match(/^Z(\d{2})/);
  if (zMatch) {
    const n = parseInt(zMatch[1], 10);
    if (n >= SENSITIVE_Z_RANGE.min && n <= SENSITIVE_Z_RANGE.max) return true;  // Reproductive
  }
  return false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Data shape
// ---------------------------------------------------------------------------
interface ResearchPaper {
  pmid: string;
  title: string;
  journal: string;
  pub_date: string;       // e.g. "2026 Apr" or "2026 May 11"
  authors_short: string;  // "Smith J, et al." or "Smith J" if solo
  url: string;            // https://pubmed.ncbi.nlm.nih.gov/{pmid}/
}

// ---------------------------------------------------------------------------
// Cache — source = "research_papers_tile" (already in CHECK constraint)
// ---------------------------------------------------------------------------
const CACHE_SOURCE = "research_papers_tile";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

async function cacheGet(admin: ReturnType<typeof createClient>, cacheKey: string) {
  try {
    const { data } = await admin.from("public_data_cache")
      .select("response, fetched_at, expires_at")
      .eq("source", CACHE_SOURCE).eq("cache_key", cacheKey).maybeSingle();
    if (!data) return null;
    if (new Date(data.expires_at).getTime() < Date.now()) return null;
    return data.response as { papers: ResearchPaper[]; fetched_at: string };
  } catch { return null; }
}

async function cachePut(
  admin: ReturnType<typeof createClient>,
  cacheKey: string,
  conditionText: string,
  payload: { papers: ResearchPaper[]; fetched_at: string },
) {
  try {
    await admin.from("public_data_cache").upsert({
      source: CACHE_SOURCE,
      cache_key: cacheKey,
      query_meta: {
        condition_text: conditionText,
        pub_type_filter: "systematic review OR meta-analysis OR practice guideline, title match, last 4 years",
        retmax: 5,
      },
      response: payload,
      fetched_at: payload.fetched_at,
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
    }, { onConflict: "source,cache_key" });
  } catch (err) {
    console.warn("[fetch-research-papers] cache write failed:", err);
  }
}

// ---------------------------------------------------------------------------
// ESummary author helper
// ---------------------------------------------------------------------------
function buildAuthorsShort(authors: Array<{ name: string; authtype: string }>): string {
  if (!authors || authors.length === 0) return "";
  const first = authors[0].name || "";
  if (authors.length === 1) return first;
  return first + ", et al.";
}

// ---------------------------------------------------------------------------
// PubMed: ESearch → ESummary (two calls, both within the 4500ms budget)
// ---------------------------------------------------------------------------
const ESEARCH_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi";
const ESUMMARY_BASE = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi";
const MAX_RESULTS = 5;


// ---------------------------------------------------------------------------
// Condition name variants (Nov 13, 2026)
// EHR names carry qualifiers ("without complications", ", stage 2",
// "(disorder)") that public registries rarely use. Try the name as recorded,
// then simpler forms, and stop at the first one that returns results.
// ---------------------------------------------------------------------------
function conditionSearchVariants(raw: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.replace(/\s+/g, " ").replace(/[\s,;:-]+$/, "").trim();
    if (v.length >= 3 && !out.includes(v.toLowerCase())) out.push(v.toLowerCase());
  };
  const base = raw.replace(/\[[^\]]*\]|\([^)]*\)/g, " ");
  add(base);
  let s = base
    .replace(/,?\s*(unspecified|not otherwise specified|nos)\b.*$/i, "")
    .replace(/\s+(without|with|due to|secondary to|in remission|affecting)\b.*$/i, "")
    .replace(/(,\s*|\s+)(stage|grade|class)\s+[0-9ivx]+[a-z]?\b.*$/i, "");
  add(s);
  if (s.includes(",")) add(s.split(",")[0]);
  add(s.replace(/\s+mellitus\b/i, ""));
  return out.slice(0, 4);
}

// Nov 13, 2026: "All Fields" + newest-first surfaced off-topic papers that
// only mentioned the condition in passing. Now: the condition must be in the
// title, the paper must be a systematic review, meta-analysis or practice
// guideline from the last four years, and results are ranked by relevance.
async function fetchFromRegistry(conditionText: string): Promise<ResearchPaper[]> {
  for (const variant of conditionSearchVariants(conditionText)) {
    for (const field of ["Title", "Title/Abstract"]) {
      const papers = await searchPubMed(variant, field);
      if (papers.length > 0) return papers;
    }
  }
  return [];
}

async function searchPubMed(conditionText: string, field: string): Promise<ResearchPaper[]> {
  const fromYear = new Date().getUTCFullYear() - 4;
  const term = `"${conditionText.replace(/"/g, "")}"[${field}]`
    + ` AND (systematic review[Publication Type] OR meta-analysis[Publication Type] OR practice guideline[Publication Type])`
    + ` AND english[Language] AND ("${fromYear}"[dp] : "3000"[dp])`;
  const esearchParams = new URLSearchParams({
    db: "pubmed",
    term,
    retmax: String(MAX_RESULTS),
    sort: "relevance",
    retmode: "json",
  });
  const esearchUrl = `${ESEARCH_BASE}?${esearchParams.toString()}`;

  let pmids: string[] = [];
  try {
    const esearchResp = await fetch(esearchUrl, { signal: AbortSignal.timeout(4500) });
    if (!esearchResp.ok) {
      console.warn("[fetch-research-papers] ESearch returned", esearchResp.status);
      return [];
    }
    const esearchJson = await esearchResp.json();
    pmids = Array.isArray(esearchJson?.esearchresult?.idlist)
      ? (esearchJson.esearchresult.idlist as string[]).slice(0, MAX_RESULTS)
      : [];
  } catch (err) {
    console.warn("[fetch-research-papers] ESearch failed:", err);
    return [];
  }

  if (pmids.length === 0) return [];

  // ESummary — keyed by PMID string in result object
  const esummaryParams = new URLSearchParams({
    db: "pubmed",
    id: pmids.join(","),
    retmode: "json",
  });
  const esummaryUrl = `${ESUMMARY_BASE}?${esummaryParams.toString()}`;

  let papers: ResearchPaper[] = [];
  try {
    const esummaryResp = await fetch(esummaryUrl, { signal: AbortSignal.timeout(4500) });
    if (!esummaryResp.ok) {
      console.warn("[fetch-research-papers] ESummary returned", esummaryResp.status);
      return []; // silent fail per spec
    }
    const esummaryJson = await esummaryResp.json();
    const resultBlock = esummaryJson?.result;
    if (!resultBlock) return [];

    // PMID is the key in result; uids array gives the order
    const uids: string[] = Array.isArray(resultBlock.uids) ? resultBlock.uids : pmids;

    papers = uids
      .filter((uid) => resultBlock[uid] && typeof resultBlock[uid] === "object")
      .map((uid): ResearchPaper => {
        const rec = resultBlock[uid] as Record<string, unknown>;

        const title = (rec.title as string | undefined) ?? "";
        const journal = (rec.source as string | undefined) ?? "";       // abbreviated journal name
        const pubdate = (rec.pubdate as string | undefined) ?? "";      // e.g. "2026 Apr" or "2026 May 11"

        // Normalise pubdate: keep as-is — it already comes as "YYYY Mon" or "YYYY Mon DD"
        // Trim any trailing day component beyond "YYYY Mon" per spec ("2026 Apr")
        const pubDateNorm = normalizePubDate(pubdate);

        const rawAuthors = Array.isArray(rec.authors)
          ? (rec.authors as Array<{ name: string; authtype: string }>)
          : [];
        const authorsShort = buildAuthorsShort(rawAuthors);

        return {
          pmid: uid,
          title,
          journal,
          pub_date: pubDateNorm,
          authors_short: authorsShort,
          url: `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
        };
      })
      .filter((p) => p.title.length > 0); // drop any malformed records
  } catch (err) {
    console.warn("[fetch-research-papers] ESummary failed:", err);
    return []; // silent fail per spec
  }

  return papers.slice(0, MAX_RESULTS);
}

// ---------------------------------------------------------------------------
// Normalise pubdate to "YYYY Mon" format
// Input examples: "2026 May 11", "2026 Apr", "2026", "2026 May-Jun"
// ---------------------------------------------------------------------------
const MONTH_ABBREVS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

function normalizePubDate(raw: string): string {
  if (!raw) return "";
  const parts = raw.trim().split(/\s+/);
  const year = parts[0] ?? "";
  if (!year) return raw;
  if (parts.length === 1) return year; // year-only

  // Second token may be "Apr" or "Apr-Jun" — take first 3 chars
  const monthRaw = (parts[1] ?? "").slice(0, 3);
  // Verify it looks like an abbreviated month
  const monthOk = MONTH_ABBREVS.some((m) => m.toLowerCase() === monthRaw.toLowerCase());
  if (!monthOk) return year;

  // Capitalise correctly
  const monthNorm = monthRaw.charAt(0).toUpperCase() + monthRaw.slice(1).toLowerCase();
  return `${year} ${monthNorm}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
Deno.serve(async (req: Request) => {
  const cors = getCorsHeaders(req);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return jsonResp({ error: "method_not_allowed" }, 405, cors);

  let body: {
    condition_code?: string;
    condition_text?: string;
    person_id?: string;
  };
  try {
    body = await req.json();
  } catch {
    return jsonResp(
      { papers: [], cached: false, fetched_at: new Date().toISOString(), error: "invalid_json" },
      200,
      cors,
    );
  }

  const { condition_code = "", condition_text = "" } = body;
  const emptyResponse = () => ({ papers: [], cached: false, fetched_at: new Date().toISOString() });

  // Sensitive-code skip-list (server-side gate)
  if (isSensitiveCode(condition_code)) return jsonResp(emptyResponse(), 200, cors);

  if (!condition_text || condition_text.trim().length < 2) {
    return jsonResp({ ...emptyResponse(), error: "missing_condition_text" }, 200, cors);
  }

  // Cache key: sha256(lowercased condition_text | reviews | v1)
  const cacheInput = `${condition_text.toLowerCase().trim()}|reviews|v2`;
  const cacheKey = await sha256(cacheInput);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Cache hit
  const cached = await cacheGet(admin, cacheKey);
  if (cached) {
    return jsonResp({ papers: cached.papers, cached: true, fetched_at: cached.fetched_at }, 200, cors);
  }

  // Cache miss — fetch from PubMed
  const papers = await fetchFromRegistry(condition_text.trim());
  const fetchedAt = new Date().toISOString();
  const payload = { papers, fetched_at: fetchedAt };
  // Never cache an empty result (a PubMed rate-limit reply looks empty).
  if (papers.length > 0) await cachePut(admin, cacheKey, condition_text.trim(), payload);

  return jsonResp({ papers, cached: false, fetched_at: fetchedAt }, 200, cors);
});
