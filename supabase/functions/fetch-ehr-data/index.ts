// Supabase Edge Function: fetch-ehr-data (v41 — Observation.component[] parsing: Epic returns BP, BMI panels, and other multi-value vitals as a single Observation with valueQuantity-bearing components. v40 only read top-level valueQuantity, which is why Mom's chart had 200 observations but 0 vitals persisted — every BP reading was dropped. v41 walks component[] when present, projects each component to its own Wellet observation row keyed by its component LOINC, so 8480-6/8462-4 land as systolic/diastolic in vitals. Panel-style observations without a top-level value AND without components fall through to the existing valueString / valueCodeableConcept paths.)
// Fetches FHIR R4 resources from the connected EHR provider (Epic),
// maps them to a simplified Wellet-friendly JSON structure,
// returns the data to the frontend, AND upserts into medications /
// allergies / health_events / lab_results / vitals so that downstream
// features (Emergency Summary, Update Me, Care Team enrichment) have real
// rows to read. Previously through v38 the function returned JSON without
// writing, which made Emergency Summary show "None reported" for every
// section even when Duke returned 200+ resources.
//
// v23 CHANGE: when the stored access_token is expired, use the stored
// refresh_token (from the `offline_access` scope) to silently mint a new
// access_token via the provider's /token endpoint, re-encrypt both tokens,
// update ehr_connections, and continue the fetch. Only force a reconnect
// if the provider rejects the refresh. Previously (v22) we early-returned
// 401 on any expired access_token, which broke all pulls after ~1 hour.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { persistEhrData } from '../_shared/ehr-persist.ts';

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return null;

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) return null;
  return user;
}

// ── Epic confidential client config (must match epic-auth) ──────────────────
// Confidential clients authenticate to Epic's token endpoint using a signed
// `client_assertion` JWT (RFC 7523) instead of a client_secret. The matching
// public keys are published at mywellet.com/.well-known/jwks-{prod,nonprod}.json.
// Connections minted by the legacy public client (a00e2e38…) still refresh
// with just client_id; everything else uses client_assertion.
const EPIC_PROD_CLIENT_ID = 'e550b8b1-8a3f-4f56-99e9-4870a616d5ab';
const EPIC_NONPROD_CLIENT_ID = '6307e012-4778-40ed-bd24-c042b932312e';
const EPIC_LEGACY_PUBLIC_CLIENT_ID = 'a00e2e38-f814-4946-9b7c-a92901a8aebc';
const EPIC_PROD_KID = 'wellet-prod-2026-04';
const EPIC_NONPROD_KID = 'wellet-nonprod-2026-04';
const EPIC_SANDBOX_FHIR_BASE = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

// PKCS#8 PEM → CryptoKey for RS384 signing. Same import path as epic-auth.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemBody = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!pemBody) throw new Error('Empty private key PEM');
  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
    false,
    ['sign'],
  );
}

async function loadPrivateKey(pemEnv: string): Promise<CryptoKey> {
  const pem = Deno.env.get(pemEnv) || '';
  if (!pem) throw new Error(`Missing Supabase secret: ${pemEnv}`);
  return await importPrivateKey(pem);
}

// Build a signed client_assertion JWT for refresh.
// jti must be unique per request — Epic rejects replays.
// exp ≤ 5 min — Epic requires this.
async function buildClientAssertion(
  tokenUrl: string,
  clientId: string,
  kid: string,
  privateKey: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS384', typ: 'JWT', kid };
  const payload = {
    iss: clientId,
    sub: clientId,
    aud: tokenUrl,
    jti: crypto.randomUUID(),
    iat: now,
    exp: now + 300,
    nbf: now,
  };
  const signingInput = `${base64UrlEncodeString(JSON.stringify(header))}.${base64UrlEncodeString(JSON.stringify(payload))}`;
  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function resolveClientCreds(isSandboxOrNonProd: boolean): {
  clientId: string;
  kid: string;
  pemEnv: string;
} {
  if (isSandboxOrNonProd) {
    return { clientId: EPIC_NONPROD_CLIENT_ID, kid: EPIC_NONPROD_KID, pemEnv: 'EPIC_JWT_PRIVATE_KEY_NONPROD' };
  }
  return { clientId: EPIC_PROD_CLIENT_ID, kid: EPIC_PROD_KID, pemEnv: 'EPIC_JWT_PRIVATE_KEY_PROD' };
}

// Per-resource telemetry captured during a fetch. Each connection maintains
// its own local telemetry array (see fetchAndPersistOneConnection) so that
// parallel fan-out calls never interleave their diagnostic data.
// The module-level vars are kept as no-op fallbacks for any call paths
// that were not yet ported — they are reset to [] at request start and
// never read in the new fan-out path.
type FhirCallTelemetry = {
  resourceType: string;
  query: string;
  first_status: number | null;
  pages: number;
  bundle_total: number | null;
  entries_returned: number;
  operation_outcomes: string[]; // short diagnostic strings from OperationOutcome entries
  error_body_snippet: string | null; // up to 200 chars of error response body when !res.ok
};
let currentFhirTelemetry: FhirCallTelemetry[] = [];

// Per-practitioner diagnostic capture for ONE-SHOT debugging of why Care Team
// contact info is empty. For each practitioner we read, record: Practitioner
// HTTP status, whether Practitioner.telecom was populated, PractitionerRole
// search HTTP status, PractitionerRole entry count, and whether any role had
// a non-empty telecom array. This bypasses the summarization in roleExtras so
// we can see exactly what Duke is returning on the wire.
type PractitionerTelemetry = {
  ref: string;
  pract_status: number | null;
  pract_telecom_count: number;
  pract_telecom_sample: string | null; // first telecom system:value seen (or null)
  role_status: number | null;
  role_entry_count: number;
  role_telecom_counts: number[]; // telecom.length for each role entry
  role_first_telecom_sample: string | null;
  role_location_display_sample: string | null;
};
let currentPractitionerTelemetry: PractitionerTelemetry[] = [];

// ── ConnectionResult ──────────────────────────────────────────────────────────
// Shape returned by fetchAndPersistOneConnection for each ehr_connections row.
// The main handler merges these into a backward-compatible flat response AND
// exposes the raw array under `connections` for frontend code that reads the
// new Phase 2 shape (_phase2: true).
type ConnectionResult = {
  connection_id: string;
  hospital_name: string | null;
  fhir_base_url: string;
  patient_id: string | null;
  status: 'ok' | 'token_refresh_failed' | 'fetch_error';
  error?: string;
  patient: Record<string, unknown> | null;
  conditions: unknown[];
  medications: unknown[];
  allergies: unknown[];
  observations: unknown[];
  immunizations: unknown[];
  diagnostic_reports: unknown[];
  visits: unknown[];
  care_team: unknown[];
  synced_at: string;
  result_counts: {
    conditions: number;
    medications: number;
    allergies: number;
    observations: number;
    immunizations: number;
    diagnostic_reports: number;
    visits: number;
    appointments?: number;
    care_team: number;
  };
  persisted: {
    medications: number;
    allergies: number;
    health_events: number;
    lab_results: number;
    vitals: number;
    errors: string[];
  };
  fhir_calls: FhirCallTelemetry[];
  practitioner_calls: PractitionerTelemetry[];
  duration_ms: number;
  provider: string;
  connected_provider: string | null;
};

// Fetch a FHIR resource type from the EHR's FHIR endpoint, handling pagination.
// The optional `tele` array accumulates per-call diagnostic records for this
// connection; pass a connection-local array so parallel fan-out calls never
// share a telemetry bucket (race condition in the old module-level approach).
async function fetchFhirResource(
  fhirBaseUrl: string,
  resourceType: string,
  accessToken: string,
  queryParams?: string,
  tele: FhirCallTelemetry[] = currentFhirTelemetry,
): Promise<unknown[]> {
  const entries: unknown[] = [];
  const query = queryParams ? `&${queryParams}` : '';
  let url: string | null = `${fhirBaseUrl}/${resourceType}?_count=50${query}`;

  const callTele: FhirCallTelemetry = {
    resourceType,
    query: queryParams || '',
    first_status: null,
    pages: 0,
    bundle_total: null,
    entries_returned: 0,
    operation_outcomes: [],
    error_body_snippet: null,
  };

  while (url && entries.length < 200) {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });

    if (callTele.first_status === null) callTele.first_status = res.status;

    if (!res.ok) {
      // Capture a short snippet of the error body to distinguish 403 scope
      // denials from 404 missing endpoints from 400 malformed queries.
      try {
        const body = await res.text();
        callTele.error_body_snippet = body.slice(0, 200);
      } catch (_e) { /* ignore */ }
      console.error(`FHIR fetch ${resourceType} failed: ${res.status}`);
      break;
    }

    // v34: wrap bundle parsing + telemetry in its own try/catch so a malformed
    // OperationOutcome or unexpected shape from Duke can't take down the
    // whole request. v33 was returning 500s on the first fetch after reconnect
    // — almost certainly from a narrow edge case in this block.
    try {
      const bundle = await res.json() as Record<string, unknown>;
      callTele.pages += 1;
      const totalVal = bundle.total;
      if (totalVal !== undefined && callTele.bundle_total === null && typeof totalVal === 'number') {
        callTele.bundle_total = totalVal;
      }
      const entryArr = Array.isArray(bundle.entry) ? bundle.entry as Record<string, unknown>[] : [];
      for (const e of entryArr) {
        const resource = e && typeof e === 'object' ? (e.resource as Record<string, unknown> | undefined) : undefined;
        if (!resource) continue;
        if (resource.resourceType === 'OperationOutcome') {
          const issuesRaw = resource.issue;
          const issues = Array.isArray(issuesRaw) ? issuesRaw as Record<string, unknown>[] : [];
          for (const issue of issues) {
            if (!issue || typeof issue !== 'object') continue;
            const diagnostics = typeof issue.diagnostics === 'string' ? issue.diagnostics : '';
            const detailsObj = (typeof issue.details === 'object' && issue.details) ? issue.details as Record<string, unknown> : null;
            const detailsText = detailsObj && typeof detailsObj.text === 'string' ? detailsObj.text : '';
            const code = typeof issue.code === 'string' ? issue.code : '';
            const diag = diagnostics || detailsText || code || '';
            if (diag && callTele.operation_outcomes.length < 5) {
              callTele.operation_outcomes.push(diag.slice(0, 200));
            }
          }
          continue;
        }
        entries.push(resource);
      }

      // Follow next page link
      url = null;
      const linkRaw = bundle.link;
      if (Array.isArray(linkRaw)) {
        const nextLink = (linkRaw as Record<string, unknown>[]).find((l) => l && (l as { relation?: string }).relation === 'next') as { url?: string } | undefined;
        if (nextLink && typeof nextLink.url === 'string') url = nextLink.url;
      }
    } catch (parseErr) {
      console.error(`FHIR parse ${resourceType} threw`, (parseErr as Error).message);
      callTele.error_body_snippet = `parse_error: ${(parseErr as Error).message}`.slice(0, 200);
      break;
    }
  }

  callTele.entries_returned = entries.length;
  tele.push(callTele);
  return entries;
}

