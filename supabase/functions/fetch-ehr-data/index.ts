// Supabase Edge Function: fetch-ehr-data (v60 — Wellet Premium pulls.
// Adds Appointment (mapped + persisted to health_events under event_type
// 'appointment', FUTURE only, skip cancelled/noshow) AND a count-only "bonus"
// block of 9 chronic-care resources (EpisodeOfCare, NutritionOrder,
// DeviceUseStatement, Device, MedicationDispense, AdverseEvent, Flag,
// ImmunizationRecommendation, Provenance) so the regression watcher can
// notice silent scope drops on Premium client_ids. v61 will add mappers + UI
// for the highest-signal bonus resources — v60 is feed-only.
//
// Backwards-compatible by design: on every existing Confidential connection
// the new resources 403 on the wire and fetchFhirResource swallows the 403,
// returning [] — so the response shape is unchanged for those connections,
// only with two new always-present zero-valued keys (appointments + bonus).
//
// Originally v40 — Phase 2 N-connections fan-out: lookup all connected rows for person, fetch+persist each in parallel via Promise.allSettled, source-tag rows with connection_id, return both legacy flat shape (merged) AND new `connections` array.)
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
  // v60 (2026-04-28): future appointments from Wellet Premium–enabled
  // hospitals. Empty for Confidential connections (Epic returns 403 on the
  // wire, fetchFhirResource swallows it as 0 entries).
  appointments: unknown[];
  synced_at: string;
  result_counts: {
    conditions: number;
    medications: number;
    allergies: number;
    observations: number;
    immunizations: number;
    diagnostic_reports: number;
    visits: number;
    care_team: number;
    appointments: number;
    // v60 bonus chronic-care resources — fetched only for raw counts so the
    // regression watcher (cron a335d77a) can flag scope drops on Premium
    // connections. No mapping, no UI, no persistence yet — v61 lands those.
    bonus: {
      episode_of_care: number;
      nutrition_order: number;
      device_use_statement: number;
      device: number;
      medication_dispense: number;
      adverse_event: number;
      flag: number;
      immunization_recommendation: number;
      provenance: number;
    };
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

function mapConditions(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    return {
      type: 'condition',
      source: 'ehr',
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Unknown condition',
      code: firstCoding.code || '',
      system: firstCoding.system || '',
      status: (r.clinicalStatus as Record<string, unknown>)?.coding?.[0]?.code || r.clinicalStatus || '',
      onset_date: r.onsetDateTime || (r.onsetPeriod as Record<string, unknown>)?.start || '',
      recorded_date: r.recordedDate || '',
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

    const medName = medCode.text || (medRef.display as string) || firstCoding.display || 'Unknown medication';

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
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Unknown allergen',
      code: firstCoding.code || '',
      severity: reactions[0]?.severity || '',
      reactions: manifestations,
      status: (r.clinicalStatus as Record<string, unknown>)?.coding?.[0]?.code || '',
      recorded_date: r.recordedDate || r.assertedDate || '',
    };
  });
}

