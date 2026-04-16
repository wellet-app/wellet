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
// Sandbox Client ID — switch to production by setting EPIC_CLIENT_ID env var
const EPIC_CLIENT_ID = Deno.env.get('EPIC_CLIENT_ID') ?? 'a4716f99-88d4-42fb-a9e7-03e7efbf9c90';
const EPIC_REDIRECT_URI = Deno.env.get('EPIC_REDIRECT_URI') ?? 'https://mywellet.com/epic-callback';

// Sandbox endpoints (override via env vars for production / other Epic instances)
const EPIC_FHIR_BASE_URL = Deno.env.get('EPIC_FHIR_BASE_URL') ?? 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
const EPIC_AUTHORIZE_URL = Deno.env.get('EPIC_AUTHORIZE_URL') ?? 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize';
const EPIC_TOKEN_URL = Deno.env.get('EPIC_TOKEN_URL') ?? 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token';

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

    // ── START: Generate PKCE challenge and return Epic authorize URL ──
    if (action === 'start') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

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
        fhir_base_url: EPIC_FHIR_BASE_URL,
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
        client_id: EPIC_CLIENT_ID,
        redirect_uri: EPIC_REDIRECT_URI,
        scope: SMART_SCOPES,
        state: state,
        aud: EPIC_FHIR_BASE_URL,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      const authorizeUrl = `${EPIC_AUTHORIZE_URL}?${params.toString()}`;

      return jsonResponse({
        authorize_url: authorizeUrl,
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
      if (callbackState && conn.state && callbackState !== conn.state) {
        return jsonResponse({ error: 'State mismatch — possible CSRF attack' }, 400);
      }

      if (!conn.code_verifier) {
        return jsonResponse({ error: 'No PKCE code_verifier found — restart the connection flow' }, 400);
      }

      // Exchange authorization code for access token (PUBLIC client — no client_secret)
      const tokenRes = await fetch(EPIC_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: EPIC_REDIRECT_URI,
          client_id: EPIC_CLIENT_ID,
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

      // Store tokens and patient context
      const { error: updateError } = await admin.from('ehr_connections')
        .update({
          access_token: tokenData.access_token,
          refresh_token: tokenData.refresh_token || null,
          token_expires_at: expiresAt,
          patient_id: tokenData.patient || null,
          connected_provider: 'Epic MyChart',
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