// Fetch a single FHIR resource by reference (e.g. "Practitioner/abc123")
// When reference starts with "Practitioner/", also records diagnostic
// telemetry for the Care Team contact info debugging pass.
// The optional `practTele` array is the connection-local practitioner
// telemetry bucket — same isolation strategy as fetchFhirResource.
async function fetchFhirById(
  fhirBaseUrl: string,
  reference: string,
  accessToken: string,
  practTele: PractitionerTelemetry[] = currentPractitionerTelemetry,
): Promise<Record<string, unknown> | null> {
  const isPractitioner = reference.startsWith('Practitioner/');
  let tele: PractitionerTelemetry | null = null;
  if (isPractitioner) {
    tele = {
      ref: reference,
      pract_status: null,
      pract_telecom_count: 0,
      pract_telecom_sample: null,
      role_status: null,
      role_entry_count: 0,
      role_telecom_counts: [],
      role_first_telecom_sample: null,
      role_location_display_sample: null,
    };
    practTele.push(tele);
  }
  try {
    const res = await fetch(`${fhirBaseUrl}/${reference}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });
    if (tele) tele.pract_status = res.status;
    if (!res.ok) return null;
    const json = await res.json() as Record<string, unknown>;
    if (tele) {
      const tel = Array.isArray(json.telecom) ? json.telecom as Record<string, unknown>[] : [];
      tele.pract_telecom_count = tel.length;
      if (tel.length > 0) {
        const first = tel[0];
        tele.pract_telecom_sample = `${(first.system as string) || '?'}:${(first.value as string) || '?'}`.slice(0, 80);
      }
    }
    return json;
  } catch (_e) {
    return null;
  }
}

// Fetch PractitionerRole resources for a given practitioner id.
// In Epic FHIR R4, contact info (phone/email/fax), specialty, and the
// practice address live on PractitionerRole — NOT on Practitioner.telecom.
// Returns the raw Bundle.entry array (zero or more roles), or [] on failure.
// The optional `practTele` array is the connection-local bucket — reads from
// it to find the matching row already pushed by fetchFhirById.
async function fetchPractitionerRoles(
  fhirBaseUrl: string,
  practitionerId: string,
  accessToken: string,
  practTele: PractitionerTelemetry[] = currentPractitionerTelemetry,
): Promise<Record<string, unknown>[]> {
  // Find the matching Practitioner telemetry row (was pushed by fetchFhirById)
  const tele = practTele.find((t) => t.ref === `Practitioner/${practitionerId}`) || null;
  try {
    const url = `${fhirBaseUrl}/PractitionerRole?practitioner=${encodeURIComponent(practitionerId)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });
    if (tele) tele.role_status = res.status;
    if (!res.ok) return [];
    const bundle = await res.json() as Record<string, unknown>;
    const entries = (bundle.entry as Record<string, unknown>[]) || [];
    const roles = entries.map((e) => (e.resource as Record<string, unknown>) || {}).filter((r) => r && r.resourceType === 'PractitionerRole');
    if (tele) {
      tele.role_entry_count = roles.length;
      for (const r of roles) {
        const tel = Array.isArray(r.telecom) ? r.telecom as Record<string, unknown>[] : [];
        tele.role_telecom_counts.push(tel.length);
        if (!tele.role_first_telecom_sample && tel.length > 0) {
          const first = tel[0];
          tele.role_first_telecom_sample = `${(first.system as string) || '?'}:${(first.value as string) || '?'}`.slice(0, 80);
        }
        if (!tele.role_location_display_sample) {
          const locs = Array.isArray(r.location) ? r.location as Record<string, unknown>[] : [];
          const firstLoc = locs[0];
          if (firstLoc && typeof firstLoc.display === 'string') {
            tele.role_location_display_sample = (firstLoc.display as string).slice(0, 120);
          }
        }
      }
    }
    return roles;
  } catch (_e) {
    return [];
  }
}

// Given a set of PractitionerRole resources for one practitioner, extract
// merged phones / emails / fax / specialty / address. Used to backfill when
// the Practitioner resource itself has nothing useful.
//
// For address, Epic FHIR R4 typically surfaces the practice address via
// PractitionerRole.location[].display (text like "Duke Internal Medicine —
// Duke Clinic 1L, 40 Duke Medicine Circle, Durham, NC 27710"). The full
// structured address lives on the linked Location resource, but the display
// string is usually good enough for the Care Team UI without another hop.
function extractFromPractitionerRoles(roles: Record<string, unknown>[]) {
  const phones: string[] = [];
  const emails: string[] = [];
  let fax = '';
  let specialty = '';
  let address = '';
  let organization = '';
  for (const role of roles) {
    const telecom = (role.telecom as Record<string, unknown>[]) || [];
    for (const t of telecom) {
      const system = (t.system as string) || '';
      const value = (t.value as string) || '';
      if (!value) continue;
      if (system === 'phone' && !phones.includes(value)) phones.push(value);
      else if (system === 'email' && !emails.includes(value)) emails.push(value);
      else if (system === 'fax' && !fax) fax = value;
    }
    if (!specialty) {
      const specialtyArr = (role.specialty as Record<string, unknown>[]) || [];
      for (const s of specialtyArr) {
        const coding = (s.coding as Record<string, unknown>[]) || [];
        const display = (s.text as string) || (coding[0]?.display as string) || '';
        if (display) { specialty = display; break; }
      }
    }
    if (!specialty) {
      const codeArr = (role.code as Record<string, unknown>[]) || [];
      for (const c of codeArr) {
        const coding = (c.coding as Record<string, unknown>[]) || [];
        const display = (c.text as string) || (coding[0]?.display as string) || '';
        if (display) { specialty = display; break; }
      }
    }
    // Address fallback: location[].display (practice location name/address line)
    if (!address) {
      const locations = (role.location as Record<string, unknown>[]) || [];
      for (const loc of locations) {
        const display = (loc.display as string) || '';
        if (display) { address = display; break; }
      }
    }
    // Organization name — useful when practice name is more recognizable than
    // the individual practitioner's address (e.g. "Duke Internal Medicine").
    if (!organization) {
      const org = (role.organization as Record<string, unknown>) || {};
      const display = (org.display as string) || '';
      if (display) organization = display;
    }
  }
  return { phones, emails, fax, specialty, address, organization };
}

// ── FHIR → Wellet Mappers ──

// Pull a FHIR Encounter id off a resource that carries an `encounter` reference.
// Most resources use `r.encounter.reference` (Observation, MedicationRequest,
// Condition, DiagnosticReport, Procedure). A few — DocumentReference,
// ServiceRequest — bury it under `r.context.encounter`. Returns the id (no
// resource prefix) so it joins cleanly against Encounter.id.
function encounterIdFromResource(r: Record<string, unknown>): string {
  const direct = (r.encounter as Record<string, unknown>) || null;
  let ref = (direct?.reference as string) || '';
  if (!ref) {
    const ctx = (r.context as Record<string, unknown>) || {};
    const encRaw = ctx.encounter;
    if (Array.isArray(encRaw)) {
      ref = (((encRaw as Record<string, unknown>[])[0] || {}).reference as string) || '';
    } else if (encRaw && typeof encRaw === 'object') {
      ref = ((encRaw as Record<string, unknown>).reference as string) || '';
    }
  }
  return ref.startsWith('Encounter/') ? ref.slice('Encounter/'.length) : '';
}

