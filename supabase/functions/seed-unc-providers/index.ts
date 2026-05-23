// Supabase Edge Function: seed-unc-providers
//
// What this does:
//   Pages through UNC Health Care's public Yext "Answers" provider
//   directory API and upserts every provider row into
//   public.unc_providers. Idempotent — re-runs pick up new providers
//   and contact changes via ON CONFLICT (npi) DO UPDATE.
//
// Why bulk-seeding (vs on-demand lookup):
//   The new Yext experience key (unc-internal-test-1, vertical
//   related_locations_deduped_small_buckets) exposes the FULL provider
//   set — currently ~5,172 records — including two fields the
//   on-demand adapter never sees: NPI and c_epicID. c_epicID matches
//   Epic FHIR Practitioner.id verbatim, which means we can resolve a
//   Care Team practitioner to a phone/photo with zero name-match
//   ambiguity. That only works if the data is already in our database
//   at lookup time. Hence: bulk seed.
//
// API call shape (verified 2026-05-22):
//   GET https://liveapi.yext.com/v2/accounts/me/search/vertical/query
//     ?input=
//     &experienceKey=unc-internal-test-1
//     &api_key=fcb2c208969a29f6bc66c93d5737793e
//     &v=20221201
//     &verticalKey=related_locations_deduped_small_buckets
//     &locale=en
//     &version=PRODUCTION
//     &limit=50
//     &offset=<N>
//
//   The api_key is the publicly embedded site key; it is shipped to
//   every browser load of unchealth.org and is intended to be public.
//   robots.txt at unchealth.org is fully open ("Allow: /").
//
// Invocation:
//   POST /functions/v1/seed-unc-providers
//   Optional body: { "max_pages": 10, "page_size": 50, "dry_run": true }
//   Defaults: max_pages=200 (effectively "all"), page_size=50, dry_run=false.
//
// Lifecycle:
//   - Service-role only (it writes to a non-PHI table; not user-callable).
//   - Sequential pagination with 250ms inter-page sleep to be neighborly.
//   - 60s per-page timeout. If a page errors, we log + continue rather
//     than abort, so a transient failure doesn't burn the whole run.
//
// Safety:
//   - Only writes to public.unc_providers (non-PHI public directory).
//   - Never touches any user-scoped table.
//   - Never logs the Yext key in the response body (it's compile-time
//     constant and public anyway, but we keep the discipline).

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

// ── Yext config ───────────────────────────────────────────────────────

const YEXT_BASE =
  "https://liveapi.yext.com/v2/accounts/me/search/vertical/query";
const YEXT_API_KEY = "fcb2c208969a29f6bc66c93d5737793e";
const YEXT_EXPERIENCE_KEY = "unc-internal-test-1";
const YEXT_VERTICAL = "related_locations_deduped_small_buckets";
const YEXT_VERSION = "20221201";
const YEXT_VERSION_TIER = "PRODUCTION";
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 200;       // 200 × 50 = 10,000 > current 5,172
const PER_PAGE_TIMEOUT_MS = 60_000;
const SLEEP_BETWEEN_PAGES_MS = 250;
const USER_AGENT =
  "Wellet/1.0 (+https://getwellet.com; contact@getwellet.com) seed-unc-providers";

// ── Types ──────────────────────────────────────────────────────────────

type YextAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
};

type YextHeadshot = { url?: string; alternateText?: string };

type YextProvider = {
  // Yext entity / native fields
  id?: string;
  meta?: { id?: string };
  uid?: string;
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  mainPhone?: string;
  fax?: string;
  address?: YextAddress;
  yextDisplayCoordinate?: { latitude?: number; longitude?: number };
  displayCoordinate?: { latitude?: number; longitude?: number };
  headshot?: YextHeadshot;
  gender?: string;
  languages?: string[];
  acceptingNewPatients?: boolean;
  websiteUrl?: { url?: string } | string;
  // UNC-specific custom fields (prefixed c_)
  npi?: string;
  c_epicID?: string;
  c_customEmail?: string;
  c_credentials?: string[];
  c_primarySpecialtyFinalV2?: string;
  c_specialties?: string[] | { name?: string }[];
  c_orgUnitFolder?: string;
  c_insuranceAccepted?: string[];
};

type YextResult = { data?: YextProvider };

