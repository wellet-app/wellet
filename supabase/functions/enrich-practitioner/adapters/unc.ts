// UNC Health directory adapter.
//
// Why UNC was the obvious second adapter:
//   UNC's Epic FHIR R4 endpoint (epicfe.unch.unc.edu) almost
//   certainly returns Practitioner / PractitionerRole resources with
//   telecom stripped, same as Duke. UNC's public provider directory
//   at unchealth.org/care-services/doctors is — happily — a
//   client-rendered React app backed by a Yext "Answers" search API
//   with publicly embedded credentials. That means we don't have to
//   parse HTML at all: one JSON call returns a structured provider
//   record with mainPhone, fax, address, specialty, photo and a
//   stable profile slug.
//
// API call:
//   GET https://liveapi.yext.com/v2/accounts/me/search/vertical/query
//        ?api_key={publicly embedded site key}
//        &v=20221201
//        &experienceKey=unch-aem-site-search
//        &locale=en
//        &verticalKey=aem_page
//        &input={query}
//        &limit=5
//
// Profile URL pattern (from Yext field c_aemPage):
//   /care-services/doctors/{first-letter-of-last-name}/{slug}
//   e.g. /care-services/doctors/s/michele-smith-pa-c
//
// Fields returned by Yext (verified by direct probing 2026-05-02):
//   name, firstName, lastName, mainPhone, fax, address{line1, city,
//   region, postalCode}, c_answersSpecialty[].name, c_aemAsset.defaultImgSrc,
//   c_credentials[], c_aemPage. NPI is NOT exposed by Yext — left
//   undefined; the cascade handles NPPES cross-match downstream.
//
// robots.txt at unchealth.org is fully open ("Allow: /"). The Yext
// API key is intentionally public — it's embedded in the AEM page
// shipped to every browser load — so we are using it the way it was
// designed to be used.

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

// ── Yext config ────────────────────────────────────────────────────────

const YEXT_BASE = "https://liveapi.yext.com/v2/accounts/me/search/vertical/query";
// Read from env so the credential isn't checked into a public repo. Set
// via `supabase secrets set UNC_YEXT_API_KEY=...` (or via the dashboard).
// If unset, the UNC adapter will skip enrichment gracefully.
const YEXT_API_KEY = Deno.env.get("UNC_YEXT_API_KEY") || "";
const YEXT_EXPERIENCE_KEY = "unch-aem-site-search";
const YEXT_VERSION = "20221201";
const YEXT_VERTICAL = "aem_page";
const YEXT_LIMIT = 5;
const UNC_SITE_ORIGIN = "https://www.unchealth.org";

// ── Yext response shapes (only the fields we read) ────────────────────

type YextAddress = {
  line1?: string;
  line2?: string;
  city?: string;
  region?: string;       // "NC"
  postalCode?: string;
  countryCode?: string;
};

type YextSpecialty = { entityId?: string; name?: string };

type YextProvider = {
  name?: string;                 // "Michele Smith, PA-C"
  firstName?: string;
  middleName?: string;
  lastName?: string;
  mainPhone?: string;            // E.164, e.g. "+18286942350"
  fax?: string;
  address?: YextAddress;
  c_answersSpecialty?: YextSpecialty[];
  c_credentials?: string[];      // ["MD"], ["PA-C"], etc.
  c_aemAsset?: { defaultImgSrc?: string; altText?: string };
  c_aemPage?: string;            // "/care-services/doctors/s/michele-smith-pa-c"
  c_aemContentType?: string;     // "Provider" — guard against location/article hits
};

type YextResult = { data?: YextProvider };

type YextResponse = {
  meta?: { errors?: Array<{ code: number; message: string }> };
  response?: { results?: YextResult[]; resultsCount?: number };
};

// ── Helpers ───────────────────────────────────────────────────────────

function buildSearchUrl(input: string): string {
  const params = new URLSearchParams({
    api_key: YEXT_API_KEY,
    v: YEXT_VERSION,
    experienceKey: YEXT_EXPERIENCE_KEY,
    locale: "en",
    verticalKey: YEXT_VERTICAL,
    input,
    limit: String(YEXT_LIMIT),
  });
  return `${YEXT_BASE}?${params.toString()}`;
}

function normalizePhone(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/[^0-9+]/g, "").replace(/^\+?1(\d{10})$/, "$1");
  return formatPhoneUS(digits) || undefined;
}

