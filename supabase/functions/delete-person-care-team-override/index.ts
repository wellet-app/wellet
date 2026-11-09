// Supabase Edge Function: delete-person-care-team-override (v1, 2026-09-10)
//
// Deletes a single caregiver override on person_care_team_overrides for a
// given (person_id, practitioner_ref). Does not touch person_care_team;
// after this, the row either drops back to the EHR baseline (correction
// case) or disappears entirely (manual-add case).
//
// Auth: verify_jwt: true. RLS gates the delete to the owner or an accepted
// care-circle member.
//
// Spec: plans/block-24a-manual-add-provider_2026-09-10.md
// Deploy target path: supabase/functions/delete-person-care-team-override/index.ts

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const ALLOWED_ORIGINS = [
  'https://mywellet.com',
  'https://www.mywellet.com',
  'https://getwellet.com',
  'https://www.getwellet.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function jsonResponse(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DeleteBody = { person_id?: unknown; practitioner_ref?: unknown };

serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, cors);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'missing_auth' }, 401, cors);

  let raw: DeleteBody;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'bad_request', detail: 'body must be json' }, 400, cors);
  }

  if (typeof raw.person_id !== 'string' || !UUID_RE.test(raw.person_id)) {
    return jsonResponse({ error: 'bad_request', detail: 'person_id must be a uuid' }, 400, cors);
  }
  if (typeof raw.practitioner_ref !== 'string' || raw.practitioner_ref.length === 0 || raw.practitioner_ref.length > 200) {
    return jsonResponse({ error: 'bad_request', detail: 'practitioner_ref required, max 200 chars' }, 400, cors);
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'server_misconfigured' }, 500, cors);
  }

  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse({ error: 'unauthenticated' }, 401, cors);

  const { data: deleted, error: delErr } = await authClient
    .from('person_care_team_overrides')
    .delete()
    .eq('person_id', raw.person_id)
    .eq('practitioner_ref', raw.practitioner_ref)
    .select('id');

  if (delErr) {
    if (delErr.code === '42501' || delErr.code === 'PGRST301') {
      return jsonResponse({ error: 'forbidden' }, 403, cors);
    }
    return jsonResponse({ error: 'server_error', detail: delErr.message }, 500, cors);
  }

  // deleted is an array; 0 rows deleted is not an error (idempotent delete).
  return jsonResponse({ ok: true, deleted_count: deleted?.length ?? 0 }, 200, cors);
});