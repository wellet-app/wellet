// Supabase Edge Function: va-auth
// Handles VA Lighthouse SMART on FHIR OAuth2 flow for VA EHR connections.
// PUBLIC CLIENT (PKCE only - no client_assertion, no client_secret).
// VA Lighthouse supports both client-public and client-confidential-symmetric;
// we use client-public+PKCE because (a) it matches our mobile/web posture and
// (b) Wellet is a SPA that cannot safely hold a confidential symmetric secret.
//
// Routes:
//   POST { action: 'start' }      - Generate PKCE challenge, return VA authorize URL
//   POST { action: 'callback' }   - Exchange auth code for tokens (PKCE)
//   POST { action: 'refresh' }    - Exchange refresh_token for new access_token
//   POST { action: 'status' }     - Check connection status
//   POST { action: 'disconnect' } - Remove VA connection
//
// References:
//   Sandbox SMART config: https://sandbox-api.va.gov/services/fhir/v0/r4/.well-known/smart-configuration
//   Dev portal:           https://developer.va.gov/explore/api/patient-health/sandbox-access

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { logSignupError } from '../_shared/log-signup-error.ts';

// ── Configuration ────────────────────────────────────────────────────────────

// Sandbox client (registered 2026-05-23). Production client will be issued
// after Lighthouse production-access review; we'll switch on body.sandbox=false
// once the prod secrets are in place.
const VA_SANDBOX_CLIENT_ID = '0oa1ao6rezk9V5D9u2p8';

// 2026-05-23: VA Lighthouse registered our sandbox app with redirect URI
// https://mywellet.com/oauth/callback (see the welcome email from VA API
// Platform team). Must match exactly or we get invalid_request from the
// authorize endpoint. /oauth/callback is the canonical OAuth callback path
// for any future provider we add - VA-specific routing happens client-side
// based on the state token, not the URL path.
const VA_REDIRECT_URI = Deno.env.get('VA_REDIRECT_URI') ?? 'https://mywellet.com/oauth/callback';

// Sandbox endpoints (verified via .well-known/smart-configuration).
const VA_SANDBOX_FHIR_BASE = 'https://sandbox-api.va.gov/services/fhir/v0/r4';
const VA_SANDBOX_AUTHORIZE = 'https://sandbox-api.va.gov/oauth2/authorization';
const VA_SANDBOX_TOKEN = 'https://sandbox-api.va.gov/oauth2/token';

// Production endpoints (Lighthouse). Reserved for after production-access
// approval - kept here so the prod branch in resolveEndpoints() is a one-line
// flip rather than a search-and-replace later.
const VA_PROD_FHIR_BASE = 'https://api.va.gov/services/fhir/v0/r4';
const VA_PROD_AUTHORIZE = 'https://api.va.gov/oauth2/authorization';
const VA_PROD_TOKEN = 'https://api.va.gov/oauth2/token';

// SMART v2 scopes. VA Lighthouse's scopes_supported (sandbox, verified
// 2026-05-23) does NOT include MedicationDispense, CareTeam, MedicationStatement,
// launch/patient, openid, or fhirUser - requesting any of them causes the
// authorize step to reject with "invalid_scope". The full advertised allow-list
// (per https://sandbox-api.va.gov/services/fhir/v0/r4/.well-known/smart-configuration)
// is offline_access + patient/{resource}.read for the 19 FHIR R4 resources VA
// exposes. We request only the clinical resources Wellet actually persists.
// Appointment.read added 2026-05-23 - VA does support it and fetch-ehr-data
// already maps Appointment to the Before-visit card.
const SMART_SCOPES = [
  'patient/Patient.read',
  'patient/AllergyIntolerance.read',
  'patient/Appointment.read',
  'patient/Condition.read',
  'patient/MedicationRequest.read',
  'patient/Observation.read',
  'patient/Immunization.read',
  'patient/DiagnosticReport.read',
  'patient/Encounter.read',
  'patient/Procedure.read',
  'patient/DocumentReference.read',
  'patient/Practitioner.read',
  'patient/PractitionerRole.read',
  'offline_access',
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.error('[va-auth] No Authorization header');
    return { user: null, diag: 'no_authorization_header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[va-auth] Missing env vars', { hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey });
    return { user: null, diag: 'missing_env' };
  }

  const tokenMatch = authHeader.match(/Bearer\s+(.+)/i);
  const token = tokenMatch ? tokenMatch[1] : '';
  const tokenFingerprint = token ? token.slice(0, 8) + '...' + token.slice(-4) + ' (len=' + token.length + ')' : 'EMPTY';

  const userClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });

  try {
    const { data: { user }, error } = await userClient.auth.getUser();
    if (error) {
      console.error('[va-auth] getUser error', { msg: error.message, status: (error as any).status, token: tokenFingerprint });
      return { user: null, diag: 'getUser_error:' + error.message };
    }
    if (!user) {
      console.error('[va-auth] getUser returned null user', { token: tokenFingerprint });
      return { user: null, diag: 'getUser_null_user' };
    }
    return { user, diag: 'ok' };
  } catch (e) {
    console.error('[va-auth] getUser threw', { err: String(e), token: tokenFingerprint });
    return { user: null, diag: 'getUser_threw:' + String(e) };
  }
}

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

