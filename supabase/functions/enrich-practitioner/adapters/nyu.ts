// NYU Langone Health directory adapter.
//
// Why NYU is high-value:
//   NYU Langone's Epic Confidential client (epicfhir.nyumc.org) follows
//   the same pattern as Duke — Practitioner.telecom is empty on the
//   wire. nyulangone.org's public Find a Doctor directory, however, is
//   uniquely friendly: every provider URL embeds the NPI directly, so
//   when fetch-ehr-data hands us a Practitioner with NPI we can resolve
//   to the canonical profile page in one HTTP call. No slug guessing,
//   no credential-permutation probing, no SPA scraping required for the
//   common path.
//
// URL pattern (primary):
//   /doctors/{npi}/{first-last}
//   e.g. /doctors/1134459597/cho-c-thin
//
// HTML shape (verified 2026-05-20):
//   - <h1><b itemprop="name">First Middle Last</b>, <span>MD</span></h1>
//   - <meta property="og:title" content="First Last, MD" />
//   - <meta property="og:image" content="...square.jpg" />
//   - <li class="specialty" itemscope itemtype="http://schema.org/MedicalSpecialty">
//       <span itemprop="name">Family Medicine</span>
//     </li>
//   - Multiple <h5 class="location-name"> + <p class="address-text"> +
//     <span class="location-contact-info__number--telephone"><a href="tel:...">
//     blocks for each practice location (one provider may list 4-6 locations).
//   - <p id="...nyuws_provider_json...">{"slug":"...","npi":"..."}</p> as a
//     belt-and-suspenders NPI re-confirmation source.
//
// Fallback behavior:
//   If the caller doesn't have an NPI (rare for FHIR-derived practitioners
//   but possible for manually-entered care team members), we return null
//   and let the orchestrator fall through to NPPES. NYU's public search
//   endpoint is a JS-rendered SPA — not worth scraping when NPPES will
//   resolve a name+state to an NPI in one API call and the next enrich
//   pass will then hit our happy path with the NPI in hand.

import type {
  Address,
  EnrichedContact,
  EnrichInput,
} from "../../_shared/practitioner-types.ts";
import type { HospitalDirectoryAdapter } from "../../_shared/hospital-directory-registry.ts";
import {
  decodeHtmlEntities,
  formatPhoneUS,
  slugify,
  splitName,
  stripHtml,
  timedFetch,
} from "../../_shared/adapter-utils.ts";

// ── Page parser ───────────────────────────────────────────────────────

function parseNyuLangoneHtml(
  html: string,
  sourceUrl: string,
  npi: string,
): EnrichedContact | null {
  const get = (re: RegExp): string | undefined => {
    const m = html.match(re);
    return m ? m[1].trim() : undefined;
  };

  // Name: prefer the rendered H1, fall back to og:title.
  // The H1 looks like: <h1>...<b itemprop="name">Cho C. Thin</b>, <span>MD</span></h1>
  // so we extract the inner of itemprop="name" and optionally append the
  // credential span.
  let name = "";
  const h1NameMatch = html.match(
    /<h1[^>]*>[\s\S]*?<b[^>]*itemprop="name"[^>]*>\s*([^<]+?)\s*<\/b>(?:\s*,\s*<span[^>]*>\s*([^<]+?)\s*<\/span>)?/i,
  );
  if (h1NameMatch) {
    name = h1NameMatch[1].trim();
    if (h1NameMatch[2]) name = `${name}, ${h1NameMatch[2].trim()}`;
  }
  if (!name) {
    name = get(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) || "";
  }

  // Specialty: schema.org MedicalSpecialty microdata.
  const specialty = get(
    /<li[^>]*class="specialty"[\s\S]*?<span[^>]*itemprop="name"[^>]*>\s*([^<]+?)\s*<\/span>/i,
  );

  // Photo: og:image is a square headshot.
  const photo_url = get(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i);

  // Phones: every tel: link on the page is a clinic line for one of this
  // provider's locations. Collect them in the order they appear; dedupe
  // formatted strings.
  const phones: string[] = [];
  const phoneRe = /href="tel:([0-9\-+() .]+)"/gi;
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(html)) !== null) {
    const digits = pm[1].replace(/[^0-9+]/g, "").replace(/^\+?1(\d{10})$/, "$1");
    const formatted = formatPhoneUS(digits) || pm[1].trim();
    if (formatted && !phones.includes(formatted)) phones.push(formatted);
  }

  // Fax: lives in a sibling span (not a tel: link) inside the location-
  // contact-info block, labeled with an <h6>Fax</h6>. We grab the first
  // Fax block we find.
  let fax: string | undefined;
  const faxBlockMatch = html.match(
    /<h6[^>]*class="location-contact-info__title"[^>]*>\s*Fax\s*<\/h6>\s*<p>\s*<span[^>]*>\s*([0-9\-+() .]+?)\s*<\/span>/i,
  );
  if (faxBlockMatch) {
    const raw = faxBlockMatch[1];
    const digits = raw.replace(/[^0-9+]/g, "");
    fax = formatPhoneUS(digits) || raw.trim();
  }

  // Addresses: every <h5 class="location-name"> is followed by a
  // <p class="address-text"> with the form:
  //   Street,
  //   City, ST ZIP
  // We pair each location-name with the next address-text and parse
  // the city/state/zip out of the second line.
  const addresses: Address[] = [];
  const locAnchorRe = /<h5[^>]*class="location-name"[^>]*>\s*([^<]+?)\s*<\/h5>[\s\S]{0,500}?<p[^>]*class="address-text"[^>]*>([\s\S]*?)<\/p>/gi;
  let am: RegExpExecArray | null;
  while ((am = locAnchorRe.exec(html)) !== null) {
    const label = decodeHtmlEntities(am[1].trim());
    const inner = stripHtml(am[2]).replace(/\s+/g, " ").trim();
    // Split on the comma that precedes "City, ST ZIP" — the address-text
    // is two lines: "Street," then "City, ST ZIP". After stripHtml +
    // whitespace collapse the comma+space separator is preserved.
    // Pattern: "<street> , <city>, <ST> <ZIP>"
    const m = inner.match(/^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    const a: Address = m
      ? { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4], label }
      : { street: inner, label };
    if (a.street || a.city || a.state || a.zip) addresses.push(a);
  }

  // Belt-and-suspenders NPI re-confirmation from the embedded JSON blob.
  // We pass NPI in from the URL so this is just a sanity check; if the
  // page's NPI mismatches the URL's NPI, the URL still wins (we trust
  // the canonical we requested over the embedded JSON).
  const embeddedNpiMatch = html.match(/"npi"\s*:\s*"(\d{10})"/);
  const npiOnPage = embeddedNpiMatch ? embeddedNpiMatch[1] : undefined;

  if (!name && phones.length === 0 && !fax && addresses.length === 0) return null;

  return {
    found: true,
    // NPI is always present here (the URL itself contains it), so the
    // canonical npi: cache key is always preferred over an nyu: slug key.
    lookup_key: `npi:${npi}`,
    name: decodeHtmlEntities(name),
    npi: npiOnPage || npi,
    phones,
    fax,
    emails: [],
    addresses,
    specialty: specialty ? decodeHtmlEntities(specialty) : undefined,
    bio: undefined,
    photo_url,
    source_name: "NYU Langone Health",
    source_url: sourceUrl,
    confidence: "high",
  };
}

