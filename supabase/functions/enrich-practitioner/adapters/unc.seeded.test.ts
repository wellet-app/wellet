// Unit tests for the seeded-table helpers in unc.ts.
//
// These tests cover the pure-logic surface added when we upgraded the
// UNC adapter to prefer the bulk-seeded public.unc_providers table:
//   - extractPractitionerBareId: parses "Practitioner/abc123" → "abc123"
//   - buildFromSeededRow: maps a unc_providers row → EnrichedContact
//   - cacheKeyForEpicId / cacheKeyForNpi
//
// No Supabase, no fetch — these are import-and-call tests.

import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  buildFromSeededRow,
  extractPractitionerBareId,
  __test,
} from "./unc.ts";

Deno.test("extractPractitionerBareId: Practitioner/abc123 → abc123", () => {
  assertEquals(extractPractitionerBareId("Practitioner/abc123"), "abc123");
});

Deno.test("extractPractitionerBareId: bare id passes through", () => {
  assertEquals(extractPractitionerBareId("e123-456"), "e123-456");
});

Deno.test("extractPractitionerBareId: undefined / empty → null", () => {
  assertEquals(extractPractitionerBareId(undefined), null);
  assertEquals(extractPractitionerBareId(""), null);
  assertEquals(extractPractitionerBareId("   "), null);
});

Deno.test("cacheKeyForEpicId / cacheKeyForNpi shapes", () => {
  assertEquals(__test.cacheKeyForEpicId("abc123"), "unc:epic:abc123");
  assertEquals(__test.cacheKeyForNpi("1234567890"), "npi:1234567890");
});

Deno.test(
  "buildFromSeededRow: high-confidence enrichment with NPI, phone, address, photo",
  () => {
    const row = {
      npi: "1234567890",
      c_epic_id: "PRACT-abc",
      name: "Jane Smith, MD",
      first_name: "Jane",
      last_name: "Smith",
      credentials: ["MD"],
      main_phone: "+19849745000",
      fax: "+19849745001",
      custom_email: null,
      address_line1: "101 Manning Drive",
      address_line2: null,
      address_city: "Chapel Hill",
      address_state: "NC",
      address_postal: "27514",
      headshot_url: "https://a.mktgcdn.com/p/xyz.jpg",
      primary_specialty: "Cardiology",
      org_unit_folder: "/cardiology",
    };
    const out = buildFromSeededRow(row, { cacheKey: "unc:epic:PRACT-abc" });

    assertEquals(out.found, true);
    assertEquals(out.npi, "1234567890");
    assertEquals(out.name, "Jane Smith, MD");
    assertEquals(out.phones, ["984-974-5000"]);
    assertEquals(out.fax, "984-974-5001");
    assertEquals(out.specialty, "Cardiology");
    assertEquals(out.photo_url, "https://a.mktgcdn.com/p/xyz.jpg");
    assertEquals(out.confidence, "high");
    assertEquals(out.source_name, "UNC Health");
    assertEquals(out.lookup_key, "unc:epic:PRACT-abc");
    assertEquals(out.addresses.length, 1);
    assertEquals(out.addresses[0].street, "101 Manning Drive");
    assertEquals(out.addresses[0].city, "Chapel Hill");
    assertEquals(out.addresses[0].state, "NC");
    assertEquals(out.addresses[0].zip, "27514");
  },
);

Deno.test(
  "buildFromSeededRow: row with no contact data still returns found=true high",
  () => {
    // Seeded rows are first-party UNC data, so the directory's confidence is
    // still high even when contact fields are sparse — the cascade does NOT
    // re-fall to NPPES once UNC has confirmed the provider exists.
    const row = {
      npi: "9999999999",
      c_epic_id: null,
      name: "Sparse Provider",
      first_name: "Sparse",
      last_name: "Provider",
      credentials: null,
      main_phone: null,
      fax: null,
      custom_email: null,
      address_line1: null,
      address_line2: null,
      address_city: null,
      address_state: null,
      address_postal: null,
      headshot_url: null,
      primary_specialty: null,
      org_unit_folder: null,
    };
    const out = buildFromSeededRow(row, { cacheKey: "npi:9999999999" });
    assertEquals(out.found, true);
    assertEquals(out.phones, []);
    assertEquals(out.addresses, []);
    assertEquals(out.confidence, "high");
    assert(out.source_name === "UNC Health");
  },
);

Deno.test(
  "buildFromSeededRow: line1 + line2 are joined with ', '",
  () => {
    const row = {
      npi: "1111111111",
      c_epic_id: null,
      name: "Test Doctor",
      first_name: "Test",
      last_name: "Doctor",
      credentials: ["MD"],
      main_phone: null,
      fax: null,
      custom_email: "test.doctor@unchealth.unc.edu",
      address_line1: "101 Manning Drive",
      address_line2: "Suite 200",
      address_city: "Chapel Hill",
      address_state: "NC",
      address_postal: "27514",
      headshot_url: null,
      primary_specialty: null,
      org_unit_folder: null,
    };
    const out = buildFromSeededRow(row, { cacheKey: "unc:test-doctor" });
    assertEquals(out.addresses[0].street, "101 Manning Drive, Suite 200");
    assertEquals(out.emails, ["test.doctor@unchealth.unc.edu"]);
  },
);
