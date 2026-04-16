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
        if (e.resource) entries.push(e.resource);
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

function mapMedications(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const medCode = (r.medicationCodeableConcept as Record<string, unknown>) || {};
    const coding = (medCode.coding as Record<string, unknown>[]) || [];
    const firstCoding = coding[0] || {};
    const dosage = (r.dosage as Record<string, unknown>[]) || [];
    const firstDosage = dosage[0] || {};
    const timing = (firstDosage.timing as Record<string, unknown>) || {};
    const repeat = (timing.repeat as Record<string, unknown>) || {};

    return {
      type: 'medication',
      source: 'ehr',
      name: medCode.text || firstCoding.display || 'Unknown medication',
      code: firstCoding.code || '',
      status: r.status || '',
      dosage: (firstDosage.text as string) || '',
      frequency: repeat.frequency ? `${repeat.frequency}x per ${repeat.period || ''} ${repeat.periodUnit || ''}`.trim() : '',
      date_asserted: r.dateAsserted || r.authoredOn || '',
    };
  });
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

function mapEncounters(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const typeCoding = ((r.type as Record<string, unknown>[]) || [])[0];
    const coding = (typeCoding?.coding as Record<string, unknown>[]) || [];
    const firstCoding = coding[0] || {};
    const period = (r.period as Record<string, unknown>) || {};

    return {
      type: 'encounter',
      source: 'ehr',
      name: typeCoding?.text || firstCoding.display || (r.class as Record<string, unknown>)?.display || 'Visit',
      status: r.status || '',
      start_date: period.start || '',
      end_date: period.end || '',
      class: (r.class as Record<string, unknown>)?.code || '',
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

function mapDiagnosticReports(resources: unknown[]) {
  return (resources as Record<string, unknown>[]).map((r) => {
    const coding = (r.code as Record<string, unknown>)?.coding as Record<string, unknown>[] || [];
    const firstCoding = coding[0] || {};
    const categories = (r.category as Record<string, unknown>[]) || [];
    const firstCategory = categories.length > 0
      ? ((categories[0].coding as Record<string, unknown>[]) || [])[0]?.display || categories[0].text || ''
      : '';

    return {
      type: 'diagnostic_report',
      source: 'ehr',
      name: (r.code as Record<string, unknown>)?.text || firstCoding.display || 'Diagnostic Report',
      code: firstCoding.code || '',
      status: r.status || '',
      category: firstCategory,
      effective_date: r.effectiveDateTime || (r.effectivePeriod as Record<string, unknown>)?.start || '',
      issued: r.issued || '',
    };
  });
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

    const accessToken = conn.access_token;
    const fhirBaseUrl = conn.fhir_base_url || 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
    const patientId = conn.patient_id;

    // Build patient search param for scoped queries
    const patientParam = patientId ? `patient=${patientId}` : '';

    // Fetch all FHIR resource types in parallel from Epic's FHIR R4 endpoint
    const [conditions, medications, allergies, labObservations, vitalObservations, immunizations, diagnosticReports] = await Promise.all([
      fetchFhirResource(fhirBaseUrl, 'Condition', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'MedicationRequest', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'AllergyIntolerance', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=laboratory` : 'category=laboratory'),
      fetchFhirResource(fhirBaseUrl, 'Observation', accessToken, patientParam ? `${patientParam}&category=vital-signs` : 'category=vital-signs'),
      fetchFhirResource(fhirBaseUrl, 'Immunization', accessToken, patientParam),
      fetchFhirResource(fhirBaseUrl, 'DiagnosticReport', accessToken, patientParam),
    ]);

    // Combine lab and vital observations
    const observations = [...labObservations, ...vitalObservations];

    // Map FHIR resources to Wellet-friendly format
    const result = {
      conditions: mapConditions(conditions),
      medications: mapMedications(medications),
      allergies: mapAllergies(allergies),
      observations: mapObservations(observations),
      immunizations: mapImmunizations(immunizations),
      diagnostic_reports: mapDiagnosticReports(diagnosticReports),
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