function mapConditions(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    return {
      type: 'condition',
      source: 'ehr',
      name: ((r.code as Record<string, unknown>)?.text as string) || (firstCoding.display as string) || 'Unknown condition',
      code: (firstCoding.code as string) || '',
      system: (firstCoding.system as string) || '',
      status: (((r.clinicalStatus as Record<string, unknown>)?.coding as Record<string, unknown>[] | undefined)?.[0]?.code as string) || (r.clinicalStatus as string) || '',
      onset_date: r.onsetDateTime || (r.onsetPeriod as Record<string, unknown>)?.start || '',
      recorded_date: r.recordedDate || '',
      encounter_ref: encounterIdFromResource(r),
    };
  });
}

// Map MedicationRequest resources and dedup by normalized medication name.
// Keeps the most recently authored order for each unique medication.
function mapMedications(resources: unknown[]) {
  const mapped = (resources as Record<string, unknown>[]).map((r) => {
    const medCode = (r.medicationCodeableConcept as Record<string, unknown>) || {};
    const medRef = (r.medicationReference as Record<string, unknown>) || {};
    const coding = (medCode.coding as Record<string, unknown>[]) || [];
    const firstCoding = coding[0] || {};
    const dosage = (r.dosageInstruction as Record<string, unknown>[]) || (r.dosage as Record<string, unknown>[]) || [];
    const firstDosage = dosage[0] || {};
    const timing = (firstDosage.timing as Record<string, unknown>) || {};
    const repeat = (timing.repeat as Record<string, unknown>) || {};

    const medName = (medCode.text as string) || (medRef.display as string) || (firstCoding.display as string) || 'Unknown medication';

    // Prescriber reference (e.g. "Practitioner/abc") — used to build Care team
    const requester = (r.requester as Record<string, unknown>) || {};
    const prescriberRef = (requester.reference as string) || '';
    const prescriberName = (requester.display as string) || '';

    return {
      type: 'medication',
      source: 'ehr',
      name: medName,
      code: firstCoding.code || '',
      status: r.status || '',
      dosage: (firstDosage.text as string) || '',
      frequency: repeat.frequency ? `${repeat.frequency}x per ${repeat.period || ''} ${repeat.periodUnit || ''}`.trim() : '',
      date_asserted: r.dateAsserted || r.authoredOn || '',
      prescriber_ref: prescriberRef,
      prescriber_name: prescriberName,
      encounter_ref: encounterIdFromResource(r),
    };
  });

  // Dedup: key by lowercased, trimmed medication name; keep most recent date_asserted
  const byName = new Map<string, typeof mapped[number]>();
  for (const m of mapped) {
    const key = (m.name || '').toLowerCase().trim();
    if (!key) continue;
    const existing = byName.get(key);
    if (!existing) {
      byName.set(key, m);
      continue;
    }
    const existingDate = existing.date_asserted ? new Date(existing.date_asserted as string).getTime() : 0;
    const newDate = m.date_asserted ? new Date(m.date_asserted as string).getTime() : 0;
    if (newDate > existingDate) byName.set(key, m);
  }
  return Array.from(byName.values());
}

function mapAllergies(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    const reactions = (r.reaction as Record<string, unknown>[]) || [];
    const manifestations = reactions.length > 0
      ? ((reactions[0].manifestation as Record<string, unknown>[]) || []).map(
          (m) => (m.coding as Record<string, unknown>[])?.[0]?.display || m.text || ''
        ).filter(Boolean)
      : [];

    return {
      type: 'allergy',
      source: 'ehr',
      name: ((r.code as Record<string, unknown>)?.text as string) || (firstCoding.display as string) || 'Unknown allergen',
      code: (firstCoding.code as string) || '',
      severity: (reactions[0]?.severity as string) || '',
      reactions: manifestations,
      status: (((r.clinicalStatus as Record<string, unknown>)?.coding as Record<string, unknown>[] | undefined)?.[0]?.code as string) || '',
      recorded_date: r.recordedDate || r.assertedDate || '',
    };
  });
}

// v41: Some FHIR Observations are panel-style — a parent resource with no
// top-level value, plus a component[] array where each entry carries its own
// code + valueQuantity. The canonical example is blood pressure (LOINC 85354-9
// or Epic-specific codes), which always splits into 8480-6 (systolic) and
// 8462-4 (diastolic) components. Same pattern for BMI panels (height + weight
// + BMI components) and many cardiology/respiratory panels.
//
// flattenObservation projects one FHIR Observation into one or more Wellet
// observation rows: either the parent (when it has a top-level value) or one
// row per component. Each row carries its own LOINC code so isVitalObservation
// in ehr-persist can recognize it without us having to widen the heuristic.
function flattenObservation(r: Record<string, unknown>): Record<string, unknown>[] {
  const parentCoding = ((r.code as Record<string, unknown>)?.coding as Record<string, unknown>[]) || [];
  const parentFirstCoding = parentCoding[0] || {};
  const parentName = ((r.code as Record<string, unknown>)?.text as string)
    || (parentFirstCoding.display as string)
    || 'Lab result';
  const effectiveDate = (r.effectiveDateTime as string)
    || ((r.effectivePeriod as Record<string, unknown>)?.start as string)
    || '';
  const status = (r.status as string) || '';
  const category = (((r.category as Record<string, unknown>[]) || [])[0]
    ?.coding as Record<string, unknown>[] | undefined)?.[0]?.code as string
    || '';
  const referenceRange = ((r.referenceRange as Record<string, unknown>[])?.[0]?.text as string) || '';
  const encounter_ref = encounterIdFromResource(r);

  // Extract value/unit from a FHIR value[x] off any node (parent or component).
  function readValue(node: Record<string, unknown>): { value: string; unit: string } {
    if (node.valueQuantity) {
      const vq = node.valueQuantity as Record<string, unknown>;
      return { value: String(vq.value ?? ''), unit: (vq.unit as string) || '' };
    }
    if (node.valueString) return { value: String(node.valueString), unit: '' };
    if (node.valueCodeableConcept) {
      const vcc = node.valueCodeableConcept as Record<string, unknown>;
      const vccText = (vcc.text as string)
        || (((vcc.coding as Record<string, unknown>[]) || [])[0]?.display as string)
        || '';
      return { value: vccText, unit: '' };
    }
    return { value: '', unit: '' };
  }

  const components = (r.component as Record<string, unknown>[]) || [];
  const parentVal = readValue(r);
  const hasParentValue = parentVal.value !== '';
  const hasComponents = components.length > 0;

  // Case 1: parent has a value and no components → one row, as before.
  if (hasParentValue && !hasComponents) {
    return [{
      type: 'observation',
      source: 'ehr',
      name: parentName,
      code: (parentFirstCoding.code as string) || '',
      value: parentVal.value,
      unit: parentVal.unit,
      reference_range: referenceRange,
      status,
      effective_date: effectiveDate,
      category,
      encounter_ref,
    }];
  }

  // Case 2: component-style observation. Emit one row per component that
  // actually carries a value, keyed by the component's own LOINC code.
  if (hasComponents) {
    const rows: Record<string, unknown>[] = [];
    for (const c of components) {
      const cCoding = ((c.code as Record<string, unknown>)?.coding as Record<string, unknown>[]) || [];
      const cFirstCoding = cCoding[0] || {};
      const cName = ((c.code as Record<string, unknown>)?.text as string)
        || (cFirstCoding.display as string)
        || parentName;
      const cCode = (cFirstCoding.code as string) || '';
      const cVal = readValue(c);
      if (!cVal.value) continue; // skip components with no value
      const cRefRange = ((c.referenceRange as Record<string, unknown>[])?.[0]?.text as string) || referenceRange;
      rows.push({
        type: 'observation',
        source: 'ehr',
        name: cName,
        code: cCode,
        value: cVal.value,
        unit: cVal.unit,
        reference_range: cRefRange,
        status,
        effective_date: effectiveDate,
        category,
        encounter_ref,
      });
    }
    // If components yielded nothing (rare — empty values) AND parent had a
    // value we already handled it above. If both are empty we drop the row;
    // a valueless Observation has no signal for the user.
    return rows;
  }

  // Case 3: no value, no components. Drop — nothing to persist.
  return [];
}

function mapObservations(resources: unknown[]) {
  const out: Record<string, unknown>[] = [];
  for (const r of resources as Record<string, unknown>[]) {
    const rows = flattenObservation(r);
    for (const row of rows) out.push(row);
  }
  return out;
}

// Map Encounter resources, extracting participant practitioners and sorting most-recent first
function mapEncounters(resources: unknown[]) {
  const visits = (resources as Record<string, unknown>[]).map((r) => {
    const typeArr = (r.type as Record<string, unknown>[]) || [];
    const typeCoding = typeArr[0] || {};
    const coding = (typeCoding.coding as Record<string, unknown>[]) || [];
    const firstCoding = coding[0] || {};
    const period = (r.period as Record<string, unknown>) || {};

    // Extract participant practitioner references + display names
    const participants = (r.participant as Record<string, unknown>[]) || [];
    const providers = participants.map((p) => {
      const individual = (p.individual as Record<string, unknown>) || {};
      return {
        ref: (individual.reference as string) || '',
        name: (individual.display as string) || '',
      };
    }).filter((p) => p.ref || p.name);

    // Location display if present
    const locationArr = (r.location as Record<string, unknown>[]) || [];
    const firstLoc = locationArr[0] || {};
    const locationDisplay = ((firstLoc.location as Record<string, unknown>) || {}).display as string || '';

    // Reason for visit (R4 uses reasonCode; falls back to reason)
    const reasonArr = (r.reasonCode as Record<string, unknown>[]) || (r.reason as Record<string, unknown>[]) || [];
    const firstReason = reasonArr[0] || {};
    const reasonText = (firstReason.text as string)
      || (((firstReason.coding as Record<string, unknown>[]) || [])[0]?.display as string)
      || '';

    // Service provider — a Reference to Organization (e.g. "Duke University Hospital")
    const svcProvider = (r.serviceProvider as Record<string, unknown>) || {};
    const serviceProviderName = (svcProvider.display as string) || '';

    const cls = (r.class as Record<string, unknown>) || {};
    return {
      type: 'encounter',
      source: 'ehr',
      id: (r.id as string) || '',
      name: typeCoding.text || firstCoding.display || (cls.display as string) || 'Visit',
      status: r.status || '',
      start_date: period.start || '',
      end_date: period.end || '',
      class: (cls.code as string) || '',
      class_display: (cls.display as string) || '',
      service_provider: serviceProviderName,
      location: locationDisplay,
      reason: reasonText,
      providers, // [{ ref, name }]
    };
  });

  // Sort most-recent first by start_date
  visits.sort((a, b) => {
    const da = a.start_date ? new Date(a.start_date as string).getTime() : 0;
    const db = b.start_date ? new Date(b.start_date as string).getTime() : 0;
    return db - da;
  });
  return visits;
}