function mapObservations(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    let value = '';
    let unit = '';

    if (r.valueQuantity) {
      const vq = r.valueQuantity as Record<string, unknown>;
      value = String(vq.value || '');
      unit = (vq.unit as string) || '';
    } else if (r.valueString) {
      value = r.valueString as string;
    } else if (r.valueCodeableConcept) {
      const vcc = r.valueCodeableConcept as Record<string, unknown>;
      value = (vcc.text as string) || ((vcc.coding as Record<string, unknown>[]))?.[0]?.display as string || '';
    }

    return {
      type: 'observation',
      source: 'ehr',
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Lab result',
      code: firstCoding.code || '',
      value: value,
      unit: unit,
      reference_range: (r.referenceRange as Record<string, unknown>[])?.length > 0
        ? (r.referenceRange as Record<string, unknown>[])[0].text || ''
        : '',
      status: r.status || '',
      effective_date: r.effectiveDateTime || (r.effectivePeriod as Record<string, unknown>)?.start || '',
      category: ((r.category as Record<string, unknown>[]) || [])[0]?.coding?.[0]?.code || '',
    };
  });
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

    return {
      type: 'encounter',
      source: 'ehr',
      id: (r.id as string) || '',
      name: typeCoding.text || firstCoding.display || (r.class as Record<string, unknown>)?.display || 'Visit',
      status: r.status || '',
      start_date: period.start || '',
      end_date: period.end || '',
      class: (r.class as Record<string, unknown>)?.code || '',
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

// v60 (2026-04-28): Map FHIR R4 Appointment resources. Wellet Premium unlocks
// this resource on hospitals that have approved manual distribution (Duke is
// the first). The Confidential client returns 403 here, which fetchFhirResource
// swallows as 0 entries — so calling this on a Confidential connection is safe.
//
// Output shape mirrors mapEncounters closely so persistEhrData can fold it into
// health_events without conditionals. Notable differences:
//   - start_date / end_date come from the top-level start/end ISO strings
//     (Appointment doesn't use period.* like Encounter)
//   - participant.actor is the Practitioner ref (vs participant.individual on
//     Encounter) — we normalise both to {ref, name}
//   - reasonCode + serviceType + appointmentType are merged into a single
//     human-readable label so the timeline card can show "Return Visual Field"
//     not "Appointment"
function mapAppointments(resources: unknown[]) {
  const appts = (resources as Record<string, unknown>[]).map((r) => {
    // Title: prefer the most specific label available
    //  1. appointmentType.text / coding[0].display  (e.g. "FOLLOW UP")
    //  2. serviceType[0].text / coding[0].display   (e.g. "Ophthalmology")
    //  3. reasonCode[0].text / coding[0].display    (e.g. "Return Visual Field")
    //  4. description (free text)
    //  5. "Appointment"  (fallback)
    const apptType = (r.appointmentType as Record<string, unknown>) || {};
    const apptTypeCoding = ((apptType.coding as Record<string, unknown>[]) || [])[0] || {};
    const apptTypeLabel = (apptType.text as string) || (apptTypeCoding.display as string) || '';

    const serviceTypeArr = (r.serviceType as Record<string, unknown>[]) || [];
    const serviceType0 = serviceTypeArr[0] || {};
    const serviceTypeCoding = ((serviceType0.coding as Record<string, unknown>[]) || [])[0] || {};
    const serviceTypeLabel = (serviceType0.text as string) || (serviceTypeCoding.display as string) || '';

    const reasonArr = (r.reasonCode as Record<string, unknown>[]) || [];
    const reason0 = reasonArr[0] || {};
    const reasonCoding = ((reason0.coding as Record<string, unknown>[]) || [])[0] || {};
    const reasonLabel = (reason0.text as string) || (reasonCoding.display as string) || '';

    const description = (r.description as string) || '';

    // Specific clinical reason wins over generic "FOLLOW UP".
    const name = reasonLabel || apptTypeLabel || serviceTypeLabel || description || 'Appointment';

    // Providers from participant.actor (Appointment) — same {ref, name} shape
    // as visits so downstream practitioner roster code can dedupe across both.
    const participants = (r.participant as Record<string, unknown>[]) || [];
    const providers = participants.map((p) => {
      const actor = (p.actor as Record<string, unknown>) || {};
      const ref = (actor.reference as string) || '';
      const display = (actor.display as string) || '';
      return { ref, name: display };
    }).filter((p) => p.ref.startsWith('Practitioner/') || p.name);

    // Location: participant.actor where reference starts with Location/.
    let location = '';
    for (const p of participants) {
      const actor = (p.actor as Record<string, unknown>) || {};
      const ref = (actor.reference as string) || '';
      if (ref.startsWith('Location/')) {
        location = (actor.display as string) || '';
        break;
      }
    }

    return {
      type: 'appointment',
      source: 'ehr',
      id: (r.id as string) || '',
      // persistEhrData reads `name` for health_events.title and `description`
      // as fallback — we already collapsed both into name above.
      name,
      description,
      status: (r.status as string) || '',
      // persistEhrData uses start_date directly; null if Epic omitted it.
      start_date: (r.start as string) || '',
      end_date: (r.end as string) || '',
      reason: reasonLabel,
      service_type: serviceTypeLabel,
      appointment_type: apptTypeLabel,
      location,
      providers, // [{ ref, name }]
    };
  });

  // Sort soonest-upcoming first by start_date so the timeline card shows
  // "tomorrow" before "three months out".
  appts.sort((a, b) => {
    const da = a.start_date ? new Date(a.start_date as string).getTime() : 0;
    const db = b.start_date ? new Date(b.start_date as string).getTime() : 0;
    return da - db;
  });
  return appts;
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
    const qCode = (q.code as Record<string, unknown>) || {};
    const qCoding = (qCode.coding as Record<string, unknown>[]) || [];
    const display = (qCode.text as string) || (qCoding[0]?.display as string) || '';
    if (display && display !== 'MD' && display !== 'DO' && display !== 'NP' && display !== 'PA') {
      specialty = display;
      break;
    }
  }

  return {
    type: 'practitioner',
    source: 'ehr',
    name: nameText || 'Unknown Provider',
    role: role || '',
    specialty,
    phones,
    emails,
    fax,
    address: addressText,
  };
}

