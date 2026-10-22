// Supabase Edge Function: epic-auth
// Handles Epic SMART on FHIR OAuth2 flow for EHR connections.
// CONFIDENTIAL CLIENT — uses private_key_jwt (RFC 7523) signed with RS384.
// Routes:
//   POST { action: 'start' }      — Generate PKCE challenge, return Epic authorize URL
//   POST { action: 'callback' }   — Exchange auth code for tokens (PKCE + client_assertion)
//   POST { action: 'confirm_patient' } — Finish or cancel a connect paused for the caregiver to confirm the patient
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
  // Binary.read is what actually unblocks AVS / Provider Summary fetches. The
  // DocumentReference itself is just metadata + an attachment URL pointing at
  // /Binary/{id}; fetching that URL needs a token with patient/Binary.read in
  // its scope set. Without it Epic returns 401 even though everything else
  // (encounters, meds, labs, document metadata) works fine. This is why the
  // "After Visit Summary" buttons never opened — the app was correctly built
  // around DocumentReference, but the token couldn't read the actual Binary
  // body Epic linked us to.
  'patient/Binary.read',
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

// Name and birth month from a FHIR Patient, for the confirm screen only.
// Birth month is YYYY-MM so the screen can say "Born March 1948".
function patientDisplay(p: Record<string, any>): { name: string | null; birth_month: string | null } {
  const names: Record<string, any>[] = Array.isArray(p?.name) ? p.name : [];
  const pick = names.find((n) => n?.use === 'official') || names.find((n) => n?.use === 'usual') || names[0] || null;
  let name: string | null = null;
  if (pick) {
    const given = Array.isArray(pick.given) ? pick.given.join(' ') : '';
    name = (typeof pick.text === 'string' && pick.text.trim()) || [given, pick.family || ''].join(' ').trim() || null;
  }
  const bd = typeof p?.birthDate === 'string' ? p.birthDate : '';
  const birth_month = /^\d{4}-\d{2}/.test(bd) ? bd.slice(0, 7) : null;
  return { name: name ? name.slice(0, 120) : null, birth_month };
}

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Mark an ehr_connections row with the reason it failed mid-OAuth so the next
// debug session has a real trail instead of a silent 'pending'/'abandoned' row.
// Best-effort: never throws, never blocks the caller's error return.
async function markConnError(
  admin: ReturnType<typeof createClient>,
  connId: string | null | undefined,
  step: string,
  detail: string,
  debug?: Record<string, unknown>,
) {
  if (!connId) return;
  try {
    const msg = (detail || '').slice(0, 500);
    const update: Record<string, unknown> = {
      status: 'abandoned',
      last_error: msg,
      last_error_step: step,
      last_error_at: new Date().toISOString(),
    };
    if (debug) update.last_error_debug = debug;
    await admin.from('ehr_connections').update(update).eq('id', connId);
    console.error('[epic-auth] marked conn error', { conn_id: connId, step, detail: msg, debug: debug || null });
  } catch (e) {
    console.error('[epic-auth] markConnError failed', { conn_id: connId, step, err: String(e) });
  }
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
      // 2026-10-21 iOS sign-in. client 'ios' tags the state with "ios." so
      // the /epic-callback page hands the return to the app (wellet://).
      // iOS never uses the sandbox, so a missing hospital is an error, not
      // a silent fallback to Epic's test system.
      const fromIos = body.client === 'ios';
      if (fromIos && (isSandbox || !fhirBaseUrl)) {
        return jsonResponse({ error: 'fhirBaseUrl is required' }, 400);
      }

      const admin = getAdminClient();

      // 2026-10-21 ownership check: only the person's owner can start a
      // connect. Without this, any signed-in user could pass another family's
      // person_id and attach a hospital record to it.
      {
        const { data: owned } = await admin.from('people')
          .select('id').eq('id', person_id).eq('user_id', user.id).maybeSingle();
        if (!owned) return jsonResponse({ error: 'Person not found' }, 404);
      }

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

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const state = (fromIos ? 'ios.' : '') + generateState();

      const { data: existingRows, error: existingErr } = await admin
        .from('ehr_connections')
        .select('id, status')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .eq('fhir_base_url', fhirBase)
        .in('status', ['pending', 'needs_reconnect', 'superseded'])
        .order('created_at', { ascending: false })
        .limit(1);
      if (existingErr) {
        console.error('[epic-auth] start existing-row lookup failed', { err: existingErr });
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

      const { data: conn, error: connError } = await admin.from('ehr_connections')
        .select('*')
        .eq('state', callbackState)
        .eq('user_id', user.id)
        .maybeSingle();

      if (connError || !conn) {
        return jsonResponse({ error: 'No pending connection found' }, 404);
      }

      if (conn.person_id !== person_id) {
        await markConnError(admin, conn.id, 'state_person_mismatch',
          `callback person_id=${person_id} did not match row person_id=${conn.person_id}`);
        return jsonResponse({ error: 'State mismatch — possible CSRF attack' }, 400);
      }

      if (!conn.code_verifier) {
        await markConnError(admin, conn.id, 'missing_code_verifier',
          'Row had no code_verifier — likely a stale row or double-submitted callback');
        return jsonResponse({ error: 'No PKCE code_verifier found — restart the connection flow' }, 400);
      }

      const tokenUrl = conn.token_url || EPIC_SANDBOX_TOKEN;
      const connIsSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;
      const connCreds = resolveClientCreds(connIsSandbox);

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
        await markConnError(admin, conn.id, 'client_assertion_build',
          `Failed to build client_assertion JWT (kid=${connCreds.kid}): ${(e as Error).message}`);
        return jsonResponse({
          error: 'client_assertion_failed',
          message: 'Server could not sign the JWT assertion — check EPIC_JWT_PRIVATE_KEY_* secrets.',
          detail: (e as Error).message,
        }, 500);
      }

      // Decode the JWT we just built so we can capture the EXACT claims we sent
      // if Epic rejects us. This is the difference between guessing and knowing.
      let jwtHeaderSent: unknown = null;
      let jwtClaimsSent: unknown = null;
      try {
        const parts = clientAssertion.split('.');
        if (parts.length === 3) {
          jwtHeaderSent = JSON.parse(
            new TextDecoder().decode(
              Uint8Array.from(
                atob(parts[0].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[0].length + (4 - parts[0].length % 4) % 4, '=')),
                (c) => c.charCodeAt(0),
              ),
            ),
          );
          jwtClaimsSent = JSON.parse(
            new TextDecoder().decode(
              Uint8Array.from(
                atob(parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[1].length + (4 - parts[1].length % 4) % 4, '=')),
                (c) => c.charCodeAt(0),
              ),
            ),
          );
        }
      } catch (_) { /* best-effort, keep going */ }

      const postBody = new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: EPIC_REDIRECT_URI,
        code_verifier: conn.code_verifier,
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: clientAssertion,
      });

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: postBody,
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        const respHeaders: Record<string, string> = {};
        try { tokenRes.headers.forEach((v, k) => { respHeaders[k] = v; }); } catch (_) {}
        console.error('Epic token exchange failed:', tokenRes.status, errText, respHeaders);

        // Capture EVERYTHING needed to compare what we sent vs what works at other
        // hospitals: exact aud, exact client_id, exact JWT claims, exact response
        // headers (Epic sometimes puts useful detail in WWW-Authenticate), exact
        // form-encoded body keys (NOT the assertion itself — too large + sensitive),
        // and the FHIR base we authorized against.
        const debug = {
          fhir_base_url: conn.fhir_base_url,
          token_url: tokenUrl,
          client_id_used: connCreds.clientId,
          kid_used: connCreds.kid,
          is_sandbox: connIsSandbox,
          jwt_header_sent: jwtHeaderSent,
          jwt_claims_sent: jwtClaimsSent,
          post_body_keys: Array.from(postBody.keys()),
          redirect_uri_sent: EPIC_REDIRECT_URI,
          epic_status: tokenRes.status,
          epic_response_headers: respHeaders,
          epic_response_body: errText.slice(0, 2000),
          captured_at: new Date().toISOString(),
        };
        await markConnError(admin, conn.id, 'token_exchange_http',
          `Epic token endpoint returned ${tokenRes.status}: ${errText.slice(0, 400)}`,
          debug);

        // 2026-05-27: Henry Ford pattern — patient completed OAuth at the
        // hospital (sometimes even gets a confirmation text from the hospital),
        // but the token exchange fails with invalid_client / unauthorized_client
        // because the hospital hasn't approved Wellet's confidential client on
        // their production allow-list. Convert that silent dead-end into a real
        // hospital_connect_requests row so:
        //   1. The every-2h Linear cron auto-files a ticket with the
        //      `hospital-connect` label, giving us a queue of hospitals to chase.
        //   2. The frontend can show an "almost there" recovery screen instead
        //      of a generic toast + ask-the-user-to-retype-everything modal.
        // We parse Epic's JSON body to detect the well-known error codes.
        // Anything else falls through to the legacy `oauth_error` path.
        let parsedEpicErr: string | null = null;
        let parsedEpicErrDesc: string | null = null;
        try {
          const parsed = JSON.parse(errText);
          if (parsed && typeof parsed === 'object') {
            if (typeof parsed.error === 'string') parsedEpicErr = parsed.error;
            if (typeof parsed.error_description === 'string') parsedEpicErrDesc = parsed.error_description;
          }
        } catch (_) { /* not JSON, leave parsed* null */ }

        const isHospitalNotApproved = parsedEpicErr === 'invalid_client'
          || parsedEpicErr === 'unauthorized_client';
        const isPatientDeclined = parsedEpicErr === 'access_denied';

        if (isHospitalNotApproved) {
          // Best-effort: file the hospital_connect_requests row so the Linear
          // cron picks it up. Never block the user response on this insert.
          try {
            // Dedup: don't file a second row for the same user+hospital within
            // 24h. The cron's linear_issue_id IS NULL filter handles its own
            // dedup, but we don't want N rows per retry attempt.
            const { data: existing } = await admin.from('hospital_connect_requests')
              .select('id')
              .eq('user_id', user.id)
              .eq('hospital_name', conn.hospital_name || 'Unknown hospital')
              .eq('issue_type', 'hospital_not_approved')
              .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
              .limit(1)
              .maybeSingle();

            if (!existing) {
              const triageNotes = 'Patient completed OAuth at hospital (Epic authorize step succeeded), ' +
                'but token exchange failed with ' + parsedEpicErr + '. ' +
                'This means the hospital has not approved Wellet\u2019s confidential client ' +
                'on their production allow-list. client_id=' + (connCreds.clientId || 'unknown') + '. ' +
                'Follow up with the hospital\u2019s Epic team referencing this client_id and the ' +
                'token endpoint URL ' + tokenUrl + '. Captured at ' + new Date().toISOString() + '.';

              await admin.from('hospital_connect_requests').insert({
                user_id: user.id,
                person_id: conn.person_id,
                hospital_name: conn.hospital_name || 'Unknown hospital',
                issue_type: 'hospital_not_approved',
                contact_email: user.email || null,
                fhir_base_url: conn.fhir_base_url || null,
                error_code: parsedEpicErr,
                error_message: (parsedEpicErrDesc || errText || '').slice(0, 2000),
                triage_notes: triageNotes,
              });
              console.log('[epic-auth] filed hospital_connect_requests for hospital_not_approved', {
                hospital_name: conn.hospital_name, user_id: user.id, error_code: parsedEpicErr,
              });
            } else {
              console.log('[epic-auth] hospital_connect_requests already filed in last 24h, skipping', {
                hospital_name: conn.hospital_name, existing_id: existing.id,
              });
            }
          } catch (filingErr) {
            // Filing failed — log but keep going so the user still gets a clean
            // recovery screen instead of a 500.
            console.error('[epic-auth] hospital_connect_requests insert failed', {
              hospital_name: conn.hospital_name, err: String(filingErr),
            });
          }

          return jsonResponse({
            error: 'hospital_not_approved',
            hospital_name: conn.hospital_name || null,
            fhir_base_url: conn.fhir_base_url || null,
            epic_error_code: parsedEpicErr,
            request_filed: true,
            message: 'Almost there \u2014 ' + (conn.hospital_name || 'this hospital') +
              ' hasn\u2019t fully approved Wellet on their developer side yet. ' +
              'We\u2019ve flagged you for the moment they do.',
          }, 200);
        }

        if (isPatientDeclined) {
          // Patient hit Cancel / Deny in the Epic UI. Not a Wellet bug.
          // Gentler UX, no DB row, no Linear ticket.
          return jsonResponse({
            error: 'patient_declined',
            hospital_name: conn.hospital_name || null,
            epic_error_code: parsedEpicErr,
            message: 'No problem \u2014 you can connect a different hospital, or come back to ' +
              (conn.hospital_name || 'this hospital') + ' anytime.',
          }, 200);
        }

        // Fallback: unrecognized Epic error. Legacy behavior — surface to the
        // existing oauth_error modal so the user can request access manually.
        return jsonResponse({
          error: 'Token exchange failed',
          epic_status: tokenRes.status,
          epic_body: errText.slice(0, 400),
          hospital_name: conn.hospital_name || null,
          fhir_base_url: conn.fhir_base_url || null,
        }, 502);
      }

      const tokenData = await tokenRes.json();
      const expiresAt = new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString();

      if (!tokenData.access_token) {
        console.error('Epic returned no access_token:', JSON.stringify(tokenData));
        await markConnError(admin, conn.id, 'no_access_token',
          `Token endpoint 2xx but body had no access_token: ${JSON.stringify(tokenData).slice(0, 400)}`);
        return jsonResponse({ error: 'No access token returned from provider' }, 502);
      }

      // ── PATIENT-MATCH GUARD (2026-10-21) ──
      // Epic returns whichever patient was chosen in MyChart. With proxy access,
      // a caregiver can sign in as themselves while connecting a loved one (the
      // Aug 2026 Duke incident). Check the returned patient against the person
      // chosen in Wellet BEFORE any token is stored, so a mismatch never syncs.
      // Deterministic checks only:
      //   1. same_patient_other_person: this account already has a connected
      //      row for the same hospital and patient on a DIFFERENT person.
      //      (Scoped to this account. Two siblings connecting the same parent
      //      from their own accounts is legitimate.)
      //   2. birth_date_mismatch: the person has a birth date in Wellet and the
      //      hospital's Patient.birthDate is a full date that differs.
      // If the Patient read fails, check 1 still runs and the connect proceeds;
      // the failure is logged in last_error_debug.
      // Set inside the guard. When Wellet has no birth date for the person,
      // the connect pauses (status awaiting_confirm) and the caregiver is
      // shown the hospital's name and birth month before anything syncs.
      let needsConfirm = false;
      let confirmDisplay: { name: string | null; birth_month: string | null } = { name: null, birth_month: null };
      {
        const returnedPatient: string | null = tokenData.patient || null;
        let mismatchReason: string | null = null;
        const guardDebug: Record<string, unknown> = { guard: 'patient_match_v1' };

        if (returnedPatient) {
          const { data: dupRows } = await admin.from('ehr_connections')
            .select('id')
            .eq('user_id', user.id)
            .eq('fhir_base_url', conn.fhir_base_url)
            .eq('patient_id', returnedPatient)
            .eq('status', 'connected')
            .neq('person_id', person_id)
            .limit(1);
          if (dupRows && dupRows.length) mismatchReason = 'same_patient_other_person';
        }

        if (!mismatchReason && returnedPatient) {
          const { data: personRow } = await admin.from('people')
            .select('date_of_birth, manual_date_of_birth')
            .eq('id', person_id)
            .eq('user_id', user.id)
            .maybeSingle();
          const weHave: string | null = (personRow?.manual_date_of_birth || personRow?.date_of_birth || null);
          guardDebug.person_has_birth_date = !!weHave;
          if (weHave) {
            try {
              const base = String(conn.fhir_base_url || '').replace(/\/+$/, '');
              const pRes = await fetch(`${base}/Patient/${encodeURIComponent(returnedPatient)}`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/fhir+json' },
              });
              guardDebug.patient_read_status = pRes.status;
              if (pRes.ok) {
                const pj = await pRes.json();
                const theirs = typeof pj?.birthDate === 'string' ? pj.birthDate : '';
                guardDebug.hospital_has_birth_date = /^\d{4}-\d{2}-\d{2}$/.test(theirs);
                if (/^\d{4}-\d{2}-\d{2}$/.test(theirs) && theirs !== String(weHave).slice(0, 10)) {
                  mismatchReason = 'birth_date_mismatch';
                }
              }
            } catch (e) {
              guardDebug.patient_read_error = String((e as Error)?.message || e).slice(0, 200);
            }
          } else {
            // ── CONFIRM STEP (2026-10-21) ── No birth date in Wellet, so
            // nothing to check against. Pause and let the caregiver confirm.
            // The name and birth month go back in this response only; they
            // are never written to the row or to logs.
            needsConfirm = true;
            try {
              const base = String(conn.fhir_base_url || '').replace(/\/+$/, '');
              const pRes = await fetch(`${base}/Patient/${encodeURIComponent(returnedPatient)}`, {
                headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/fhir+json' },
              });
              guardDebug.patient_read_status = pRes.status;
              if (pRes.ok) confirmDisplay = patientDisplay(await pRes.json());
            } catch (e) {
              guardDebug.patient_read_error = String((e as Error)?.message || e).slice(0, 200);
            }
          }
        }
        if (!mismatchReason && !returnedPatient) {
          // No patient in the token response means nothing to compare. Ask.
          needsConfirm = true;
        }

        if (mismatchReason) {
          // No tokens stored. The row is closed so nothing can sync from it.
          // No names or dates are written here, only the reason.
          await admin.from('ehr_connections').update({
            status: 'patient_mismatch',
            code_verifier: null,
            state: null,
            last_error: mismatchReason,
            last_error_step: 'patient_match',
            last_error_at: new Date().toISOString(),
            last_error_debug: guardDebug,
          }).eq('id', conn.id).eq('user_id', user.id);
          console.warn('[epic-auth] patient-match guard blocked connect', { conn_id: conn.id, reason: mismatchReason });
          return jsonResponse({
            error: 'patient_mismatch',
            reason: mismatchReason,
            hospital_name: conn.hospital_name || null,
          }, 409);
        }
        if (Object.keys(guardDebug).length > 1) console.log('[epic-auth] patient-match guard passed', { conn_id: conn.id, ...guardDebug });
      }

      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      if (!encKey) {
        await markConnError(admin, conn.id, 'missing_enc_key',
          'EHR_ENCRYPTION_KEY env var not set on edge function');
        return jsonResponse({
          error: 'server_misconfigured',
          message: 'Server encryption key is not configured. Please contact support.',
        }, 500);
      }

      const { data: encAccessToken, error: encAccessErr } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.access_token, enc_key: encKey,
      });
      if (encAccessErr || !encAccessToken) {
        await markConnError(admin, conn.id, 'encrypt_access_token',
          `encrypt_ehr_token RPC failed for access_token: ${encAccessErr?.message || 'no token returned'}`);
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
          await markConnError(admin, conn.id, 'encrypt_refresh_token',
            `encrypt_ehr_token RPC failed for refresh_token: ${encRErr?.message || 'no token returned'}`);
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

      if (needsConfirm) {
        // Tokens are stored encrypted so the caregiver does not have to sign
        // in twice, but the row is not 'connected': no sync schedule is
        // created (ehr_connection_create_schedule only fires on connected),
        // fetch-ehr-data and background-ehr-sync skip it, and no prior row is
        // superseded. confirm_patient finishes it; a cron job clears it once
        // the access token expires.
        const { error: pauseErr } = await admin.from('ehr_connections')
          .update({
            access_token: encAccessToken,
            refresh_token: encRefreshToken,
            token_expires_at: expiresAt,
            patient_id: tokenData.patient || null,
            connected_provider: hospitalLabel,
            client_id_used: connCreds.clientId,
            needs_reconnect: false,
            status: 'awaiting_confirm',
            code_verifier: null,
            state: null,
          })
          .eq('id', conn.id)
          .eq('user_id', user.id);
        if (pauseErr) {
          await markConnError(admin, conn.id, 'confirm_pause_failed',
            `UPDATE to awaiting_confirm failed: ${(pauseErr as { message?: string })?.message || 'unknown'}`);
          return jsonResponse({ error: 'Failed to store tokens' }, 500);
        }
        console.log('[epic-auth] paused for patient confirm', { conn_id: conn.id, has_name: !!confirmDisplay.name, has_birth_month: !!confirmDisplay.birth_month });
        return jsonResponse({
          needs_confirm: true,
          connection_id: conn.id,
          hospital_name: conn.hospital_name || null,
          patient: confirmDisplay,
          expires_at: expiresAt,
        });
      }

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
          console.error('[epic-auth] supersede prior connected row failed', { err: supersedeErr });
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
        const isUniq = /idx_ehr_connections_person_fhir_connected|duplicate key/i.test(
          (updateError as { message?: string })?.message || ''
        );
        await markConnError(admin, conn.id, isUniq ? 'token_store_unique_conflict' : 'token_store_update_failed',
          `Final UPDATE to status=connected failed: ${(updateError as { message?: string })?.message || 'unknown'}`);
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

    // ── REFRESH ──
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
        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('person_id', person_id)
          .eq('user_id', user.id);

        try {
          const { data: prior } = await admin.from('wellet_ops_events')
            .select('id')
            .eq('event_type', 'ehr_silent_failure')
            .eq('source', 'epic-auth')
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .filter('payload->>connection_id', 'eq', conn.id)
            .limit(1);
          if (!prior || prior.length === 0) {
            await admin.from('wellet_ops_events').insert({
              event_type: 'ehr_silent_failure',
              severity: 'high',
              summary: 'EHR connection lost for ' + (conn.hospital_name || 'a connected hospital') + ' — reconnect needed.',
              source: 'epic-auth',
              payload: {
                vendor: 'epic',
                reason: 'no_refresh_token',
                connection_id: conn.id,
                person_id,
                user_id: user.id,
                hospital_name: conn.hospital_name || null,
                fhir_base_url: conn.fhir_base_url || null,
              },
            });
          }
        } catch (_) { /* best-effort logging */ }

        return jsonResponse({
          error: 'no_refresh_token',
          message: 'This connection has no refresh token. Reconnect required.',
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
        console.error('[epic-auth] decrypt refresh_token failed', { err: decErr?.message });
        return jsonResponse({ error: 'decrypt_failed', detail: decErr?.message }, 500);
      }

      const tokenUrl = conn.token_url || EPIC_SANDBOX_TOKEN;
      const connIsSandbox = conn.fhir_base_url === EPIC_SANDBOX_FHIR_BASE;

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
        const respHeaders: Record<string, string> = {};
        for (const [k, v] of tokenRes.headers.entries()) {
          if (/^(www-authenticate|x-epic|x-request-id|content-type|date)$/i.test(k)) {
            respHeaders[k] = v;
          }
        }
        console.error('[epic-auth] refresh failed', {
          status: tokenRes.status,
          body: errText.slice(0, 1000),
          headers: respHeaders,
          person_id,
          conn_id: conn.id,
          client_id_used: conn.client_id_used,
          fhir_base_url: conn.fhir_base_url,
          token_url: tokenUrl,
          is_legacy_public: isLegacyPublic,
          refresh_token_age_days: conn.created_at ? Math.floor((Date.now() - new Date(conn.created_at).getTime()) / 86400000) : null,
        });

        await admin.from('ehr_connections')
          .update({ needs_reconnect: true, status: 'needs_reconnect' })
          .eq('person_id', person_id)
          .eq('user_id', user.id);

        try {
          await admin.from('ehr_sync_log').insert({
            person_id,
            patient_id: conn.patient_id,
            status: tokenRes.status,
            result_counts: { refresh_error: true, epic_body: errText.slice(0, 500), epic_headers: respHeaders },
          });
        } catch (_) { /* best-effort logging */ }

        try {
          const { data: prior } = await admin.from('wellet_ops_events')
            .select('id')
            .eq('event_type', 'ehr_silent_failure')
            .eq('source', 'epic-auth')
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .filter('payload->>connection_id', 'eq', conn.id)
            .limit(1);
          if (!prior || prior.length === 0) {
            await admin.from('wellet_ops_events').insert({
              event_type: 'ehr_silent_failure',
              severity: 'high',
              summary: 'EHR refresh failed for ' + (conn.hospital_name || 'a connected hospital') + ' — reconnect needed.',
              source: 'epic-auth',
              payload: {
                vendor: 'epic',
                reason: 'refresh_failed',
                epic_status: tokenRes.status,
                connection_id: conn.id,
                person_id,
                user_id: user.id,
                hospital_name: conn.hospital_name || null,
                fhir_base_url: conn.fhir_base_url || null,
                is_legacy_public: isLegacyPublic,
                refresh_token_age_days: conn.created_at ? Math.floor((Date.now() - new Date(conn.created_at).getTime()) / 86400000) : null,
              },
            });
          }
        } catch (_) { /* best-effort logging */ }

        return jsonResponse({
          error: 'refresh_failed',
          epic_status: tokenRes.status,
          epic_body: errText.slice(0, 1000),
          epic_headers: respHeaders,
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
    // ── CONFIRM_PATIENT (2026-10-21) ──
    // Finishes or cancels a connect paused at awaiting_confirm.
    //   answer 'yes': re-checks the account-level duplicate rule, saves the
    //     hospital's full birth date on the person if Wellet still has none,
    //     supersedes any prior connected row, and marks the row connected.
    //   answer 'no': clears the tokens and closes the row as patient_mismatch.
    if (action === 'confirm_patient') {
      const { connection_id, person_id, answer } = body;
      if (!connection_id || !person_id || (answer !== 'yes' && answer !== 'no')) {
        return jsonResponse({ error: 'connection_id, person_id and answer (yes or no) are required' }, 400);
      }
      const admin = getAdminClient();
      const { data: conn } = await admin.from('ehr_connections')
        .select('*')
        .eq('id', connection_id)
        .eq('user_id', user.id)
        .eq('person_id', person_id)
        .eq('status', 'awaiting_confirm')
        .maybeSingle();
      if (!conn) return jsonResponse({ error: 'not_found' }, 404);

      const closeRow = async (status: string, reason: string) => {
        await admin.from('ehr_connections').update({
          status,
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          last_error: reason,
          last_error_step: 'patient_confirm',
          last_error_at: new Date().toISOString(),
        }).eq('id', conn.id).eq('user_id', user.id);
      };

      if (answer === 'no') {
        await closeRow('patient_mismatch', 'user_declined');
        return jsonResponse({ declined: true, hospital_name: conn.hospital_name || null });
      }

      const expiresMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
      if (!expiresMs || expiresMs <= Date.now()) {
        await closeRow('abandoned', 'confirm_expired');
        return jsonResponse({ error: 'confirm_expired', hospital_name: conn.hospital_name || null }, 410);
      }

      if (conn.patient_id) {
        const { data: dupRows } = await admin.from('ehr_connections')
          .select('id')
          .eq('user_id', user.id)
          .eq('fhir_base_url', conn.fhir_base_url)
          .eq('patient_id', conn.patient_id)
          .eq('status', 'connected')
          .neq('person_id', person_id)
          .limit(1);
        if (dupRows && dupRows.length) {
          await closeRow('patient_mismatch', 'same_patient_other_person');
          return jsonResponse({ error: 'patient_mismatch', reason: 'same_patient_other_person', hospital_name: conn.hospital_name || null }, 409);
        }
      }

      // Save the hospital's birth date so later sign-ins are checked
      // automatically. Only a full YYYY-MM-DD from the Patient resource, and
      // only when the person still has no birth date (never overwrites).
      let birthDateSaved = false;
      const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
      if (encKey && conn.patient_id && conn.access_token) {
        try {
          const { data: plain } = await admin.rpc('decrypt_ehr_token', { encrypted_token: conn.access_token, enc_key: encKey });
          if (plain) {
            const base = String(conn.fhir_base_url || '').replace(/\/+$/, '');
            const pRes = await fetch(`${base}/Patient/${encodeURIComponent(conn.patient_id)}`, {
              headers: { Authorization: `Bearer ${plain}`, Accept: 'application/fhir+json' },
            });
            if (pRes.ok) {
              const pj = await pRes.json();
              const bd = typeof pj?.birthDate === 'string' ? pj.birthDate : '';
              if (/^\d{4}-\d{2}-\d{2}$/.test(bd)) {
                const { data: upd } = await admin.from('people')
                  .update({ date_of_birth: bd, date_of_birth_source: `ehr_confirm:${conn.id}` })
                  .eq('id', person_id)
                  .eq('user_id', user.id)
                  .is('date_of_birth', null)
                  .is('manual_date_of_birth', null)
                  .select('id');
                birthDateSaved = !!(upd && upd.length);
              }
            }
          }
        } catch (e) {
          console.warn('[epic-auth] confirm birth-date save skipped', { conn_id: conn.id, err: String((e as Error)?.message || e).slice(0, 200) });
        }
      }

      await admin.from('ehr_connections')
        .update({ status: 'superseded', access_token: null, refresh_token: null, token_expires_at: null, needs_reconnect: false })
        .eq('person_id', person_id)
        .eq('fhir_base_url', conn.fhir_base_url)
        .eq('status', 'connected')
        .neq('id', conn.id);

      const { error: connErr } = await admin.from('ehr_connections')
        .update({ status: 'connected', connected_at: new Date().toISOString() })
        .eq('id', conn.id)
        .eq('user_id', user.id)
        .eq('status', 'awaiting_confirm');
      if (connErr) {
        console.error('[epic-auth] confirm final update failed', { conn_id: conn.id, err: (connErr as { message?: string })?.message });
        return jsonResponse({ error: 'Failed to store tokens' }, 500);
      }
      console.log('[epic-auth] patient confirmed by caregiver', { conn_id: conn.id, birth_date_saved: birthDateSaved });
      return jsonResponse({
        success: true,
        confirmed: true,
        hospital_name: conn.hospital_name || null,
        expires_at: conn.token_expires_at,
        has_refresh_token: !!conn.refresh_token,
        birth_date_saved: birthDateSaved,
      });
    }

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

    return jsonResponse({ error: 'Unknown action. Use: start, callback, confirm_patient, refresh, status, disconnect' }, 400);

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
