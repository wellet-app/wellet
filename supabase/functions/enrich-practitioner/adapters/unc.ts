// UNC Health Care directory adapter.
//
// Two-source resolution, in order:
//
// 1) Seeded table (public.unc_providers, populated by the
//    seed-unc-providers edge function).
//      a. Match on c_epic_id == input.practitioner_ref's bare id.
//         This is the gold path — Yext's c_epicID field is the same
//         token UNC's Epic FHIR returns as Practitioner.id, so when
//         the caller passes practitioner_ref (which fetch-ehr-data
//         always does for FHIR-derived Care Team rows), we resolve
//         the row in one indexed lookup with zero name ambiguity.
//      b. Match on npi when input.npi is set.
//      c. Match on (lower(last_name), lower(first_name)) when only a
//         name was provided.
//
// 2) Live Yext search (the "old" on-demand path, kept as a safety
//    net for the period between deploy and the first successful
//    bulk seed, and for providers Yext exposes via /search but not
//    yet captured in the seeded table). Uses the AEM search vertical
//    that previously powered this adapter.
//
// Why bulk-seeding was the upgrade:
//   The previously deployed adapter used Yext's small-result AEM
//   search vertical, which returns name/phone/specialty but no NPI
//   and no c_epicID — so every Care Team card had to fall through to
//   NPPES for a stable identifier. The new vertical
//   (related_locations_deduped_small_buckets, experienceKey
//   unc-internal-test-1) exposes the FULL ~5,172-provider directory
//   with both fields. We seed once, then resolve in our own DB.
//
// Lookups never throw on network errors — return null and let the
// router fall through to NPPES, same contract as Duke.
//
// robots.txt at unchealth.org is fully open ("Allow: /"). The Yext
// keys involved are publicly embedded in the AEM page shipped to
// every browser load.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  Address,
  EnrichedContact,
  EnrichInput,
} from "../../_shared/practitioner-types.ts";
import type { HospitalDirectoryAdapter } from "../../_shared/hospital-directory-registry.ts";
import {
  formatPhoneUS,
  slugify,
  splitName,
  timedFetch,
} from "../../_shared/adapter-utils.ts";

// ── Constants ─────────────────────────────────────────────────────────

const UNC_SITE_ORIGIN = "https://www.unchealth.org";

// Live-search Yext config (legacy on-demand path; safety net only).
const YEXT_LIVE_BASE =
  "https://liveapi.yext.com/v2/accounts/me/search/vertical/query";
const YEXT_LIVE_API_KEY = Deno.env.get("UNC_YEXT_API_KEY") || "";
const YEXT_LIVE_EXPERIENCE_KEY = "unch-aem-site-search";
const YEXT_LIVE_VERSION = "20221201";
const YEXT_LIVE_VERTICAL = "aem_page";
const YEXT_LIVE_LIMIT = 5;

// ── Supabase client (lazy) ────────────────────────────────────────────

let _supabase: SupabaseClient | null = null;
function getSupabase(): SupabaseClient | null {
  if (_supabase) return _supabase;
  const url = Deno.env.get("SUPABASE_URL");
  const key =
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ||
    Deno.env.get("SUPABASE_ANON_KEY") ||
    "";
  if (!url || !key) return null;
  _supabase = createClient(url, key);
  return _supabase;
}

// ── Live-Yext response shapes ─────────────────────────────────────────

type YextLiveAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
};

type YextLiveSpecialty = { entityId?: string; name?: string };

type YextLiveProvider = {
  name?: string;
  firstName?: string;
  middleName?: string;
  lastName?: string;
  mainPhone?: string;
  fax?: string;
  address?: YextLiveAddress;
  c_answersSpecialty?: YextLiveSpecialty[];
  c_credentials?: string[];
  c_aemAsset?: { defaultImgSrc?: string; altText?: string };
  c_aemPage?: string;
  c_aemContentType?: string;
};

type YextLiveResult = { data?: YextLiveProvider };

type YextLiveResponse = {
  meta?: { errors?: Array<{ code: number; message: string }> };
  response?: { results?: YextLiveResult[]; resultsCount?: number };
};

// ── Seeded-row shape ──────────────────────────────────────────────────

