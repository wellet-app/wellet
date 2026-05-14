// WakeMed Health & Hospitals directory adapter.
//
// Why WakeMed is the third adapter:
//   WakeMed runs Epic and exposes the FHIR endpoint at
//   epic-soap.wakemed.org/FHIR/api/FHIR/R4. Per Duke/UNC pattern, the
//   Epic Practitioner.telecom is almost certainly stripped on the wire,
//   so care-team contact data has to come from a public hospital
//   directory or from NPPES fallback.
//
//   WakeMed's "Find a Doctor" page at wakemed.org/providers is a
//   client-rendered Vue.js SPA backed by Healthgrades Mercury DXE — a
//   first-party JSON API exposed at /hgwf-api/v1/records/providers
//   with NO authentication required. Recon on 2026-05-14 verified the
//   endpoint returns structured provider records including NPI,
//   phone_number, primary_specialty (as taxonomy ID), images, and a
//   stable profile slug. This is strictly better than UNC's Yext shape
//   because WakeMed actually exposes the NPI.
//
// API call:
//   GET https://www.wakemed.org/hgwf-api/v1/records/providers
//        ?q={query}
//        &limit=10
//        &offset=0
//        &filter=show_in_search%3D1%7Cstatus%3D1
//        &sortBy=order
//
// Profile URL pattern (from response field `url`):
//   https://www.wakemed.org/provider/{slug}
//   e.g. https://www.wakemed.org/provider/logan-smith-md
//
// Fields returned by the Mercury DXE API (verified 2026-05-14):
//   nid, title (full display name), name {given, family, credentials},
//   npi (10-digit integer), phone_number, primary_specialty (term ID),
//   accepting_new_patients, gender, images[], locations[] (location nids),
//   url (absolute profile URL). Fax and address are NOT in the provider
//   record — they live on the linked location records and would require
//   a second hop. For now we accept phone-only, and the cascade picks
//   up address from NPPES if needed.
//
// robots.txt at wakemed.org has no restriction on /hgwf-api or
// /providers. The endpoint is fully public — the same one the public
// Vue SPA calls on every page load — so we use it the way it was
// designed.

import type {
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

// ── Mercury DXE config ─────────────────────────────────────────────────

const DXE_BASE = "https://www.wakemed.org/hgwf-api/v1/records/providers";
const WAKEMED_SITE_ORIGIN = "https://www.wakemed.org";
const DXE_LIMIT = 10;
// Default Mercury DXE filter ensures only published, listed providers
// come back. The Vue SPA uses the same filter on every search.
const DXE_FILTER = "show_in_search=1|status=1";
const DXE_SORT = "order";

// ── DXE response shapes (only the fields we read) ──────────────────────

type DxeProviderImage = {
  url?: string;
  alt?: string;
};

type DxeProvider = {
  nid?: number;
  title?: string;                 // "Logan Smith, MD"
  name?: {
    given?: string;
    family?: string;
    credentials?: string;         // "MD", "PA-C", "DO", etc.
  };
  npi?: number;                   // 10-digit integer
  phone_number?: string;          // sometimes formatted, sometimes raw
  primary_specialty?: number;     // taxonomy term ID (we don't resolve)
  specialties?: number[];
  accepting_new_patients?: boolean;
  gender?: string;
  images?: DxeProviderImage[];
  url?: string;                   // absolute profile URL
  show_in_search?: boolean;
  status?: boolean;
};

type DxeResponse = {
  items?: DxeProvider[];
  paging?: {
    totalCount?: number;
    count?: number;
  };
};

// ── Helpers ────────────────────────────────────────────────────────────

function buildSearchUrl(input: string): string {
  const params = new URLSearchParams({
    q: input,
    limit: String(DXE_LIMIT),
    offset: "0",
    filter: DXE_FILTER,
    sortBy: DXE_SORT,
  });
  return `${DXE_BASE}?${params.toString()}`;
}

function normalizePhone(raw: string | number | undefined): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw);
  const digits = s.replace(/[^0-9+]/g, "").replace(/^\+?1(\d{10})$/, "$1");
  return formatPhoneUS(digits) || undefined;
}

function normalizeNpi(n: number | string | undefined): string | undefined {
  if (n === undefined || n === null) return undefined;
  const digits = String(n).replace(/\D/g, "");
  if (digits.length !== 10) return undefined;
  return digits;
}

function nameMatches(
  candidate: DxeProvider,
  wanted: { first?: string; last?: string },
): boolean {
  if (!wanted.last) return false;
  // DXE sometimes leaves a trailing space in `name.given` (e.g. "Logan ").
  const candFirst = (candidate.name?.given || "").trim().toLowerCase();
  const candLast = (candidate.name?.family || "").trim().toLowerCase();
  if (candLast !== wanted.last.toLowerCase()) return false;
  if (!wanted.first) return true;
  const wantedFirst = wanted.first.toLowerCase();
  // Allow first-name initial-only matches ("J" matches "Jane") since
  // the FHIR side sometimes only carries an initial.
  if (wantedFirst.length === 1) return candFirst.startsWith(wantedFirst);
  return candFirst === wantedFirst;
}