type YextResponse = {
  meta?: { errors?: Array<{ code: number; message: string }> };
  response?: { results?: YextResult[]; resultsCount?: number };
};

type SeedBody = {
  max_pages?: number;
  page_size?: number;
  start_offset?: number;
  dry_run?: boolean;
};

type PageOutcome = {
  offset: number;
  page_size: number;
  status: "ok" | "error" | "empty";
  fetched: number;
  upserted: number;
  skipped_no_npi: number;
  error?: string;
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildPageUrl(offset: number, pageSize: number): string {
  const params = new URLSearchParams({
    input: "",
    experienceKey: YEXT_EXPERIENCE_KEY,
    api_key: YEXT_API_KEY,
    v: YEXT_VERSION,
    verticalKey: YEXT_VERTICAL,
    locale: "en",
    version: YEXT_VERSION_TIER,
    limit: String(pageSize),
    offset: String(offset),
  });
  return `${YEXT_BASE}?${params.toString()}`;
}

async function timedFetch(url: string): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PER_PAGE_TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    });
  } finally {
    clearTimeout(t);
  }
}

function normalizeSpecialties(input: YextProvider["c_specialties"]): string[] {
  if (!input) return [];
  const out: string[] = [];
  for (const v of input as Array<string | { name?: string }>) {
    if (typeof v === "string" && v.trim()) out.push(v.trim());
    else if (v && typeof v === "object" && typeof v.name === "string" && v.name.trim()) {
      out.push(v.name.trim());
    }
  }
  return out;
}

function pickWebsite(input: YextProvider["websiteUrl"]): string | null {
  if (!input) return null;
  if (typeof input === "string") return input;
  if (typeof input === "object" && typeof input.url === "string") return input.url;
  return null;
}

function pickCoord(p: YextProvider): { lat: number | null; lng: number | null } {
  const c = p.yextDisplayCoordinate || p.displayCoordinate;
  if (c && typeof c.latitude === "number" && typeof c.longitude === "number") {
    return { lat: c.latitude, lng: c.longitude };
  }
  return { lat: null, lng: null };
}

function toRow(p: YextProvider) {
  const npi = (p.npi || "").trim();
  if (!npi) return null;
  const coord = pickCoord(p);
  return {
    npi,
    c_epic_id: p.c_epicID?.trim() || null,
    yext_entity_id: p.id || p.meta?.id || p.uid || null,
    name: p.name?.trim() || null,
    first_name: p.firstName?.trim() || null,
    last_name: p.lastName?.trim() || null,
    middle_name: p.middleName?.trim() || null,
    credentials: Array.isArray(p.c_credentials) ? p.c_credentials : [],
    main_phone: p.mainPhone?.trim() || null,
    fax: p.fax?.trim() || null,
    custom_email: p.c_customEmail?.trim() || null,
    address_line1: p.address?.line1?.trim() || null,
    address_line2: p.address?.line2?.trim() || null,
    address_city: p.address?.city?.trim() || null,
    address_state: p.address?.region?.trim() || null,
    address_postal: p.address?.postalCode?.trim() || null,
    address_country: p.address?.countryCode?.trim() || null,
    headshot_url: p.headshot?.url || null,
    headshot_alt: p.headshot?.alternateText || null,
    primary_specialty: p.c_primarySpecialtyFinalV2?.trim() || null,
    specialties: normalizeSpecialties(p.c_specialties),
    org_unit_folder: p.c_orgUnitFolder?.trim() || null,
    languages: Array.isArray(p.languages) ? p.languages : [],
    accepting_new_patients:
      typeof p.acceptingNewPatients === "boolean" ? p.acceptingNewPatients : null,
    gender: p.gender?.trim() || null,
    insurance_accepted: Array.isArray(p.c_insuranceAccepted) ? p.c_insuranceAccepted : [],
    website: pickWebsite(p.websiteUrl),
    geocoded_lat: coord.lat,
    geocoded_lng: coord.lng,
    raw_yext: p as unknown,
    last_seen_at: new Date().toISOString(),
  };
}

