// Supabase Edge Function: epic-auth
// Handles Epic SMART on FHIR OAuth2 flow for EHR connections.
// CONFIDENTIAL CLIENT — uses private_key_jwt (RFC 7523) signed with RS384.
// Routes:
//   POST { action: 'start' }      — Generate PKCE challenge, return Epic authorize URL
//   POST { action: 'callback' }   — Exchange auth code for tokens (PKCE + client_assertion)
//   POST { action: 'refresh' }    — Exchange refresh_token for new access_token (client_assertion)
//   POST { action: 'status' }     — Check connection status
//   POST { action: 'disconnect' } — Remove Epic connection

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';
import { logSignupError } from '../_shared/log-signup-error.ts';

// ── Configuration ────────────────────────────────────────────────────────────
// Wellet Confidential (2026-04-24) — Client IDs issued by Epic on app registration.
// Prod is used for real hospital FHIR bases; non-prod is used for fhir.epic.com sandbox.
const EPIC_PROD_CLIENT_ID = 'e550b8b1-8a3f-4f56-99e9-4870a616d5ab';
const EPIC_NONPROD_CLIENT_ID = '6307e012-4778-40ed-bd24-c042b932312e';

// Legacy public-client fallback. Kept ONLY so the handful of already-connected users
// on old client IDs can still refresh during the transition window. New connections
// always use the confidential client. Remove after May 23, 2026.
const EPIC_LEGACY_PUBLIC_CLIENT_ID = 'a00e2e38-f814-4946-9b7c-a92901a8aebc';

const EPIC_REDIRECT_URI = Deno.env.get('EPIC_REDIRECT_URI') ?? 'https://mywellet.com/epic-callback';

// Sandbox fallback endpoints (used when sandbox=true or no fhirBaseUrl provided)
const EPIC_SANDBOX_FHIR_BASE = 'https://fhir.epic.com/interconnect-fhir-oauth/api/FHIR/R4';
const EPIC_SANDBOX_AUTHORIZE = 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/authorize';
const EPIC_SANDBOX_TOKEN = 'https://fhir.epic.com/interconnect-fhir-oauth/oauth2/token';

// Key IDs (must match kid in the published JWKS at mywellet.com/.well-known/jwks-*.json)
const EPIC_PROD_KID = 'wellet-prod-2026-04';
const EPIC_NONPROD_KID = 'wellet-nonprod-2026-04';

