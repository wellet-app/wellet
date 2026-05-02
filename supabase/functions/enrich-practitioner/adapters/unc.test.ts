// Unit tests for the UNC Yext-backed adapter.
//
// All HTTP is intercepted via a swapped global fetch — these tests
// never hit liveapi.yext.com so they're stable in CI. The 10 fixtures
// below cover:
//   1.  Full match: unique name + full contact data → high confidence
//   2.  Full match with a hyphenated last name (Smith-Jones)
//   3.  Full match with apostrophe (O'Brien)
//   4.  Full match with non-MD credential (PA-C)
//   5.  Full match where input is "first_name+last_name" (no display name)
//   6.  Partial match: same last name, multiple firsts → ambiguous,
//       picks the one with most contact data, drops to medium
//   7.  First-initial match ("J Smith" matches "Jane Smith")
//   8.  No name match at all in the result set → returns first provider,
//       low/medium confidence
//   9.  Yext returns 0 results → null
//  10.  Yext returns errors[] (e.g. invalid params) → null gracefully

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { uncAdapter, buildEnrichedContact, __test } from "./unc.ts";

// ── Fixture builders ─────────────────────────────────────────────────

type MinimalProvider = {
  name: string;
  firstName: string;
  lastName: string;
  mainPhone?: string;
  fax?: string;
  address?: { line1: string; city: string; region: string; postalCode: string };
  c_answersSpecialty?: Array<{ name: string }>;
  c_aemPage?: string;
  c_aemContentType?: string;
  c_aemAsset?: { defaultImgSrc: string };
};

function fixtureResponse(providers: MinimalProvider[]) {
  return {
    meta: { errors: [] },
    response: {
      resultsCount: providers.length,
      results: providers.map((p) => ({ data: p })),
    },
  };
}

function errorResponse(message: string) {
  return {
    meta: { errors: [{ code: 9411, message }] },
    response: {},
  };
}

function withMockFetch(
  responseBody: unknown,
  status: number,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = ((_input: unknown, _init?: unknown) => {
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

// ── Tests ─────────────────────────────────────────────────────────────

Deno.test("1. unique full match returns high confidence with full contact data", async () => {
  const provider: MinimalProvider = {
    name: "Michele Smith, PA-C",
    firstName: "Michele",
    lastName: "Smith",
    mainPhone: "+18286942350",
    fax: "+18286942351",
    address: { line1: "2695 Hendersonville Road", city: "Arden", region: "NC", postalCode: "28704" },
    c_answersSpecialty: [{ name: "Urgent Care" }],
    c_aemPage: "/care-services/doctors/s/michele-smith-pa-c",
    c_aemContentType: "Provider",
    c_aemAsset: { defaultImgSrc: "https://a.mktgcdn.com/p/abc/332x415.jpg" },
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Michele Smith, PA-C" });
    assert(out, "expected enrichment result");
    assertEquals(out!.confidence, "high");
    assertEquals(out!.phones, ["828-694-2350"]);
    assertEquals(out!.fax, "828-694-2351");
    assertEquals(out!.specialty, "Urgent Care");
    assertEquals(out!.addresses.length, 1);
    assertEquals(out!.addresses[0].state, "NC");
    assertEquals(out!.source_name, "UNC Health");
    assertEquals(out!.source_url, "https://www.unchealth.org/care-services/doctors/s/michele-smith-pa-c");
    assertEquals(out!.lookup_key, "unc:michele-smith");
    assertEquals(out!.npi, undefined);
    assertEquals(out!.photo_url, "https://a.mktgcdn.com/p/abc/332x415.jpg");
  });
});

Deno.test("2. hyphenated last name slugs and matches correctly", async () => {
  const provider: MinimalProvider = {
    name: "Jane Smith-Jones, MD",
    firstName: "Jane",
    lastName: "Smith-Jones",
    mainPhone: "+19195551234",
    address: { line1: "101 Manning Dr", city: "Chapel Hill", region: "NC", postalCode: "27514" },
    c_answersSpecialty: [{ name: "Family Medicine" }],
    c_aemPage: "/care-services/doctors/s/jane-smith-jones-md",
    c_aemContentType: "Provider",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Jane Smith-Jones, MD" });
    assert(out);
    assertEquals(out!.confidence, "high");
    assertEquals(out!.lookup_key, "unc:jane-smith-jones");
  });
});

Deno.test("3. apostrophe in last name (O'Brien) is stripped in slug", async () => {
  const provider: MinimalProvider = {
    name: "Patrick O'Brien, MD",
    firstName: "Patrick",
    lastName: "O'Brien",
    mainPhone: "+19195556789",
    address: { line1: "100 Clinic Rd", city: "Raleigh", region: "NC", postalCode: "27607" },
    c_aemPage: "/care-services/doctors/o/patrick-obrien-md",
    c_aemContentType: "Provider",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Patrick O'Brien, MD" });
    assert(out);
    assertEquals(out!.lookup_key, "unc:patrick-obrien");
  });
});

