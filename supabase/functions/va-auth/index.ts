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

// Decode a JWT payload without signature verification (we already trust the
// token because we just received it over TLS from VA's token endpoint).
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let s = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(atob(s));
  } catch (_) {
    return null;
  }
}

// Sandbox-only fallback: VA's ID.me test users map to known test patient ids.
// Documented at https://department-of-veterans-affairs.github.io/veteran-facing-services-tools/patient-generator/.
// The bypass-auth path silent-grants a token without showing the Lighthouse
// patient picker, so we cannot rely on a launch/patient claim in sandbox.
// VA test patient ids are publicly known and contain only synthetic data.
const VA_SANDBOX_USER_TO_PATIENT: Record<string, string> = {
  // ID.me sandbox user 101 (va.api.user+101-2024@gmail.com) - WelletEble label
  '00u2p9far4ihDAEX82p7': '32000225',
};

// Discover the patient FHIR id for a newly issued VA access token.
async function discoverVaPatientId(
  fhirBase: string,
  accessToken: string,
  isSandbox: boolean,
): Promise<{ patientId: string | null; diag: string }> {
  // 1. Try JWT payload first.
  const claims = decodeJwtPayload(accessToken);
  if (claims) {
    const patientClaim = (typeof claims.patient === 'string' && claims.patient) ? claims.patient as string : null;
    if (patientClaim) {
      console.log('[va-auth] patient resolved from jwt patient claim', { patientId: patientClaim });
      return { patientId: patientClaim, diag: 'jwt_patient_claim' };
    }
    const fhirUser = typeof claims.fhirUser === 'string' ? claims.fhirUser as string : null;
    if (fhirUser) {
      const m = fhirUser.match(/Patient\/([^\/?#]+)/);
      if (m) {
        console.log('[va-auth] patient resolved from jwt fhirUser claim', { fhirUser, patientId: m[1] });
        return { patientId: m[1], diag: 'jwt_fhir_user_claim' };
      }
    }
  }

  // 2. Try /Patient probe.
  let probeDiag = 'patient_search_skipped';
  try {
    const url = fhirBase.replace(/\/$/, '') + '/Patient';
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/fhir+json',
      },
    });
    if (res.ok) {
      const bundle = await res.json().catch(() => null);
      const entries = (bundle && Array.isArray(bundle.entry)) ? bundle.entry : [];
      const first = entries[0]?.resource;
      const id = first && typeof first.id === 'string' ? first.id : null;
      if (id) {
        return { patientId: id, diag: 'patient_search_bundle' };
      }
      probeDiag = 'patient_bundle_empty';
    } else {
      probeDiag = 'patient_search_status_' + res.status;
    }
  } catch (e) {
    probeDiag = 'patient_search_threw';
    console.error('[va-auth] Patient discovery threw', { err: (e as Error).message });
  }

  // 3. Sandbox fallback - map ID.me test user uid to the documented test patient.
  if (isSandbox && claims) {
    const uid = typeof claims.uid === 'string' ? claims.uid as string : '';
    if (uid && VA_SANDBOX_USER_TO_PATIENT[uid]) {
      const sandboxPatient = VA_SANDBOX_USER_TO_PATIENT[uid];
      console.log('[va-auth] patient resolved from sandbox uid mapping', {
        uid,
        patientId: sandboxPatient,
      });
      return { patientId: sandboxPatient, diag: 'sandbox_uid_mapping' };
    }
  }

  console.warn('[va-auth] patient_id could not be resolved', { probeDiag, isSandbox });
  return { patientId: null, diag: probeDiag };
}