// SMART v2 scopes
// offline_access is required for Epic to issue a refresh_token so connections
// auto-renew after the initial access_token expires (Epic access_tokens last ~1h).
const SMART_SCOPES = [
  'patient/Patient.read',
  'patient/AllergyIntolerance.read',
  'patient/Condition.read',
  'patient/MedicationRequest.read',
  'patient/Observation.read',
  'patient/Immunization.read',
  'patient/DiagnosticReport.read',
  'patient/Encounter.read',
  'patient/Appointment.read',
  'patient/CareTeam.read',
  'patient/DocumentReference.read',
  'patient/Practitioner.read',
  'patient/PractitionerRole.read',
  'launch/patient',
  'openid',
  'fhirUser',
  'offline_access',
].join(' ');

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getAuthenticatedUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) {
    console.error('[epic-auth] No Authorization header');
    return { user: null, diag: 'no_authorization_header' };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
  if (!supabaseUrl || !supabaseAnonKey) {
    console.error('[epic-auth] Missing env vars', { hasUrl: !!supabaseUrl, hasAnon: !!supabaseAnonKey });
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
      console.error('[epic-auth] getUser error', { msg: error.message, status: (error as any).status, token: tokenFingerprint });
      return { user: null, diag: 'getUser_error:' + error.message };
    }
    if (!user) {
      console.error('[epic-auth] getUser returned null user', { token: tokenFingerprint });
      return { user: null, diag: 'getUser_null_user' };
    }
    return { user, diag: 'ok' };
  } catch (e) {
    console.error('[epic-auth] getUser threw', { err: String(e), token: tokenFingerprint });
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

function base64UrlEncodeString(s: string): string {
  return base64UrlEncode(new TextEncoder().encode(s));
}

async function computeCodeChallenge(codeVerifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// ── private_key_jwt signing (RFC 7523) ───────────────────────────────────────
// Epic confidential clients authenticate to the token endpoint by sending a
// signed JWT as `client_assertion` with type `urn:ietf:params:oauth:client-assertion-type:jwt-bearer`.
// The JWT is signed with RS384 using the private key whose public counterpart
// we published at mywellet.com/.well-known/jwks-{prod,nonprod}.json.
// Epic docs: https://fhir.epic.com/Documentation?docId=oauth2&section=BackendOAuth2Guide

// Convert a PEM-encoded PKCS#8 RSA private key to a CryptoKey for RS384 signing.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Strip header/footer/whitespace. Accept both PKCS#8 ("BEGIN PRIVATE KEY") and
  // PKCS#1 ("BEGIN RSA PRIVATE KEY") — openssl genrsa on modern macOS emits PKCS#8
  // with "BEGIN PRIVATE KEY" so that's the common case. PKCS#1 keys need pre-conversion.
  const pemBody = pem
    .replace(/-----BEGIN (RSA )?PRIVATE KEY-----/g, '')
    .replace(/-----END (RSA )?PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!pemBody) throw new Error('Empty private key PEM');

  const der = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  try {
    return await crypto.subtle.importKey(
      'pkcs8',
      der,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-384' },
      false,
      ['sign'],
    );
  } catch (e) {
    throw new Error(
      'Failed to import RSA private key — is it PKCS#8? openssl rsa -in key.pem -out key.pkcs8.pem if not. Original: ' +
        (e as Error).message,
    );
  }
}

// Build a signed client_assertion JWT for a given token endpoint + client_id.
async function buildClientAssertion(
  tokenUrl: string,
  clientId: string,
  kid: string,
  privateKey: CryptoKey,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: 'RS384',
    typ: 'JWT',
    kid,
  };
  const payload = {
    iss: clientId,       // Issuer: the client
    sub: clientId,       // Subject: the client
    aud: tokenUrl,       // Audience: Epic's token endpoint (exact match required)
    jti: crypto.randomUUID(), // Unique per request — Epic rejects replays
    iat: now,
    exp: now + 300,      // 5 minutes — Epic requires ≤ 5 min
    nbf: now,
  };

  const encodedHeader = base64UrlEncodeString(JSON.stringify(header));
  const encodedPayload = base64UrlEncodeString(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const signature = await crypto.subtle.sign(
    { name: 'RSASSA-PKCS1-v1_5' },
    privateKey,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

// Resolve which (client_id, kid, private_key_env) tuple to use based on
// whether this is a sandbox/non-prod or production flow.
function resolveClientCreds(isSandboxOrNonProd: boolean): {
  clientId: string;
  kid: string;
  pemEnv: string;
} {
  if (isSandboxOrNonProd) {
    return {
      clientId: EPIC_NONPROD_CLIENT_ID,
      kid: EPIC_NONPROD_KID,
      pemEnv: 'EPIC_JWT_PRIVATE_KEY_NONPROD',
    };
  }
  return {
    clientId: EPIC_PROD_CLIENT_ID,
    kid: EPIC_PROD_KID,
    pemEnv: 'EPIC_JWT_PRIVATE_KEY_PROD',
  };
}

// Load + import the RS384 private key for a given environment. Throws with a
// clear error if the secret is missing so it shows up as a 500 in logs rather
// than a mysterious signature mismatch from Epic.
async function loadPrivateKey(pemEnv: string): Promise<CryptoKey> {
  const pem = Deno.env.get(pemEnv) || '';
  if (!pem) {
    throw new Error(
      `Missing Supabase secret: ${pemEnv}. Set it with the PEM contents of the matching private key.`,
    );
  }
  return await importPrivateKey(pem);
}

// Discover SMART on FHIR authorization and token endpoints from a FHIR base URL.
async function discoverSmartEndpoints(fhirBaseUrl: string): Promise<{
  authorization_endpoint: string;
  token_endpoint: string;
}> {
  try {
    const smartUrl = `${fhirBaseUrl}/.well-known/smart-configuration`;
    const res = await fetch(smartUrl, { headers: { 'Accept': 'application/json' } });
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
    console.warn('SMART .well-known fetch failed, trying /metadata:', (e as Error).message);
  }

  try {
    const metadataUrl = `${fhirBaseUrl}/metadata`;
    const res = await fetch(metadataUrl, { headers: { 'Accept': 'application/fhir+json' } });
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
    console.warn('FHIR /metadata fetch failed:', (e as Error).message);
  }

  throw new Error('Could not discover SMART endpoints from ' + fhirBaseUrl);
}

async function probeR4Metadata(r4BaseUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timeoutId = setTimeout(() => ctrl.abort(), 4000);
  try {
    const res = await fetch(`${r4BaseUrl}/metadata`, {
      headers: { 'Accept': 'application/fhir+json, application/json, application/fhir+xml' },
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
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

    // "Non-prod" means sandbox FHIR base. Everything else uses the production
    // confidential client + production signing key.
    const isSandbox = body.sandbox === true;
    const creds = resolveClientCreds(isSandbox);

    // ── START: Generate PKCE challenge and return Epic authorize URL ──
    if (action === 'start') {
      const { person_id, fhirBaseUrl, hospitalName } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      let fhirBase: string;
      let authorizeUrl: string;
      let tokenUrl: string;

      if (isSandbox || !fhirBaseUrl) {
        fhirBase = EPIC_SANDBOX_FHIR_BASE;
        authorizeUrl = EPIC_SANDBOX_AUTHORIZE;
        tokenUrl = EPIC_SANDBOX_TOKEN;
      } else {
        fhirBase = fhirBaseUrl;

        if (/\/DSTU2(\/|$)/i.test(fhirBase) || /\/stu2(\/|$)/i.test(fhirBase)) {
          const r4Candidate = fhirBase.replace(/\/DSTU2(\/|$)/i, '/R4$1').replace(/\/stu2(\/|$)/i, '/R4$1');
          const r4Works = await probeR4Metadata(r4Candidate);
          if (r4Works) {
            console.log('[epic-auth] Rewrote DSTU2 -> R4', { from: fhirBase, to: r4Candidate });
            fhirBase = r4Candidate;
          } else {
            return jsonResponse({
              error: 'unsupported_fhir_version',
              message: 'This provider is on an older FHIR version (DSTU2) that Wellet does not yet support. Please try a different location or ask us to add support.',
              fhir_base_url: fhirBase,
              hospital_name: hospitalName || null,
            }, 400);
          }
        }

        const endpoints = await discoverSmartEndpoints(fhirBase);
        authorizeUrl = endpoints.authorization_endpoint;
        tokenUrl = endpoints.token_endpoint;
      }

      // 2026-04-27: The 2026-04-26 hotfix guard that returned
      // `multi_hospital_not_yet_supported` (409) for a SECOND hospital is
      // removed now that the rest of the N-connections refactor is in
      // place: the DB partial unique index
      // `idx_ehr_connections_person_fhir_connected` enforces at most one
      // CONNECTED row per (person_id, fhir_base_url), `fetch-ehr-data` fans
      // out across all connections, and the frontend cache + render path
      // merge them. Same-hospital reconnect (e.g. expired refresh) is still
      // handled correctly: the new pending row carries a unique `state` and
      // the partial unique index ignores rows whose status is not
      // 'connected', so concurrent OAuth attempts don't collide.

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const state = generateState();

      // 2026-05-01: previously every `start` call did a plain insert,
      // which created a NEW ehr_connections row per OAuth attempt. The
      // partial unique index keeps us from ending up with two CONNECTED
      // rows for the same hospital, but it does not stop dead 'pending' /
      // 'needs_reconnect' / 'superseded' rows from accumulating across
      // reconnects, which made the duplicate-row bug real (multiple
      // pendings would race on the same hospital and the cache could
      // pick a stale one).
      //
      // Behavior now: if there's already a reusable row for this
      // (person_id, fhir_base_url) — i.e. status in
      // ('pending','needs_reconnect','superseded') — UPDATE it in place
      // with the fresh PKCE+state and flip status='pending'. If the only
      // existing row is status='connected', leave it alone (the live
      // token must stay valid until the new OAuth dance finishes — the
      // partial unique index will be respected because we're inserting a
      // 'pending', not another 'connected') and insert a new pending row
      // alongside it. The `state` column is globally unique per attempt,
      // so `callback` still resolves the right row.
      const { data: existingRows, error: existingErr } = await admin
        .from('ehr_connections')
        .select('id, status')
        .eq('person_id', person_id)
        .eq('fhir_base_url', fhirBase)
        .in('status', ['pending', 'needs_reconnect', 'superseded'])
        .order('created_at', { ascending: false })
        .limit(1);
      if (existingErr) {
        console.error('[epic-auth] start existing-row lookup failed', { err: existingErr });
        // Fail soft: fall through to the insert path so a transient lookup
        // error doesn't block reconnect entirely.
      }
      const reusable = existingRows && existingRows[0];

      let insertError: { message: string } | null = null;
      if (reusable) {
        const { error: updateError } = await admin.from('ehr_connections')
          .update({
            user_id: user.id,
            provider: 'epic',
            code_verifier: codeVerifier,
            state: state,
            token_url: tokenUrl,
            hospital_name: hospitalName || (isSandbox ? 'Epic Sandbox' : null),
            status: 'pending',
            // Clear out any stale OAuth artifacts from a previous failed
            // attempt — the new dance will repopulate these on success.
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
          console.error('[epic-auth] start reuse-row update failed', { err: updateError, row_id: reusable.id });
          insertError = updateError;
        } else {
          console.log('[epic-auth] start reused existing row', { row_id: reusable.id, prior_status: reusable.status });
        }
      } else {
        const { error: insErr } = await admin.from('ehr_connections').insert({
          user_id: user.id,
          person_id: person_id,
          provider: 'epic',
          code_verifier: codeVerifier,
          state: state,
          fhir_base_url: fhirBase,
          token_url: tokenUrl,
          hospital_name: hospitalName || (isSandbox ? 'Epic Sandbox' : null),
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
        console.error('[epic-auth] start insert failed', { err: insertError });
        return jsonResponse({
          error: 'connection_start_failed',
          message: 'Could not start a new EHR connection — please try again.',
          detail: insertError.message,
        }, 500);
      }

      const params = new URLSearchParams({
        response_type: 'code',
        client_id: creds.clientId,
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

    // ── CALLBACK: Exchange auth code for tokens (PKCE + client_assertion) ──
    if (action === 'callback') {
      const { code, state: callbackState, person_id } = body;
      if (!code || !person_id) {
        return jsonResponse({ error: 'code and person_id are required' }, 400);
      }

      const admin = getAdminClient();

      // HOTFIX 2026-04-26: callback now looks up the pending connection by
      // `state` (which is globally unique per OAuth attempt) instead of by
      // person_id. Under N-connections-per-person a single person can have
      // multiple pending rows in flight, so person_id is no longer
      // sufficient to identify the right row. We still verify person_id and
      // user_id match the row we found to defend against state forgery from
      // a different account.
      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('state', callbackState)
        .eq('user_id', user.id)
        .maybeSingle();

      if (connError || !conn) {
        return jsonResponse({ error: 'No pending connection found' }, 404);
      }

      if (conn.person_id !== person_id) {
        // The state matched a row but for a different person on this account.
        // Treat as a CSRF / cross-person leak and refuse.
        return jsonResponse({ error: 'State mismatch — possible CSRF attack' }, 400);
      }

      if (!conn.code_verifier) {
        return jsonResponse({ error: 'No PKCE code_verifier found — restart the connection flow' }, 400);
      }

      const tokenUrl = conn.token_url || EPIC_SANDBOX_TOKEN;
      const connIsSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;
      const connCreds = resolveClientCreds(connIsSandbox);

      // Build client_assertion JWT signed with our RS384 private key.
      let clientAssertion: string;
      try {
        const privateKey = await loadPrivateKey(connCreds.pemEnv);
        clientAssertion = await buildClientAssertion(
          tokenUrl,
          connCreds.clientId,
          connCreds.kid,
          privateKey,
        );
      } catch (e) {
        console.error('[epic-auth] client_assertion build failed', { err: (e as Error).message });
        return jsonResponse({
          error: 'client_assertion_failed',
          message: 'Server could not sign the JWT assertion — check EPIC_JWT_PRIVATE_KEY_* secrets.',
          detail: (e as Error).message,
        }, 500);
      }

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code,
          redirect_uri: EPIC_REDIRECT_URI,
          code_verifier: conn.code_verifier,
          // Confidential client auth: no client_id in body, no client_secret.
          // client_id is embedded in the assertion's iss/sub claims.
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion,
        }),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('Epic token exchange failed:', tokenRes.status, errText);
        return jsonResponse({
          error: 'Token exchange failed',
          epic_status: tokenRes.status,
          epic_body: errText.slice(0, 400),
        }, 502);
      }

      const tokenData = await tokenRes.json();
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      if (!tokenData.access_token) {
        console.error('Epic returned no access_token:', JSON.stringify(tokenData));
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

      const hospitalLabel = conn.hospital_name
        ? `${conn.hospital_name} (Epic)`
        : 'Epic MyChart';

      const scopeReturned = typeof tokenData.scope === 'string' ? tokenData.scope : '';
      const offlineGranted = scopeReturned.split(/\s+/).includes('offline_access');
      if (!tokenData.refresh_token) {
        console.warn('[epic-auth] Epic did NOT return a refresh_token', {
          client_id: connCreds.clientId,
          scope_requested: SMART_SCOPES,
          scope_granted: scopeReturned,
          offline_access_granted: offlineGranted,
          expires_in: tokenData.expires_in,
        });
      }

      // HOTFIX 2026-04-26: scope this update to the specific connection row
      // we resolved by `state` above. Previously it filtered by person_id
      // which would clobber sibling rows once a person had multiple
      // connections (e.g. wipe Mom's Duke code_verifier when finishing UNC).
      //
      // HOTFIX 2026-05-14: same-hospital reconnect was failing with
      // "Failed to store tokens" because the partial unique index
      // `idx_ehr_connections_person_fhir_connected` (one CONNECTED row per
      // (person_id, fhir_base_url)) rejected the UPDATE that flipped the
      // NEW pending row to status='connected' while the PRIOR connected
      // row was still occupying the slot. The start path comment claimed
      // this case was handled — it wasn't. Fix: in a SINGLE step, mark any
      // OTHER 'connected' row for the same (person_id, fhir_base_url) as
      // 'superseded' immediately before flipping this row, so the partial
      // unique index never sees two CONNECTED rows at once. This is
      // idempotent: if no prior row exists (first-time connect), the
      // supersede affects 0 rows and we proceed normally.
      try {
        const { error: supersedeErr } = await admin.from('ehr_connections')
          .update({
            status: 'superseded',
            // Wipe tokens on the old row so a stray refresh can't accidentally
            // hit Duke with a stale token bound to a no-longer-current
            // access grant.
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
          console.error('[epic-auth] supersede prior connected row failed', { err: supersedeErr });
          // Continue anyway — if there's no prior connected row this is a
          // no-op. If there IS one and we couldn't supersede it, the
          // following UPDATE will hit the unique index and surface a
          // clearer error downstream.
        }
      } catch (e) {
        console.error('[epic-auth] supersede prior connected row threw', { err: (e as Error).message });
      }

      const { error: updateError } = await admin.from('ehr_connections')
        .update({
          access_token: encAccessToken,
          refresh_token: encRefreshToken,
          token_expires_at: expiresAt,
          patient_id: tokenData.patient || null,
          connected_provider: hospitalLabel,
          connected_at: new Date().toISOString(),
          client_id_used: connCreds.clientId,
          needs_reconnect: false,
          status: 'connected',
          code_verifier: null,
          state: null,
        })
        .eq('id', conn.id)
        .eq('user_id', user.id);

      if (updateError) {
        console.error('Token store error:', updateError);
        // Surface a more actionable error to the client. The most common
        // cause here is the partial unique index rejecting the flip-to-
        // connected because a sibling 'connected' row still exists — which
        // should now be impossible thanks to the supersede above, but if
        // it does happen the message tells Betsy exactly what to look for.
        const isUniq = /idx_ehr_connections_person_fhir_connected|duplicate key/i.test(
          (updateError as { message?: string })?.message || ''
        );
        return jsonResponse({
          error: 'Failed to store tokens',
          detail: (updateError as { message?: string })?.message,
          hint: isUniq
            ? 'Another connected row for this hospital already exists for this person. The supersede step should have cleared it — check ehr_connections for stuck rows.'
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

    // ── REFRESH: Exchange refresh_token for a new access_token ──
    // Called by fetch-ehr-data (or any caller) right before the existing
    // access_token expires, or transparently on a 401 from Epic.
    // Uses private_key_jwt — same client_assertion pattern as callback.
    if (action === 'refresh') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .single();

      if (connError || !conn) {
        return jsonResponse({ error: 'No connection found' }, 404);
      }
      if (!conn.refresh_token) {
        // No refresh token on file — only a fresh connect can fix this.
        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('person_id', person_id)
          .eq('user_id', user.id);
        return jsonResponse({
          error: 'no_refresh_token',
          message: 'This connection has no refresh token. Reconnect required.',
        }, 409);
      }

      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      if (!encKey) {
        return jsonResponse({ error: 'server_misconfigured' }, 500);
      }

      // Decrypt the stored refresh token.
      const { data: plainRefresh, error: decErr } = await admin.rpc('decrypt_ehr_token', {
        encrypted_token: conn.refresh_token, enc_key: encKey,
      });
      if (decErr || !plainRefresh) {
        console.error('[epic-auth] decrypt refresh_token failed', { err: decErr?.message });
        return jsonResponse({ error: 'decrypt_failed', detail: decErr?.message }, 500);
      }

      const tokenUrl = conn.token_url || EPIC_SANDBOX_TOKEN;
      const connIsSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;

      // Figure out which credentials to use. If the connection was minted by
      // the legacy public client, refresh using the legacy client_id with NO
      // client_assertion. Everything new uses confidential client_assertion.
      const isLegacyPublic = conn.client_id_used === EPIC_LEGACY_PUBLIC_CLIENT_ID;
      const connCreds = resolveClientCreds(connIsSandbox);

      let refreshBody: URLSearchParams;
      if (isLegacyPublic) {
        refreshBody = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: plainRefresh,
          client_id: EPIC_LEGACY_PUBLIC_CLIENT_ID,
        });
      } else {
        let clientAssertion: string;
        try {
          const privateKey = await loadPrivateKey(connCreds.pemEnv);
          clientAssertion = await buildClientAssertion(
            tokenUrl,
            connCreds.clientId,
            connCreds.kid,
            privateKey,
          );
        } catch (e) {
          console.error('[epic-auth] refresh client_assertion build failed', { err: (e as Error).message });
          return jsonResponse({
            error: 'client_assertion_failed',
            detail: (e as Error).message,
          }, 500);
        }

        refreshBody = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: plainRefresh,
          client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
          client_assertion: clientAssertion,
        });
      }

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: refreshBody,
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        console.error('[epic-auth] refresh failed', { status: tokenRes.status, body: errText.slice(0, 400) });

        // Refresh tokens expire too (Epic = 90 days rolling). On refresh
        // failure, flag the connection so the UI can prompt a reconnect
        // banner instead of silently failing forever.
        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('person_id', person_id)
          .eq('user_id', user.id);

        return jsonResponse({
          error: 'refresh_failed',
          epic_status: tokenRes.status,
          epic_body: errText.slice(0, 400),
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

      // Epic uses rolling refresh tokens — every refresh MAY return a new
      // refresh_token which invalidates the old one. Persist if present.
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
        .eq('person_id', person_id)
        .eq('user_id', user.id);

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
        needs_reconnect: !!conn.needs_reconnect,
        status: conn.status || null,
      });
    }

    // ── DISCONNECT ──
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

    return jsonResponse({ error: 'Unknown action. Use: start, callback, refresh, status, disconnect' }, 400);

  } catch (err) {
    console.error('epic-auth error:', err);
    await logSignupError({
      source: 'epic-auth',
      severity: 'critical',
      error: err,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    });
    return jsonResponse({ error: (err as Error).message || 'Internal server error' }, 500);
  }
});