function mapAddress(a: YextAddress | undefined): Address | undefined {
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

function nameMatches(
  candidate: YextProvider,
  wanted: { first?: string; last?: string },
): boolean {
  if (!wanted.last) return false;
  const wantedLast = wanted.last.toLowerCase();
  const candLast = (candidate.lastName || "").toLowerCase();
  if (candLast !== wantedLast) return false;
  if (!wanted.first) return true;
  const wantedFirst = wanted.first.toLowerCase();
  const candFirst = (candidate.firstName || "").toLowerCase();
  // Allow first-name initial-only matches ("J" matches "Jane") since
  // the FHIR side sometimes only carries an initial. Otherwise require
  // an exact match — UNC has many same-last-name physicians.
  if (wantedFirst.length === 1) return candFirst.startsWith(wantedFirst);
  return candFirst === wantedFirst;
}

function pickBest(
  results: YextResult[],
  wanted: { first?: string; last?: string },
): { provider: YextProvider; uniqueByName: boolean } | null {
  const providers = results
    .map((r) => r.data)
    .filter((p): p is YextProvider => !!p)
    .filter((p) => p.c_aemContentType === "Provider" || p.c_aemContentType === undefined);
  if (providers.length === 0) return null;

  const matches = providers.filter((p) => nameMatches(p, wanted));
  if (matches.length === 1) {
    return { provider: matches[0], uniqueByName: true };
  }
  if (matches.length > 1) {
    // Prefer the one with the most contact data populated
    matches.sort((a, b) =>
      (Number(!!b.mainPhone) + Number(!!b.fax) + Number(!!b.address?.line1)) -
      (Number(!!a.mainPhone) + Number(!!a.fax) + Number(!!a.address?.line1))
    );
    return { provider: matches[0], uniqueByName: false };
  }
  // No name match at all → fall back to first provider record so the
  // cascade can still surface something useful, but mark as not-unique
  // so confidence drops below "high".
  return { provider: providers[0], uniqueByName: false };
}

/** Convert a Yext provider record to our EnrichedContact shape. */
export function buildEnrichedContact(
  provider: YextProvider,
  opts: { confidence: "high" | "medium" | "low"; cacheKey: string },
): EnrichedContact {
  const phones = [normalizePhone(provider.mainPhone)].filter((v): v is string => !!v);
  const fax = normalizePhone(provider.fax);
  const addr = mapAddress(provider.address);
  const specialty = provider.c_answersSpecialty?.[0]?.name;
  const sourceUrl = provider.c_aemPage
    ? `${UNC_SITE_ORIGIN}${provider.c_aemPage}`
    : `${UNC_SITE_ORIGIN}/care-services/doctors`;

  return {
    found: true,
    lookup_key: opts.cacheKey,
    name: provider.name,
    // NPI is intentionally omitted — Yext doesn't expose it for UNC.
    // The downstream cascade still cross-matches via NPPES if needed.
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

function cacheKeyFor(parts: { first?: string; last?: string }): string | null {
  const slug = slugify([parts.first, parts.last].filter(Boolean).join(" "));
  if (!slug) return null;
  return `unc:${slug}`;
}

// ── Adapter implementation ────────────────────────────────────────────

async function lookup(input: EnrichInput): Promise<EnrichedContact | null> {
  // Graceful skip if env-driven key isn't configured. Caller will fall
  // through to NPPES (tier 3) which still produces medium-confidence rows.
  if (!YEXT_API_KEY) return null;

  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name }
    : (() => {
      const s = splitName(input.name);
      return { first: s.first, last: s.last };
    })();

  if (!parts.last) return null;
  const cacheKey = cacheKeyFor(parts);
  if (!cacheKey) return null;

  const queryName = [parts.first, parts.last].filter(Boolean).join(" ");
  let res: Response;
  try {
    res = await timedFetch(buildSearchUrl(queryName));
  } catch {
    return null;
  }
  if (!res.ok) return null;

  let body: YextResponse;
  try {
    body = await res.json() as YextResponse;
  } catch {
    return null;
  }

  if (body.meta?.errors && body.meta.errors.length > 0) return null;
  const results = body.response?.results || [];
  if (results.length === 0) return null;

  const best = pickBest(results, parts);
  if (!best) return null;

  const hasContact = !!(
    best.provider.mainPhone ||
    best.provider.fax ||
    best.provider.address?.line1
  );
  const confidence: "high" | "medium" | "low" = best.uniqueByName && hasContact
    ? "high"
    : hasContact
    ? "medium"
    : "low";

  return buildEnrichedContact(best.provider, { confidence, cacheKey });
}

// Tentative cache key for an input — used by the registry to attempt a
// cache hit before we make a network request. UNC has a single key
// shape (no credential variants in the slug), so this returns one key.
function tentativeCacheKeys(input: EnrichInput): string[] {
  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name }
    : (() => {
      const s = splitName(input.name);
      return { first: s.first, last: s.last };
    })();
  const key = cacheKeyFor(parts);
  return key ? [key] : [];
}

export const uncAdapter: HospitalDirectoryAdapter = {
  id: "unc",
  display_name: "UNC Health",
  // FHIR base host is epicfe.unch.unc.edu (per Epic's public endpoint
  // listing — UNC has 1,284 patient connections behind it). The
  // registry routes on this host when ehr_connections.fhir_base_url
  // points at UNC.
  fhir_domains: ["epicfe.unch.unc.edu"],
  hint_org_keywords: ["unc"],
  directory_homepage: "https://www.unchealth.org/care-services/doctors",
  cache_key_prefix: "unc",
  tentativeCacheKeys,
  lookup,
};

// ── Test surface ──────────────────────────────────────────────────────
//
// Internal pure helpers re-exported so unc.test.ts can exercise them
// without spinning up a fake fetch. Keep the names stable.

export const __test = {
  buildSearchUrl,
  normalizePhone,
  mapAddress,
  nameMatches,
  pickBest,
  cacheKeyFor,
};
