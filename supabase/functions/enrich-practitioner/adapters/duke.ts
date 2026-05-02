// Duke Health directory adapter.
//
// Why Duke is the first adapter:
//   Duke's Epic FHIR R4 endpoint returns Practitioner / PractitionerRole
//   resources with telecom completely empty. dukehealth.org's public
//   provider directory is, in contrast, exceptionally clean — every
//   provider page is rendered server-side with Schema.org microdata
//   (itemprop="telephone" / "fax" / "streetAddress" / etc.), and the
//   NPI is embedded inside a drupal-settings-json <script> tag. That
//   makes a regex-based extractor reliable and cheap.
//
// URL pattern:
//   /find-doctors-physicians/{first}-{last}-{credential}
//   e.g. /find-doctors-physicians/jaseela-illath-md
//
// This file is the verbatim Duke logic that previously lived directly
// in enrich-practitioner/index.ts, repackaged behind the
// HospitalDirectoryAdapter contract. Behavior is intentionally
// identical so the registry refactor is observably a no-op for Duke.
//
// Shared utilities (timedFetch, splitName, slugify, stripHtml,
// decodeHtmlEntities, formatPhoneUS) live in _shared/adapter-utils.ts
// so future hospital adapters can compose them without duplication.

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

function parseDukeHealthHtml(html: string, sourceUrl: string, slug: string): EnrichedContact | null {
  const get = (re: RegExp): string | undefined => {
    const m = html.match(re);
    return m ? m[1].trim() : undefined;
  };

  const name =
    get(/<h1[^>]*itemprop="name"[^>]*>\s*([^<]+?)\s*<\/h1>/i) ||
    get(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
    "";

  const phones: string[] = [];
  const phoneRe = /href="tel:([0-9\-+() .]+)"/gi;
  let pm: RegExpExecArray | null;
  while ((pm = phoneRe.exec(html)) !== null) {
    const normalized = pm[1].replace(/[^0-9+]/g, "").replace(/^1(\d{10})$/, "$1");
    const formatted = formatPhoneUS(normalized) || pm[1].trim();
    if (formatted && !phones.includes(formatted)) phones.push(formatted);
  }
  const ipTel = get(/<[^>]*itemprop="telephone"[^>]*>\s*([^<]+?)\s*</i);
  if (ipTel) {
    const norm = ipTel.replace(/[^0-9+]/g, "");
    const fmt = formatPhoneUS(norm) || ipTel.trim();
    if (fmt && !phones.includes(fmt)) phones.push(fmt);
  }

  const faxRaw = get(/<[^>]*itemprop="fax"[^>]*>\s*([^<]+?)\s*</i);
  const fax = faxRaw ? (formatPhoneUS(faxRaw.replace(/[^0-9+]/g, "")) || faxRaw.trim()) : undefined;

  const addresses: Address[] = [];
  const addrAnchors: number[] = [];
  const anchorRe = /itemprop="address"/gi;
  let aam: RegExpExecArray | null;
  while ((aam = anchorRe.exec(html)) !== null) addrAnchors.push(aam.index);
  for (let i = 0; i < addrAnchors.length; i++) {
    const start = addrAnchors[i];
    const end = i + 1 < addrAnchors.length ? addrAnchors[i + 1] : html.length;
    const block = html.slice(start, Math.min(end, start + 4096));
    const a: Address = {
      street: block.match(/itemprop="streetAddress"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      city: block.match(/itemprop="addressLocality"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      state: block.match(/itemprop="addressRegion"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
      zip: block.match(/itemprop="postalCode"[^>]*>\s*([^<]+?)\s*</i)?.[1]?.trim(),
    };
    const labelMatch = block.match(/class="location-name-text"[^>]*>\s*([\s\S]*?)\s*<\/a>/i);
    if (labelMatch) {
      a.label = labelMatch[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    }
    if (a.street || a.city || a.state || a.zip) {
      addresses.push(a);
    }
  }

  const bioRaw = get(/itemprop="description"[^>]*>([\s\S]*?)<\/(?:div|p|span)>/i);
  const bio = bioRaw ? stripHtml(bioRaw).trim() : undefined;

  const photo_url =
    get(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/i) ||
    get(/itemprop="image"[^>]+(?:src|content)="([^"]+)"/i);

  let npi: string | undefined;
  let specialty: string | undefined;
  const drupalMatch = html.match(/drupal-settings-json[^>]*>([\s\S]*?)<\/script>/i);
  if (drupalMatch) {
    const raw = drupalMatch[1];
    const npiMatch = raw.match(/"np_id":"(\d+)"/);
    if (npiMatch) npi = npiMatch[1];
    const specMatch = raw.match(/"physicianSpecialities":\{([^}]+)\}/);
    if (specMatch) {
      const firstName = specMatch[1].match(/"\d+":"([^"]+)"/);
      if (firstName) specialty = firstName[1];
    }
  }

  if (!name && phones.length === 0 && !fax && addresses.length === 0) return null;

  return {
    found: true,
    lookup_key: npi ? `npi:${npi}` : `duke:${slug}`,
    name: decodeHtmlEntities(name),
    npi,
    phones,
    fax,
    emails: [],
    addresses,
    specialty: specialty ? decodeHtmlEntities(specialty) : undefined,
    bio: bio ? decodeHtmlEntities(bio) : undefined,
    photo_url,
    // source_name preserved as "dukehealth.org" so existing rows in
    // practitioner_contact_cache and any downstream UI logic that
    // matches on this exact string keep working unchanged.
    source_name: "dukehealth.org",
    source_url: sourceUrl,
    confidence: "high",
  };
}

// ── Adapter implementation ────────────────────────────────────────────

async function lookup(input: EnrichInput): Promise<EnrichedContact | null> {
  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name, credential: "" }
    : splitName(input.name);

  if (!parts.last) return null;

  const credentials = parts.credential
    ? [parts.credential.toLowerCase()]
    : ["md", "do", "pa-c", "pa", "np", "aprn", "rn", "phd"];

  const baseSlug = slugify([parts.first, parts.last].filter(Boolean).join(" "));
  if (!baseSlug) return null;

  for (const cred of credentials) {
    const slug = cred ? `${baseSlug}-${cred}` : baseSlug;
    const url = `https://www.dukehealth.org/find-doctors-physicians/${slug}`;
    let res: Response;
    try {
      res = await timedFetch(url);
    } catch {
      continue;
    }
    if (!res.ok) continue;

    const html = await res.text();
    if (!html.includes('itemprop="')) continue;

    const parsed = parseDukeHealthHtml(html, url, slug);
    if (parsed && (parsed.phones.length || parsed.fax || parsed.addresses.length)) {
      parsed.confidence = "high";
      return parsed;
    }
    if (parsed) return parsed;
  }

  return null;
}

// Tentative cache keys for an input — mirrors the slugs we'd actually
// build if we hit the network. Probing these before any HTTP request
// keeps the cache hit path identical to the pre-refactor code.
function tentativeCacheKeys(input: EnrichInput): string[] {
  const parts = input.first_name && input.last_name
    ? { first: input.first_name, last: input.last_name }
    : splitName(input.name);
  if (!parts.first || !parts.last) return [];
  const slug = slugify(`${parts.first} ${parts.last}`);
  if (!slug) return [];
  // Match the original index.ts probe order: -md then -do (the two
  // overwhelmingly common Duke physician credentials).
  return [`duke:${slug}-md`, `duke:${slug}-do`];
}

export const dukeAdapter: HospitalDirectoryAdapter = {
  id: "duke",
  display_name: "Duke Health",
  fhir_domains: ["health-apis.duke.edu"],
  hint_org_keywords: ["duke"],
  directory_homepage: "https://www.dukehealth.org/find-doctors-physicians",
  cache_key_prefix: "duke",
  tentativeCacheKeys,
  lookup,
};
