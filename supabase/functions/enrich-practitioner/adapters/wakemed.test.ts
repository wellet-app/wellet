// Unit tests for the WakeMed Mercury DXE-backed adapter.
//
// All HTTP is intercepted via a swapped global fetch — these tests
// never hit www.wakemed.org so they're stable in CI. The 10 fixtures
// below cover:
//   1.  Full match: unique name + NPI + phone → high confidence
//   2.  Full match with a hyphenated last name (Smith-Jones)
//   3.  Full match with apostrophe (O'Brien)
//   4.  Full match with non-MD credential (PA-C)
//   5.  Full match where input is "first_name+last_name" (no display name)
//   6.  Ambiguous match: two Smiths, picks one with NPI, drops to medium
//   7.  First-initial match ("J Smith" matches "Jane Smith")
//   8.  No name match in result set → returns first provider, never high
//   9.  Zero items → null
//  10.  Trailing-space given name ("Logan ") still matches "logan"

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { wakemedAdapter, buildEnrichedContact, __test } from "./wakemed.ts";

// ── Fixture builders ─────────────────────────────────────────────────

type MinimalProvider = {
  nid?: number;
  title?: string;
  name?: { given?: string; family?: string; credentials?: string };
  npi?: number;
  phone_number?: string;
  images?: Array<{ url: string; alt?: string }>;
  url?: string;
};

function fixtureResponse(providers: MinimalProvider[]) {
  return {
    items: providers,
    paging: { totalCount: providers.length, count: providers.length },
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

Deno.test("1. unique full match with NPI + phone returns high confidence", async () => {
  const provider: MinimalProvider = {
    nid: 8443,
    title: "Logan Smith, MD",
    name: { given: "Logan ", family: "Smith", credentials: "MD" },
    npi: 1235799024,
    phone_number: "919-782-5400",
    images: [{ url: "https://www.wakemed.org/sites/default/files/default-male.jpg" }],
    url: "https://www.wakemed.org/provider/logan-smith-md",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Logan Smith, MD" });
    assert(out, "expected enrichment result");
    assertEquals(out!.confidence, "high");
    assertEquals(out!.phones, ["919-782-5400"]);
    assertEquals(out!.npi, "1235799024");
    assertEquals(out!.name, "Logan Smith, MD");
    assertEquals(out!.source_name, "WakeMed");
    assertEquals(out!.source_url, "https://www.wakemed.org/provider/logan-smith-md");
    assertEquals(out!.lookup_key, "wakemed:logan-smith");
    assertEquals(out!.photo_url, "https://www.wakemed.org/sites/default/files/default-male.jpg");
    // Fax and addresses live on linked location records — adapter doesn't fetch.
    assertEquals(out!.fax, undefined);
    assertEquals(out!.addresses, []);
  });
});

Deno.test("2. hyphenated last name slugs and matches correctly", async () => {
  const provider: MinimalProvider = {
    title: "Jane Smith-Jones, MD",
    name: { given: "Jane", family: "Smith-Jones", credentials: "MD" },
    npi: 1111111111,
    phone_number: "919-555-1234",
    url: "https://www.wakemed.org/provider/jane-smith-jones-md",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Jane Smith-Jones, MD" });
    assert(out);
    assertEquals(out!.confidence, "high");
    assertEquals(out!.lookup_key, "wakemed:jane-smith-jones");
  });
});

Deno.test("3. apostrophe in last name (O'Brien) is stripped in slug", async () => {
  const provider: MinimalProvider = {
    title: "Patrick O'Brien, MD",
    name: { given: "Patrick", family: "O'Brien", credentials: "MD" },
    npi: 2222222222,
    phone_number: "919-555-6789",
    url: "https://www.wakemed.org/provider/patrick-obrien-md",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Patrick O'Brien, MD" });
    assert(out);
    assertEquals(out!.lookup_key, "wakemed:patrick-obrien");
  });
});

Deno.test("4. PA-C credential parses and matches", async () => {
  const provider: MinimalProvider = {
    title: "Alex Chen, PA-C",
    name: { given: "Alex", family: "Chen", credentials: "PA-C" },
    npi: 3333333333,
    phone_number: "919-555-0000",
    url: "https://www.wakemed.org/provider/alex-chen-pa-c",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Alex Chen, PA-C" });
    assert(out);
    assertEquals(out!.confidence, "high");
    assertEquals(out!.phones, ["919-555-0000"]);
    assertEquals(out!.npi, "3333333333");
  });
});

Deno.test("5. first_name + last_name input (no display name) works", async () => {
  const provider: MinimalProvider = {
    title: "Sarah Wong, MD",
    name: { given: "Sarah", family: "Wong", credentials: "MD" },
    npi: 4444444444,
    phone_number: "919-555-1111",
    url: "https://www.wakemed.org/provider/sarah-wong-md",
  };
  await withMockFetch(fixtureResponse([provider]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "", first_name: "Sarah", last_name: "Wong" });
    assert(out);
    assertEquals(out!.lookup_key, "wakemed:sarah-wong");
  });
});

