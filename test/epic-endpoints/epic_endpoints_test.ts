// Local test for epic-endpoints `activated`. The fixture is a small slice
// of Epic's public R4 endpoint bundle (open.epic.com/Endpoints/R4).
import { assert, assertEquals } from 'jsr:@std/assert@1';

const fixture = JSON.parse(await Deno.readTextFile(new URL('./bundle_fixture.json', import.meta.url)));
let upstreamStatus = 200;
globalThis.fetch = async (input: any) => {
  const url = typeof input === 'string' ? input : input.url;
  assertEquals(url, 'https://open.epic.com/Endpoints/R4');
  return new Response(JSON.stringify(fixture), { status: upstreamStatus });
};

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
const mod = await import('../../supabase/functions/epic-endpoints/index.ts');

const call = async (init: RequestInit = {}, query = '') => {
  const res = await handler(new Request('https://fn.local/epic-endpoints' + query, init));
  return { status: res.status, body: await res.json() };
};
const post = (body: unknown) => call({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

Deno.test('default response is unchanged: every endpoint, raw names', async () => {
  const r = await call();
  assertEquals(r.status, 200);
  assertEquals(r.body.Activated, undefined);
  assertEquals(r.body.Entries.length, fixture.entry.length);
  assert(r.body.Entries.some((e: any) => e.OrganizationName === "Childrens's Healthcare of Atlanta"));
});

Deno.test('POST {activated:true} returns only activated hospitals, sorted', async () => {
  const r = await post({ activated: true });
  assertEquals(r.status, 200);
  assertEquals(r.body.Activated, true);
  const names = r.body.Entries.map((e: any) => e.OrganizationName);
  assertEquals(names, [...names].sort((a: string, b: string) => a.localeCompare(b)));
  assert(names.includes('Duke Health'));
  assert(names.includes('New York-Presbyterian'));
  assert(names.includes('Weill Cornell Medicine'));
  for (const e of r.body.Entries) assert(mod.ACTIVATED_FHIR_URLS.map(mod.normFhirUrl).includes(mod.normFhirUrl(e.FHIRPatientFacingURI)));
  assert(r.body.Entries.length < fixture.entry.length);
});

Deno.test('activated names fix the double possessive', async () => {
  const r = await post({ activated: true });
  const names = r.body.Entries.map((e: any) => e.OrganizationName);
  assert(names.includes("Children's Healthcare of Atlanta"));
  assert(!names.some((n: string) => n.includes("Childrens's")));
});

Deno.test('?activated=1 works for GET', async () => {
  const r = await call({}, '?activated=1');
  assertEquals(r.body.Activated, true);
});

Deno.test('POST without activated, or with a bad body, keeps the default', async () => {
  assertEquals((await post({})).body.Activated, undefined);
  const r = await call({ method: 'POST', body: 'not json' });
  assertEquals(r.status, 200);
  assertEquals(r.body.Activated, undefined);
});

Deno.test('allow-list matches wellet.js exactly', async () => {
  const js = await Deno.readTextFile(new URL('../../assets/wellet.js', import.meta.url));
  const blk = js.slice(js.indexOf('var ACTIVATED_FHIR_URLS = ['), js.indexOf('];', js.indexOf('var ACTIVATED_FHIR_URLS = [')));
  const web = [...blk.matchAll(/'(https:\/\/[^']+)'/g)].map((m) => m[1]);
  assertEquals(mod.ACTIVATED_FHIR_URLS, web);
});

Deno.test('upstream failure returns 502', async () => {
  upstreamStatus = 500;
  const r = await post({ activated: true });
  upstreamStatus = 200;
  assertEquals(r.status, 502);
});