type UncProviderRow = {
  npi: string;
  c_epic_id: string | null;
  name: string | null;
  first_name: string | null;
  last_name: string | null;
  credentials: string[] | null;
  main_phone: string | null;
  fax: string | null;
  custom_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  address_city: string | null;
  address_state: string | null;
  address_postal: string | null;
  headshot_url: string | null;
  primary_specialty: string | null;
  org_unit_folder: string | null;
};

// ── Phone / address helpers ───────────────────────────────────────────

function normalizePhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9+]/g, "").replace(/^\+?1(\d{10})$/, "$1");
  return formatPhoneUS(digits) || undefined;
}

function mapSeededAddress(row: UncProviderRow): Address | undefined {
  const street = [row.address_line1, row.address_line2]
    .filter(Boolean)
    .join(", ")
    .trim();
  const a: Address = {
    street: street || undefined,
    city: row.address_city || undefined,
    state: row.address_state || undefined,
    zip: row.address_postal || undefined,
  };
  if (!a.street && !a.city && !a.state && !a.zip) return undefined;
  return a;
}

function mapLiveAddress(a: YextLiveAddress | undefined): Address | undefined {
  if (!a) return undefined;
  const out: Address = {
    street: [a.line1, a.line2].filter(Boolean).join(", ").trim() || undefined,
    city: a.city,
    state: a.region,
    zip: a.postalCode,
  };
  if (!out.street && !out.city && !out.state && !out.zip) return undefined;
  return out;
}

// ── Practitioner.id extraction ────────────────────────────────────────
//
// Caller passes "Practitioner/abc123" in practitioner_ref. We accept
// either the bare id ("abc123") or the resource form. c_epicID in Yext
// is stored as the bare id.

export function extractPractitionerBareId(ref: string | undefined): string | null {
  if (!ref) return null;
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const slash = trimmed.lastIndexOf("/");
  const id = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  return id || null;
}

// ── Cache key helpers ─────────────────────────────────────────────────

function cacheKeyForName(parts: { first?: string; last?: string }): string | null {
  const slug = slugify([parts.first, parts.last].filter(Boolean).join(" "));
  if (!slug) return null;
  return `unc:${slug}`;
}

function cacheKeyForEpicId(epicId: string): string {
  return `unc:epic:${epicId}`;
}

function cacheKeyForNpi(npi: string): string {
  return `npi:${npi}`;
}

// ── Build EnrichedContact from a seeded row ──────────────────────────

export function buildFromSeededRow(
  row: UncProviderRow,
  opts: { cacheKey: string },
): EnrichedContact {
  const phones = [normalizePhone(row.main_phone)].filter(
    (v): v is string => !!v,
  );
  const fax = normalizePhone(row.fax);
  const addr = mapSeededAddress(row);
  const emails = row.custom_email ? [row.custom_email] : [];
  // No per-provider URL is exposed by the bulk Yext vertical, so the
  // public directory homepage is the safest source_url.
  return {
    found: true,
    lookup_key: opts.cacheKey,
    name: row.name || undefined,
    npi: row.npi,
    phones,
    fax,
    emails,
    addresses: addr ? [addr] : [],
    specialty: row.primary_specialty || undefined,
    bio: undefined,
    photo_url: row.headshot_url || undefined,
    source_name: "UNC Health",
    source_url: `${UNC_SITE_ORIGIN}/care-services/doctors`,
    confidence: "high", // Seeded rows are first-party UNC directory data.
  };
}

// ── Seeded-table lookups ──────────────────────────────────────────────