Deno.test("6. ambiguous match: two Smiths, picks one with NPI, drops to medium", async () => {
  const providers: MinimalProvider[] = [
    {
      title: "Jane Smith, MD",
      name: { given: "Jane", family: "Smith", credentials: "MD" },
      // No NPI, no phone — minimal record
      url: "https://www.wakemed.org/provider/jane-smith-md",
    },
    {
      title: "Jane Smith, MD",
      name: { given: "Jane", family: "Smith", credentials: "MD" },
      npi: 5555555555,
      phone_number: "919-555-2222",
      url: "https://www.wakemed.org/provider/jane-smith-md-2",
    },
  ];
  await withMockFetch(fixtureResponse(providers), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Jane Smith, MD" });
    assert(out);
    assertEquals(out!.confidence, "medium", "two name matches → not unique → medium");
    assertEquals(out!.npi, "5555555555", "should pick the one with NPI");
    assertEquals(out!.phones, ["919-555-2222"]);
  });
});

Deno.test("7. first-initial match: 'J Smith' matches 'Jane Smith'", () => {
  const candidate = { name: { given: "Jane", family: "Smith" } };
  assert(__test.nameMatches(candidate, { first: "j", last: "smith" }));
  assert(!__test.nameMatches(candidate, { first: "k", last: "smith" }));
});

Deno.test("8. no name match in result set → returns first provider, never high", async () => {
  const providers: MinimalProvider[] = [
    {
      title: "Robert Lee, MD",
      name: { given: "Robert", family: "Lee", credentials: "MD" },
      npi: 6666666666,
      phone_number: "919-555-3333",
      url: "https://www.wakemed.org/provider/robert-lee-md",
    },
  ];
  await withMockFetch(fixtureResponse(providers), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Carlos Hernandez, MD" });
    assert(out, "should still return something so cascade can use it");
    assert(out!.confidence !== "high", "must not claim high confidence on a non-match");
  });
});

Deno.test("9. zero items → null", async () => {
  await withMockFetch(fixtureResponse([]), 200, async () => {
    const out = await wakemedAdapter.lookup({ name: "Nobody Here, MD" });
    assertEquals(out, null);
  });
});

Deno.test("10. DXE-style trailing space in given name still matches", () => {
  // The recon confirmed DXE returns "given": "Logan " with a trailing
  // space. Our nameMatches must trim before comparing.
  const candidate = { name: { given: "Logan ", family: "Smith" } };
  assert(__test.nameMatches(candidate, { first: "logan", last: "smith" }));
});

// ── Pure-helper sanity checks (cheap, no fetch) ───────────────────────

Deno.test("buildSearchUrl uses Mercury DXE base + required params", () => {
  const url = __test.buildSearchUrl("Jane Smith");
  assert(url.startsWith("https://www.wakemed.org/hgwf-api/v1/records/providers"));
  assert(url.includes("q=Jane+Smith"));
  assert(url.includes("limit=10"));
  assert(url.includes("offset=0"));
  // URLSearchParams encodes the | as %7C
  assert(url.includes("filter=show_in_search%3D1%7Cstatus%3D1"));
  assert(url.includes("sortBy=order"));
});

Deno.test("normalizePhone handles dashed, E.164, parens, and integer forms", () => {
  assertEquals(__test.normalizePhone("919-782-5400"), "919-782-5400");
  assertEquals(__test.normalizePhone("+19197825400"), "919-782-5400");
  assertEquals(__test.normalizePhone("(919) 782-5400"), "919-782-5400");
  assertEquals(__test.normalizePhone("9197825400"), "919-782-5400");
  assertEquals(__test.normalizePhone(undefined), undefined);
  assertEquals(__test.normalizePhone("12345"), undefined);
});

Deno.test("normalizeNpi requires exactly 10 digits", () => {
  assertEquals(__test.normalizeNpi(1235799024), "1235799024");
  assertEquals(__test.normalizeNpi("1235799024"), "1235799024");
  assertEquals(__test.normalizeNpi("123"), undefined);
  assertEquals(__test.normalizeNpi(undefined), undefined);
});

Deno.test("cacheKeyFor produces stable lowercase slug", () => {
  assertEquals(__test.cacheKeyFor({ first: "Jane", last: "Smith" }), "wakemed:jane-smith");
  assertEquals(__test.cacheKeyFor({ first: "Patrick", last: "O'Brien" }), "wakemed:patrick-obrien");
  assertEquals(__test.cacheKeyFor({ first: "", last: "" }), null);
});

Deno.test("tentativeCacheKeys returns the same key the lookup writes", () => {
  const keys = wakemedAdapter.tentativeCacheKeys({ name: "Logan Smith, MD" });
  assertEquals(keys, ["wakemed:logan-smith"]);
});

Deno.test("buildEnrichedContact: NPI is normalized to a 10-digit string", () => {
  const contact = buildEnrichedContact(
    {
      title: "X Y, MD",
      name: { given: "X", family: "Y", credentials: "MD" },
      npi: 1234567890,
      phone_number: "919-555-0000",
      url: "https://www.wakemed.org/provider/x-y-md",
    },
    { confidence: "high", cacheKey: "wakemed:x-y" },
  );
  assertEquals(contact.npi, "1234567890");
  assertEquals(contact.source_name, "WakeMed");
  assertEquals(contact.source_url, "https://www.wakemed.org/provider/x-y-md");
  assertEquals(contact.phones, ["919-555-0000"]);
});

Deno.test("buildEnrichedContact: missing url falls back to directory homepage", () => {
  const contact = buildEnrichedContact(
    { title: "Z W, MD", name: { given: "Z", family: "W", credentials: "MD" } },
    { confidence: "low", cacheKey: "wakemed:z-w" },
  );
  assertEquals(contact.source_url, "https://www.wakemed.org/providers");
});
