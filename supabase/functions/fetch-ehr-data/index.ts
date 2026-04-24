// Supabase Edge Function: fetch-ehr-data (v38 — persist sync diagnostics to ehr_sync_log and echo counts in response)
// Fetches FHIR R4 resources from the connected EHR provider (Epic),
// maps them to a simplified Wellet-friendly JSON structure,
// and returns the data to the frontend (NOT stored in Supabase).
//
// v23 CHANGE: when the stored access_token is expired, use the stored
// refresh_token (from the `offline_access` scope) to silently mint a new
// access_token via the provider's /token endpoint, re-encrypt both tokens,
// update ehr_connections, and continue the fetch. Only force a reconnect
// if the provider rejects the refresh. Previously (v22) we early-returned
// 401 on any expired access_token, which broke all pulls after ~1 hour.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

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

// Per-resource telemetry captured during a fetch. The global telemetry array
// is reset at the start of each request handler and logged once near the end
// so we can see exactly which FHIR endpoints Duke accepted / rejected /
// returned empty. Critical for debugging scope mismatches — previously an
// empty bundle and a 403 looked identical at the caller.
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

// Fetch a FHIR resource type from the EHR's FHIR endpoint, handling pagination
async function fetchFhirResource(
  fhirBaseUrl: string,
  resourceType: string,
  accessToken: string,
  queryParams?: string,
): Promise<unknown[]> {
  const entries: unknown[] = [];
  const query = queryParams ? `&${queryParams}` : '';
  let url: string | null = `${fhirBaseUrl}/${resourceType}?_count=50${query}`;

  const tele: FhirCallTelemetry = {
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

    if (tele.first_status === null) tele.first_status = res.status;

    if (!res.ok) {
      // Capture a short snippet of the error body to distinguish 403 scope
      // denials from 404 missing endpoints from 400 malformed queries.
      try {
        const body = await res.text();
        tele.error_body_snippet = body.slice(0, 200);
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
      tele.pages += 1;
      const totalVal = bundle.total;
      if (totalVal !== undefined && tele.bundle_total === null && typeof totalVal === 'number') {
        tele.bundle_total = totalVal;
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
            if (diag && tele.operation_outcomes.length < 5) {
              tele.operation_outcomes.push(diag.slice(0, 200));
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
      tele.error_body_snippet = `parse_error: ${(parseErr as Error).message}`.slice(0, 200);
      break;
    }
  }

  tele.entries_returned = entries.length;
  currentFhirTelemetry.push(tele);
  return entries;
}

// Fetch a single FHIR resource by reference (e.g. "Practitioner/abc123")
async function fetchFhirById(
  fhirBaseUrl: string,
  reference: string,
  accessToken: string,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`${fhirBaseUrl}/${reference}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });
    if (!res.ok) return null;
    return await res.json() as Record<string, unknown>;
  } catch (_e) {
    return null;
  }
}

// Fetch PractitionerRole resources for a given practitioner id.
// In Epic FHIR R4, contact info (phone/email/fax), specialty, and the
// practice address live on PractitionerRole — NOT on Practitioner.telecom.
// Returns the raw Bundle.entry array (zero or more roles), or [] on failure.
async function fetchPractitionerRoles(
  fhirBaseUrl: string,
  practitionerId: string,
  accessToken: string,
): Promise<Record<string, unknown>[]> {
  try {
    const url = `${fhirBaseUrl}/PractitionerRole?practitioner=${encodeURIComponent(practitionerId)}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });
    if (!res.ok) return [];
    const bundle = await res.json() as Record<string, unknown>;
    const entries = (bundle.entry as Record<string, unknown>[]) || [];
    return entries.map((e) => (e.resource as Record<string, unknown>) || {}).filter((r) => r && r.resourceType === 'PractitionerRole');
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

  // POST to the provider's token endpoint with grant_type=refresh_token
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: decRefresh as string,
    client_id: conn.client_id_used as string,
  });

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

  // Reset per-request FHIR call telemetry. Logged as a single line before
  // returning, so a dashboard log search for '[fetch-ehr-data] FHIR call summary'
  // surfaces per-resource HTTP status + bundle.total for every call.
  currentFhirTelemetry = [];
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

    // Get stored connection
    console.log('[fetch-ehr-data] lookup', { user_id: user.id, person_id, person_id_type: typeof person_id });
    const { data: conn, error: connError } = await admin.from('ehr_connections')
      .select('*')
      .eq('person_id', person_id)
      .eq('user_id', user.id)
      .single();

    if (connError || !conn || !conn.access_token) {
      // Diagnostic: find any rows that match on person_id OR user_id to surface the mismatch.
      const byPerson = await admin.from('ehr_connections')
        .select('id, user_id, person_id, provider, token_expires_at, has_access:access_token')
        .eq('person_id', person_id);
      const byUser = await admin.from('ehr_connections')
        .select('id, user_id, person_id, provider, token_expires_at, has_access:access_token')
        .eq('user_id', user.id);
      const diagnostic = {
        requested: { user_id: user.id, person_id, person_id_type: typeof person_id },
        connError: connError?.message,
        connError_code: connError?.code,
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
        conn_has_token: !!conn?.access_token,
      };
      console.error('[fetch-ehr-data] 404 diagnostic', diagnostic);
      return jsonResponse({ error: 'No EHR connection found for this person', _diagnostic: diagnostic }, 404);
    }
    console.log('[fetch-ehr-data] lookup hit', { conn_id: conn.id, provider: conn.provider, patient_id: conn.patient_id });

    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    if (!encKey) {
      console.error('[fetch-ehr-data] EHR_ENCRYPTION_KEY is not set');
      return jsonResponse({ error: 'server_misconfigured', message: 'Encryption key not configured' }, 500);
    }

    // Refresh the access token if it's expired (or within a 60s skew window).
    // Uses the offline_access refresh_token stored at connect time.
    const refreshed = await refreshAccessTokenIfNeeded(admin, conn, encKey);
    if (!refreshed.ok) {
      return jsonResponse({
        error: 'Token refresh failed. Please reconnect to Epic MyChart.',
        detail: refreshed.detail,
      }, 401);
    }
    const accessToken = refreshed.accessToken;
    const fhirBaseUrl = conn.fhir_base_url || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
    const patientId = conn.patient_id;

    // Build patient search param for scoped queries
    const patientParam = patientId ? `patient=${patientId}` : '';

    // Fetch Encounters with no date filter — frontend applies 2-year window
    // so user can toggle "show older" without re-hitting Epic.
    // Fetch FHIR resources in parallel from Epic's FHIR R4 endpoint
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
      careTeamsRaw,
      documentReferencesRaw,
    ] = await Promise.all([
      // Patient identity — proves which chart we are actually pulling
      patientId ? fetchFhirById(fhirBaseUrl, `Patient/${patientId}`, accessToken) : Promise.resolve(null),
      fetchFhirResource(fhirBaseUrl, 'Condition', accessToken, patientParam),
      // status=active is an Epic-supported filter — fixes the "78 amlodipine rows" bug
      fetchFhirResource(fhirBaseUrl, 'MedicationRequest', accessToken, patientParam ? `${patientParam}&status=active` : 'status=active'),
      fetchFhirResource(fhirBaseUrl, 'AllergyIntolerance', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=laboratory` : 'category=laboratory'),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=vital-signs` : 'category=vital-signs'),
      fetchFhirResource(fhirBaseUrl, 'Immunization', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'DiagnosticReport', accessToken, patientParam),
      // All encounters — UI filters to last 2 years with a "show older" toggle
      fetchFhirResource(fhirBaseUrl, 'Encounter', accessToken, patientParam),
      // Active care teams
      fetchFhirResource(fhirBaseUrl, 'CareTeam', accessToken, patientParam ? `${patientParam}&status=active` : 'status=active'),
      // Clinical notes / AVS / provider summaries (metadata only — content fetched on tap)
      fetchFhirResource(fhirBaseUrl, 'DocumentReference', accessToken, patientParam),
    ]);

    const patient = patientResource ? mapPatient(patientResource) : { id: patientId || '', name: '', birth_date: '', gender: '' };

    // Combine lab and vital observations
    const observations = [...labObservations, ...vitalObservations];

    const medicationsMapped = mapMedications(medications);
    const visitsMapped = mapEncounters(encountersRaw);

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
      refList.map((ref) => fetchFhirById(fhirBaseUrl, ref, accessToken))
    );

    // In Epic FHIR R4, Practitioner.telecom is almost always empty — phones,
    // emails, fax, and specialty live on PractitionerRole resources instead.
    // Fetch PractitionerRole?practitioner=<id> for each practitioner in
    // parallel, then merge the contact info onto the Practitioner mapping.
    const roleBundles = await Promise.all(
      refList.map((ref) => {
        const id = ref.split('/')[1] || '';
        if (!id) return Promise.resolve([] as Record<string, unknown>[]);
        return fetchPractitionerRoles(fhirBaseUrl, id, accessToken);
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
      person_id,
      practitioner_count: practitionerTelemetry.length,
      sample: practitionerTelemetry.slice(0, 10),
    });

    // Sort care team alphabetically by name
    careTeam.sort((a, b) => (a!.name || '').localeCompare(b!.name || ''));

    // Map FHIR resources to Wellet-friendly format
    const result = {
      patient, // { id, name, birth_date, gender } — for UI verification
      expected_patient_id: patientId || '',
      conditions: mapConditions(conditions),
      medications: medicationsMapped,
      allergies: mapAllergies(allergies),
      observations: mapObservations(observations),
      immunizations: mapImmunizations(immunizations),
      diagnostic_reports: mapDiagnosticReports(diagnosticReports),
      visits: visitsMapped,
      care_team: careTeam,
      provider: conn.connected_provider || 'Epic MyChart',
      synced_at: new Date().toISOString(),
    };

    // Update last_synced_at
    await admin.from('ehr_connections').update({
      last_synced_at: result.synced_at,
    }).eq('id', conn.id);

    // Build per-resource counts — used for both log line and persisted diagnostics row
    const resultCounts = {
      conditions: result.conditions.length,
      medications: result.medications.length,
      allergies: result.allergies.length,
      observations: result.observations.length,
      immunizations: result.immunizations.length,
      diagnostic_reports: result.diagnostic_reports.length,
      visits: result.visits.length,
      care_team: result.care_team.length,
    };

    // One-line per-resource summary: status, bundle.total (when Epic sends it),
    // entries actually returned, and any OperationOutcome / error-body snippet.
    // This is the telemetry that lets us distinguish "Duke denied the scope"
    // from "patient has no data" without another redeploy.
    console.log('[fetch-ehr-data] FHIR call summary', {
      person_id,
      patient_id: patientId || null,
      calls: currentFhirTelemetry,
      result_counts: resultCounts,
    });

    // Persist a diagnostics row so we can query it from SQL without relying on
    // log scrapers (which only surface HTTP access logs, not console output).
    // Best-effort — never blocks the response.
    try {
      await admin.from('ehr_sync_log').insert({
        person_id,
        user_id: user.id,
        provider: conn.provider || null,
        patient_id: patientId || null,
        expected_patient_id: patientId || null,
        patient_name: (patient && (patient as Record<string, unknown>).name as string) || null,
        result_counts: resultCounts,
        fhir_calls: currentFhirTelemetry,
        duration_ms: Date.now() - t0,
        status: 200,
        error_message: null,
      });
    } catch (logErr) {
      console.error('[fetch-ehr-data] ehr_sync_log insert failed', logErr);
    }

    // Also include a lightweight diagnostic block on the response. Safe to
    // ship — no PHI, just counts and FHIR call status codes. Lets the client
    // console surface the same info without a round trip to the DB.
    (result as Record<string, unknown>)._diagnostic = {
      result_counts: resultCounts,
      fhir_calls: currentFhirTelemetry,
      duration_ms: Date.now() - t0,
    };

    return jsonResponse(result);

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
