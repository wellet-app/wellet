// Shared types for the practitioner enrichment pipeline.
//
// Lives in _shared so any edge function (enrich-practitioner today,
// future bulk-enrich job tomorrow) can import the same shapes without
// duplicating definitions.

export type Address = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  label?: string;
};

export type EnrichedContact = {
  found: boolean;
  lookup_key?: string;
  practitioner_ref?: string;
  name?: string;
  npi?: string;
  phones: string[];
  fax?: string;
  emails: string[];
  addresses: Address[];
  specialty?: string;
  bio?: string;
  photo_url?: string;
  // source_name is the human-readable provenance shown in the UI
  // ("Duke Health", "NPPES", "cache"). Adapters set their own.
  source_name?: string;
  source_url?: string;
  confidence?: "high" | "medium" | "low";
  cached?: boolean;
};

export type EnrichInput = {
  // At minimum we need a name. Everything else sharpens the match.
  name: string;               // full display name e.g. "Jaseela Illath, MD"
  first_name?: string;
  last_name?: string;
  npi?: string;               // if already known from anywhere
  practitioner_ref?: string;  // Epic "Practitioner/abc123"
  state?: string;             // 2-letter, biases NPPES matches
  hint_org?: string;          // e.g. "Duke" — picks the matching adapter first
  // hint_fhir_domain lets the caller pass the FHIR base URL's host so
  // the registry can route by Epic FHIR domain when hint_org is missing
  // (which is the common case for FHIR-derived practitioners).
  hint_fhir_domain?: string;
};
