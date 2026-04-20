// Supabase Edge Function: epic-auth
// Handles Epic SMART on FHIR OAuth2 + PKCE flow for EHR connections.
// This is a PUBLIC client (no client_secret) — standalone launch.
// Routes:
//   POST { action: 'start' }      — Generate PKCE challenge, return Epic authorize URL
//   POST { action: 'callback' }   — Exchange auth code for tokens via PKCE
//   POST { action: 'status' }     — Check connection status
//   POST { action: 'disconnect' } — Remove Epic connection

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

// ── Configuration ────────────────────────────────────────────────────────────
// Production Client ID (default). Sandbox used when sandbox=true query param is passed.
const EPIC_PROD_CLIENT_ID = '8ade6bac-dc9a-4318-99fd-3a0aebde1da1';
const EPIC_SANDBOX_CLIENT_ID = 'a4716f99-88d4-42fb-a9e7-03e7efbf9c90';
const EPIC_REDIRECT_URI = Deno.env.get('EPIC_REDIRECT_URI') ?? 'https://mywellet.com/epic-callback';

// Sandbox fallback endpoints (used when sandbox=true or no fhirBaseUrl provided)
const EPIC_SANDBOX_FHIR_BASE = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
const EPIC_SANDBOX_AUTHORIZE = 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize';
const EPIC_SANDBOX_TOKEN = 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token';

// SMART v2 scopes
const SMART_SCOPES = [
  'patient/Patient.read',
  'patient/AllergyIntolerance.read',
  'patient/Condition.read',
  'patient/MedicationRequest.read',
  'patient/Observation.read',
  'patient/Immunization.read',
  'patient/DiagnosticReport.read',
  'launch/patient',
  'openid',
  'fhirUser',
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

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

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Generate a cryptographically random string for PKCE code_verifier (43-128 chars)
function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// Generate a random state parameter for CSRF protection
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

// Base64 URL-encode (no padding)
function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compute SHA-256 hash and base64url-encode it for PKCE code_challenge
async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Discover SMART on FHIR authorization and token endpoints from a FHIR base URL.
// Tries .well-known/smart-configuration first, falls back to /metadata (CapabilityStatement).
async function discoverSmartEndpoints(fhirBaseUrl: string): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
}> {
  // Try .well-known/smart-configuration
  try {
    const smartUrl = `${fhirBaseUrl}/.well-known/smart-configuration`;
    const res = await fetch(smartUrl, {
      headers: { 'Accept': 'application/json' },
    });
    if (res.ok) {
      const config = await res.json();
      if (config.authorization_endpoint && config.token_endpoint) {
        return {
          authorization_endpoint: config.authorization_endpoint,
          token_endpoint: config.token_endpoint,
        };
      }
    }
  } catch (e) {
    console.warn('SMART .well-known fetch failed, trying /metadata:', e.message);
  }

  // Fallback: /metadata (CapabilityStatement)
  try {
    const metadataUrl = `${fhirBaseUrl}/metadata`;
    const res = await fetch(metadataUrl, {
      headers: { 'Accept': 'application/fhir+json' },
    });
    if (res.ok) {
      const cap = await res.json();
      const restSecurity = cap.rest?.[0]?.security;
      if (restSecurity?.extension) {
        for (const ext of restSecurity.extension) {
          if (ext.url === 'http://fhir-registry.smarthealthit.org/StructureDefinition/oauth-uris') {
            let authEndpoint = '';
            let tokenEndpoint = '';
            for (const inner of ext.extension || []) {
              if (inner.url === 'authorize') authEndpoint = inner.valueUri;
              if (inner.url === 'token') tokenEndpoint = inner.valueUri;
            }
            if (authEndpoint && tokenEndpoint) {
              return { authorization_endpoint: authEndpoint, token_endpoint: tokenEndpoint };
            }
          }
        }
      }
    }
  } catch (e) {
    console.warn('FHIR /metadata fetch failed:', e.message);
  }

  throw new Error('Could not discover SMART endpoints from ' + fhirBaseUrl);
}

