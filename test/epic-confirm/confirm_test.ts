// Local flow test for epic-auth confirm step. Mocks Supabase REST/auth and the
// Epic token + FHIR endpoints in memory. No network.
import { assertEquals, assert } from 'jsr:@std/assert@1';

const SB = 'http://sb.local';
Deno.env.set('SUPABASE_URL', SB);
Deno.env.set('SUPABASE_ANON_KEY', 'anon');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'service');
Deno.env.set('EHR_ENCRYPTION_KEY', 'k');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1,0,1]), hash: 'SHA-384' }, true, ['sign','verify']);
const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
const pem = '-----BEGIN PRIVATE KEY-----\n' + btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n') + '\n-----END PRIVATE KEY-----';
Deno.env.set('EPIC_JWT_PRIVATE_KEY_PROD', pem);
Deno.env.set('EPIC_JWT_PRIVATE_KEY_NONPROD', pem);

const FHIR = 'https://fhir.hospital.test/api/FHIR/R4';
const TOKEN_URL = 'https://fhir.hospital.test/oauth2/token';
const USER = '11111111-1111-1111-1111-111111111111';
const MOM = '22222222-2222-2222-2222-222222222222';
const DAD = '33333333-3333-3333-3333-333333333333';

type Row = Record<string, any>;
let db: Record<string, Row[]> = {};
let patient: Row = {};
let tokenPatient: string | null = 'pat-1';
const logs: string[] = [];

function reset(momDob: string | null) {
  db = {
    people: [
      { id: MOM, user_id: USER, date_of_birth: momDob, manual_date_of_birth: null },
      { id: DAD, user_id: USER, date_of_birth: null, manual_date_of_birth: null },
    ],
    ehr_connections: [],
  };
  patient = { resourceType: 'Patient', id: 'pat-1', name: [{ use: 'official', given: ['Ann'], family: 'Sample' }], birthDate: '1948-03-14' };
  tokenPatient = 'pat-1';
}
function pending(id: string, person = MOM) {
  db.ehr_connections.push({ id, user_id: USER, person_id: person, status: 'pending', state: 'st-' + id, code_verifier: 'cv', fhir_base_url: FHIR, token_url: TOKEN_URL, hospital_name: 'Sample Health', provider: 'epic', patient_id: null, access_token: null, refresh_token: null, token_expires_at: null });
}

function applyFilters(rows: Row[], params: URLSearchParams) {
  let out = rows;
  for (const [k, v] of params) {
    if (['select', 'limit', 'order'].includes(k)) continue;
    if (v.startsWith('eq.')) out = out.filter((r) => String(r[k]) === v.slice(3));
    else if (v.startsWith('neq.')) out = out.filter((r) => String(r[k]) !== v.slice(4));
    else if (v === 'is.null') out = out.filter((r) => r[k] === null || r[k] === undefined);
  }
  const lim = params.get('limit');
  return lim ? out.slice(0, Number(lim)) : out;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: any, init?: any) => {
  const req = input instanceof Request ? input : new Request(input, init);
  const url = new URL(req.url);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'Content-Type': 'application/json' } });
  if (url.origin === SB) {
    if (url.pathname === '/auth/v1/user') return json({ id: USER, aud: 'authenticated', email: 'x@example.com' });
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      const fn = url.pathname.split('/').pop();
      const b = await req.json();
      if (fn === 'encrypt_ehr_token') return json('enc:' + b.plain_token);
      if (fn === 'decrypt_ehr_token') return json(String(b.encrypted_token).replace(/^enc:/, ''));
      return json(null);
    }
    const table = url.pathname.replace('/rest/v1/', '');
    db[table] ||= [];
    const rows = applyFilters(db[table], url.searchParams);
    const wantsObj = (req.headers.get('Accept') || '').includes('vnd.pgrst.object');
    if (req.method === 'GET') {
      if (wantsObj) return rows.length === 1 ? json(rows[0]) : json({ code: 'PGRST116', message: 'no rows', details: 'The result contains 0 rows' }, 406);
      return json(rows);
    }
    if (req.method === 'PATCH') {
      const patch = await req.json();
      if (table === 'ehr_connections' && patch.status === 'connected') {
        for (const r of rows) {
          const clash = db.ehr_connections.find((o) => o !== r && o.status === 'connected' && o.person_id === r.person_id && o.fhir_base_url === r.fhir_base_url);
          if (clash) return json({ code: '23505', message: 'duplicate key value violates unique constraint "idx_ehr_connections_person_fhir_connected"' }, 409);
        }
      }
      rows.forEach((r) => Object.assign(r, patch));
      return (req.headers.get('Prefer') || '').includes('representation') ? json(rows) : new Response(null, { status: 204 });
    }
    if (req.method === 'POST') { const b = await req.json(); (Array.isArray(b) ? b : [b]).forEach((x) => db[table].push(x)); return new Response(null, { status: 201 }); }
    if (req.method === 'DELETE') { db[table] = db[table].filter((r) => !rows.includes(r)); return new Response(null, { status: 204 }); }
  }
  if (req.url === TOKEN_URL) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'offline_access patient/Patient.read', patient: tokenPatient });
  if (url.href.startsWith(FHIR + '/Patient/')) {
    assertEquals(req.headers.get('Authorization'), 'Bearer AT');
    return json(patient);
  }
  return realFetch(input, init);
};
const origLog = console.log, origWarn = console.warn;
console.log = (...a: unknown[]) => logs.push(JSON.stringify(a));
console.warn = (...a: unknown[]) => logs.push(JSON.stringify(a));

let handler: (r: Request) => Promise<Response>;
(Deno as any).serve = (h: any) => { handler = h; return {} as any; };
await import('../../supabase/functions/epic-auth/index.ts');

