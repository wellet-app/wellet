// Local test for wellet-health-ingest v12 sample keys. In-memory Supabase.
import { assertEquals } from 'jsr:@std/assert@1';

const SB = 'http://sb.local';
Deno.env.set('SUPABASE_URL', SB);
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
const USER = '11111111-1111-1111-1111-111111111111';
const SELF = '44444444-4444-4444-4444-444444444444';
type Row = Record<string, any>;
let obs: Row[] = [];
let upserts = 0;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.origin !== SB) return realFetch(input, init);
  if (url.pathname === '/auth/v1/user') return json({ id: USER, aud: 'authenticated' });
  if (url.pathname === '/rest/v1/people') {
    if (req.method === 'GET') return json({ id: SELF });
    return new Response(null, { status: 204 });
  }
  if (url.pathname === '/rest/v1/wearable_observations' && req.method === 'POST') {
    upserts++;
    const cols = (url.searchParams.get('on_conflict') || '').split(',');
    assertEquals(cols, ['person_id', 'source', 'sample_key']);
    const body: Row[] = await req.json();
    const k = (r: Row) => cols.map((c) => r[c]).join('§');
    const seen = new Set<string>();
    for (const r of body) {
      if (seen.has(k(r))) return json({ code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' }, 500);
      seen.add(k(r));
    }
    for (const r of body) {
      const i = obs.findIndex((o) => k(o) === k(r));
      if (i >= 0) obs[i] = { ...obs[i], ...r }; else obs.push({ ...r });
    }
    return new Response(null, { status: 201 });
  }
  return json({ error: 'unexpected ' + req.method + ' ' + url.pathname }, 500);
};

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
const mod = await import('../../supabase/functions/wellet-health-ingest/index.ts');

async function send(batches: Row) {
  const res = await handler(new Request('https://fn.local/wellet-health-ingest', { method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify({ source: 'ios-healthkit', client_version: 't', batches }) }));
  return { status: res.status, body: await res.json() };
}
const STEPS = 'HKQuantityTypeIdentifierStepCount';
const at = (s: string, e: string, value: number, source: string, uuid?: string) => ({ start: s, end: e, value, unit: 'count', source, ...(uuid ? { uuid } : {}) });

Deno.test('iPhone and Apple Watch samples with the same start are both kept', async () => {
  obs = [];
  const r = await send({ [STEPS]: [
    at('2026-10-21T14:00:00Z', '2026-10-21T14:10:00Z', 400, 'iPhone'),
    at('2026-10-21T14:00:00Z', '2026-10-21T14:10:00Z', 380, 'Apple Watch'),
  ] });
  assertEquals(r.status, 200);
  assertEquals(obs.length, 2);
});

Deno.test('two samples with the same start but different UUIDs are both kept', async () => {
  obs = [];
  await send({ [STEPS]: [
    at('2026-10-21T14:00:00Z', '2026-10-21T14:05:00Z', 100, 'iPhone', 'aaaaaaaa-0000-0000-0000-000000000001'),
    at('2026-10-21T14:00:00Z', '2026-10-21T14:05:00Z', 120, 'iPhone', 'aaaaaaaa-0000-0000-0000-000000000002'),
  ] });
  assertEquals(obs.length, 2);
  assertEquals(obs[0].sample_key, 'hk|AAAAAAAA-0000-0000-0000-000000000001');
});

Deno.test('re-sending the same snapshot updates rows, no copies', async () => {
  obs = [];
  const batch = { [STEPS]: [at('2026-10-21T14:00:00Z', '2026-10-21T14:10:00Z', 400, 'iPhone')] };
  await send(batch); await send(batch);
  assertEquals(obs.length, 1);
});

Deno.test('an exact repeat inside one payload no longer fails the chunk', async () => {
  obs = []; upserts = 0;
  const s = at('2026-10-21T14:00:00Z', '2026-10-21T14:10:00Z', 400, 'iPhone');
  const r = await send({ [STEPS]: [s, { ...s, value: 401 }] });
  assertEquals(r.status, 200);
  assertEquals(obs.length, 1);
  assertEquals(obs[0].value, 401);
});

Deno.test('unreadable start time is skipped, not fatal', async () => {
  obs = [];
  const r = await send({ [STEPS]: [at('not a date', '', 1, 'iPhone'), at('2026-10-21T15:00:00Z', '2026-10-21T15:01:00Z', 2, 'iPhone')] });
  assertEquals(r.status, 200);
  assertEquals(r.body.skipped, 1);
  assertEquals(obs.length, 1);
});

Deno.test('fallback key matches the SQL backfill format', () => {
  const k = mod.sampleKey(STEPS, at('2026-05-11T16:00:00.123456Z', '2026-05-11T16:10:00Z', 1, 'Apple Watch'));
  assertEquals(k, `v1|${STEPS}|${Date.UTC(2026, 4, 11, 16, 0, 0, 123)}|${Date.UTC(2026, 4, 11, 16, 10)}|Apple Watch`);
  assertEquals(mod.sampleKey(STEPS, { start: '2026-05-11T16:00:00Z', end: '', value: 1, unit: 'count', source: null }), `v1|${STEPS}|${Date.UTC(2026, 4, 11, 16)}||`);
  assertEquals(mod.sampleKey(STEPS, { ...at('2026-05-11T16:00:00Z', '', 1, 'x'), uuid: 'not-a-uuid' })!.startsWith('v1|'), true);
});

Deno.test('more than one chunk of 500', async () => {
  obs = []; upserts = 0;
  const many = Array.from({ length: 1203 }, (_, i) => at(new Date(Date.UTC(2026, 9, 1) + i * 60000).toISOString(), '', i, 'iPhone'));
  const r = await send({ [STEPS]: many });
  assertEquals(r.body.ingested, 1203);
  assertEquals(upserts, 3);
  assertEquals(obs.length, 1203);
});