// ── Main Handler ─────────────────────────────────────────────────────────────

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
    const action = body.action || '';

    // Determine sandbox vs production from body param
    const isSandbox = body.sandbox === true;
    const clientId = isSandbox ? EPIC_SANDBOX_CLIENT_ID : EPIC_PROD_CLIENT_ID;

    // ── START: Generate PKCE challenge and return Epic authorize URL ──
    if (action === 'start') {
      const { person_id, fhirBaseUrl, hospitalName } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      // Determine FHIR base URL and endpoints
      let fhirBase: string;
      let authorizeUrl: string;
      let tokenUrl: string;

      if (isSandbox || !fhirBaseUrl) {
        // Sandbox mode — use hardcoded sandbox endpoints
        fhirBase = EPIC_SANDBOX_FHIR_BASE;
        authorizeUrl = EPIC_SANDBOX_AUTHORIZE;
        tokenUrl = EPIC_SANDBOX_TOKEN;
      } else {
        // Production — discover SMART endpoints from the hospital's FHIR base URL
        fhirBase = fhirBaseUrl;
        const endpoints = await discoverSmartEndpoints(fhirBase);
        authorizeUrl = endpoints.authorization_endpoint;
        tokenUrl = endpoints.token_endpoint;
      }

      // Generate PKCE values
      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const state = generateState();

      // Upsert connection record with PKCE state (clears any prior tokens)
      await admin.from('ehr_connections').upsert({
        user_id: user.id,
        person_id: person_id,
        provider: 'epic',
        code_verifier: codeVerifier,
        state: state,
        fhir_base_url: fhirBase,
        token_url: tokenUrl,
        hospital_name: hospitalName || (isSandbox ? 'Epic Sandbox' : null),
        // Clear previous token data on re-auth
        access_token: null,
        refresh_token: null,
        token_expires_at: null,
        patient_id: null,
        connected_provider: null,
        connected_at: null,
      }, { onConflict: 'person_id' });

      // Build Epic authorize URL
      const params = new URLSearchParams({
        response_type: 'code',
        client_id: clientId,
        redirect_uri: EPIC_REDIRECT_URI,
        scope: SMART_SCOPES,
        state: state,
        aud: fhirBase,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      return jsonResponse({
        authorize_url: `${authorizeUrl}?${params.toString()}`,
      });
    }

    // ── CALLBACK: Exchange auth code for tokens via PKCE ──
    if (action === 'callback') {
      const { code, state: callbackState, person_id } = body;
      if (!code || !person_id) {
        return jsonResponse({ error: 'code and person_id are required' }, 400);
      }

      const admin = getAdminClient();

      // Retrieve the stored connection with code_verifier and state
      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .single();

      if (connError || !conn) {
        return jsonResponse({ error: 'No pending connection found' }, 404);
      }

      // Verify state parameter for CSRF protection
      if (conn.state && callbackState !== conn.state) {
        return jsonResponse({ error: 'State mismatch — possible CSRF attack' }, 400);
      }

      if (!conn.code_verifier) {
        return jsonResponse({ error: 'No PKCE code_verifier found — restart the connection flow' }, 400);
      }

      // Use the token_url stored during start, fall back to sandbox
      const tokenUrl = conn.token_url || EPIC_SANDBOX_TOKEN;

      // Determine which client_id was used (check if sandbox FHIR base)
      const connIsSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;
      const connClientId = connIsSandbox ? EPIC_SANDBOX_CLIENT_ID : EPIC_PROD_CLIENT_ID;

      // Exchange authorization code for access token (PUBLIC client — no client_secret)
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: EPIC_REDIRECT_URI,
          client_id: connClientId,
          code_verifier: conn.code_verifier,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('Epic token exchange failed:', tokenRes.status, errText);
        return jsonResponse({ error: 'Token exchange failed' }, 502);
      }

      const tokenData = await tokenRes.json();

      // Epic returns: access_token, token_type, expires_in, scope, patient (FHIR patient ID)
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      // Encrypt tokens before storing
      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      const { data: encAccessToken } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.access_token, enc_key: encKey,
      });
      const { data: encRefreshToken } = tokenData.refresh_token
        ? await admin.rpc('encrypt_ehr_token', {
            plain_token: tokenData.refresh_token, enc_key: encKey,
          })
        : { data: null };

      // Build connected_provider label
      const hospitalLabel = conn.hospital_name
        ? `${conn.hospital_name} (Epic)`
        : 'Epic MyChart';

      // Store encrypted tokens and patient context
      const { error: updateError } = await admin.from('ehr_connections')
        .update({
          access_token: encAccessToken,
          refresh_token: encRefreshToken,
          token_expires_at: expiresAt,
          patient_id: tokenData.patient || null,
          connected_provider: hospitalLabel,
          connected_at: new Date().toISOString(),
          // Clear PKCE values — no longer needed
          code_verifier: null,
          state: null,
        })
        .eq('person_id', person_id)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Token store error:', updateError);
        return jsonResponse({ error: 'Failed to store tokens' }, 500);
      }

      return jsonResponse({ success: true, expires_at: expiresAt });
    }

    // ── STATUS: Check connection status ──
    if (action === 'status') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();
      const { data: conn } = await admin.from('ehr_connections')
        .select('id, provider, connected_provider, connected_at, last_synced_at, token_expires_at')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .single();

      if (!conn || !conn.connected_at) {
        return jsonResponse({ connected: false });
      }

      return jsonResponse({
        connected: true,
        provider: conn.connected_provider,
        connected_at: conn.connected_at,
        last_synced_at: conn.last_synced_at,
        token_valid: conn.token_expires_at ? new Date(conn.token_expires_at) > new Date() : false,
      });
    }

    // ── DISCONNECT: Remove Epic connection ──
    if (action === 'disconnect') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();
      await admin.from('ehr_connections')
        .delete()
        .eq('person_id', person_id)
        .eq('user_id', user.id);

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Unknown action. Use: start, callback, status, disconnect' }, 400);

  } catch (err) {
    console.error('epic-auth error:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
});