// Build the care team from Encounter participant references + DiagnosticReport performers.
// For each unique Practitioner reference, fetches the Practitioner resource and optionally
// PractitionerRole (for contact info / specialty / address that Epic doesn't put on Practitioner.telecom).
async function buildCareTeam(
  fhirBaseUrl: string,
  accessToken: string,
  visits: ReturnType<typeof mapEncounters>,
  appointments: ReturnType<typeof mapAppointments>,
  diagnosticReports: ReturnType<typeof mapDiagnosticReports>,
  practTele: PractitionerTelemetry[],
): Promise<ReturnType<typeof mapPractitioner>[]> {
  // Collect all unique Practitioner refs, deduped
  const seen = new Set<string>();
  const refs: Array<{ ref: string; name: string; role: string }> = [];

  // From visits
  for (const v of visits) {
    for (const prov of (v.providers || []) as Array<{ ref: string; name: string }>) {
      if (prov.ref && prov.ref.startsWith('Practitioner/') && !seen.has(prov.ref)) {
        seen.add(prov.ref);
        refs.push({ ref: prov.ref, name: prov.name, role: 'Encounter Participant' });
      }
    }
  }

  // From appointments (v60)
  for (const a of appointments) {
    for (const prov of (a.providers || []) as Array<{ ref: string; name: string }>) {
      if (prov.ref && prov.ref.startsWith('Practitioner/') && !seen.has(prov.ref)) {
        seen.add(prov.ref);
        refs.push({ ref: prov.ref, name: prov.name, role: 'Appointment Provider' });
      }
    }
  }

  // From DiagnosticReport performers (display-string only, no refs)
  // We skip those here since they don't have Practitioner refs; the care team
  // will show them if they happen to match an encounter practitioner reference.

  if (refs.length === 0) return [];

  // Fetch practitioners in parallel (fan-out, fire-and-forget on failure)
  const careTeam = await Promise.all(
    refs.map(async ({ ref, name, role }) => {
      const practitionerId = ref.replace('Practitioner/', '');
      const pResource = await fetchFhirById(fhirBaseUrl, ref, accessToken, practTele);
      if (!pResource) {
        // Return a stub with whatever display name we have from the encounter
        return { type: 'practitioner', source: 'ehr', name: name || 'Unknown Provider', role, specialty: '', phones: [], emails: [], fax: '', address: '' };
      }

      const member = mapPractitioner(pResource, role);

      // Backfill contact info from PractitionerRole if Practitioner.telecom is empty
      if (member.phones.length === 0 && member.emails.length === 0 && !member.fax) {
        const roles = await fetchPractitionerRoles(fhirBaseUrl, practitionerId, accessToken, practTele);
        if (roles.length > 0) {
          const extras = extractFromPractitionerRoles(roles);
          if (extras.phones.length > 0) member.phones = extras.phones;
          if (extras.emails.length > 0) member.emails = extras.emails;
          if (extras.fax) member.fax = extras.fax;
          if (!member.specialty && extras.specialty) member.specialty = extras.specialty;
          if (!member.address && extras.address) member.address = extras.address;
        }
      }

      return member;
    }),
  );

  return careTeam;
}