async function lookupSeeded(
  input: EnrichInput,
): Promise<EnrichedContact | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  // 1) c_epic_id (strongest)
  const epicId = extractPractitionerBareId(input.practitioner_ref);
  if (epicId) {
    const { data, error } = await supabase
      .from("unc_providers")
      .select(
        "npi,c_epic_id,name,first_name,last_name,credentials,main_phone,fax,custom_email,address_line1,address_line2,address_city,address_state,address_postal,headshot_url,primary_specialty,org_unit_folder",
      )
      .eq("c_epic_id", epicId)
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      return buildFromSeededRow(data as UncProviderRow, {
        cacheKey: cacheKeyForEpicId(epicId),
      });
    }
  }

  // 2) NPI
  if (input.npi) {
    const { data, error } = await supabase
      .from("unc_providers")
      .select(
        "npi,c_epic_id,name,first_name,last_name,credentials,main_phone,fax,custom_email,address_line1,address_line2,address_city,address_state,address_postal,headshot_url,primary_specialty,org_unit_folder",
      )
      .eq("npi", input.npi)
      .limit(1)
      .maybeSingle();
    if (!error && data) {
      return buildFromSeededRow(data as UncProviderRow, {
        cacheKey: cacheKeyForNpi(input.npi),
      });
    }
  }

  // 3) Name (last required, first optional)
  const parts =
    input.first_name && input.last_name
      ? { first: input.first_name, last: input.last_name }
      : (() => {
          const s = splitName(input.name);
          return { first: s.first, last: s.last };
        })();
  if (parts.last) {
    let q = supabase
      .from("unc_providers")
      .select(
        "npi,c_epic_id,name,first_name,last_name,credentials,main_phone,fax,custom_email,address_line1,address_line2,address_city,address_state,address_postal,headshot_url,primary_specialty,org_unit_folder",
      )
      .ilike("last_name", parts.last);
    if (parts.first && parts.first.length > 1) {
      q = q.ilike("first_name", parts.first);
    } else if (parts.first && parts.first.length === 1) {
      q = q.ilike("first_name", `${parts.first}%`);
    }
    const { data, error } = await q.limit(2);
    if (!error && data && data.length === 1) {
      const row = data[0] as UncProviderRow;
      const cacheKey = cacheKeyForName(parts) ||
        cacheKeyForNpi(row.npi);
      return buildFromSeededRow(row, { cacheKey });
    }
    // If 2+ matches, we'd be guessing — defer to the cascade.
  }

  return null;
}

// ── Live-Yext lookup (legacy safety net) ──────────────────────────────

function buildLiveSearchUrl(input: string): string {
  const params = new URLSearchParams({
    api_key: YEXT_LIVE_API_KEY,
    v: YEXT_LIVE_VERSION,
    experienceKey: YEXT_LIVE_EXPERIENCE_KEY,
    locale: "en",
    verticalKey: YEXT_LIVE_VERTICAL,
    input,
    limit: String(YEXT_LIVE_LIMIT),
  });
  return `${YEXT_LIVE_BASE}?${params.toString()}`;
}

function nameMatchesLive(
  candidate: YextLiveProvider,
  wanted: { first?: string; last?: string },
): boolean {
  if (!wanted.last) return false;
  const wantedLast = wanted.last.toLowerCase();
  const candLast = (candidate.lastName || "").toLowerCase();
  if (candLast !== wantedLast) return false;
  if (!wanted.first) return true;
  const wantedFirst = wanted.first.toLowerCase();
  const candFirst = (candidate.firstName || "").toLowerCase();
  if (wantedFirst.length === 1) return candFirst.startsWith(wantedFirst);
  return candFirst === wantedFirst;
}

function pickBestLive(
  results: YextLiveResult[],
  wanted: { first?: string; last?: string },
): { provider: YextLiveProvider; uniqueByName: boolean } | null {
  const providers = results
    .map((r) => r.data)
    .filter((p): p is YextLiveProvider => !!p)
    .filter(
      (p) =>
        p.c_aemContentType === "Provider" ||
        p.c_aemContentType === undefined,
    );
  if (providers.length === 0) return null;

  const matches = providers.filter((p) => nameMatchesLive(p, wanted));
  if (matches.length === 1) {
    return { provider: matches[0], uniqueByName: true };
  }
  if (matches.length > 1) {
    matches.sort(
      (a, b) =>
        Number(!!b.mainPhone) +
        Number(!!b.fax) +
        Number(!!b.address?.line1) -
        (Number(!!a.mainPhone) +
          Number(!!a.fax) +
          Number(!!a.address?.line1)),
    );
    return { provider: matches[0], uniqueByName: false };
  }
  return { provider: providers[0], uniqueByName: false };
}

export function buildFromLiveProvider(
  provider: YextLiveProvider,
  opts: { confidence: "high" | "medium" | "low"; cacheKey: string },
): EnrichedContact {
  const phones = [normalizePhone(provider.mainPhone)].filter(
    (v): v is string => !!v,
  );
  const fax = normalizePhone(provider.fax);
  const addr = mapLiveAddress(provider.address);
  const specialty = provider.c_answersSpecialty?.[0]?.name;
  const sourceUrl = provider.c_aemPage
    ? `${UNC_SITE_ORIGIN}${provider.c_aemPage}`
    : `${UNC_SITE_ORIGIN}/care-services/doctors`;
  return {
    found: true,
    lookup_key: opts.cacheKey,
    name: provider.name,
    npi: undefined,
    phones,
    fax,
    emails: [],
    addresses: addr ? [addr] : [],
    specialty,
    bio: undefined,
    photo_url: provider.c_aemAsset?.defaultImgSrc,
    source_name: "UNC Health",
    source_url: sourceUrl,
    confidence: opts.confidence,
  };
}