// Map FHIR Appointment resources — these are future/scheduled visits and power
// the Before-visit card. Epic returns Appointment.start as ISO-8601. We project
// them onto the same shape as Encounters so the persist layer treats them as
// visits (event_type='visit') with a future event_date.
function mapAppointments(resources: unknown[]) {
  const out = (resources as Record<string, unknown>[]).map((r) => {
    // serviceType[0].text gives a friendly name like 'Follow-up' or 'Office Visit'
    const svcType = ((r.serviceType as Record<string, unknown>[]) || [])[0] || {};
    const svcCoding = ((svcType.coding as Record<string, unknown>[]) || [])[0] || {};
    const apptType = (r.appointmentType as Record<string, unknown>) || {};
    const apptCoding = ((apptType.coding as Record<string, unknown>[]) || [])[0] || {};

    // Reason — R4 uses reasonCode (array) or reasonReference
    const reasonArr = (r.reasonCode as Record<string, unknown>[]) || [];
    const firstReason = reasonArr[0] || {};
    const reasonText = (firstReason.text as string)
      || (((firstReason.coding as Record<string, unknown>[]) || [])[0]?.display as string)
      || (r.description as string)
      || '';

    // Participants — mostly the practitioner(s) and the patient. We keep only
    // Practitioner refs so they roll into the same enrichment pipeline.
    const participants = (r.participant as Record<string, unknown>[]) || [];
    const providers = participants.map((p) => {
      const actor = (p.actor as Record<string, unknown>) || {};
      return {
        ref: (actor.reference as string) || '',
        name: (actor.display as string) || '',
      };
    }).filter((p) => p.ref.startsWith('Practitioner/') || p.name);

    // Location — first participant of type Location, if any
    let locationDisplay = '';
    for (const p of participants) {
      const actor = (p.actor as Record<string, unknown>) || {};
      const ref = (actor.reference as string) || '';
      if (ref.startsWith('Location/')) {
        locationDisplay = (actor.display as string) || '';
        break;
      }
    }

    const name = (svcType.text as string)
      || (svcCoding.display as string)
      || (apptType.text as string)
      || (apptCoding.display as string)
      || (r.description as string)
      || 'Upcoming visit';

    return {
      type: 'appointment',
      source: 'ehr',
      id: (r.id as string) || '',
      name,
      status: (r.status as string) || '',
      start_date: (r.start as string) || '',
      end_date: (r.end as string) || '',
      class: '',
      class_display: '',
      service_provider: '',
      location: locationDisplay,
      reason: reasonText,
      providers,
    };
  });

  // Drop appointments without a usable start date (Epic occasionally returns
  // proposed appointments with no time block) and anything already in the
  // past — the FHIR date filter is a hint, not a guarantee on every server.
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  const filtered = out.filter((a) => {
    if (!a.start_date) return false;
    const t = new Date(a.start_date).getTime();
    if (!isFinite(t)) return false;
    if (t < cutoffMs) return false;
    // Skip cancelled/no-show; keep booked/pending/arrived/checked-in/proposed.
    const status = (a.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'noshow' || status === 'entered-in-error') return false;
    return true;
  });

  // Sort soonest first — the Before-visit card wants the next appointment up top.
  filtered.sort((a, b) => {
    const da = new Date(a.start_date).getTime();
    const db = new Date(b.start_date).getTime();
    return da - db;
  });
  return filtered;
}

// Map DocumentReference resources. Extracts encounter link + LOINC type + attachment URLs
// so the frontend can offer tappable AVS / Provider-note links per visit.
function mapDocumentReferences(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const typeObj = (r.type as Record<string, unknown>) || {};
    const typeCoding = ((typeObj.coding as Record<string, unknown>[]) || [])[0] || {};
    const content = (r.content as Record<string, unknown>[]) || [];
    const firstAtt = (content[0]?.attachment as Record<string, unknown>) || {};

    // context.encounter can be a single reference object or an array of refs
    const ctx = (r.context as Record<string, unknown>) || {};
    const encRaw = ctx.encounter;
    let encounterRef = '';
    if (Array.isArray(encRaw)) {
      encounterRef = (((encRaw as Record<string, unknown>[])[0] || {}).reference as string) || '';
    } else if (encRaw && typeof encRaw === 'object') {
      encounterRef = ((encRaw as Record<string, unknown>).reference as string) || '';
    }
    const encounterId = encounterRef.startsWith('Encounter/') ? encounterRef.slice('Encounter/'.length) : '';

    return {
      id: (r.id as string) || '',
      encounter_id: encounterId,
      loinc_code: (typeCoding.code as string) || '',
      type_display: (typeObj.text as string) || (typeCoding.display as string) || '',
      description: (r.description as string) || '',
      date: (r.date as string) || '',
      content_type: (firstAtt.contentType as string) || '',
      url: (firstAtt.url as string) || '',
      title: (firstAtt.title as string) || '',
    };
  });
}

function mapProcedures(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};

    return {
      type: 'procedure',
      source: 'ehr',
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Procedure',
      code: firstCoding.code || '',
      status: r.status || '',
      performed_date: r.performedDateTime || (r.performedPeriod as Record<string, unknown>)?.start || '',
    };
  });
}

function mapImmunizations(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const vaccineCode = (r.vaccineCode as Record<string, unknown>) || {};
    const coding = (vaccineCode.coding as Record<string, unknown>[]) || [];
    const firstCoding = coding[0] || {};

    return {
      type: 'immunization',
      source: 'ehr',
      name: vaccineCode.text || firstCoding.display || 'Immunization',
      code: firstCoding.code || '',
      status: r.status || '',
      date: r.occurrenceDateTime || (r.occurrenceString as string) || '',
      lot_number: r.lotNumber || '',
    };
  });
}

// Safely decode a base64 string to UTF-8 text. Returns '' on failure.
function decodeBase64Utf8(b64: string): string {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

// Strip HTML tags and collapse whitespace — for rendering text/html presentedForm
// content in a plain-text mobile row. Keeps paragraph breaks.
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function mapDiagnosticReports(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    const categories = (r.category as Record<string, unknown>[]) || [];
    const firstCategory = categories.length > 0
      ? ((categories[0].coding as Record<string, unknown>[]) || [])[0]?.display || categories[0].text || ''
      : '';

    // Conclusion — clinician-written free text summary
    const conclusion = (r.conclusion as string) || '';

    // conclusionCode — coded findings; surface display strings
    const conclusionCodes = (r.conclusionCode as Record<string, unknown>[]) || [];
    const conclusionCodeDisplays = conclusionCodes
      .map((cc) => {
        const ccCoding = (cc.coding as Record<string, unknown>[]) || [];
        const first = ccCoding[0] || {};
        return (cc.text as string) || (first.display as string) || '';
      })
      .filter(Boolean);

    // Performer — who wrote the report (for attribution). This is an array
    // of references; we keep display strings only (Practitioner detail is
    // fetched separately into care_team).
    const performers = (r.performer as Record<string, unknown>[]) || [];
    const performerNames = performers
      .map((p) => (p.display as string) || '')
      .filter(Boolean);

    // presentedForm — attached versions of the report (inline text/html or PDF URL).
    // We decode inline text/html content; for binary attachments (PDF) we keep a
    // descriptor so the client can fetch them via a future signed endpoint.
    const presentedForms = (r.presentedForm as Record<string, unknown>[]) || [];
    const attachments = presentedForms.map((pf) => {
      const contentType = (pf.contentType as string) || '';
      const title = (pf.title as string) || '';
      const url = (pf.url as string) || '';
      const data = (pf.data as string) || '';
      const sizeNum = typeof pf.size === 'number' ? (pf.size as number) : 0;
      const att: Record<string, unknown> = {
        content_type: contentType,
        title,
        url,
        size: sizeNum,
        inline_text: '',
      };
      if (data) {
        if (contentType.startsWith('text/plain')) {
          att.inline_text = decodeBase64Utf8(data);
        } else if (contentType.startsWith('text/html')) {
          att.inline_text = htmlToPlainText(decodeBase64Utf8(data));
        }
        // For PDFs and other binary attachments, we intentionally skip decoding
        // here; tomorrow's DocumentReference pass will add a signed-fetch path.
      }
      return att;
    });

    // Result references — count of individual observations attached to this report
    const results = (r.result as Record<string, unknown>[]) || [];
    const result_count = results.length;

    return {
      type: 'diagnostic_report',
      source: 'ehr',
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Diagnostic Report',
      code: firstCoding.code || '',
      status: r.status || '',
      category: firstCategory,
      effective_date: r.effectiveDateTime || (r.effectivePeriod as Record<string, unknown>)?.start || '',
      issued: r.issued || '',
      conclusion,
      conclusion_codes: conclusionCodeDisplays,
      performers: performerNames,
      attachments,
      result_count,
      encounter_ref: encounterIdFromResource(r),
    };
  });
}