function generateCodeVerifier(): string {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

function base64UrlEncode(buffer: Uint8Array): string {
  let binary = '';
  for (const byte of buffer) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Resolve (client_id, fhirBase, authorizeUrl, tokenUrl) for the current
// environment. Production secrets aren't issued yet - sandbox is the only
// live path until Lighthouse production-access approval lands.
function resolveEndpoints(isSandbox: boolean): {
  clientId: string;
  fhirBase: string;
  authorizeUrl: string;
  tokenUrl: string;
} {
  if (isSandbox) {
    return {
      clientId: VA_SANDBOX_CLIENT_ID,
      fhirBase: VA_SANDBOX_FHIR_BASE,
      authorizeUrl: VA_SANDBOX_AUTHORIZE,
      tokenUrl: VA_SANDBOX_TOKEN,
    };
  }
  // Production. VA_PROD_CLIENT_ID is read from env so we can flip without
  // a code redeploy once the prod client is issued.
  const prodClientId = Deno.env.get('VA_PROD_CLIENT_ID') ?? '';
  return {
    clientId: prodClientId,
    fhirBase: VA_PROD_FHIR_BASE,
    authorizeUrl: VA_PROD_AUTHORIZE,
    tokenUrl: VA_PROD_TOKEN,
  };
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
    const authResult = await getAuthenticatedUser(req);
    const user = authResult.user;
    if (!user) {
      return jsonResponse({ error: 'Unauthorized', diag: authResult.diag }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const action = body.action || '';

    // Default to sandbox until production-access is approved. Callers can
    // pass sandbox=false explicitly once VA_PROD_CLIENT_ID is set.
    const isSandbox = body.sandbox !== false;
    const ep = resolveEndpoints(isSandbox);

    if (!ep.clientId) {
      return jsonResponse({
        error: 'va_client_not_configured',
        message: 'VA production client is not configured yet. Sandbox is the only available environment.',
      }, 500);
    }

    // ── START: Generate PKCE challenge and return VA authorize URL ──
    if (action === 'start') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const state = generateState();

      // Mirror epic-auth's "reuse an existing pending/needs_reconnect/superseded
      // row if one exists" pattern so dead rows don't accumulate across
      // reconnect attempts. The partial unique index
      // idx_ehr_connections_person_fhir_connected only enforces uniqueness
      // among CONNECTED rows, so multiple pending rows for the same
      // (person_id, fhir_base_url) are tolerated but messy.
      const { data: existingRows, error: existingErr } = await admin
        .from('ehr_connections')
        .select('id, status')
        .eq('person_id', person_id)
        .eq('fhir_base_url', ep.fhirBase)
        .in('status', ['pending', 'needs_reconnect', 'superseded'])
        .order('created_at', { ascending: false })
        .limit(1);
      if (existingErr) {
        console.error('[va-auth] start existing-row lookup failed', { err: existingErr });
      }
      const reusable = existingRows && existingRows[0];

      let insertError: { message: string } | null = null;
      if (reusable) {
        const { error: updateError } = await admin.from('ehr_connections')
          .update({
            user_id: user.id,
            provider: 'va',
            code_verifier: codeVerifier,
            state: state,
            token_url: ep.tokenUrl,
            hospital_name: isSandbox ? 'VA Lighthouse Sandbox' : 'Department of Veterans Affairs',
            status: 'pending',
            access_token: null,
            refresh_token: null,
            token_expires_at: null,
            patient_id: null,
            connected_provider: null,
            connected_at: null,
            needs_reconnect: false,
          })
          .eq('id', reusable.id);
        if (updateError) {
          console.error('[va-auth] start reuse-row update failed', { err: updateError, row_id: reusable.id });
          insertError = updateError;
        } else {
          console.log('[va-auth] start reused existing row', { row_id: reusable.id, prior_status: reusable.status });
        }
      } else {
        const { error: insErr } = await admin.from('ehr_connections').insert({
          user_id: user.id,
          person_id: person_id,
          provider: 'va',
          code_verifier: codeVerifier,
          state: state,
          fhir_base_url: ep.fhirBase,
          token_url: ep.tokenUrl,
          hospital_name: isSandbox ? 'VA Lighthouse Sandbox' : 'Department of Veterans Affairs',
          status: 'pending',
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          patient_id: null,
          connected_provider: null,
          connected_at: null,
        });
        insertError = insErr;
      }
      if (insertError) {
        console.error('[va-auth] start insert failed', { err: insertError });
        return jsonResponse({
          error: 'connection_start_failed',
          message: 'Could not start a new VA connection. Please try again.',
          detail: insertError.message,
        }, 500);
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: ep.clientId,
        redirect_uri: VA_REDIRECT_URI,
        scope: SMART_SCOPES,
        state: state,
        aud: ep.fhirBase,
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
      });

      return jsonResponse({
        authorize_url: `${ep.authorizeUrl}?${params.toString()}`,
      });
    }

    // ── CALLBACK: Exchange auth code for tokens (PKCE only - no client_assertion) ──
    if (action === 'callback') {
      const { code, state: callbackState, person_id } = body;
      if (!code || !person_id) {
        return jsonResponse({ error: 'code and person_id are required' }, 400);
      }

      const admin = getAdminClient();

      // Look up the pending connection by `state` (globally unique per OAuth
      // attempt) and verify both user_id and person_id match.
      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('state', callbackState)
        .eq('user_id', user.id)
        .maybeSingle();

      if (connError || !conn) {
        return jsonResponse({ error: 'No pending connection found' }, 404);
      }

      if (conn.person_id !== person_id) {
        return jsonResponse({ error: 'State mismatch - possible CSRF attack' }, 400);
      }

      if (!conn.code_verifier) {
        return jsonResponse({ error: 'No PKCE code_verifier found. Restart the connection flow.' }, 400);
      }

      const tokenUrl = conn.token_url || ep.tokenUrl;
      const connIsSandbox = conn.fhir_base_url === VA_SANDBOX_FHIR_BASE;
      const connEp = resolveEndpoints(connIsSandbox);

      // Public client token exchange: client_id in body, no client_secret,
      // no client_assertion. PKCE code_verifier proves possession.
      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: VA_REDIRECT_URI,
          client_id: connEp.clientId,
          code_verifier: conn.code_verifier,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('[va-auth] token exchange failed', { status: tokenRes.status, body: errText.slice(0, 400) });
        return jsonResponse({
          error: 'Token exchange failed',
          va_status: tokenRes.status,
          va_body: errText.slice(0, 400),
        }, 502);
      }

      const tokenData = await tokenRes.json();
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      if (!tokenData.access_token) {
        console.error('[va-auth] VA returned no access_token', { resp: JSON.stringify(tokenData) });
        return jsonResponse({ error: 'No access token returned from provider' }, 502);
      }

      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      if (!encKey) {
        return jsonResponse({
          error: 'server_misconfigured',
          message: 'Server encryption key is not configured. Please contact support.',
        }, 500);
      }

      const { data: encAccessToken, error: encAccessErr } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.access_token, enc_key: encKey,
      });
      if (encAccessErr || !encAccessToken) {
        return jsonResponse({
          error: 'encryption_failed',
          message: 'Failed to encrypt access token',
          detail: encAccessErr?.message,
        }, 500);
      }

      let encRefreshToken: string | null = null;
      if (tokenData.refresh_token) {
        const { data: encR, error: encRErr } = await admin.rpc('encrypt_ehr_token', {
          plain_token: tokenData.refresh_token, enc_key: encKey,
        });
        if (encRErr || !encR) {
          return jsonResponse({
            error: 'encryption_failed',
            message: 'Failed to encrypt refresh token',
            detail: encRErr?.message,
          }, 500);
        }
        encRefreshToken = encR;
      }

      const hospitalLabel = connIsSandbox
        ? 'VA Lighthouse Sandbox'
        : 'Department of Veterans Affairs';

      const scopeReturned = typeof tokenData.scope === 'string' ? tokenData.scope : '';
      const offlineGranted = scopeReturned.split(/\s+/).includes('offline_access');
      if (!tokenData.refresh_token) {
        console.warn('[va-auth] VA did NOT return a refresh_token', {
          client_id: connEp.clientId,
          scope_requested: SMART_SCOPES,
          scope_granted: scopeReturned,
          offline_access_granted: offlineGranted,
          expires_in: tokenData.expires_in,
        });
      }

      // Supersede any prior CONNECTED row for the same (person_id, fhir_base_url)
      // before flipping this row to connected - same pattern as epic-auth to
      // keep the partial unique index from rejecting the UPDATE.
      try {
        const { error: supersedeErr } = await admin.from('ehr_connections')
          .update({
            status: 'superseded',
            access_token: null,
            refresh_token: null,
            token_expires_at: null,
            needs_reconnect: false,
          })
          .eq('person_id', person_id)
          .eq('fhir_base_url', conn.fhir_base_url)
          .eq('status', 'connected')
          .neq('id', conn.id);
        if (supersedeErr) {
          console.error('[va-auth] supersede prior connected row failed', { err: supersedeErr });
        }
      } catch (e) {
        console.error('[va-auth] supersede prior connected row threw', { err: (e as Error).message });
      }

      const { error: updateError } = await admin.from('ehr_connections')
        .update({
          access_token: encAccessToken,
          refresh_token: encRefreshToken,
          token_expires_at: expiresAt,
          patient_id: tokenData.patient || null,
          connected_provider: hospitalLabel,
          connected_at: new Date().toISOString(),
          client_id_used: connEp.clientId,
          needs_reconnect: false,
          status: 'connected',
          code_verifier: null,
          state: null,
        })
        .eq('id', conn.id)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('[va-auth] token store error', { err: updateError });
        const isUniq = /idx_ehr_connections_person_fhir_connected|duplicate key/i.test(
          (updateError as { message?: string })?.message || ''
        );
        return jsonResponse({
          error: 'Failed to store tokens',
          detail: (updateError as { message?: string })?.message,
          hint: isUniq
            ? 'Another connected row for VA already exists for this person. The supersede step should have cleared it - check ehr_connections for stuck rows.'
            : undefined,
        }, 500);
      }

      return jsonResponse({
        success: true,
        expires_at: expiresAt,
        has_refresh_token: !!tokenData.refresh_token,
        offline_access_granted: offlineGranted,
      });
    }

    // ── REFRESH: Exchange refresh_token for a new access_token (public client) ──
    if (action === 'refresh') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      // VA connections can coexist with Epic/Cerner/etc for the same person.
      // Scope this lookup to provider='va' so we don't accidentally refresh
      // an Epic row with VA's token endpoint.
      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .eq('provider', 'va')
        .eq('status', 'connected')
        .maybeSingle();

      if (connError || !conn) {
        return jsonResponse({ error: 'No VA connection found' }, 404);
      }
      if (!conn.refresh_token) {
        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('id', conn.id);
        return jsonResponse({
          error: 'no_refresh_token',
          message: 'This VA connection has no refresh token. Reconnect required.',
        }, 409);
      }

      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      if (!encKey) {
        return jsonResponse({ error: 'server_misconfigured' }, 500);
      }

      const { data: plainRefresh, error: decErr } = await admin.rpc('decrypt_ehr_token', {
        encrypted_token: conn.refresh_token, enc_key: encKey,
      });
      if (decErr || !plainRefresh) {
        console.error('[va-auth] decrypt refresh_token failed', { err: decErr?.message });
        return jsonResponse({ error: 'decrypt_failed', detail: decErr?.message }, 500);
      }

      const tokenUrl = conn.token_url || ep.tokenUrl;
      const connIsSandbox = conn.fhir_base_url === VA_SANDBOX_FHIR_BASE;
      const connEp = resolveEndpoints(connIsSandbox);

      // Public client refresh: client_id in body, refresh_token, that's it.
      const refreshBody = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: plainRefresh,
        client_id: connEp.clientId,
      });

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshBody,
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of tokenRes.headers.entries()) {
          if (/^(www-authenticate|x-va|x-request-id|content-type|date)$/i.test(k)) {
            respHeaders[k] = v;
          }
        }
        console.error('[va-auth] refresh failed', {
          status: tokenRes.status,
          body: errText.slice(0, 1000),
          headers: respHeaders,
          person_id,
          conn_id: conn.id,
          client_id_used: conn.client_id_used,
          fhir_base_url: conn.fhir_base_url,
          token_url: tokenUrl,
        });

        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('id', conn.id);

        try {
          await admin.from('ehr_sync_log').insert({
            person_id,
            patient_id: conn.patient_id,
            status: tokenRes.status,
            result_counts: { refresh_error: true, va_body: errText.slice(0, 500), va_headers: respHeaders },
          });
        } catch (_) { /* best-effort logging */ }

        return jsonResponse({
          error: 'refresh_failed',
          va_status: tokenRes.status,
          va_body: errText.slice(0, 1000),
          va_headers: respHeaders,
        }, 502);
      }

      const tokenData = await tokenRes.json();
      if (!tokenData.access_token) {
        return jsonResponse({ error: 'No access token returned from refresh' }, 502);
      }

      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      const { data: encAccessToken, error: encAccessErr } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.access_token, enc_key: encKey,
      });
      if (encAccessErr || !encAccessToken) {
        return jsonResponse({ error: 'encryption_failed', detail: encAccessErr?.message }, 500);
      }

      // VA rotates refresh tokens per spec (same pattern as Epic). Persist if present.
      let encRefreshToken: string | null = null;
      if (tokenData.refresh_token) {
        const { data: encR, error: encRErr } = await admin.rpc('encrypt_ehr_token', {
          plain_token: tokenData.refresh_token, enc_key: encKey,
        });
        if (encRErr || !encR) {
          return jsonResponse({ error: 'encryption_failed', detail: encRErr?.message }, 500);
        }
        encRefreshToken = encR;
      }

      const updatePatch: Record<string, unknown> = {
        access_token: encAccessToken,
        token_expires_at: expiresAt,
        needs_reconnect: false,
        status: 'connected',
      };
      if (encRefreshToken) updatePatch.refresh_token = encRefreshToken;

      const { error: updateError } = await admin.from('ehr_connections')
        .update(updatePatch)
        .eq('id', conn.id);

      if (updateError) {
        return jsonResponse({ error: 'Failed to store refreshed tokens' }, 500);
      }

      return jsonResponse({
        success: true,
        expires_at: expiresAt,
        rotated: !!tokenData.refresh_token,
      });
    }

    // ── STATUS ──
    if (action === 'status') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();
      const { data: conn } = await admin.from('ehr_connections')
        .select('id, provider, connected_provider, connected_at, last_synced_at, token_expires_at, needs_reconnect, status')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .eq('provider', 'va')
        .eq('status', 'connected')
        .maybeSingle();

      if (!conn || !conn.connected_at) {
        return jsonResponse({ connected: false });
      }

      return jsonResponse({
        connected: true,
        provider: conn.connected_provider,
        connected_at: conn.connected_at,
        last_synced_at: conn.last_synced_at,
        token_valid: conn.token_expires_at ? new Date(conn.token_expires_at) > new Date() : false,
        needs_reconnect: !!conn.needs_reconnect,
        status: conn.status || null,
      });
    }

    // ── DISCONNECT ──
    // Best-effort: revoke the token at VA (https://sandbox-api.va.gov/oauth2/revoke
    // in sandbox), then delete the local row. Revocation failures don't block
    // local cleanup - we still want the row gone from our side.
    if (action === 'disconnect') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      // Try to load the VA connection first so we can revoke at VA.
      const { data: conn } = await admin.from('ehr_connections')
        .select('id, refresh_token, fhir_base_url, token_url')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .eq('provider', 'va')
        .maybeSingle();

      if (conn?.refresh_token) {
        try {
          const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
          if (encKey) {
            const { data: plainRefresh } = await admin.rpc('decrypt_ehr_token', {
              encrypted_token: conn.refresh_token, enc_key: encKey,
            });
            const connIsSandbox = conn.fhir_base_url === VA_SANDBOX_FHIR_BASE;
            const revokeUrl = connIsSandbox
              ? 'https://sandbox-api.va.gov/oauth2/revoke'
              : 'https://api.va.gov/oauth2/revoke';
            const connEp = resolveEndpoints(connIsSandbox);
            if (plainRefresh && connEp.clientId) {
              await fetch(revokeUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                  token: plainRefresh,
                  client_id: connEp.clientId,
                  token_type_hint: 'refresh_token',
                }),
              });
            }
          }
        } catch (e) {
          console.warn('[va-auth] revoke at VA failed (continuing with local delete)', { err: (e as Error).message });
        }
      }

      await admin.from('ehr_connections')
        .delete()
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .eq('provider', 'va');

      return jsonResponse({ success: true });
    }

    return jsonResponse({ error: 'Unknown action. Use: start, callback, refresh, status, disconnect' }, 400);

  } catch (err) {
    console.error('va-auth error:', err);
    await logSignupError({
      source: 'va-auth',
      severity: 'critical',
      error: err,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    });
    return jsonResponse({ error: (err as Error).message || 'Internal server error' }, 500);
  }
});