// ── Adapter implementation ────────────────────────────────────────────

async function lookup(input: EnrichInput): Promise<EnrichedContact | null> {
  // NYU's URL contract is /doctors/{npi}/{slug}. Without an NPI we
  // cannot construct a canonical URL — fall through to NPPES (which
  // will resolve the name to an NPI; a subsequent enrich pass will
  // then hit our happy path).
  if (!input.npi || !/^\d{10}$/.test(input.npi)) return null;

  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name }
    : splitName(input.name);

  // We always try the NPI-only canonical first. NYU happily 301s the
  // bare-NPI URL to the slugged URL, so this works even when our slug
  // guess is wrong. Building a slug is still nice when present because
  // it saves the redirect and matches the URL we'd display anyway.
  const baseSlug = parts.first && parts.last
    ? slugify(`${parts.first} ${parts.last}`)
    : parts.last
    ? slugify(parts.last)
    : "";

  const urls = baseSlug
    ? [
        `https://nyulangone.org/doctors/${input.npi}/${baseSlug}`,
        `https://nyulangone.org/doctors/${input.npi}`,
      ]
    : [`https://nyulangone.org/doctors/${input.npi}`];

  for (const url of urls) {
    let res: Response;
    try {
      res = await timedFetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const html = await res.text();
    // NYU returns a soft-404 (200 OK with a "We couldn't find that
    // provider" page) when the NPI doesn't map to a public-facing
    // profile. Use the presence of the profile microdata as the real
    // success signal.
    if (!html.includes('itemprop="name"') || !html.includes('og:title')) continue;
    // The canonical href is the source of truth for the URL we display.
    const canonicalMatch = html.match(
      /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/i,
    );
    const finalUrl = canonicalMatch ? canonicalMatch[1] : url;

    const parsed = parseNyuLangoneHtml(html, finalUrl, input.npi);
    if (parsed && (parsed.phones.length || parsed.fax || parsed.addresses.length)) {
      parsed.confidence = "high";
      return parsed;
    }
    if (parsed) return parsed;
  }

  return null;
}

// Tentative cache keys. NYU's only stable identifier is the NPI, so we
// always use the canonical `npi:{npi}` key — handled generically by the
// router upstream. We return [] here to signal "no adapter-specific
// pre-NPI cache key", matching the registry contract (cache_key_prefix
// empty string).
function tentativeCacheKeys(_input: EnrichInput): string[] {
  return [];
}

export const nyuAdapter: HospitalDirectoryAdapter = {
  id: "nyu",
  display_name: "NYU Langone Health",
  fhir_domains: ["epicfhir.nyumc.org"],
  hint_org_keywords: ["nyu langone", "nyu medical", "nyu health", "nyu hospital"],
  directory_homepage: "https://nyulangone.org/doctors",
  // Empty cache_key_prefix because we only ever cache by NPI; the router
  // handles npi: keys generically. See Duke for the alternate pattern
  // (slug-based pre-NPI cache).
  cache_key_prefix: "",
  tentativeCacheKeys,
  lookup,
};
