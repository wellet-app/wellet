// Supabase Edge Function: fetch-ehr-data
// Fetches FHIR R4 resources from the connected EHR provider (Epic),
// maps them to a simplified Wellet-friendly JSON structure,
// and returns the data to the frontend (NOT stored in Supabase).

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

  while (url && entries.length < 200) {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Accept': 'application/fhir+json',
      },
    });

    if (!res.ok) {
      console.error(`FHIR fetch ${resourceType} failed: ${res.status}`);
      break;
    }

    const bundle = await res.json();
    if (bundle.entry) {
      for (const e of bundle.entry) {
        // Skip OperationOutcome entries (Epic returns these as warnings)
        if (e.resource && e.resource.resourceType !== 'OperationOutcome') entries.push(e.resource);
      }
    }

    // Follow next page link
    url = null;
    if (bundle.link) {
      const nextLink = bundle.link.find((l: { relation: string; url: string }) => l.relation === 'next');
      if (nextLink) url = nextLink.url;
    }
  }

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
    const { data: conn, error: connError } = await admin.from('ehr_connections')
      .select('*')
      .eq('person_id', person_id)
      .eq('user_id', user.id)
      .single();

    if (connError || !conn || !conn.access_token) {
      return jsonResponse({ error: 'No EHR connection found for this person' }, 404);
    }

    // Check token expiry — Epic public clients don't issue refresh tokens
    if (conn.token_expires_at && new Date(conn.token_expires_at) <= new Date()) {
      return jsonResponse({ error: 'Token expired. Please reconnect to Epic MyChart.' }, 401);
    }

    // Decrypt the stored access token
    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    const { data: decAccessToken } = await admin.rpc('decrypt_ehr_token', {
      encrypted_token: conn.access_token, enc_key: encKey,
    });
    const accessToken = decAccessToken || conn.access_token;
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
    ]);

    const patient = patientResource ? mapPatient(patientResource) : { id: patientId || '', name: '', birth_date: '', gender: '' };

    // Combine lab and vital observations
    const observations = [...labObservations, ...vitalObservations];

    const medicationsMapped = mapMedications(medications);
    const visitsMapped = mapEncounters(encountersRaw);

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
    const careTeam = practitionerResources
      .map((p, i) => p ? mapPractitioner(p, roleByRef[refList[i]]) : null)
      .filter((p) => p !== null) as ReturnType<typeof mapPractitioner>[];

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

    return jsonResponse(result);

  } catch (err) {
    console.error('fetch-ehr-data error:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
});