// ── JSON response helper ──
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Token refresh helper ──
// Accepts an ehr_connections row and tries to exchange the stored refresh_token
// for a new access_token. Returns { access_token, refresh_token } on success
// or throws on failure.
async function refreshAccessToken(
  conn: Record<string, unknown>,
): Promise<{ access_token: string; refresh_token: string }> {
  const tokenUrl = (conn.token_url as string) || '';
  if (!tokenUrl) throw new Error('No token_url on connection');

  const clientId = (conn.client_id as string) || '';
  const storedRefreshToken = (conn.refresh_token as string) || '';
  if (!storedRefreshToken) throw new Error('No refresh_token on connection');

  const isLegacyPublic = clientId === EPIC_LEGACY_PUBLIC_CLIENT_ID;
  const isSandboxOrNonProd =
    clientId === EPIC_NONPROD_CLIENT_ID ||
    ((conn.fhir_base_url as string) || '').includes('fhir.epic.com');

  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: storedRefreshToken,
    client_id: clientId,
  });

  if (!isLegacyPublic) {
    const creds = resolveClientCreds(isSandboxOrNonProd);
    const privateKey = await loadPrivateKey(creds.pemEnv);
    const clientAssertion = await buildClientAssertion(tokenUrl, creds.clientId, creds.kid, privateKey);
    params.set('client_id', creds.clientId);
    params.set('client_assertion_type', 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    params.set('client_assertion', clientAssertion);
  }

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${body.slice(0, 200)}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const newAccess = (json.access_token as string) || '';
  const newRefresh = (json.refresh_token as string) || storedRefreshToken;
  if (!newAccess) throw new Error('Token refresh: no access_token in response');
  return { access_token: newAccess, refresh_token: newRefresh };
}

