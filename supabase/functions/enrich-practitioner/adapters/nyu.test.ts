// Unit tests for the NYU Langone directory adapter.
//
// HTTP is intercepted via a swapped global fetch — tests never hit
// nyulangone.org so they're stable in CI. The fixtures cover:
//   1.  Full match: real NYU profile HTML → high confidence with phones,
//       fax, address, specialty, photo_url.
//   2.  Missing NPI in input → adapter returns null (caller falls
//       through to NPPES which resolves name→NPI; next pass succeeds).
//   3.  Hard 404 on bare NPI URL → returns null.
//   4.  200 OK with no profile microdata (NYU's "We couldn't find that
//       provider" placeholder shape) → returns null.

import { assert, assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { nyuAdapter } from "./nyu.ts";

// ── Fixture HTML loader ───────────────────────────────────────────────

const REAL_CHO_THIN_HTML = await Deno.readTextFile(
  new URL("./__fixtures__/nyu_cho_thin.html", import.meta.url),
);

// ── Test scaffolding ─────────────────────────────────────────────────

type FetchMock = (url: string) => Response | Promise<Response>;

function withMockedFetch<T>(
  mock: FetchMock,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
    return Promise.resolve(mock(url));
  };
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

// ── Tests ────────────────────────────────────────────────────────────

Deno.test("nyu adapter: real NYU profile HTML returns high-confidence contact", async () => {
  const result = await withMockedFetch(
    (url: string) => {
      // The adapter requests the slugged URL first, then the bare NPI.
      // Both should land on the same fixture in the happy path.
      assert(
        url.startsWith("https://nyulangone.org/doctors/1134459597"),
        `unexpected fetch URL: ${url}`,
      );
      return new Response(REAL_CHO_THIN_HTML, { status: 200 });
    },
    () =>
      nyuAdapter.lookup({
        name: "Cho C. Thin, MD",
        first_name: "Cho",
        last_name: "Thin",
        npi: "1134459597",
        hint_fhir_domain: "epicfhir.nyumc.org",
      }),
  );

  assert(result !== null, "expected NYU adapter to return a contact");
  assertEquals(result!.found, true);
  assertEquals(result!.confidence, "high");
  assertEquals(result!.source_name, "NYU Langone Health");
  assertEquals(result!.lookup_key, "npi:1134459597");
  assertEquals(result!.npi, "1134459597");
  assertEquals(result!.name, "Cho C. Thin, MD");
  assertEquals(result!.specialty, "Family Medicine");
  // The provider page lists at least one clinic phone + NYU's global
  // 855 scheduling number. Order matters less than non-empty.
  assert(result!.phones.length >= 1, "expected at least one phone");
  assert(
    result!.phones.includes("718-907-8100"),
    `expected Brooklyn clinic phone in phones=${JSON.stringify(result!.phones)}`,
  );
  assert(result!.fax !== undefined, "expected a fax number");
  assertEquals(result!.fax, "646-754-7573");
  assert(result!.addresses.length >= 1, "expected at least one address");
  const addr = result!.addresses[0];
  assertEquals(addr.city, "Brooklyn");
  assertEquals(addr.state, "NY");
  assertEquals(addr.zip, "11220");
  assert(
    addr.label?.includes("Park Ridge"),
    `expected location label to include "Park Ridge": ${addr.label}`,
  );
  assert(
    result!.photo_url?.endsWith("cho-c-thin-square.jpg"),
    `expected square headshot, got ${result!.photo_url}`,
  );
  assert(
    result!.source_url?.includes("/doctors/1134459597/cho-c-thin"),
    `expected canonical URL with NPI + slug, got ${result!.source_url}`,
  );
});

Deno.test("nyu adapter: no NPI in input → returns null (NPPES will fill the gap)", async () => {
  // No fetch should fire at all when NPI is absent.
  let fetchCalled = false;
  const result = await withMockedFetch(
    () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    },
    () =>
      nyuAdapter.lookup({
        name: "Cho C. Thin, MD",
        first_name: "Cho",
        last_name: "Thin",
        // npi intentionally missing
        hint_fhir_domain: "epicfhir.nyumc.org",
      }),
  );
  assertEquals(result, null);
  assertEquals(fetchCalled, false);
});

Deno.test("nyu adapter: invalid NPI format → returns null", async () => {
  let fetchCalled = false;
  const result = await withMockedFetch(
    () => {
      fetchCalled = true;
      return new Response("", { status: 200 });
    },
    () =>
      nyuAdapter.lookup({
        name: "Cho C. Thin, MD",
        npi: "not-a-real-npi",
        hint_fhir_domain: "epicfhir.nyumc.org",
      }),
  );
  assertEquals(result, null);
  assertEquals(fetchCalled, false);
});

Deno.test("nyu adapter: hard 404 on all candidate URLs → returns null", async () => {
  const result = await withMockedFetch(
    () => new Response("Not Found", { status: 404 }),
    () =>
      nyuAdapter.lookup({
        name: "Imaginary Doctor",
        first_name: "Imaginary",
        last_name: "Doctor",
        npi: "9999999999",
        hint_fhir_domain: "epicfhir.nyumc.org",
      }),
  );
  assertEquals(result, null);
});

Deno.test("nyu adapter: 200 OK with no profile microdata → returns null", async () => {
  const result = await withMockedFetch(
    () =>
      new Response(
        "<html><body><h1>We couldn't find that provider</h1></body></html>",
        { status: 200 },
      ),
    () =>
      nyuAdapter.lookup({
        name: "Imaginary Doctor",
        first_name: "Imaginary",
        last_name: "Doctor",
        npi: "9999999999",
        hint_fhir_domain: "epicfhir.nyumc.org",
      }),
  );
  assertEquals(result, null);
});

Deno.test("nyu adapter registry metadata is correct", () => {
  assertEquals(nyuAdapter.id, "nyu");
  assertEquals(nyuAdapter.display_name, "NYU Langone Health");
  assert(nyuAdapter.fhir_domains.includes("epicfhir.nyumc.org"));
  assertEquals(nyuAdapter.cache_key_prefix, "");
  assertEquals(nyuAdapter.tentativeCacheKeys({ name: "x" }), []);
});
