// Supabase Edge Function: cerner-auth-callback
// Cerner Wave 1 — SMART on FHIR OAuth2 callback handler.
// Public client — no client_secret. Exchange code for tokens using only client_id.
//
// GET/POST with: code=...&state=...
// Validates state, exchanges code at token URL, persists tokens to ehr_connections
// with provider='cerner', redirects user to mywellet.com/me/connections?ok=cerner.
//
// FHIR shape gotchas logged during Wave 1 build:
//   - Cerner escapes ampersands as \u0026 in link.url pagination fields.
//     We unescape these before following next-page links.
//   - Encounter.period.start can be null on in-progress encounters.
//     We guard all period reads with null checks.
//
// Voice rules: loved one / family member — not parent. notices / watches for — not track/monitor.
// CareSignals is one word. No emojis, no italics, no exclamation points.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CERNER_CLIENT_ID = '3b98223e-17ec-4a8f-ac77-f4fdbb242371';
const CERNER_REDIRECT_URI = Deno.env.get('CERNER_REDIRECT_URI') ??
  'https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/cerner-auth-callback';
const APP_REDIRECT_BASE = Deno.env.get('APP_REDIRECT_BASE') ?? 'https://mywellet.com';

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

// ── Main Handler ─────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  // This endpoint is the OAuth2 redirect target — Cerner sends GET with
  // query params. We also accept POST for testing convenience.
  try {
    let code: string | null = null;
    let state: string | null = null;
    let errorParam: string | null = null;

    if (req.method === 'GET') {
      const url = new URL(req.url);
      code = url.searchParams.get('code');
      state = url.searchParams.get('state');
      errorParam = url.searchParams.get('error');
    } else if (req.method === 'POST') {
      const body = await req.json().catch(() => ({}));
      code = body.code ?? null;
      state = body.state ?? null;
      errorParam = body.error ?? null;
    } else {
      return new Response('Method not allowed', { status: 405 });
    }

    // Handle user-denied or provider error
    if (errorParam) {
      console.warn('[cerner-auth-callback] provider returned error', { error: errorParam });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_denied&detail=${encodeURIComponent(errorParam)}`,
        302,
      );
    }

    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    const admin = getAdminClient();

    // Validate state — look up pending ehr_connections row by state value.
    const { data: conn, error: connError } = await admin
      .from('ehr_connections')
      .select('*')
      .eq('state', state)
      .eq('provider', 'cerner')
      .maybeSingle();

    if (connError || !conn) {
      console.error('[cerner-auth-callback] state not found', { state: state.slice(0, 8) + '...', connError });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_state_mismatch`,
        302,
      );
    }

    const tokenUrl = conn.token_url as string;
    if (!tokenUrl) {
      console.error('[cerner-auth-callback] no token_url on connection row', { conn_id: conn.id });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_config_error`,
        302,
      );
    }

    // Exchange authorization code for tokens.
    // Cerner public app — no client_secret, no client_assertion.
    // POST application/x-www-form-urlencoded per SMART on FHIR spec.
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: CERNER_REDIRECT_URI,
      client_id: CERNER_CLIENT_ID,
    });

    const t0 = Date.now();
    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenBody,
    });
    const tokenLatencyMs = Date.now() - t0;

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[cerner-auth-callback] token exchange failed', {
        status: tokenRes.status,
        body: errText.slice(0, 400),
        latency_ms: tokenLatencyMs,
      });
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_token_failed&status=${tokenRes.status}`,
        302,
      );
    }

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error('[cerner-auth-callback] no access_token in response', tokenData);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_no_token`,
        302,
      );
    }

    const expiresAt = new Date(
      Date.now() + (tokenData.expires_in || 3600) * 1000,
    ).toISOString();

    // Encrypt tokens using the shared EHR encryption key.
    const encKey = Deno.env.get('EHR_ENCRYPTION_KEY') || '';
    if (!encKey) {
      console.error('[cerner-auth-callback] EHR_ENCRYPTION_KEY not set');
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_server_misconfigured`,
        302,
      );
    }

    const { data: encAccessToken, error: encAccessErr } = await admin.rpc('encrypt_ehr_token', {
      plain_token: tokenData.access_token,
      enc_key: encKey,
    });
    if (encAccessErr || !encAccessToken) {
      console.error('[cerner-auth-callback] encrypt access_token failed', encAccessErr);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_encrypt_failed`,
        302,
      );
    }

    let encRefreshToken: string | null = null;
    if (tokenData.refresh_token) {
      const { data: encR, error: encRErr } = await admin.rpc('encrypt_ehr_token', {
        plain_token: tokenData.refresh_token,
        enc_key: encKey,
      });
      if (encRErr || !encR) {
        console.error('[cerner-auth-callback] encrypt refresh_token failed', encRErr);
        // Non-fatal — proceed without refresh token. User will need to reconnect sooner.
      } else {
        encRefreshToken = encR;
      }
    }

    // patient comes from the token response (Cerner includes it as `patient`).
    const patientId = (tokenData.patient as string | null) ?? null;

    // Before flipping this row to 'connected', supersede any prior connected
    // row for the same (person_id, fhir_base_url) — same pattern as epic-auth
    // to satisfy the partial unique index.
    try {
      await admin
        .from('ehr_connections')
        .update({
          status: 'superseded',
          access_token: null,
          refresh_token: null,
          token_expires_at: null,
          needs_reconnect: false,
        })
        .eq('person_id', conn.person_id)
        .eq('fhir_base_url', conn.fhir_base_url)
        .eq('status', 'connected')
        .neq('id', conn.id);
    } catch (e) {
      console.error('[cerner-auth-callback] supersede prior row failed', (e as Error).message);
    }

    const { error: updateError } = await admin
      .from('ehr_connections')
      .update({
        access_token: encAccessToken,
        refresh_token: encRefreshToken,
        token_expires_at: expiresAt,
        patient_id: patientId,
        connected_provider: 'Cerner Sandbox',
        connected_at: new Date().toISOString(),
        client_id_used: CERNER_CLIENT_ID,
        needs_reconnect: false,
        status: 'connected',
        state: null,
        code_verifier: null,
      })
      .eq('id', conn.id);

    if (updateError) {
      console.error('[cerner-auth-callback] token store failed', updateError);
      return Response.redirect(
        `${APP_REDIRECT_BASE}/me/connections?error=cerner_store_failed`,
        302,
      );
    }

    console.log('[cerner-auth-callback] connection established', {
      conn_id: conn.id,
      person_id: conn.person_id,
      patient_id: patientId,
      has_refresh_token: !!tokenData.refresh_token,
      token_latency_ms: tokenLatencyMs,
    });

    return Response.redirect(
      `${APP_REDIRECT_BASE}/me/connections?ok=cerner`,
      302,
    );
  } catch (err) {
    console.error('[cerner-auth-callback] unhandled error', err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