// Map a Practitioner resource to Wellet care team member shape.
// Pulls display name, specialty (from qualification when available), phone/email (from telecom), and mailing address.
function mapPractitioner(p: Record<string, unknown>, role?: string) {
  // Name
  const nameArr = (p.name as Record<string, unknown>[]) || [];
  const firstName = nameArr[0] || {};
  const nameText = (firstName.text as string)
    || [(firstName.prefix as string[] | undefined)?.join(' '), (firstName.given as string[] | undefined)?.join(' '), firstName.family as string, (firstName.suffix as string[] | undefined)?.join(' ')]
        .filter(Boolean).join(' ').trim();

  // Telecom — split by system
  const telecom = (p.telecom as Record<string, unknown>[]) || [];
  const phones: string[] = [];
  const emails: string[] = [];
  let fax = '';
  for (const t of telecom) {
    const system = (t.system as string) || '';
    const value = (t.value as string) || '';
    if (!value) continue;
    if (system === 'phone') phones.push(value);
    else if (system === 'email') emails.push(value);
    else if (system === 'fax') fax = value;
  }

  // Address — first usable one
  const addresses = (p.address as Record<string, unknown>[]) || [];
  const firstAddr = addresses[0] || {};
  const lineArr = (firstAddr.line as string[]) || [];
  const addressText = (firstAddr.text as string) || [
    lineArr.join(', '),
    firstAddr.city as string,
    firstAddr.state as string,
    firstAddr.postalCode as string,
  ].filter(Boolean).join(', ');

  // Specialty from qualification.code.text (best effort)
  const qualifications = (p.qualification as Record<string, unknown>[]) || [];
  let specialty = '';
  for (const q of qualifications) {
    const code = (q.code as Record<string, unknown>) || {};
    const coding = (code.coding as Record<string, unknown>[]) || [];
    const display = (code.text as string) || (coding[0]?.display as string) || '';
    if (display) { specialty = display; break; }
  }

  return {
    type: 'practitioner',
    source: 'ehr',
    id: (p.id as string) || '',
    name: nameText || 'Unknown provider',
    role: role || '',
    specialty,
    phones,
    fax,
    emails,
    address: addressText,
  };
}

// Map a Patient resource to a minimal identity payload used by the frontend
// to VERIFY the chart shown matches the connected patient. Without this,
// a mismatched token/patient_id could silently show the wrong person's data.
function mapPatient(p: Record<string, unknown>) {
  const nameArr = (p.name as Record<string, unknown>[]) || [];
  // Prefer official name, else first usable
  const preferred = nameArr.find((n) => (n.use as string) === 'official') || nameArr[0] || {};
  const nameText = (preferred.text as string)
    || [
      (preferred.given as string[] | undefined)?.join(' '),
      preferred.family as string,
    ].filter(Boolean).join(' ').trim();
  return {
    id: (p.id as string) || '',
    name: nameText || 'Unknown',
    birth_date: (p.birthDate as string) || '',
    gender: (p.gender as string) || '',
  };
}

// ── Refresh flow ─────────────────────────────────────────────────────────────
// Decrypts stored refresh_token and exchanges it at the provider's token
// endpoint for a new access_token (and usually a new refresh_token). Updates
// ehr_connections in place. Returns { ok, accessToken, detail? }.
async function refreshAccessTokenIfNeeded(
  admin: ReturnType<typeof getAdminClient>,
  conn: Record<string, any>,
  encKey: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; detail: string }> {
  // Decrypt the current access token up front — we'll need it if no refresh is required.
  const { data: decAccessToken } = await admin.rpc('decrypt_ehr_token', {
    encrypted_token: conn.access_token, enc_key: encKey,
  });
  const currentAccess = (decAccessToken as string | null) || conn.access_token;

  // If expires_at is missing OR the token is still valid (with 60s skew), use it as-is.
  const skewMs = 60_000;
  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
  if (!expiresAt || expiresAt - Date.now() > skewMs) {
    return { ok: true, accessToken: currentAccess };
  }

  // Expired. We need a refresh token + token_url + client_id to continue.
  if (!conn.refresh_token || !conn.token_url || !conn.client_id_used) {
    console.warn('[fetch-ehr-data] Expired but missing refresh inputs', {
      hasRefresh: !!conn.refresh_token,
      hasTokenUrl: !!conn.token_url,
      hasClientId: !!conn.client_id_used,
    });
    await admin.from('ehr_connections')
      .update({ needs_reconnect: true })
      .eq('id', conn.id);
    return { ok: false, detail: 'missing_refresh_inputs' };
  }

  // Decrypt the refresh token
  const { data: decRefresh, error: decRefreshErr } = await admin.rpc('decrypt_ehr_token', {
    encrypted_token: conn.refresh_token, enc_key: encKey,
  });
  if (decRefreshErr || !decRefresh) {
    console.error('[fetch-ehr-data] decrypt_ehr_token failed for refresh_token', decRefreshErr);
    return { ok: false, detail: 'decrypt_refresh_failed' };
  }

  // Build the refresh body. Confidential clients (everything except the
  // legacy public client) authenticate via a signed client_assertion JWT.
  // Public clients use just `client_id`. epic-auth's callback path already
  // does this correctly — we mirror that here so subsequent token refreshes
  // don't quietly fail and force users into a reconnect loop.
  const isLegacyPublic = conn.client_id_used === EPIC_LEGACY_PUBLIC_CLIENT_ID;
  const isSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;

  let body: URLSearchParams;
  if (isLegacyPublic) {
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: decRefresh as string,
      client_id: EPIC_LEGACY_PUBLIC_CLIENT_ID,
    });
  } else {
    let clientAssertion: string;
    try {
      const creds = resolveClientCreds(isSandbox);
      const privateKey = await loadPrivateKey(creds.pemEnv);
      clientAssertion = await buildClientAssertion(
        conn.token_url as string,
        creds.clientId,
        creds.kid,
        privateKey,
      );
    } catch (e) {
      console.error('[fetch-ehr-data] refresh client_assertion build failed', {
        err: (e as Error).message,
        conn_id: conn.id,
      });
      return { ok: false, detail: 'client_assertion_failed' };
    }
    body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: decRefresh as string,
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: clientAssertion,
    });
  }

  const res = await fetch(conn.token_url as string, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error('[fetch-ehr-data] Refresh exchange failed', {
      status: res.status,
      err: errText.slice(0, 300),
      tokenUrl: conn.token_url,
      clientId: conn.client_id_used,
    });
    await admin.from('ehr_connections')
      .update({ needs_reconnect: true })
      .eq('id', conn.id);
    return { ok: false, detail: `refresh_rejected_${res.status}` };
  }

  const tokenData = await res.json();
  if (!tokenData.access_token) {
    console.error('[fetch-ehr-data] Refresh returned no access_token', tokenData);
    return { ok: false, detail: 'no_access_token_in_refresh' };
  }

  console.log('[fetch-ehr-data] Refresh succeeded', {
    hasNewRefresh: !!tokenData.refresh_token,
    expiresIn: tokenData.expires_in,
    clientId: conn.client_id_used,
  });

  // Re-encrypt and persist the new tokens
  const newExpiresAt = new Date(Date.now() + ((tokenData.expires_in || 3600) * 1000)).toISOString();

  const { data: encNewAccess, error: encAccErr } = await admin.rpc('encrypt_ehr_token', {
    plain_token: tokenData.access_token, enc_key: encKey,
  });
  if (encAccErr || !encNewAccess) {
    console.error('[fetch-ehr-data] encrypt_ehr_token failed for new access_token', encAccErr);
    return { ok: false, detail: 'encrypt_new_access_failed' };
  }

  let encNewRefresh: string | null = conn.refresh_token as string | null;
  if (tokenData.refresh_token) {
    const { data: encR, error: encRErr } = await admin.rpc('encrypt_ehr_token', {
      plain_token: tokenData.refresh_token, enc_key: encKey,
    });
    if (encRErr || !encR) {
      console.error('[fetch-ehr-data] encrypt_ehr_token failed for new refresh_token', encRErr);
      // Don't fail the request — keep the old refresh token and the new access token.
    } else {
      encNewRefresh = encR as string;
    }
  }

  const { error: updateErr } = await admin.from('ehr_connections')
    .update({
      access_token: encNewAccess,
      refresh_token: encNewRefresh,
      token_expires_at: newExpiresAt,
      needs_reconnect: false,
    })
    .eq('id', conn.id);

  if (updateErr) {
    console.error('[fetch-ehr-data] Failed to persist refreshed tokens', updateErr);
    // Still return the new access token for this request.
  }

  return { ok: true, accessToken: tokenData.access_token as string };
}