async function call(body: Row) {
  const res = await handler(new Request('https://fn.local/epic-auth', { method: 'POST', headers: { Authorization: 'Bearer user-jwt', 'Content-Type': 'application/json', Origin: 'https://mywellet.com' }, body: JSON.stringify(body) }));
  return { status: res.status, body: await res.json() };
}
const conn = (id: string) => db.ehr_connections.find((r) => r.id === id)!;

Deno.test('no birth date in Wellet: callback pauses, shows name and birth month, nothing connected', async () => {
  reset(null); pending('c1');
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.status, 200);
  assertEquals(r.body.needs_confirm, true);
  assertEquals(r.body.connection_id, 'c1');
  assertEquals(r.body.patient, { name: 'Ann Sample', birth_month: '1948-03' });
  assertEquals(conn('c1').status, 'awaiting_confirm');
  assertEquals(conn('c1').access_token, 'enc:AT');
  assertEquals(conn('c1').state, null);
  assert(!JSON.stringify(conn('c1')).includes('Ann'), 'name must not be written to the row');
  assert(!logs.join('').includes('Ann') && !logs.join('').includes('1948'), 'name and birth date must not be logged');
});

Deno.test('yes: connects, saves the hospital birth date, supersedes the prior row', async () => {
  reset(null);
  db.ehr_connections.push({ id: 'old', user_id: USER, person_id: MOM, status: 'connected', fhir_base_url: FHIR, access_token: 'enc:OLD', refresh_token: 'enc:OLDR' });
  pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(conn('old').status, 'connected', 'prior row untouched while paused');
  const r = await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'yes' });
  assertEquals(r.status, 200);
  assertEquals(r.body.confirmed, true);
  assertEquals(r.body.birth_date_saved, true);
  assertEquals(conn('c1').status, 'connected');
  assertEquals(conn('old').status, 'superseded');
  assertEquals(conn('old').access_token, null);
  assertEquals(db.people.find((p) => p.id === MOM)!.date_of_birth, '1948-03-14');
  assertEquals(db.people.find((p) => p.id === MOM)!.date_of_birth_source, 'ehr_confirm:c1');
});

Deno.test('no: tokens cleared, row closed, birth date not saved', async () => {
  reset(null); pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  const r = await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'no' });
  assertEquals(r.body.declined, true);
  assertEquals(conn('c1').status, 'patient_mismatch');
  assertEquals(conn('c1').access_token, null);
  assertEquals(conn('c1').refresh_token, null);
  assertEquals(db.people.find((p) => p.id === MOM)!.date_of_birth, null);
});

Deno.test('expired pause: 410 and tokens cleared', async () => {
  reset(null); pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  conn('c1').token_expires_at = new Date(Date.now() - 1000).toISOString();
  const r = await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'yes' });
  assertEquals(r.status, 410);
  assertEquals(conn('c1').status, 'abandoned');
  assertEquals(conn('c1').access_token, null);
});

Deno.test('confirm cannot target another person or a non-paused row', async () => {
  reset(null); pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals((await call({ action: 'confirm_patient', connection_id: 'c1', person_id: DAD, answer: 'yes' })).status, 404);
  assertEquals((await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'maybe' })).status, 400);
  conn('c1').user_id = 'someone-else';
  assertEquals((await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'yes' })).status, 404);
});

Deno.test('yes is re-checked: same patient connected to another person in the meantime', async () => {
  reset(null); pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  db.ehr_connections.push({ id: 'dad', user_id: USER, person_id: DAD, status: 'connected', fhir_base_url: FHIR, patient_id: 'pat-1' });
  const r = await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'yes' });
  assertEquals(r.status, 409);
  assertEquals(conn('c1').status, 'patient_mismatch');
  assertEquals(conn('c1').access_token, null);
});

Deno.test('existing birth date never overwritten on yes', async () => {
  reset(null); pending('c1');
  await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  db.people.find((p) => p.id === MOM)!.manual_date_of_birth = '1948-03-14';
  const r = await call({ action: 'confirm_patient', connection_id: 'c1', person_id: MOM, answer: 'yes' });
  assertEquals(r.body.birth_date_saved, false);
  assertEquals(db.people.find((p) => p.id === MOM)!.date_of_birth, null);
});

Deno.test('birth date on file and it matches: connects directly, no pause (unchanged)', async () => {
  reset('1948-03-14'); pending('c1');
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.status, 200);
  assertEquals(r.body.success, true);
  assertEquals(r.body.needs_confirm, undefined);
  assertEquals(conn('c1').status, 'connected');
});

Deno.test('birth date on file and it differs: blocked 409 (unchanged)', async () => {
  reset('1975-06-01'); pending('c1');
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.status, 409);
  assertEquals(r.body.error, 'patient_mismatch');
  assertEquals(conn('c1').access_token, null);
});

Deno.test('same patient already on another person: blocked 409 before any pause (unchanged)', async () => {
  reset(null);
  db.ehr_connections.push({ id: 'dad', user_id: USER, person_id: DAD, status: 'connected', fhir_base_url: FHIR, patient_id: 'pat-1' });
  pending('c1');
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.status, 409);
  assertEquals(conn('c1').status, 'patient_mismatch');
});

Deno.test('Patient read fails with no birth date: still pauses, name unknown', async () => {
  reset(null); pending('c1');
  patient = { resourceType: 'OperationOutcome' };
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.body.needs_confirm, true);
  assertEquals(r.body.patient, { name: null, birth_month: null });
});

Deno.test('no patient in token response: pauses', async () => {
  reset(null); pending('c1'); tokenPatient = null;
  const r = await call({ action: 'callback', code: 'x', state: 'st-c1', person_id: MOM });
  assertEquals(r.body.needs_confirm, true);
  assertEquals(conn('c1').status, 'awaiting_confirm');
});