// ── Encryption helpers (AES-GCM, 256-bit, base64url) ──
// Matches the encryption used in epic-auth to store tokens.
async function getEncryptionKey(): Promise<CryptoKey> {
  const rawKeyB64 = Deno.env.get('TOKEN_ENCRYPTION_KEY') || '';
  if (!rawKeyB64) throw new Error('Missing TOKEN_ENCRYPTION_KEY secret');
  const rawKey = Uint8Array.from(atob(rawKeyB64), (c) => c.charCodeAt(0));
  return await crypto.subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function encryptToken(token: string, key: CryptoKey): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(token);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return btoa(String.fromCharCode(...combined)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function decryptToken(encryptedB64url: string, key: CryptoKey): Promise<string> {
  const encryptedB64 = encryptedB64url.replace(/-/g, '+').replace(/_/g, '/');
  const combined = Uint8Array.from(atob(encryptedB64), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const ciphertext = combined.slice(12);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new TextDecoder().decode(decrypted);
}

// ── Per-connection fetch + persist ──────────────────────────────────────────
// Fetches all FHIR resources for ONE ehr_connections row,
// maps + persists them, returns a ConnectionResult.
// Any error is caught here so Promise.allSettled can collect all results.
async function fetchAndPersistOneConnection(
  conn: Record<string, unknown>,
  admin: ReturnType<typeof getAdminClient>,
  personId: string,
): Promise<ConnectionResult> {
  const connId = (conn.id as string) || '';
  const fhirBaseUrl = ((conn.fhir_base_url as string) || '').replace(/\/$/, '');
  const hospitalName = (conn.hospital_name as string) || null;
  const connectedProvider = (conn.connected_provider as string) || null;

  // Connection-local telemetry buckets — no shared state across parallel calls
  const localFhirTele: FhirCallTelemetry[] = [];
  const localPractTele: PractitionerTelemetry[] = [];

  let accessToken = '';
  let patientId = '';
  let tokenRefreshStatus: ConnectionResult['status'] = 'ok';
  let tokenRefreshError: string | undefined;

  try {
    const encKey = await getEncryptionKey();
    const encryptedAccess = (conn.access_token as string) || '';
    const encryptedRefresh = (conn.refresh_token as string) || '';
    if (!encryptedAccess) throw new Error('No access_token stored');

    accessToken = await decryptToken(encryptedAccess, encKey);
    patientId = (conn.patient_id as string) || '';
  } catch (decryptErr) {
    return {
      connection_id: connId,
      hospital_name: hospitalName,
      fhir_base_url: fhirBaseUrl,
      patient_id: null,
      status: 'fetch_error',
      error: `decrypt: ${(decryptErr as Error).message}`,
      patient: null,
      conditions: [], medications: [], allergies: [], observations: [],
      immunizations: [], diagnostic_reports: [], visits: [], care_team: [],
      appointments: [],
      synced_at: new Date().toISOString(),
      result_counts: { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, care_team: 0, appointments: 0, bonus: { episode_of_care: 0, nutrition_order: 0, device_use_statement: 0, device: 0, medication_dispense: 0, adverse_event: 0, flag: 0, immunization_recommendation: 0, provenance: 0 } },
      persisted: { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] },
      fhir_calls: [],
      practitioner_calls: [],
      duration_ms: 0,
      provider: 'epic',
      connected_provider: connectedProvider,
    };
  }

  // Probe token with a lightweight Patient read.
  // If 401, attempt silent refresh once before giving up.
  try {
    const probeUrl = `${fhirBaseUrl}/Patient/${patientId}`;
    const probeRes = await fetch(probeUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });

    if (probeRes.status === 401) {
      // Try refresh
      try {
        const encKey = await getEncryptionKey();
        const encryptedRefresh = (conn.refresh_token as string) || '';
        if (!encryptedRefresh) throw new Error('No refresh token available');
        const storedRefreshToken = await decryptToken(encryptedRefresh, encKey);
        const connForRefresh = { ...conn as Record<string, string>, refresh_token: storedRefreshToken };
        const { access_token: newAccess, refresh_token: newRefresh } = await refreshAccessToken(connForRefresh);

        // Re-encrypt and persist
        const newEncryptedAccess = await encryptToken(newAccess, encKey);
        const newEncryptedRefresh = await encryptToken(newRefresh, encKey);
        await admin.from('ehr_connections').update({
          access_token: newEncryptedAccess,
          refresh_token: newEncryptedRefresh,
          updated_at: new Date().toISOString(),
        }).eq('id', connId);

        accessToken = newAccess;
      } catch (refreshErr) {
        tokenRefreshStatus = 'token_refresh_failed';
        tokenRefreshError = (refreshErr as Error).message;
        // Fall through — we'll return token_refresh_failed below
      }
    }
  } catch (probeErr) {
    // Network or unexpected error during probe — log and continue (don't abort)
    console.error('probe error', (probeErr as Error).message);
  }

  if (tokenRefreshStatus === 'token_refresh_failed') {
    return {
      connection_id: connId,
      hospital_name: hospitalName,
      fhir_base_url: fhirBaseUrl,
      patient_id: patientId,
      status: 'token_refresh_failed',
      error: tokenRefreshError,
      patient: null,
      conditions: [], medications: [], allergies: [], observations: [],
      immunizations: [], diagnostic_reports: [], visits: [], care_team: [],
      appointments: [],
      synced_at: new Date().toISOString(),
      result_counts: { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, care_team: 0, appointments: 0, bonus: { episode_of_care: 0, nutrition_order: 0, device_use_statement: 0, device: 0, medication_dispense: 0, adverse_event: 0, flag: 0, immunization_recommendation: 0, provenance: 0 } },
      persisted: { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] },
      fhir_calls: localFhirTele,
      practitioner_calls: localPractTele,
      duration_ms: 0,
      provider: 'epic',
      connected_provider: connectedProvider,
    };
  }

  const t0 = Date.now();

  // Fetch all resources in parallel
  const patientQuery = `${fhirBaseUrl}/Patient/${patientId}`;
  const [patientRes, condRes, medRes, allergyRes, obsRes, immunRes, docRes, encRes, apptRes,
         bonusEocRes, bonusNutrRes, bonusDusRes, bonusDevRes, bonusMdRes, bonusAeRes, bonusFlagRes, bonusImrRes, bonusProvRes
        ] = await Promise.allSettled([
    fetch(patientQuery, { headers: { 'Authorization': `Bearer ${accessToken}`, 'Accept': 'application/fhir+json' } }),
    fetchFhirResource(fhirBaseUrl, 'Condition', accessToken, `patient=${patientId}&category=problem-list-item`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'MedicationRequest', accessToken, `patient=${patientId}&status=active,on-hold`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'AllergyIntolerance', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, `patient=${patientId}&category=laboratory,vital-signs&_sort=-date`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Immunization', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'DocumentReference', accessToken, `patient=${patientId}&_sort=-date`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Encounter', accessToken, `patient=${patientId}&_sort=-date`, localFhirTele),
    // v60: Appointment — Premium scope only; Confidential returns 403 (swallowed as [])
    fetchFhirResource(fhirBaseUrl, 'Appointment', accessToken, `patient=${patientId}&status=booked,arrived,fulfilled,waitlist&date=ge${new Date().toISOString().slice(0, 10)}`, localFhirTele),
    // v60 bonus chronic-care resources (count-only, no mapping/persistence until v61)
    fetchFhirResource(fhirBaseUrl, 'EpisodeOfCare', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'NutritionOrder', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'DeviceUseStatement', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Device', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'MedicationDispense', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'AdverseEvent', accessToken, `subject=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Flag', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'ImmunizationRecommendation', accessToken, `patient=${patientId}`, localFhirTele),
    fetchFhirResource(fhirBaseUrl, 'Provenance', accessToken, `patient=${patientId}`, localFhirTele),
  ]);

  // Unwrap patient
  let patientData: Record<string, unknown> | null = null;
  if (patientRes.status === 'fulfilled' && patientRes.value.ok) {
    try { patientData = await patientRes.value.json() as Record<string, unknown>; } catch (_e) { /* ignore */ }
  }

  const conditions = condRes.status === 'fulfilled' ? condRes.value : [];
  const medications = medRes.status === 'fulfilled' ? medRes.value : [];
  const allergies = allergyRes.status === 'fulfilled' ? allergyRes.value : [];
  const observations = obsRes.status === 'fulfilled' ? obsRes.value : [];
  const immunizations = immunRes.status === 'fulfilled' ? immunRes.value : [];
  const documentReferences = docRes.status === 'fulfilled' ? docRes.value : [];
  const encounters = encRes.status === 'fulfilled' ? encRes.value : [];
  const appointmentResources = apptRes.status === 'fulfilled' ? apptRes.value : [];
  // v60 bonus resource counts
  const bonusEpisodeOfCare = bonusEocRes.status === 'fulfilled' ? bonusEocRes.value : [];
  const bonusNutritionOrder = bonusNutrRes.status === 'fulfilled' ? bonusNutrRes.value : [];
  const bonusDeviceUseStatement = bonusDusRes.status === 'fulfilled' ? bonusDusRes.value : [];
  const bonusDevice = bonusDevRes.status === 'fulfilled' ? bonusDevRes.value : [];
  const bonusMedicationDispense = bonusMdRes.status === 'fulfilled' ? bonusMdRes.value : [];
  const bonusAdverseEvent = bonusAeRes.status === 'fulfilled' ? bonusAeRes.value : [];
  const bonusFlag = bonusFlagRes.status === 'fulfilled' ? bonusFlagRes.value : [];
  const bonusImmunizationRecommendation = bonusImrRes.status === 'fulfilled' ? bonusImrRes.value : [];
  const bonusProvenance = bonusProvRes.status === 'fulfilled' ? bonusProvRes.value : [];

  // Map resources
  const mappedConditions = mapConditions(conditions);
  const mappedMedications = mapMedications(medications);
  const mappedAllergies = mapAllergies(allergies);
  const mappedObservations = mapObservations(observations);
  const mappedImmunizations = mapImmunizations(immunizations);
  const mappedDocumentReferences = mapDocumentReferences(documentReferences);
  const mappedVisits = mapEncounters(encounters);
  const mappedAppointments = mapAppointments(appointmentResources);

  // Build care team from visits + appointments + diagnostic reports
  const mappedDiagnosticReports = mapDiagnosticReports([]);
  const careTeam = await buildCareTeam(fhirBaseUrl, accessToken, mappedVisits, mappedAppointments, mappedDiagnosticReports, localPractTele);

  // Persist
  const persistResult = await persistEhrData(
    admin,
    personId,
    {
      medications: mappedMedications,
      allergies: mappedAllergies,
      conditions: mappedConditions,
      visits: mappedVisits,
      immunizations: mappedImmunizations,
      diagnostic_reports: mappedDiagnosticReports,
      observations: mappedObservations,
      appointments: mappedAppointments,
    },
    connId,
  );

  // Update sync timestamp on ehr_connections
  await admin.from('ehr_connections').update({ last_synced_at: new Date().toISOString() }).eq('id', connId);

  return {
    connection_id: connId,
    hospital_name: hospitalName,
    fhir_base_url: fhirBaseUrl,
    patient_id: patientId,
    status: 'ok',
    patient: patientData,
    conditions: mappedConditions,
    medications: mappedMedications,
    allergies: mappedAllergies,
    observations: mappedObservations,
    immunizations: mappedImmunizations,
    diagnostic_reports: mappedDiagnosticReports,
    visits: mappedVisits,
    care_team: careTeam,
    appointments: mappedAppointments,
    synced_at: new Date().toISOString(),
    result_counts: {
      conditions: mappedConditions.length,
      medications: mappedMedications.length,
      allergies: mappedAllergies.length,
      observations: mappedObservations.length,
      immunizations: mappedImmunizations.length,
      diagnostic_reports: mappedDocumentReferences.length,
      visits: mappedVisits.length,
      care_team: careTeam.length,
      appointments: mappedAppointments.length,
      bonus: {
        episode_of_care: bonusEpisodeOfCare.length,
        nutrition_order: bonusNutritionOrder.length,
        device_use_statement: bonusDeviceUseStatement.length,
        device: bonusDevice.length,
        medication_dispense: bonusMedicationDispense.length,
        adverse_event: bonusAdverseEvent.length,
        flag: bonusFlag.length,
        immunization_recommendation: bonusImmunizationRecommendation.length,
        provenance: bonusProvenance.length,
      },
    },
    persisted: {
      medications: persistResult.medications,
      allergies: persistResult.allergies,
      health_events: persistResult.health_events,
      lab_results: persistResult.lab_results,
      vitals: persistResult.vitals,
      errors: persistResult.errors,
    },
    fhir_calls: localFhirTele,
    practitioner_calls: localPractTele,
    duration_ms: Date.now() - t0,
    provider: 'epic',
    connected_provider: connectedProvider,
  };
}