function pickBest(
  providers: DxeProvider[],
  wanted: { first?: string; last?: string },
): { provider: DxeProvider; uniqueByName: boolean } | null {
  if (providers.length === 0) return null;

  const matches = providers.filter((p) => nameMatches(p, wanted));
  if (matches.length === 1) {
    return { provider: matches[0], uniqueByName: true };
  }
  if (matches.length > 1) {
    // Prefer the one with the most identifying signal: NPI > phone > image.
    matches.sort((a, b) =>
      (Number(!!normalizeNpi(b.npi)) * 2 + Number(!!b.phone_number) + Number(!!b.images?.[0]?.url)) -
      (Number(!!normalizeNpi(a.npi)) * 2 + Number(!!a.phone_number) + Number(!!a.images?.[0]?.url))
    );
    return { provider: matches[0], uniqueByName: false };
  }
  // No name match → return first so cascade can still surface something,
  // but flag as not-unique so confidence drops below "high".
  return { provider: providers[0], uniqueByName: false };
}

/** Convert a Mercury DXE provider record to our EnrichedContact shape. */
export function buildEnrichedContact(
  provider: DxeProvider,
  opts: { confidence: "high" | "medium" | "low"; cacheKey: string },
): EnrichedContact {
  const phones = [normalizePhone(provider.phone_number)].filter(
    (v): v is string => !!v,
  );
  const npi = normalizeNpi(provider.npi);
  const photo = provider.images?.[0]?.url;
  // DXE doesn't expand specialty taxonomy in the search response — we
  // get an integer term ID, not a label. Leave specialty undefined and
  // let downstream resolve it from FHIR or NPPES taxonomy.
  const sourceUrl = provider.url || `${WAKEMED_SITE_ORIGIN}/providers`;

  // Compose display name. Prefer DXE's `title` (already includes
  // credentials), then fall back to assembled given/family/credentials.
  const name = provider.title ||
    [provider.name?.given, provider.name?.family, provider.name?.credentials]
      .map((s) => (s || "").trim())
      .filter(Boolean)
      .join(" ") ||
    undefined;

  return {
    found: true,
    lookup_key: opts.cacheKey,
    name,
    npi,
    phones,
    fax: undefined,                // DXE does not expose fax at provider level
    emails: [],
    addresses: [],                 // address lives on linked locations[]
    specialty: undefined,
    bio: undefined,
    photo_url: photo,
    source_name: "WakeMed",
    source_url: sourceUrl,
    confidence: opts.confidence,
  };
}

function cacheKeyFor(parts: { first?: string; last?: string }): string | null {
  const slug = slugify([parts.first, parts.last].filter(Boolean).join(" "));
  if (!slug) return null;
  return `wakemed:${slug}`;
}

// ── Adapter implementation ────────────────────────────────────────────

async function lookup(input: EnrichInput): Promise<EnrichedContact | null> {
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

  let body: DxeResponse;
  try {
    body = await res.json() as DxeResponse;
  } catch {
    return null;
  }

  const items = body.items || [];
  if (items.length === 0) return null;

  const best = pickBest(items, parts);
  if (!best) return null;

  // Confidence ladder: unique name match + NPI + phone → high. Unique
  // match + (NPI or phone) → high. Ambiguous match with contact → medium.
  // No name match → low.
  const hasNpi = !!normalizeNpi(best.provider.npi);
  const hasPhone = !!best.provider.phone_number;
  const hasContact = hasNpi || hasPhone;
  const confidence: "high" | "medium" | "low" = best.uniqueByName && hasContact
    ? "high"
    : hasContact
    ? "medium"
    : "low";

  return buildEnrichedContact(best.provider, { confidence, cacheKey });
}

// Tentative cache key — used by the registry to attempt a cache hit
// before we make a network request. WakeMed has a single key shape.
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

export const wakemedAdapter: HospitalDirectoryAdapter = {
  id: "wakemed",
  display_name: "WakeMed",
  // WakeMed's Epic FHIR base is epic-soap.wakemed.org. The registry
  // routes on this host when ehr_connections.fhir_base_url points at
  // WakeMed. (MyChart at mychart.wakemed.org is the patient-facing
  // portal, not the FHIR endpoint.)
  fhir_domains: ["epic-soap.wakemed.org"],
  hint_org_keywords: ["wakemed", "wake med", "wake medical"],
  directory_homepage: "https://www.wakemed.org/providers",
  cache_key_prefix: "wakemed",
  tentativeCacheKeys,
  lookup,
};

// ── Test surface ──────────────────────────────────────────────────────
//
// Internal pure helpers re-exported so wakemed.test.ts can exercise
// them without spinning up a fake fetch. Keep the names stable.

export const __test = {
  buildSearchUrl,
  normalizePhone,
  normalizeNpi,
  nameMatches,
  pickBest,
  cacheKeyFor,
};