Deno.test("4. PA-C credential parses and matches", async () => {
  const provider: MinimalProvider = {
    name: "Alex Chen, PA-C",
    firstName: "Alex",
    lastName: "Chen",
    mainPhone: "+19195550000",
    address: { line1: "200 Mason Farm Rd", city: "Chapel Hill", region: "NC", postalCode: "27599" },
    c_aemPage: "/care-services/doctors/c/alex-chen-pa-c",
    c_aemContentType: "Provider",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Alex Chen, PA-C" });
    assert(out);
    assertEquals(out!.confidence, "high");
    assertEquals(out!.phones, ["919-555-0000"]);
  });
});

Deno.test("5. first_name + last_name input (no display name) works", async () => {
  const provider: MinimalProvider = {
    name: "Sarah Wong, MD",
    firstName: "Sarah",
    lastName: "Wong",
    mainPhone: "+19195551111",
    address: { line1: "300 Manning Dr", city: "Chapel Hill", region: "NC", postalCode: "27514" },
    c_aemPage: "/care-services/doctors/w/sarah-wong-md",
    c_aemContentType: "Provider",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "", first_name: "Sarah", last_name: "Wong" });
    assert(out);
    assertEquals(out!.lookup_key, "unc:sarah-wong");
  });
});

Deno.test("6. ambiguous match: multiple Smiths, picks one with most contact, drops to medium", async () => {
  const providers: MinimalProvider[] = [
    {
      name: "Jane Smith, MD",
      firstName: "Jane",
      lastName: "Smith",
      // No phone, no fax, no address — minimal record
      c_aemPage: "/care-services/doctors/s/jane-smith-md",
      c_aemContentType: "Provider",
    },
    {
      name: "Jane Smith, MD",
      firstName: "Jane",
      lastName: "Smith",
      mainPhone: "+19195552222",
      fax: "+19195552223",
      address: { line1: "400 Manning Dr", city: "Chapel Hill", region: "NC", postalCode: "27514" },
      c_aemPage: "/care-services/doctors/s/jane-smith-md-2",
      c_aemContentType: "Provider",
    },
  ];
  await withMockFetch(fixtureResponse(providers), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Jane Smith, MD" });
    assert(out);
    assertEquals(out!.confidence, "medium", "two name matches → not unique → medium");
    assertEquals(out!.phones, ["919-555-2222"], "should pick the one with contact data");
  });
});

Deno.test("7. first-initial match: 'J Smith' matches 'Jane Smith'", () => {
  const candidate = { firstName: "Jane", lastName: "Smith" };
  assert(__test.nameMatches(candidate, { first: "j", last: "smith" }));
  assert(!__test.nameMatches(candidate, { first: "k", last: "smith" }));
});

