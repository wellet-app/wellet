// Unit tests for the hospital directory registry. Validates:
//   1. selectAdaptersFor routes by FHIR domain (highest precedence)
//   2. selectAdaptersFor routes by hint_org keyword (fallback)
//   3. selectAdaptersFor returns nothing when neither matches
//   4. tentativeCacheKeysFor builds NPI key first, then adapter slugs
//   5. runDirectoryLookup returns first non-null hit
//   6. runDirectoryLookup soft-fails when an adapter throws
//   7. registerAdapter rejects duplicate IDs

import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";

import type {
  EnrichInput,
  EnrichedContact,
} from "./practitioner-types.ts";

// Deno's module cache makes the registry singleton across tests in
// the same file. Tests use distinct adapter ids and assert on
// specific outcomes rather than reaching into REGISTRY.

import {
  registerAdapter,
  selectAdaptersFor,
  tentativeCacheKeysFor,
  runDirectoryLookup,
  type HospitalDirectoryAdapter,
} from "./hospital-directory-registry.ts";

function makeAdapter(
  id: string,
  overrides: Partial<HospitalDirectoryAdapter> = {},
): HospitalDirectoryAdapter {
  return {
    id,
    display_name: id,
    fhir_domains: [`${id}.example.com`],
    hint_org_keywords: [id],
    directory_homepage: `https://${id}.example.com`,
    cache_key_prefix: id,
    tentativeCacheKeys: (input: EnrichInput) =>
      input.last_name ? [`${id}:${input.last_name.toLowerCase()}`] : [],
    lookup: async (_input: EnrichInput) => null,
    ...overrides,
  };
}

// ── Register fixture adapters once ────────────────────────────────────
// All test adapter ids are prefixed "test_" so they can never collide
// with real adapters that the composition root might also register
// when this test file imports its dependencies.

const fhirAdapter = makeAdapter("test_fhirhospital");
const orgAdapter = makeAdapter("test_orghospital", {
  fhir_domains: [],
  hint_org_keywords: ["acme medical"],
});
const hitAdapter = makeAdapter("test_hithospital", {
  fhir_domains: ["hit.example.com"],
  hint_org_keywords: ["hit"],
  lookup: async (_input) =>
    ({
      found: true,
      lookup_key: "test:hit",
      phones: ["555-0100"],
      emails: [],
      addresses: [],
      source_name: "test_hithospital",
      source_url: "https://hit.example.com",
      confidence: "high",
    } satisfies EnrichedContact),
});
const throwingAdapter = makeAdapter("test_brokenhospital", {
  fhir_domains: ["broken.example.com"],
  hint_org_keywords: ["broken"],
  lookup: async () => {
    throw new Error("intentional test failure");
  },
});

registerAdapter(fhirAdapter);
registerAdapter(orgAdapter);
registerAdapter(hitAdapter);
registerAdapter(throwingAdapter);

// ── Tests ─────────────────────────────────────────────────────────────

Deno.test("selectAdaptersFor routes by FHIR domain (case-insensitive)", () => {
  const matches = selectAdaptersFor({
    name: "Jane Smith MD",
    hint_fhir_domain: "TEST_FHIRHOSPITAL.EXAMPLE.COM",
  });
  assertEquals(matches.map((a) => a.id), ["test_fhirhospital"]);
});

Deno.test("selectAdaptersFor routes by hint_org substring", () => {
  const matches = selectAdaptersFor({
    name: "Jane Smith MD",
    hint_org: "Acme Medical Group",
  });
  assertEquals(matches.map((a) => a.id), ["test_orghospital"]);
});

Deno.test("selectAdaptersFor returns empty when nothing matches", () => {
  const matches = selectAdaptersFor({
    name: "Jane Smith MD",
    hint_org: "unknown hospital",
    hint_fhir_domain: "unknown.example.com",
  });
  assertEquals(matches, []);
});

Deno.test("tentativeCacheKeysFor: NPI first, then adapter slugs", () => {
  const keys = tentativeCacheKeysFor({
    name: "Jane Smith MD",
    last_name: "Smith",
    npi: "1234567890",
    hint_fhir_domain: "test_fhirhospital.example.com",
  });
  assertEquals(keys, ["npi:1234567890", "test_fhirhospital:smith"]);
});

Deno.test("tentativeCacheKeysFor: no NPI, no matching adapter -> empty", () => {
  const keys = tentativeCacheKeysFor({
    name: "Jane Smith MD",
    last_name: "Smith",
    hint_org: "unknown hospital",
  });
  assertEquals(keys, []);
});

Deno.test("runDirectoryLookup returns the first non-null hit", async () => {
  const result = await runDirectoryLookup({
    name: "Jane Smith MD",
    hint_fhir_domain: "hit.example.com",
  });
  assertEquals(result?.found, true);
  assertEquals(result?.source_name, "test_hithospital");
});

Deno.test("runDirectoryLookup soft-fails when an adapter throws", async () => {
  // broken adapter throws; result should be null (caller falls through to NPPES)
  const result = await runDirectoryLookup({
    name: "Jane Smith MD",
    hint_fhir_domain: "broken.example.com",
  });
  assertEquals(result, null);
});

Deno.test("registerAdapter rejects duplicate ids", () => {
  assertThrows(
    () => registerAdapter(makeAdapter("test_fhirhospital")),
    Error,
    'adapter id "test_fhirhospital" already registered',
  );
});