// ── Main request handler ─────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  // Reset module-level telemetry at the start of each request.
  // (These are only used as fallbacks for non-fan-out code paths.)
  currentFhirTelemetry = [];
  currentPractitionerTelemetry = [];

  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const admin = getAdminClient();

    // Look up person_id from users table
    const { data: personRow, error: personError } = await admin
      .from('users')
      .select('person_id')
      .eq('id', user.id)
      .single();

    if (personError || !personRow?.person_id) {
      return jsonResponse({ error: 'Person not found', detail: personError?.message }, 404);
    }
    const personId: string = personRow.person_id;

    // Phase 2: look up ALL ehr_connections for this person, sorted by created_at
    const { data: connections, error: connError } = await admin
      .from('ehr_connections')
      .select('*')
      .eq('person_id', personId)
      .eq('status', 'connected')
      .order('created_at', { ascending: true });

    if (connError) {
      return jsonResponse({ error: 'DB error looking up connections', detail: connError.message }, 500);
    }

    if (!connections || connections.length === 0) {
      return jsonResponse({ error: 'No EHR connection found for this user' }, 404);
    }

    // Fan-out: fetch+persist each connection in parallel
    const settled = await Promise.allSettled(
      connections.map((conn: Record<string, unknown>) =>
        fetchAndPersistOneConnection(conn, admin, personId)
      )
    );

    const connectionResults: ConnectionResult[] = settled.map((s, i) => {
      if (s.status === 'fulfilled') return s.value;
      // Rejected means an unhandled throw from fetchAndPersistOneConnection
      const conn = connections[i] as Record<string, string>;
      return {
        connection_id: conn.id || '',
        hospital_name: conn.hospital_name || null,
        fhir_base_url: conn.fhir_base_url || '',
        patient_id: conn.patient_id || null,
        status: 'fetch_error' as const,
        error: s.reason instanceof Error ? s.reason.message : String(s.reason),
        patient: null,
        conditions: [], medications: [], allergies: [], observations: [],
        immunizations: [], diagnostic_reports: [], visits: [], care_team: [],
        appointments: [],
        synced_at: new Date().toISOString(),
        result_counts: { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, care_team: 0, appointments: 0, bonus: { episode_of_care: 0, nutrition_order: 0, device_use_statement: 0, device: 0, medication_dispense: 0, adverse_event: 0, flag: 0, immunization_recommendation: 0, provenance: 0 } },
        persisted: { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] },
        fhir_calls: [],
        practitioner_calls: [],
        duration_ms: 0,
        provider: 'epic',
        connected_provider: conn.connected_provider || null,
      };
    });

    // ── Merge results into backward-compatible flat response ──────────────────
    // v40+: all keys still present at top level (for legacy frontend code that
    // reads response.conditions, response.medications, etc.).
    // v40+ also exposes the raw `connections` array under _phase2: true.

    // Aggregate across connections (dedup by lowercased name where applicable)
    function mergeArrays<T>(key: keyof ConnectionResult): T[] {
      const all: T[] = [];
      for (const c of connectionResults) {
        const arr = c[key];
        if (Array.isArray(arr)) all.push(...arr as T[]);
      }
      return all;
    }

    const allConditions = mergeArrays<ReturnType<typeof mapConditions>[0]>('conditions');
    const allMedications = mergeArrays<ReturnType<typeof mapMedications>[0]>('medications');
    const allAllergies = mergeArrays<ReturnType<typeof mapAllergies>[0]>('allergies');
    const allObservations = mergeArrays<ReturnType<typeof mapObservations>[0]>('observations');
    const allImmunizations = mergeArrays<ReturnType<typeof mapImmunizations>[0]>('immunizations');
    const allDiagnosticReports = mergeArrays<ReturnType<typeof mapDiagnosticReports>[0]>('diagnostic_reports');
    const allVisits = mergeArrays<ReturnType<typeof mapEncounters>[0]>('visits');
    const allCareTeam = mergeArrays<ReturnType<typeof mapPractitioner>>('care_team');
    const allAppointments = mergeArrays<ReturnType<typeof mapAppointments>[0]>('appointments');

    // First ok result's patient data (or first non-null)
    const firstOkResult = connectionResults.find((c) => c.status === 'ok') || connectionResults[0];
    const patientData = connectionResults.map((c) => c.patient).find((p) => p !== null) || null;

    // Aggregate persisted counts
    const totalPersisted = connectionResults.reduce((acc, c) => ({
      medications: acc.medications + c.persisted.medications,
      allergies: acc.allergies + c.persisted.allergies,
      health_events: acc.health_events + c.persisted.health_events,
      lab_results: acc.lab_results + c.persisted.lab_results,
      vitals: acc.vitals + c.persisted.vitals,
      errors: [...acc.errors, ...c.persisted.errors],
    }), { medications: 0, allergies: 0, health_events: 0, lab_results: 0, vitals: 0, errors: [] as string[] });

    // Aggregate result_counts
    const totalCounts = connectionResults.reduce((acc, c) => ({
      conditions: acc.conditions + c.result_counts.conditions,
      medications: acc.medications + c.result_counts.medications,
      allergies: acc.allergies + c.result_counts.allergies,
      observations: acc.observations + c.result_counts.observations,
      immunizations: acc.immunizations + c.result_counts.immunizations,
      diagnostic_reports: acc.diagnostic_reports + c.result_counts.diagnostic_reports,
      visits: acc.visits + c.result_counts.visits,
      care_team: acc.care_team + c.result_counts.care_team,
      appointments: acc.appointments + c.result_counts.appointments,
      bonus: {
        episode_of_care: acc.bonus.episode_of_care + c.result_counts.bonus.episode_of_care,
        nutrition_order: acc.bonus.nutrition_order + c.result_counts.bonus.nutrition_order,
        device_use_statement: acc.bonus.device_use_statement + c.result_counts.bonus.device_use_statement,
        device: acc.bonus.device + c.result_counts.bonus.device,
        medication_dispense: acc.bonus.medication_dispense + c.result_counts.bonus.medication_dispense,
        adverse_event: acc.bonus.adverse_event + c.result_counts.bonus.adverse_event,
        flag: acc.bonus.flag + c.result_counts.bonus.flag,
        immunization_recommendation: acc.bonus.immunization_recommendation + c.result_counts.bonus.immunization_recommendation,
        provenance: acc.bonus.provenance + c.result_counts.bonus.provenance,
      },
    }), { conditions: 0, medications: 0, allergies: 0, observations: 0, immunizations: 0, diagnostic_reports: 0, visits: 0, care_team: 0, appointments: 0, bonus: { episode_of_care: 0, nutrition_order: 0, device_use_statement: 0, device: 0, medication_dispense: 0, adverse_event: 0, flag: 0, immunization_recommendation: 0, provenance: 0 } });

    return new Response(
      JSON.stringify({
        _phase2: true,
        patient: patientData,
        conditions: allConditions,
        medications: allMedications,
        allergies: allAllergies,
        observations: allObservations,
        immunizations: allImmunizations,
        diagnostic_reports: allDiagnosticReports,
        visits: allVisits,
        care_team: allCareTeam,
        appointments: allAppointments,
        synced_at: new Date().toISOString(),
        result_counts: totalCounts,
        persisted: totalPersisted,
        // Raw per-connection breakdown for Phase 2 frontend
        connections: connectionResults,
      }),
      {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/json',
        },
      },
    );
  } catch (e) {
    const err = e as Record<string, unknown>;
    return jsonResponse({
      error: err?.message || 'Unknown error',
      _error_code: err?.code || null,
      _error_details: err?.details || null,
      _error_hint: err?.hint || null,
      _error_stack: err?.stack ? String(err.stack).split('\n').slice(0, 20) : null,
    }, 500);
  }
});
