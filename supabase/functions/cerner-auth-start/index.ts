// Supabase Edge Function: cerner-auth-start
// Cerner Wave 1 — SMART on FHIR OAuth2 authorization start for Cerner EHR connections.
// Public client (no client_secret). Uses PKCE is not required by Cerner public app profile
// but state is used for CSRF protection.
//
// POST body: { person_id: string, tenant_id?: string }
// Returns: 302 redirect to Cerner authorize URL
//          OR JSON { authorize_url } for clients that handle redirects themselves.
//
// Voice rules: loved one / family member — not parent. notices / watches for — not track/monitor.
// CareSignals is one word. No emojis, no italics, no exclamation points.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

// ── Cerner sandbox configuration ─────────────────────────────────────────────
const CERNER_CLIENT_ID = '3b98223e-17ec-4a8f-ac77-f4fdbb242371';
const CERNER_REDIRECT_URI = Deno.env.get('CERNER_REDIRECT_URI') ??
  'https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/cerner-auth-callback';
const CERNER_SANDBOX_TENANT_ID = 'ec2458f2-1e24-41c8-b71b-0e701af7583d';
const CERNER_SANDBOX_FHIR_BASE =
  'https://fhir-open.cerner.com/r4/ec2458f2-1e24-41c8-b71b-0e701af7583d';
const CERNER_SANDBOX_AUTH_URL =
  'https://authorization.cerner.com/tenants/ec2458f2-1e24-41c8-b71b-0e701af7583d/protocols/oauth2/profiles/smart-v1/personas/patient/authorize';
const CERNER_SANDBOX_TOKEN_URL =
  'https://authorization.cerner.com/tenants/ec2458f2-1e24-41c8-b71b-0e701af7583d/protocols/oauth2/profiles/smart-v1/token';

// Scopes requested from Cerner. DocumentReference is included at Patient tier
// (Cerner exposes it without an additional gateway unlike Epic).
const CERNER_SCOPES = [
  'launch/patient',
  'openid',
  'fhirUser',
  'offline_access',
  'patient/Patient.read',
  'patient/Observation.read',
  'patient/MedicationRequest.read',
  'patient/AllergyIntolerance.read',
  'patient/Condition.read',
  'patient/DocumentReference.read',
  'patient/Encounter.read',
  'patient/Immunization.read',
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  let binary = '';
  for (const byte of array) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

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

// Resolve Cerner endpoint URLs from the cerner_endpoints table, falling back
// to the hardcoded sandbox values if no row matches.
async function resolveCernerEndpoints(
  admin: ReturnType<typeof getAdminClient>,
  tenantId: string,
): Promise<{
  fhirBaseUrl: string;
  authUrl: string;
  tokenUrl: string;
  hospitalName: string;
}> {
  const { data: endpoint } = await admin
    .from('cerner_endpoints')
    .select('fhir_base_url, auth_url, token_url, name')
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (endpoint) {
    return {
      fhirBaseUrl: endpoint.fhir_base_url,
      authUrl: endpoint.auth_url,
      tokenUrl: endpoint.token_url,
      hospitalName: endpoint.name,
    };
  }

  // Sandbox fallback
  return {
    fhirBaseUrl: CERNER_SANDBOX_FHIR_BASE,
    authUrl: CERNER_SANDBOX_AUTH_URL,
    tokenUrl: CERNER_SANDBOX_TOKEN_URL,
    hospitalName: 'Cerner Sandbox',
  };
}

// ── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
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
    const { person_id, tenant_id } = body;

    if (!person_id) {
      return jsonResponse({ error: 'person_id is required' }, 400);
    }

    const resolvedTenantId = tenant_id || CERNER_SANDBOX_TENANT_ID;
    const admin = getAdminClient();

    const { fhirBaseUrl, authUrl, tokenUrl, hospitalName } =
      await resolveCernerEndpoints(admin, resolvedTenantId);

    const state = generateState();

    // Reuse or create a pending ehr_connections row — same pattern as epic-auth.
    const { data: existingRows, error: existingErr } = await admin
      .from('ehr_connections')
      .select('id, status')
      .eq('person_id', person_id)
      .eq('fhir_base_url', fhirBaseUrl)
      .in('status', ['pending', 'needs_reconnect', 'superseded'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingErr) {
      console.warn('[cerner-auth-start] existing row lookup failed', existingErr);
    }

    const reusable = existingRows && existingRows[0];
    let insertError: { message: string } | null = null;

    if (reusable) {
      const { error: updateError } = await admin
        .from('ehr_connections')
        .update({
          user_id: user.id,
          provider: 'cerner',
          state,
          token_url: tokenUrl,
          hospital_name: hospitalName,
          status: 'pending',
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          patient_id: null,
          connected_provider: null,
          connected_at: null,
          needs_reconnect: false,
          // Cerner public app does not use PKCE — clear any stale verifier.
          code_verifier: null,
        })
        .eq('id', reusable.id);
      if (updateError) {
        console.error('[cerner-auth-start] reuse row update failed', updateError);
        insertError = updateError;
      } else {
        console.log('[cerner-auth-start] reused existing row', { row_id: reusable.id });
      }
    } else {
      const { error: insErr } = await admin.from('ehr_connections').insert({
        user_id: user.id,
        person_id,
        provider: 'cerner',
        state,
        fhir_base_url: fhirBaseUrl,
        token_url: tokenUrl,
        hospital_name: hospitalName,
        status: 'pending',
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        patient_id: null,
        connected_provider: null,
        connected_at: null,
        code_verifier: null,
      });
      insertError = insErr;
    }

    if (insertError) {
      console.error('[cerner-auth-start] insert/update failed', insertError);
      return jsonResponse({
        error: 'connection_start_failed',
        message: 'Could not start a new EHR connection. Please try again.',
        detail: insertError.message,
      }, 500);
    }

    // Build Cerner authorize URL.
    // Cerner requires aud to equal the FHIR base URL.
    // Cerner escapes ampersands as \u0026 in link.url responses — the params
    // we generate here use standard & which is correct for a URL query string.
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CERNER_CLIENT_ID,
      redirect_uri: CERNER_REDIRECT_URI,
      scope: CERNER_SCOPES,
      state,
      aud: fhirBaseUrl,
    });

    const authorizeUrl = `${authUrl}?${params.toString()}`;

    console.log('[cerner-auth-start] generated authorize URL', {
      person_id,
      tenant_id: resolvedTenantId,
      state: state.slice(0, 8) + '...',
    });

    // Return JSON so the mobile app can open the URL in a system browser.
    return jsonResponse({ authorize_url: authorizeUrl });
  } catch (err) {
    console.error('[cerner-auth-start] unhandled error', err);
    return jsonResponse({ error: (err as Error).message || 'Internal server error' }, 500);
  }
});