// Resolve (client_id, fhirBase, authorizeUrl, tokenUrl) for the current
// environment.
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
  const prodClientId = Deno.env.get('VA_PROD_CLIENT_ID') ?? '';
  return {
    clientId: prodClientId,
    fhirBase: VA_PROD_FHIR_BASE,
    authorizeUrl: VA_PROD_AUTHORIZE,
    tokenUrl: VA_PROD_TOKEN,
  };
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

      // 2026-10-21 ownership check: only the person's owner can start a connect.
      {
        const { data: owned } = await admin.from('people')
          .select('id').eq('id', person_id).eq('user_id', user.id).maybeSingle();
        if (!owned) return jsonResponse({ error: 'Person not found' }, 404);
      }

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await computeCodeChallenge(codeVerifier);
      const state = generateState();

      const { data: existingRows, error: existingErr } = await admin
        .from('ehr_connections')
        .select('id, status')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
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

      let resolvedPatientId: string | null = (typeof tokenData.patient === 'string' && tokenData.patient) ? tokenData.patient : null;
      let patientDiscoveryDiag = 'token_claim_present';
      if (!resolvedPatientId) {
        const probeIsSandbox = conn.fhir_base_url === VA_SANDBOX_FHIR_BASE;
        const probe = await discoverVaPatientId(conn.fhir_base_url as string, tokenData.access_token, probeIsSandbox);
        resolvedPatientId = probe.patientId;
        patientDiscoveryDiag = probe.diag;
      }
      console.log('[va-auth] patient_id resolution', {
        from_token_claim: !!tokenData.patient,
        resolved_patient_id: resolvedPatientId,
        diag: patientDiscoveryDiag,
      });

      // ── PATIENT-MATCH GUARD (2026-10-21, same rules as epic-auth v64) ──
      // Before any token is stored or any prior row is superseded:
      //   1. same_patient_other_person: this account already has a connected row
      //      for the same base URL and patient on a DIFFERENT person.
      //   2. birth_date_mismatch: the person has a birth date in Wellet and the
      //      Patient resource has a full birthDate that differs.
      // A failed Patient read does not block; it is logged.
      let mismatchReason: string | null = null;
      const guardDebug: Record<string, unknown> = { guard: 'patient_match_v1' };
      // Confirm step (2026-10-21, same as epic-auth v66): with no birth date
      // in Wellet on a production base, pause at awaiting_confirm and show the
      // caregiver the name and birth month from VA. Sandbox bases skip it so
      // synthetic test birth dates are never saved to a real profile.
      let needsConfirm = false;
      let confirmDisplay: { name: string | null; birth_month: string | null } = { name: null, birth_month: null };
      if (resolvedPatientId) {
        const { data: dupRows } = await admin.from('ehr_connections')
          .select('id')
          .eq('user_id', user.id)
          .eq('fhir_base_url', conn.fhir_base_url)
          .eq('patient_id', resolvedPatientId)
          .eq('status', 'connected')
          .neq('person_id', person_id)
          .limit(1);
        if (dupRows && dupRows.length) mismatchReason = 'same_patient_other_person';
      }
      // Vendor test patients are synthetic and never match a real profile's
      // birth date, so the birth-date check is skipped on sandbox bases.
      const isSandboxBase = String(conn.fhir_base_url || '').startsWith(VA_SANDBOX_FHIR_BASE);
      guardDebug.sandbox_base = isSandboxBase;
      if (!mismatchReason && !isSandboxBase && resolvedPatientId) {
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
            const pRes = await fetch(`${base}/Patient/${encodeURIComponent(resolvedPatientId)}`, {
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
          needsConfirm = true;
          try {
            const base = String(conn.fhir_base_url || '').replace(/\/+$/, '');
            const pRes = await fetch(`${base}/Patient/${encodeURIComponent(resolvedPatientId)}`, {
              headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/fhir+json' },
            });
            guardDebug.patient_read_status = pRes.status;
            if (pRes.ok) confirmDisplay = patientDisplay(await pRes.json());
          } catch (e) {
            guardDebug.patient_read_error = String((e as Error)?.message || e).slice(0, 200);
          }
        }
      }
      if (!mismatchReason && !isSandboxBase && !resolvedPatientId) needsConfirm = true;
      if (mismatchReason) {
        await admin.from('ehr_connections').update({
          status: 'patient_mismatch',
          code_verifier: null,
          state: null,
          last_error: mismatchReason,
          last_error_step: 'patient_match',
          last_error_at: new Date().toISOString(),
          last_error_debug: guardDebug,
        }).eq('id', conn.id).eq('user_id', user.id);
        console.warn('[va-auth] patient-match guard blocked connect', { conn_id: conn.id, reason: mismatchReason });
        return jsonResponse({ error: 'patient_mismatch', reason: mismatchReason, hospital_name: 'VA' }, 409);
      }

      if (needsConfirm) {
        // See epic-auth v66. Not 'connected': no sync schedule, sync skips it,
        // nothing superseded. confirm_patient finishes it; the
        // ehr-confirm-expire cron clears it once the access token expires.
        const { error: pauseErr } = await admin.from('ehr_connections')
          .update({
            access_token: encAccessToken,
            refresh_token: encRefreshToken,
            token_expires_at: expiresAt,
            patient_id: resolvedPatientId,
            connected_provider: hospitalLabel,
            client_id_used: connEp.clientId,
            needs_reconnect: false,
            status: 'awaiting_confirm',
            code_verifier: null,
            state: null,
          })
          .eq('id', conn.id)
          .eq('user_id', user.id);
        if (pauseErr) {
          console.error('[va-auth] pause for confirm failed', { err: (pauseErr as { message?: string })?.message });
          return jsonResponse({ error: 'Failed to store tokens' }, 500);
        }
        console.log('[va-auth] paused for patient confirm', { conn_id: conn.id, has_name: !!confirmDisplay.name, has_birth_month: !!confirmDisplay.birth_month });
        return jsonResponse({
          needs_confirm: true,
          connection_id: conn.id,
          hospital_name: 'VA',
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
          patient_id: resolvedPatientId,
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
        .eq('provider', 'va')
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
        return jsonResponse({ declined: true, hospital_name: 'VA' });
      }

      const expiresMs = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;
      if (!expiresMs || expiresMs <= Date.now()) {
        await closeRow('abandoned', 'confirm_expired');
        return jsonResponse({ error: 'confirm_expired', hospital_name: 'VA' }, 410);
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
          return jsonResponse({ error: 'patient_mismatch', reason: 'same_patient_other_person', hospital_name: 'VA' }, 409);
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
          console.warn('[va-auth] confirm birth-date save skipped', { conn_id: conn.id, err: String((e as Error)?.message || e).slice(0, 200) });
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
        console.error('[va-auth] confirm final update failed', { conn_id: conn.id, err: (connErr as { message?: string })?.message });
        return jsonResponse({ error: 'Failed to store tokens' }, 500);
      }
      console.log('[va-auth] patient confirmed by caregiver', { conn_id: conn.id, birth_date_saved: birthDateSaved });
      return jsonResponse({
        success: true,
        confirmed: true,
        hospital_name: 'VA',
        expires_at: conn.token_expires_at,
        has_refresh_token: !!conn.refresh_token,
        birth_date_saved: birthDateSaved,
      });
    }

    // ── REFRESH: Exchange refresh_token for a new access_token (public client) ──
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

        try {
          const { data: prior } = await admin.from('wellet_ops_events')
            .select('id')
            .eq('event_type', 'ehr_silent_failure')
            .eq('source', 'va-auth')
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .filter('payload->>connection_id', 'eq', conn.id)
            .limit(1);
          if (!prior || prior.length === 0) {
            await admin.from('wellet_ops_events').insert({
              event_type: 'ehr_silent_failure',
              severity: 'high',
              summary: 'VA connection refresh failed — reconnect needed.',
              source: 'va-auth',
              payload: {
                vendor: 'va',
                reason: 'refresh_failed',
                va_status: tokenRes.status,
                connection_id: conn.id,
                person_id,
                user_id: user.id,
                fhir_base_url: conn.fhir_base_url || null,
              },
            });
          }
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
    if (action === 'disconnect') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

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