// ── fetchAndPersistOneConnection ──────────────────────────────────────────────
// Runs the full EHR fetch + persist pipeline for a single ehr_connections row.
// Each call is isolated: it creates its own telemetry arrays, its own FHIR
// call set, and persists with the connection's own id. Returning a structured
// ConnectionResult instead of throwing means Promise.allSettled callers can
// surface per-connection errors without one failed hospital taking down the rest.
async function fetchAndPersistOneConnection(
  admin: ReturnType<typeof getAdminClient>,
  userId: string,
  personId: string,
  conn: any, // a single ehr_connections row
  encKey: string,
): Promise<ConnectionResult> {
  const connT0 = Date.now();

  // Connection-local telemetry buckets — never shared with sibling connections.
  const localFhirTele: FhirCallTelemetry[] = [];
  const localPractTele: PractitionerTelemetry[] = [];

  const emptyArrays = {
    conditions: [] as unknown[],
    medications: [] as unknown[],
    allergies: [] as unknown[],
    observations: [] as unknown[],
    immunizations: [] as unknown[],
    diagnostic_reports: [] as unknown[],
    visits: [] as unknown[],
    care_team: [] as unknown[],
  };
  const emptyPersisted = { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] as string[] };
  const emptyCounts = { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, appointments: 0, care_team: 0 };

  const baseResult = {
    connection_id: conn.id as string,
    hospital_name: (conn.hospital_name as string | null) ?? null,
    fhir_base_url: (conn.fhir_base_url as string) || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
    patient_id: (conn.patient_id as string | null) ?? null,
    provider: (conn.connected_provider as string) || 'Epic MyChart',
    connected_provider: (conn.connected_provider as string | null) ?? null,
  };

  try {
    // Step 1: Refresh token if needed. A failed refresh is a soft error —
    // return a structured status so the caller can prompt reconnect only when
    // ALL connections fail (not just this one).
    const refreshed = await refreshAccessTokenIfNeeded(admin, conn, encKey);
    if (!refreshed.ok) {
      console.warn('[fetch-ehr-data] token_refresh_failed', {
        conn_id: conn.id,
        hospital: conn.hospital_name,
        detail: refreshed.detail,
      });
      return {
        ...baseResult,
        status: 'token_refresh_failed',
        error: refreshed.detail,
        patient: null,
        ...emptyArrays,
        synced_at: new Date().toISOString(),
        result_counts: emptyCounts,
        persisted: emptyPersisted,
        fhir_calls: localFhirTele,
        practitioner_calls: localPractTele,
        duration_ms: Date.now() - connT0,
      };
    }

    const accessToken = refreshed.accessToken;
    const fhirBaseUrl = (conn.fhir_base_url as string) || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
    const patientId = conn.patient_id as string | null;
    const patientParam = patientId ? `patient=${patientId}` : '';

    // Step 2: Fetch all FHIR resources in parallel, threading local tele buckets.
    //
    // Future appointments — Epic supports date=ge{YYYY-MM-DD}. We use yesterday as
    // the floor (timezone-safe slack) so today's not-yet-started visits still come
    // through. If the connection doesn't have the patient/Appointment.read scope
    // granted yet (legacy connections), this returns 403 inside fetchFhirResource
    // and we swallow it as an empty array via the .catch fallback.
    const apptFloor = (() => {
      try {
        const d = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${y}-${m}-${day}`;
      } catch { return ''; }
    })();
    const apptDateParam = apptFloor ? `date=ge${apptFloor}` : '';
    const apptQuery = [patientParam, apptDateParam].filter(Boolean).join('&');

    const [
      patientResource,
      conditions,
      medications,
      allergies,
      labObservations,
      vitalObservations,
      immunizations,
      diagnosticReports,
      encountersRaw,
      appointmentsRaw,
      careTeamsRaw,
      documentReferencesRaw,
    ] = await Promise.all([
      // Patient identity — proves which chart we are actually pulling
      patientId ? fetchFhirById(fhirBaseUrl, `Patient/${patientId}`, accessToken, localPractTele) : Promise.resolve(null),
      fetchFhirResource(fhirBaseUrl, 'Condition', accessToken, patientParam, localFhirTele),
      // status=active is an Epic-supported filter — fixes the "78 amlodipine rows" bug
      fetchFhirResource(fhirBaseUrl, 'MedicationRequest', accessToken, patientParam ? `${patientParam}&status=active` : 'status=active', localFhirTele),
      fetchFhirResource(fhirBaseUrl, 'AllergyIntolerance', accessToken, patientParam, localFhirTele),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=laboratory` : 'category=laboratory', localFhirTele),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=vital-signs` : 'category=vital-signs', localFhirTele),
      fetchFhirResource(fhirBaseUrl, 'Immunization', accessToken, patientParam, localFhirTele),
      fetchFhirResource(fhirBaseUrl, 'DiagnosticReport', accessToken, patientParam, localFhirTele),
      // All encounters — UI filters to last 2 years with a "show older" toggle
      fetchFhirResource(fhirBaseUrl, 'Encounter', accessToken, patientParam, localFhirTele),
      // Future Appointments — powers the Before-visit card. Tolerant of missing
      // scope on legacy connections; will be empty until user re-consents Duke.
      fetchFhirResource(fhirBaseUrl, 'Appointment', accessToken, apptQuery, localFhirTele).catch((e: unknown) => {
        console.warn('[fetch-ehr-data] Appointment fetch failed (likely scope not granted yet)', String(e));
        return [] as unknown[];
      }),
      // Active care teams
      fetchFhirResource(fhirBaseUrl, 'CareTeam', accessToken, patientParam ? `${patientParam}&status=active` : 'status=active', localFhirTele),
      // Clinical notes / AVS / provider summaries (metadata only — content fetched on tap)
      fetchFhirResource(fhirBaseUrl, 'DocumentReference', accessToken, patientParam, localFhirTele),
    ]);

    const patient = patientResource ? mapPatient(patientResource) : { id: patientId || '', name: '', birth_date: '', gender: '' };

    // Combine lab and vital observations
    const observations = [...labObservations, ...vitalObservations];

    const medicationsMapped = mapMedications(medications);
    const encountersMapped = mapEncounters(encountersRaw);
    const appointmentsMapped = mapAppointments(appointmentsRaw);
    // Visits we pass downstream = past Encounters + future Appointments. Both
    // share the same shape (start_date/end_date/name/providers/etc.), so the
    // existing care-team enrichment, persistence, and UI rendering all just
    // work. The `type` field ('encounter' vs 'appointment') lets the persist
    // layer differentiate fingerprints so they never collide.
    const visitsMapped = [...encountersMapped, ...appointmentsMapped];

    // Attach DocumentReference metadata to each visit by encounter id so the
    // expanded visit row can offer AVS / Provider Summary links.
    const documentsMapped = mapDocumentReferences(documentReferencesRaw);
    const docsByEncounter: Record<string, typeof documentsMapped> = {};
    for (const d of documentsMapped) {
      if (!d.encounter_id) continue;
      if (!docsByEncounter[d.encounter_id]) docsByEncounter[d.encounter_id] = [];
      docsByEncounter[d.encounter_id].push(d);
    }
    for (const v of visitsMapped as Record<string, unknown>[]) {
      const vid = (v.id as string) || '';
      (v as Record<string, unknown>).documents = vid ? (docsByEncounter[vid] || []) : [];
    }

    // ── Build unified practitioner roster ──
    // Collect Practitioner references from: CareTeam.participant, Encounter.participant, and MedicationRequest.requester
    const practitionerRefs = new Set<string>();
    const roleByRef: Record<string, string> = {};

    for (const ct of careTeamsRaw as Record<string, unknown>[]) {
      const participants = (ct.participant as Record<string, unknown>[]) || [];
      for (const p of participants) {
        const member = (p.member as Record<string, unknown>) || {};
        const ref = (member.reference as string) || '';
        if (ref && ref.startsWith('Practitioner/')) {
          practitionerRefs.add(ref);
          const roleArr = (p.role as Record<string, unknown>[]) || [];
          const firstRole = roleArr[0] || {};
          const roleCoding = (firstRole.coding as Record<string, unknown>[]) || [];
          const roleText = (firstRole.text as string) || (roleCoding[0]?.display as string) || '';
          if (roleText) roleByRef[ref] = roleText;
        }
      }
    }
    for (const v of visitsMapped) {
      for (const p of v.providers) {
        if (p.ref && p.ref.startsWith('Practitioner/')) practitionerRefs.add(p.ref);
      }
    }
    for (const m of medicationsMapped) {
      if (m.prescriber_ref && m.prescriber_ref.startsWith('Practitioner/')) practitionerRefs.add(m.prescriber_ref);
    }

    // Fetch each Practitioner individually (Epic's FHIR R4 supports Practitioner.Read by ID)
    // Capped to protect against runaway (should be well under 50 for a typical patient)
    const refList = Array.from(practitionerRefs).slice(0, 50);
    const practitionerResources = await Promise.all(
      refList.map((ref) => fetchFhirById(fhirBaseUrl, ref, accessToken, localPractTele))
    );

    // In Epic FHIR R4, Practitioner.telecom is almost always empty — phones,
    // emails, fax, and specialty live on PractitionerRole resources instead.
    // Fetch PractitionerRole?practitioner=<id> for each practitioner in
    // parallel, then merge the contact info onto the Practitioner mapping.
    const roleBundles = await Promise.all(
      refList.map((ref) => {
        const id = ref.split('/')[1] || '';
        if (!id) return Promise.resolve([] as Record<string, unknown>[]);
        return fetchPractitionerRoles(fhirBaseUrl, id, accessToken, localPractTele);
      })
    );

    // Telemetry: per-practitioner snapshot of what Practitioner vs. PractitionerRole
    // returned — so we can see whether Duke is exposing contact info on PractitionerRole
    // (or whether we need a different fallback path for this provider).
    const practitionerTelemetry: Record<string, unknown>[] = [];

    const careTeam = practitionerResources
      .map((p, i) => {
        if (!p) return null;
        const mapped = mapPractitioner(p, roleByRef[refList[i]]);
        const roleExtras = extractFromPractitionerRoles(roleBundles[i] || []);
        const practPhones = Array.isArray(mapped.phones) ? mapped.phones.length : 0;
        const practEmails = Array.isArray(mapped.emails) ? mapped.emails.length : 0;
        const practHasAddress = !!mapped.address;

        // Merge — prefer the Practitioner resource's own values when present,
        // fall back to PractitionerRole when Practitioner is missing the field.
        if ((!mapped.phones || mapped.phones.length === 0) && roleExtras.phones.length > 0) {
          mapped.phones = roleExtras.phones;
        }
        if ((!mapped.emails || mapped.emails.length === 0) && roleExtras.emails.length > 0) {
          mapped.emails = roleExtras.emails;
        }
        if (!mapped.fax && roleExtras.fax) {
          mapped.fax = roleExtras.fax;
        }
        if (!mapped.specialty && roleExtras.specialty) {
          mapped.specialty = roleExtras.specialty;
        }
        if (!mapped.address && roleExtras.address) {
          mapped.address = roleExtras.address;
        }
        // If still no address but we have an organization name, use that —
        // "Duke Internal Medicine" is more useful than a blank field when
        // coordinating care across a large system.
        if (!mapped.address && roleExtras.organization) {
          mapped.address = roleExtras.organization;
        }

        practitionerTelemetry.push({
          ref: refList[i],
          name: mapped.name,
          roles_returned: (roleBundles[i] || []).length,
          practitioner_phones: practPhones,
          practitioner_emails: practEmails,
          practitioner_has_address: practHasAddress,
          role_phones: roleExtras.phones.length,
          role_emails: roleExtras.emails.length,
          role_has_fax: !!roleExtras.fax,
          role_has_address: !!roleExtras.address,
          role_organization: roleExtras.organization || null,
          final_phones: (mapped.phones || []).length,
          final_emails: (mapped.emails || []).length,
          final_has_address: !!mapped.address,
        });

        return mapped;
      })
      .filter((p) => p !== null) as ReturnType<typeof mapPractitioner>[];

    console.log('[fetch-ehr-data] Care team contact backfill', {
      conn_id: conn.id,
      person_id: personId,
      practitioner_count: practitionerTelemetry.length,
      sample: practitionerTelemetry.slice(0, 10),
    });

    // Sort care team alphabetically by name
    careTeam.sort((a, b) => (a!.name || '').localeCompare(b!.name || ''));

    const synced_at = new Date().toISOString();

    // Build per-resource counts
    const conditionsMapped = mapConditions(conditions);
    const allergiesMapped = mapAllergies(allergies);
    const observationsMapped = mapObservations(observations);
    const immunizationsMapped = mapImmunizations(immunizations);
    const diagnosticReportsMapped = mapDiagnosticReports(diagnosticReports);

    const resultCounts = {
      conditions: conditionsMapped.length,
      medications: medicationsMapped.length,
      allergies: allergiesMapped.length,
      observations: observationsMapped.length,
      immunizations: immunizationsMapped.length,
      diagnostic_reports: diagnosticReportsMapped.length,
      visits: visitsMapped.length,
      appointments: appointmentsMapped.length,
      care_team: careTeam.length,
    };

    // Step 3: Update last_synced_at for this specific connection.
    await admin.from('ehr_connections').update({
      last_synced_at: synced_at,
    }).eq('id', conn.id);

    // Step 4: Persist into canonical Wellet tables. Pass conn.id as the 4th
    // arg so every row is source-tagged with this connection — lets the
    // per-hospital pill UI and per-connection reconnect banners find their data.
    const persist = await persistEhrData(admin, personId, {
      medications: medicationsMapped,
      allergies: allergiesMapped,
      conditions: conditionsMapped,
      visits: visitsMapped,
      immunizations: immunizationsMapped,
      diagnostic_reports: diagnosticReportsMapped,
      observations: observationsMapped,
    }, conn.id);

    if (persist.errors.length > 0) {
      console.error('[fetch-ehr-data] persistence errors', {
        conn_id: conn.id,
        person_id: personId,
        errors: persist.errors,
      });
    } else {
      console.log('[fetch-ehr-data] persisted', {
        conn_id: conn.id,
        person_id: personId,
        ...persist,
      });
    }

    return {
      ...baseResult,
      status: 'ok',
      patient: patient as unknown as Record<string, unknown>,
      conditions: conditionsMapped,
      medications: medicationsMapped,
      allergies: allergiesMapped,
      observations: observationsMapped,
      immunizations: immunizationsMapped,
      diagnostic_reports: diagnosticReportsMapped,
      visits: visitsMapped,
      care_team: careTeam,
      synced_at,
      result_counts: resultCounts,
      persisted: {
        medications: persist.medications,
        allergies: persist.allergies,
        health_events: persist.health_events,
        lab_results: persist.lab_results,
        vitals: persist.vitals,
        errors: persist.errors,
      },
      fhir_calls: localFhirTele,
      practitioner_calls: localPractTele,
      duration_ms: Date.now() - connT0,
    };

  } catch (err) {
    // One failing connection MUST NOT take down sibling connections. Catch
    // everything, log it, and return a structured error result.
    const e = err as any;
    console.error('[fetch-ehr-data] fetchAndPersistOneConnection threw', {
      conn_id: conn.id,
      hospital: conn.hospital_name,
      error: e?.message || String(err),
      stack: e?.stack ? String(e.stack).split('\n').slice(0, 10) : null,
    });
    return {
      ...baseResult,
      status: 'fetch_error',
      error: (e?.message || String(err)).slice(0, 500),
      patient: null,
      ...emptyArrays,
      synced_at: new Date().toISOString(),
      result_counts: emptyCounts,
      persisted: emptyPersisted,
      fhir_calls: localFhirTele,
      practitioner_calls: localPractTele,
      duration_ms: Date.now() - connT0,
    };
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  function jsonResponse(data: unknown, status = 200) {
    return new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // Reset module-level telemetry vars to [] at request start. These are no-op
  // fallbacks for any call paths not yet ported to the per-connection bucket
  // pattern. The real telemetry lives in localFhirTele / localPractTele inside
  // fetchAndPersistOneConnection.
  currentFhirTelemetry = [];
  currentPractitionerTelemetry = [];
  const t0 = Date.now();

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const { person_id } = body;
    if (!person_id) {
      return jsonResponse({ error: 'person_id is required' }, 400);
    }

    const admin = getAdminClient();

    // Phase 2 fan-out: look up ALL connected rows for this person (not .single()).
    // Ordered by connected_at descending so the first successful result we pick
    // for the merged flat response is the most recently connected hospital.
    console.log('[fetch-ehr-data] lookup', { user_id: user.id, person_id, person_id_type: typeof person_id });
    const { data: conns, error: connsErr } = await admin.from('ehr_connections')
      .select('*')
      .eq('person_id', person_id)
      .eq('user_id', user.id)
      .eq('status', 'connected')
      .is('disconnected_at', null)
      .order('connected_at', { ascending: false });

    if (connsErr || !conns || conns.length === 0) {
      // Diagnostic: find any rows that match on person_id OR user_id to surface the mismatch.
      // Preserved exactly from v39 so the frontend error handling doesn't break.
      const byPerson = await admin.from('ehr_connections')
        .select('id, user_id, person_id, provider, token_expires_at, has_access:access_token')
        .eq('person_id', person_id);
      const byUser = await admin.from('ehr_connections')
        .select('id, user_id, person_id, provider, token_expires_at, has_access:access_token')
        .eq('user_id', user.id);
      const diagnostic = {
        requested: { user_id: user.id, person_id, person_id_type: typeof person_id },
        connError: connsErr?.message,
        connError_code: connsErr?.code,
        byPerson_count: byPerson.data?.length || 0,
        byPerson_rows: (byPerson.data || []).map((r: any) => ({
          id: r.id, user_id: r.user_id, person_id: r.person_id,
          provider: r.provider, token_expires_at: r.token_expires_at,
          has_access: !!r.has_access,
        })),
        byUser_count: byUser.data?.length || 0,
        byUser_rows: (byUser.data || []).map((r: any) => ({
          id: r.id, user_id: r.user_id, person_id: r.person_id,
          provider: r.provider, token_expires_at: r.token_expires_at,
          has_access: !!r.has_access,
        })),
        conn_has_token: false,
      };
      console.error('[fetch-ehr-data] 404 diagnostic', diagnostic);
      return jsonResponse({ error: 'No EHR connection found for this person', _diagnostic: diagnostic }, 404);
    }

    console.log('[fetch-ehr-data] lookup hit', {
      conn_count: conns.length,
      conn_ids: conns.map((c: any) => c.id),
      providers: conns.map((c: any) => c.provider),
    });

    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    if (!encKey) {
      console.error('[fetch-ehr-data] EHR_ENCRYPTION_KEY is not set');
      return jsonResponse({ error: 'server_misconfigured', message: 'Encryption key not configured' }, 500);
    }

    // ── Fan-out: run all connections in parallel ──────────────────────────────
    // Promise.allSettled means one rejected promise (unexpected throw that
    // escaped the inner try/catch) still surfaces as a structured error rather
    // than blowing up the whole response.
    const settled = await Promise.allSettled(
      conns.map((c: any) => fetchAndPersistOneConnection(admin, user.id, person_id, c, encKey))
    );

    const connectionResults: ConnectionResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      // Unexpected rejection that escaped the inner catch — synthesize a result.
      const c = conns[i];
      return {
        connection_id: c.id as string,
        hospital_name: (c.hospital_name as string | null) ?? null,
        fhir_base_url: (c.fhir_base_url as string) || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4',
        patient_id: (c.patient_id as string | null) ?? null,
        provider: (c.connected_provider as string) || 'Epic MyChart',
        connected_provider: (c.connected_provider as string | null) ?? null,
        status: 'fetch_error' as const,
        error: String(s.reason).slice(0, 500),
        patient: null,
        conditions: [],
        medications: [],
        allergies: [],
        observations: [],
        immunizations: [],
        diagnostic_reports: [],
        visits: [],
        care_team: [],
        synced_at: new Date().toISOString(),
        result_counts: { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, appointments: 0, care_team: 0 },
        persisted: { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] },
        fhir_calls: [],
        practitioner_calls: [],
        duration_ms: 0,
      } satisfies ConnectionResult;
    });

    // ── Build backward-compatible flat response ───────────────────────────────
    // Merge across all successful connections. When conns.length === 1 (today's
    // single-Duke case), the merged shape is byte-equivalent to the v39 response.
    const successfulResults = connectionResults.filter((r) => r.status === 'ok');
    const firstOk = successfulResults[0] ?? null;

    // Concatenate clinical arrays across all connections
    const mergedConditions = connectionResults.flatMap((r) => r.conditions);
    const mergedMedications = connectionResults.flatMap((r) => r.medications);
    const mergedAllergies = connectionResults.flatMap((r) => r.allergies);
    const mergedObservations = connectionResults.flatMap((r) => r.observations);
    const mergedImmunizations = connectionResults.flatMap((r) => r.immunizations);
    const mergedDiagnosticReports = connectionResults.flatMap((r) => r.diagnostic_reports);
    const mergedVisits = connectionResults.flatMap((r) => r.visits);
    const mergedCareTeam = connectionResults.flatMap((r) => r.care_team);

    // Patient identity: take from first successful connection (preserves
    // existing identity-check semantics for single-connection families).
    const mergedPatient = firstOk?.patient ?? { id: '', name: '', birth_date: '', gender: '' };
    const mergedExpectedPatientId = firstOk?.patient_id ?? '';
    const mergedProvider = firstOk?.provider ?? 'Epic MyChart';

    // synced_at: max across successful connections so the UI shows the latest sync time.
    const syncedAtMs = successfulResults.map((r) => new Date(r.synced_at).getTime()).filter((t) => !isNaN(t));
    const mergedSyncedAt = syncedAtMs.length > 0
      ? new Date(Math.max(...syncedAtMs)).toISOString()
      : new Date().toISOString();

    // Merged result_counts — sum across all connections
    const mergedResultCounts = {
      conditions: mergedConditions.length,
      medications: mergedMedications.length,
      allergies: mergedAllergies.length,
      observations: mergedObservations.length,
      immunizations: mergedImmunizations.length,
      diagnostic_reports: mergedDiagnosticReports.length,
      visits: mergedVisits.length,
      care_team: mergedCareTeam.length,
    };

    // Merged persisted counts — sum across all connections
    const mergedPersisted = connectionResults.reduce(
      (acc, r) => ({
        medications: acc.medications + r.persisted.medications,
        allergies: acc.allergies + r.persisted.allergies,
        health_events: acc.health_events + r.persisted.health_events,
        lab_results: acc.lab_results + r.persisted.lab_results,
        vitals: acc.vitals + r.persisted.vitals,
        errors: [...acc.errors, ...r.persisted.errors],
      }),
      { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] as string[] },
    );

    // Flat fhir_calls for the top-level _diagnostic (backward compat)
    const allFhirCalls = connectionResults.flatMap((r) => r.fhir_calls);
    const allPractCalls = connectionResults.flatMap((r) => r.practitioner_calls);
    const fhirCallsWithPract = [
      ...allFhirCalls,
      { resourceType: '__practitioner_debug__', practitioner_calls: allPractCalls },
    ];

    // One ehr_sync_log row PER connection — the regression watcher cron
    // (a335d77a) reads by patient_id so per-connection rows are required.
    for (const cr of connectionResults) {
      try {
        await admin.from('ehr_sync_log').insert({
          person_id,
          user_id: user.id,
          provider: conns.find((c: any) => c.id === cr.connection_id)?.provider || null,
          patient_id: cr.patient_id || null,
          expected_patient_id: cr.patient_id || null,
          patient_name: (cr.patient && (cr.patient as Record<string, unknown>).name as string) || null,
          result_counts: {
            ...cr.result_counts,
            _persisted: {
              medications: cr.persisted.medications,
              allergies: cr.persisted.allergies,
              health_events: cr.persisted.health_events,
              lab_results: cr.persisted.lab_results,
              vitals: cr.persisted.vitals,
              errors: cr.persisted.errors,
              duration_ms: cr.duration_ms,
            },
          },
          fhir_calls: [
            ...cr.fhir_calls,
            { resourceType: '__practitioner_debug__', practitioner_calls: cr.practitioner_calls },
          ],
          duration_ms: cr.duration_ms,
          status: cr.status === 'ok' ? 200 : cr.status === 'token_refresh_failed' ? 401 : 500,
          error_message: cr.error || null,
        });
      } catch (logErr) {
        console.error('[fetch-ehr-data] ehr_sync_log insert failed', { conn_id: cr.connection_id, logErr });
      }
    }

    // One-line summary across all connections
    console.log('[fetch-ehr-data] FHIR call summary', {
      person_id,
      connection_count: connectionResults.length,
      ok_count: successfulResults.length,
      calls: allFhirCalls,
      practitioner_calls: allPractCalls,
      result_counts: mergedResultCounts,
    });

    // ── Build the response object ─────────────────────────────────────────────
    // Top-level flat shape matches v39 exactly for single-connection users.
    // Additional fields (_phase2, connections) are additive only.
    const responseData: Record<string, unknown> = {
      // Backward-compat flat fields
      patient: mergedPatient,
      expected_patient_id: mergedExpectedPatientId,
      conditions: mergedConditions,
      medications: mergedMedications,
      allergies: mergedAllergies,
      observations: mergedObservations,
      immunizations: mergedImmunizations,
      diagnostic_reports: mergedDiagnosticReports,
      visits: mergedVisits,
      care_team: mergedCareTeam,
      provider: mergedProvider,
      synced_at: mergedSyncedAt,

      // Phase 2 new fields — frontend detects via _phase2: true
      _phase2: true,
      connections: connectionResults.map((cr) => ({
        connection_id: cr.connection_id,
        hospital_name: cr.hospital_name,
        fhir_base_url: cr.fhir_base_url,
        patient_id: cr.patient_id,
        provider: cr.provider,
        status: cr.status,
        error: cr.error,
        patient: cr.patient,
        conditions: cr.conditions,
        medications: cr.medications,
        allergies: cr.allergies,
        observations: cr.observations,
        immunizations: cr.immunizations,
        diagnostic_reports: cr.diagnostic_reports,
        visits: cr.visits,
        care_team: cr.care_team,
        synced_at: cr.synced_at,
        result_counts: cr.result_counts,
        persisted: cr.persisted,
        duration_ms: cr.duration_ms,
        _diagnostic: {
          result_counts: cr.result_counts,
          persisted: cr.persisted,
          fhir_calls: cr.fhir_calls,
          practitioner_calls: cr.practitioner_calls,
          duration_ms: cr.duration_ms,
        },
      })),

      // Top-level _diagnostic: merged across all connections (backward compat)
      _diagnostic: {
        result_counts: mergedResultCounts,
        persisted: mergedPersisted,
        fhir_calls: allFhirCalls,
        practitioner_calls: allPractCalls,
        duration_ms: Date.now() - t0,
      },
    };

    // HTTP 401 only when EVERY connection failed token refresh AND there was at
    // least one connection — lets the client prompt a blanket reconnect.
    // If only SOME connections failed, return 200 with per-connection error
    // details in connections[i].status so the UI can show a targeted banner.
    const allTokenFailed = connectionResults.length > 0 &&
      connectionResults.every((r) => r.status === 'token_refresh_failed');
    if (allTokenFailed) {
      return jsonResponse({
        error: 'Token refresh failed for all connections. Please reconnect to your EHR provider.',
        connections: responseData.connections,
        _phase2: true,
      }, 401);
    }

    return jsonResponse(responseData);

  } catch (err) {
    const e = err as any;
    console.error('fetch-ehr-data error:', e);
    return jsonResponse({
      error: (e && e.message) || 'Internal server error',
      _error_name: e?.name || null,
      _error_code: e?.code || null,
      _error_details: e?.details || null,
      _error_hint: e?.hint || null,
      _error_stack: e?.stack ? String(e.stack).split('\n').slice(0, 20) : null,
    }, 500);
  }
});
