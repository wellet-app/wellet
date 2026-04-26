// Hospital directory enricher registry.
//
// Why this exists:
//   The original enrich-practitioner edge function hardcoded a single
//   directory adapter (dukehealth.org). As Wellet adds non-Duke users
//   (UNC, WakeMed, Cone, Atrium, etc.), every hospital needs its own
//   "Tier 2.5" adapter that knows how that hospital's public Find-a-
//   Doctor pages are structured. This file defines the contract every
//   adapter must satisfy and the registry that maps a hospital to its
//   adapter.
//
// What this file is NOT:
//   - It does NOT scrape or fetch anything itself. Adapters do that.
//   - It does NOT touch FHIR endpoints. That's fetch-ehr-data's job.
//   - It does NOT bypass NPPES; NPPES remains the federal Tier 3
//     fallback inside enrich-practitioner.
//
// Adding a new hospital is two steps:
//   1. Implement HospitalDirectoryAdapter for the new hospital
//      (e.g. enrich-practitioner/adapters/unc.ts).
//   2. Register it in the HOSPITAL_DIRECTORY_REGISTRY array below.
//
// Future:
//   When the registry has 3+ adapters we'll likely move the config rows
//   to a Supabase table (hospital_directory_config) so adding a hospital
//   doesn't require an edge function deploy. For now, a TypeScript const
//   keeps the blast radius zero.

import type { EnrichInput, EnrichedContact } from "./practitioner-types.ts";

export type HospitalDirectoryAdapter = {
  // Stable id for logging/telemetry (e.g. "duke", "unc").
  id: string;

  // Human-readable provenance string. Shown verbatim in the Wellet UI
  // as "Phone: ... · from <display_name>". Use the patient-friendly
  // name (e.g. "Duke Health"), not the legal entity.
  display_name: string;

  // FHIR base URL host(s) this adapter serves. Used by the router when
  // the caller provides hint_fhir_domain. Always lowercase, no port,
  // no path. A single hospital can have multiple endpoints (e.g.
  // Kaiser regional brands all share fhir.kp.org).
  fhir_domains: string[];

  // Substrings (lowercased) that, if present in EnrichInput.hint_org,
  // route to this adapter. Keep these specific to avoid collisions
  // (e.g. "duke" matches Duke but would collide with "duke street
  // medical" — accept the risk for now; adapters fail-soft on miss).
  hint_org_keywords: string[];

  // Public homepage of the directory. Used for diagnostics and as a
  // fallback source_url if the adapter's lookup somehow returns a
  // contact without a per-provider URL.
  directory_homepage: string;

  // Cache key prefix this adapter uses when stamping lookup_key on
  // results that don't have an NPI yet. The router uses this to build
  // tentative cache keys before any network call. Duke uses "duke";
  // future adapters should use a short stable id matching their
  // adapter id (e.g. "unc", "wakemed"). Empty string means "this
  // adapter doesn't pre-NPI cache, only NPI-keyed cache".
  cache_key_prefix: string;

  // Build the tentative cache keys (sans "npi:" — that's handled
  // generically by the router) for a given input. Returning multiple
  // keys lets the adapter probe likely credential variants without
  // committing the router to know about credentials. Order matters:
  // most-likely first.
  tentativeCacheKeys: (input: EnrichInput) => string[];

  // The actual lookup. Returns null when the adapter cannot find the
  // provider in this hospital's directory. Returns an EnrichedContact
  // (with confidence = "high") when it finds clean structured data.
  // MUST set source_name and source_url on the returned object.
  // MUST NOT throw on network errors — return null instead so the
  // caller can fall through to NPPES.
  lookup: (input: EnrichInput) => Promise<EnrichedContact | null>;
};

// Registry is mutable at module-init time only. Adapters register
// themselves by being imported and pushed into this array. We avoid a
// global side-effect import pattern to keep the dependency graph
// explicit — see enrich-practitioner/adapters/index.ts which does the
// composition.
const REGISTRY: HospitalDirectoryAdapter[] = [];

export function registerAdapter(adapter: HospitalDirectoryAdapter): void {
  // Refuse silent duplicates — they almost always indicate a bug.
  if (REGISTRY.some((a) => a.id === adapter.id)) {
    throw new Error(
      `hospital-directory-registry: adapter id "${adapter.id}" already registered`,
    );
  }
  REGISTRY.push(adapter);
}

export function listAdapters(): readonly HospitalDirectoryAdapter[] {
  return REGISTRY;
}

// Pick which adapters to try, in order, for a given input. The router
// is intentionally conservative: it only returns adapters whose FHIR
// domain or org-hint matches. If nothing matches, callers should fall
// straight through to NPPES rather than hammering every adapter.
//
// Match precedence:
//   1. hint_fhir_domain exact match (most reliable — comes from the
//      ehr_connections row that produced the practitioner).
//   2. hint_org keyword substring match.
//   3. (no fallback — if neither matched, we don't know who this
//      provider is, so don't guess.)
export function selectAdaptersFor(input: EnrichInput): HospitalDirectoryAdapter[] {
  const matches: HospitalDirectoryAdapter[] = [];
  const seen = new Set<string>();

  const fhir = (input.hint_fhir_domain || "").trim().toLowerCase();
  if (fhir) {
    for (const a of REGISTRY) {
      if (a.fhir_domains.some((d) => d.toLowerCase() === fhir)) {
        if (!seen.has(a.id)) {
          matches.push(a);
          seen.add(a.id);
        }
      }
    }
  }

  const hint = (input.hint_org || "").toLowerCase();
  if (hint) {
    for (const a of REGISTRY) {
      if (a.hint_org_keywords.some((k) => hint.includes(k))) {
        if (!seen.has(a.id)) {
          matches.push(a);
          seen.add(a.id);
        }
      }
    }
  }

  return matches;
}

// Build the ordered list of cache keys to probe for an input, given
// the adapters that match. Always probes "npi:<npi>" first (because
// that's the strongest cross-source identifier), then each matching
// adapter's tentative keys in registration order.
export function tentativeCacheKeysFor(input: EnrichInput): string[] {
  const keys: string[] = [];
  if (input.npi) keys.push(`npi:${input.npi}`);
  for (const a of selectAdaptersFor(input)) {
    for (const k of a.tentativeCacheKeys(input)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

// Run the selected adapters in order, returning the first hit. Any
// adapter that throws is caught and logged so a single broken adapter
// can never poison the whole pipeline.
export async function runDirectoryLookup(
  input: EnrichInput,
): Promise<EnrichedContact | null> {
  const adapters = selectAdaptersFor(input);
  for (const a of adapters) {
    try {
      const hit = await a.lookup(input);
      if (hit) return hit;
    } catch (err) {
      // Soft-fail: log to stderr and try the next adapter (or fall
      // through to NPPES). We never want a directory adapter bug to
      // 500 a Care Team card.
      console.error(`[hospital-directory] adapter ${a.id} threw:`, err);
    }
  }
  return null;
}