Deno.test("8. no name match in result set → returns first provider, never high", async () => {
  const providers: MinimalProvider[] = [
    {
      name: "Robert Lee, MD",
      firstName: "Robert",
      lastName: "Lee",
      mainPhone: "+19195553333",
      address: { line1: "500 Manning Dr", city: "Chapel Hill", region: "NC", postalCode: "27514" },
      c_aemPage: "/care-services/doctors/l/robert-lee-md",
      c_aemContentType: "Provider",
    },
  ];
  await withMockFetch(fixtureResponse(providers), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Carlos Hernandez, MD" });
    assert(out, "should still return something so cascade can use it");
    assert(out!.confidence !== "high", "must not claim high confidence on a non-match");
  });
});

Deno.test("9. zero results → null", async () => {
  await withMockFetch(fixtureResponse([]), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Nobody Here, MD" });
    assertEquals(out, null);
  });
});

Deno.test("10. Yext error response → null (no throw)", async () => {
  await withMockFetch(errorResponse("Invalid/missing parameters: verticalKey"), 200, async () => {
    const out = await uncAdapter.lookup({ name: "Jane Smith, MD" });
    assertEquals(out, null);
  });
});

// ── Pure-helper sanity checks (cheap, no fetch) ───────────────────────

Deno.test("buildSearchUrl uses correct API key, version, vertical, experience", () => {
  const url = __test.buildSearchUrl("Jane Smith");
  assert(url.startsWith("https://liveapi.yext.com/v2/accounts/me/search/vertical/query"));
  assert(url.includes("api_key=fcb2c208969a29f6bc66c93d5737793e"));
  assert(url.includes("v=20221201"));
  assert(url.includes("experienceKey=unch-aem-site-search"));
  assert(url.includes("verticalKey=aem_page"));
  assert(url.includes("input=Jane+Smith"));
});

Deno.test("normalizePhone handles E.164, dashed, and parens forms", () => {
  assertEquals(__test.normalizePhone("+18286942350"), "828-694-2350");
  assertEquals(__test.normalizePhone("(828) 694-2350"), "828-694-2350");
  assertEquals(__test.normalizePhone("8286942350"), "828-694-2350");
  assertEquals(__test.normalizePhone(undefined), undefined);
  assertEquals(__test.normalizePhone("12345"), undefined);
});

Deno.test("mapAddress returns undefined when all parts blank", () => {
  assertEquals(__test.mapAddress(undefined), undefined);
  assertEquals(__test.mapAddress({}), undefined);
  const out = __test.mapAddress({ line1: "1 Main St", city: "Durham", region: "NC", postalCode: "27710" });
  assertEquals(out?.street, "1 Main St");
  assertEquals(out?.state, "NC");
});

Deno.test("cacheKeyFor produces stable lowercase slug", () => {
  assertEquals(__test.cacheKeyFor({ first: "Jane", last: "Smith" }), "unc:jane-smith");
  assertEquals(__test.cacheKeyFor({ first: "Patrick", last: "O'Brien" }), "unc:patrick-obrien");
  assertEquals(__test.cacheKeyFor({ first: "", last: "" }), null);
});

Deno.test("tentativeCacheKeys returns the same key the lookup writes", () => {
  const keys = uncAdapter.tentativeCacheKeys({ name: "Michele Smith, PA-C" });
  assertEquals(keys, ["unc:michele-smith"]);
});

Deno.test("buildEnrichedContact: NPI is always undefined for UNC (Yext does not expose it)", () => {
  const contact = buildEnrichedContact(
    { name: "X Y", firstName: "X", lastName: "Y", mainPhone: "+19195550000", c_aemPage: "/p/y" },
    { confidence: "high", cacheKey: "unc:x-y" },
  );
  assertEquals(contact.npi, undefined);
  assertEquals(contact.source_name, "UNC Health");
  assertEquals(contact.source_url, "https://www.unchealth.org/p/y");
});