async function upsertBatch(
  supabase: SupabaseClient,
  rows: ReturnType<typeof toRow>[],
): Promise<{ upserted: number; error?: string }> {
  const filtered = rows.filter((r): r is NonNullable<typeof r> => r !== null);
  if (filtered.length === 0) return { upserted: 0 };
  const { error } = await supabase
    .from("unc_providers")
    .upsert(filtered, { onConflict: "npi" });
  if (error) return { upserted: 0, error: error.message };
  return { upserted: filtered.length };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Handler ────────────────────────────────────────────────────────────

serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POST only" }),
      { status: 405, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }

  let body: SeedBody = {};
  try {
    body = (await req.json().catch(() => ({}))) as SeedBody;
  } catch {
    body = {};
  }

  const pageSize = Math.min(Math.max(body.page_size ?? DEFAULT_PAGE_SIZE, 1), 50);
  const maxPages = Math.min(Math.max(body.max_pages ?? DEFAULT_MAX_PAGES, 1), 500);
  const startOffset = Math.max(body.start_offset ?? 0, 0);
  const dryRun = body.dry_run === true;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!supabaseUrl || !serviceKey) {
    return new Response(
      JSON.stringify({ error: "missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
  const supabase = createClient(supabaseUrl, serviceKey);

  const startedAt = new Date().toISOString();
  const pages: PageOutcome[] = [];
  let totalFetched = 0;
  let totalUpserted = 0;
  let totalSkipped = 0;
  let resultsCount: number | undefined;

  for (let i = 0; i < maxPages; i++) {
    const offset = startOffset + i * pageSize;
    const url = buildPageUrl(offset, pageSize);

    let resp: Response;
    try {
      resp = await timedFetch(url);
    } catch (err) {
      pages.push({
        offset,
        page_size: pageSize,
        status: "error",
        fetched: 0,
        upserted: 0,
        skipped_no_npi: 0,
        error: `fetch threw: ${(err as Error).message}`,
      });
      break;
    }

    if (!resp.ok) {
      pages.push({
        offset,
        page_size: pageSize,
        status: "error",
        fetched: 0,
        upserted: 0,
        skipped_no_npi: 0,
        error: `HTTP ${resp.status}`,
      });
      break;
    }

    let json: YextResponse;
    try {
      json = (await resp.json()) as YextResponse;
    } catch (err) {
      pages.push({
        offset,
        page_size: pageSize,
        status: "error",
        fetched: 0,
        upserted: 0,
        skipped_no_npi: 0,
        error: `json parse: ${(err as Error).message}`,
      });
      break;
    }

    if (json.meta?.errors && json.meta.errors.length > 0) {
      pages.push({
        offset,
        page_size: pageSize,
        status: "error",
        fetched: 0,
        upserted: 0,
        skipped_no_npi: 0,
        error: json.meta.errors.map((e) => `${e.code}:${e.message}`).join("; "),
      });
      break;
    }

    if (typeof json.response?.resultsCount === "number") {
      resultsCount = json.response.resultsCount;
    }
    const results = json.response?.results ?? [];
    const providers = results
      .map((r) => r.data)
      .filter((p): p is YextProvider => !!p);

    if (providers.length === 0) {
      pages.push({
        offset,
        page_size: pageSize,
        status: "empty",
        fetched: 0,
        upserted: 0,
        skipped_no_npi: 0,
      });
      break;
    }

    const rows = providers.map(toRow);
    const skippedNoNpi = rows.filter((r) => r === null).length;
    totalSkipped += skippedNoNpi;

    let upserted = 0;
    let pageErr: string | undefined;
    if (!dryRun) {
      const out = await upsertBatch(supabase, rows);
      upserted = out.upserted;
      pageErr = out.error;
    } else {
      upserted = rows.filter((r) => r !== null).length;
    }

    pages.push({
      offset,
      page_size: pageSize,
      status: pageErr ? "error" : "ok",
      fetched: providers.length,
      upserted,
      skipped_no_npi: skippedNoNpi,
      error: pageErr,
    });
    totalFetched += providers.length;
    totalUpserted += upserted;

    // Stop early if we got fewer than a full page back — Yext signaling end.
    if (providers.length < pageSize) break;

    await sleep(SLEEP_BETWEEN_PAGES_MS);
  }

  const finishedAt = new Date().toISOString();
  const summary = {
    ok: true,
    dry_run: dryRun,
    started_at: startedAt,
    finished_at: finishedAt,
    yext_results_count: resultsCount ?? null,
    pages: pages.length,
    total_fetched: totalFetched,
    total_upserted: totalUpserted,
    total_skipped_no_npi: totalSkipped,
    page_outcomes: pages,
  };
  return new Response(JSON.stringify(summary), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
