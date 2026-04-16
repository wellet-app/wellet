// Supabase Edge Function: fetch-ehr-data
// Fetches FHIR resources from 1upHealth for a connected person,
// maps them to a simplified Wellet-friendly JSON structure,
// and returns the data to the frontend (NOT stored in Supabase).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

const ONEUP_CLIENT_ID = Deno.env.get('ONEUP_CLIENT_ID') ?? '';
const ONEUP_CLIENT_SECRET = Deno.env.get('ONEUP_CLIENT_SECRET') ?? '';
const ONEUP_API_BASE = 'https://api.1up.health';
const ONEUP_AUTH_BASE = 'https://auth.1up.health';
const FHIR_BASE = `${ONEUP_API_BASE}/fhir/r4`;

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

// Refresh expired tokens
async function refreshTokens(refreshToken: string) {
  const res = await fetch(`${ONEUP_AUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ONEUP_CLIENT_ID,
      client_secret: ONEUP_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error('Token refresh failed');
  return await res.json();
}

// Fetch a FHIR resource type, handling pagination
async function fetchFhirResource(resourceType: string, accessToken: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  let url: string | null = `${FHIR_BASE}/${resourceType}?_count=50`;

  while (url && entries.length < 200) {
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
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

    let accessToken = conn.access_token;

    // Refresh token if expired
    if (conn.token_expires_at && new Date(conn.token_expires_at) <= new Date()) {
      if (!conn.refresh_token) {
        return jsonResponse({ error: 'Token expired and no refresh token available' }, 401);
      }

      const refreshed = await refreshTokens(conn.refresh_token);
      accessToken = refreshed.access_token;
      const newExpiry = new Date(Date.now() + (refreshed.expires_in || 7200) * 1000).toISOString();

      await admin.from('ehr_connections').update({
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || conn.refresh_token,
        token_expires_at: newExpiry,
      }).eq('id', conn.id);
    }

    // Fetch all FHIR resource types in parallel
    const [conditions, medications, allergies, observations, encounters, procedures] = await Promise.all([
      fetchFhirResource('Condition', accessToken),
      fetchFhirResource('MedicationStatement', accessToken).then(async (stmts) => {
        // Also try MedicationRequest if MedicationStatement is empty
        if (stmts.length === 0) {
          return await fetchFhirResource('MedicationRequest', accessToken);
        }
        return stmts;
      }),
      fetchFhirResource('AllergyIntolerance', accessToken),
      fetchFhirResource('Observation', accessToken),
      fetchFhirResource('Encounter', accessToken),
      fetchFhirResource('Procedure', accessToken),
    ]);

    // Map FHIR resources to Wellet-friendly format
    const result = {
      conditions: mapConditions(conditions),
      medications: mapMedications(medications),
      allergies: mapAllergies(allergies),
      observations: mapObservations(observations),
      encounters: mapEncounters(encounters),
      procedures: mapProcedures(procedures),
      provider: conn.connected_provider || 'EHR Provider',
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
