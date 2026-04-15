// Supabase Edge Function: oneup-auth
// Handles 1upHealth OAuth2 flow for EHR connections.
// Routes:
//   POST /start   — Creates a 1upHealth user, returns authorize URL
//   POST /callback — Exchanges auth code for tokens, stores in ehr_connections

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ONEUP_CLIENT_ID = Deno.env.get('ONEUP_CLIENT_ID') ?? '';
const ONEUP_CLIENT_SECRET = Deno.env.get('ONEUP_CLIENT_SECRET') ?? '';
const ONEUP_API_BASE = 'https://api.1up.health';
const ONEUP_AUTH_BASE = 'https://auth.1up.health';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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

function getAdminClient() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  return createClient(supabaseUrl, supabaseServiceKey);
}

// Create a 1upHealth user via their API
async function createOneUpUser(appUserId: string): Promise<{ oneup_user_id: string; code: string }> {
  const res = await fetch(`${ONEUP_API_BASE}/user-management/v1/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      app_user_id: appUserId,
      client_id: ONEUP_CLIENT_ID,
      client_secret: ONEUP_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`1upHealth user creation failed: ${res.status} ${text}`);
  }

  const data = await res.json();
  return {
    oneup_user_id: String(data.oneup_user_id || data.id || ''),
    code: data.code || '',
  };
}

// Exchange an auth code for access + refresh tokens
async function exchangeCodeForTokens(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
  const res = await fetch(`${ONEUP_AUTH_BASE}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: ONEUP_CLIENT_ID,
      client_secret: ONEUP_CLIENT_SECRET,
      code: code,
      grant_type: 'authorization_code',
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return await res.json();
}

// Refresh an expired access token
async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
}> {
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

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${text}`);
  }

  return await res.json();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const user = await getAuthenticatedUser(req);
    if (!user) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }

    const url = new URL(req.url);
    const body = await req.json().catch(() => ({}));
    const action = body.action || url.searchParams.get('action') || '';

    // ── START: Create 1upHealth user and return authorize URL ──
    if (action === 'start') {
      const { person_id } = body;
      if (!person_id) {
        return jsonResponse({ error: 'person_id is required' }, 400);
      }

      const admin = getAdminClient();

      // Check if there's already a connection for this person
      const { data: existing } = await admin.from('ehr_connections')
        .select('*')
        .eq('person_id', person_id)
        .eq('user_id', user.id)
        .single();

      let oneupUserId: string;
      let authCode: string;

      if (existing?.oneup_user_id) {
        // Re-generate an auth code for the existing 1upHealth user
        const codeRes = await fetch(`${ONEUP_API_BASE}/user-management/v1/user/auth-code`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_user_id: `${user.id}_${person_id}`,
            client_id: ONEUP_CLIENT_ID,
            client_secret: ONEUP_CLIENT_SECRET,
          }),
        });
        if (!codeRes.ok) {
          // Fallback: re-create user
          const result = await createOneUpUser(`${user.id}_${person_id}`);
          oneupUserId = existing.oneup_user_id;
          authCode = result.code;
        } else {
          const codeData = await codeRes.json();
          oneupUserId = existing.oneup_user_id;
          authCode = codeData.code || '';
        }
      } else {
        // Create a new 1upHealth user
        const result = await createOneUpUser(`${user.id}_${person_id}`);
        oneupUserId = result.oneup_user_id;
        authCode = result.code;

        // Store the connection record
        await admin.from('ehr_connections').upsert({
          user_id: user.id,
          person_id: person_id,
          oneup_user_id: oneupUserId,
          connected_at: new Date().toISOString(),
        }, { onConflict: 'person_id' });
      }

      // Build the authorize URL — this opens 1upHealth's health system picker
      const authorizeUrl = `${ONEUP_API_BASE}/connect/system/clinical?client_id=${ONEUP_CLIENT_ID}&access_token=${authCode}`;

      return jsonResponse({
        authorize_url: authorizeUrl,
        oneup_user_id: oneupUserId,
      });
    }

    // ── CALLBACK: Exchange auth code for tokens ──
    if (action === 'callback') {
      const { code, person_id } = body;
      if (!code || !person_id) {
        return jsonResponse({ error: 'code and person_id are required' }, 400);
      }

      // Exchange the code for tokens
      const tokens = await exchangeCodeForTokens(code);
      const expiresAt = new Date(Date.now() + (tokens.expires_in || 7200) * 1000).toISOString();

      const admin = getAdminClient();

      // Update the connection with tokens
      const { error: updateError } = await admin.from('ehr_connections')
        .update({
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_expires_at: expiresAt,
          connected_provider: 'EHR Provider',
          connected_at: new Date().toISOString(),
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
        .select('id, connected_provider, connected_at, last_synced_at, token_expires_at')
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

    // ── DISCONNECT: Remove EHR connection ──
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
    console.error('oneup-auth error:', err);
    return jsonResponse({ error: err.message || 'Internal server error' }, 500);
  }
});