async function lookupLive(input: EnrichInput): Promise<EnrichedContact | null> {
  if (!YEXT_LIVE_API_KEY) return null;

  const parts =
    input.first_name && input.last_name
      ? { first: input.first_name, last: input.last_name }
      : (() => {
          const s = splitName(input.name);
          return { first: s.first, last: s.last };
        })();
  if (!parts.last) return null;
  const cacheKey = cacheKeyForName(parts);
  if (!cacheKey) return null;

  const queryName = [parts.first, parts.last].filter(Boolean).join(" ");
  let res: Response;
  try {
    res = await timedFetch(buildLiveSearchUrl(queryName));
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: YextLiveResponse;
  try {
    body = (await res.json()) as YextLiveResponse;
  } catch {
    return null;
  }
  if (body.meta?.errors && body.meta.errors.length > 0) return null;
  const results = body.response?.results || [];
  if (results.length === 0) return null;

  const best = pickBestLive(results, parts);
  if (!best) return null;

  const hasContact = !!(
    best.provider.mainPhone ||
    best.provider.fax ||
    best.provider.address?.line1
  );
  const confidence: "high" | "medium" | "low" =
    best.uniqueByName && hasContact
      ? "high"
      : hasContact
      ? "medium"
      : "low";

  return buildFromLiveProvider(best.provider, { confidence, cacheKey });
}

// ── Adapter entry point ───────────────────────────────────────────────

async function lookup(input: EnrichInput): Promise<EnrichedContact | null> {
  // 1) Prefer seeded table (zero network round-trips when populated).
  const seeded = await lookupSeeded(input).catch(() => null);
  if (seeded) return seeded;

  // 2) Fall back to live Yext search (legacy path).
  const live = await lookupLive(input).catch(() => null);
  if (live) return live;

  return null;
}

function tentativeCacheKeys(input: EnrichInput): string[] {
  const keys: string[] = [];
  const epicId = extractPractitionerBareId(input.practitioner_ref);
  if (epicId) keys.push(cacheKeyForEpicId(epicId));

  const parts =
    input.first_name && input.last_name
      ? { first: input.first_name, last: input.last_name }
      : (() => {
          const s = splitName(input.name);
          return { first: s.first, last: s.last };
        })();
  const nameKey = cacheKeyForName(parts);
  if (nameKey && !keys.includes(nameKey)) keys.push(nameKey);

  return keys;
}

export const uncAdapter: HospitalDirectoryAdapter = {
  id: "unc",
  display_name: "UNC Health",
  fhir_domains: ["epicfe.unch.unc.edu"],
  hint_org_keywords: ["unc"],
  directory_homepage: `${UNC_SITE_ORIGIN}/care-services/doctors`,
  cache_key_prefix: "unc",
  tentativeCacheKeys,
  lookup,
};

// ── Test surface ──────────────────────────────────────────────────────
//
// Both new and legacy aliases are exported so the pre-existing
// unc.test.ts (which imports buildEnrichedContact, nameMatches,
// buildSearchUrl, mapAddress, cacheKeyFor, pickBest) continues to
// pass unchanged after the seeded-table upgrade.

export const buildEnrichedContact = buildFromLiveProvider;

export const __test = {
  // New names
  extractPractitionerBareId,
  normalizePhone,
  mapSeededAddress,
  mapLiveAddress,
  nameMatchesLive,
  pickBestLive,
  cacheKeyForName,
  cacheKeyForEpicId,
  cacheKeyForNpi,
  buildLiveSearchUrl,
  // Legacy aliases (kept so existing unc.test.ts still compiles).
  nameMatches: nameMatchesLive,
  pickBest: pickBestLive,
  buildSearchUrl: buildLiveSearchUrl,
  mapAddress: mapLiveAddress,
  cacheKeyFor: cacheKeyForName,
};
