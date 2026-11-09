// Supabase Edge Function: write-person-care-team-override (v1, 2026-09-10)
//
// Upserts a single caregiver override on person_care_team_overrides. Two use
// cases share this endpoint:
//   1. Manual add. The client generates a practitioner_ref like 'manual:<uuid>'
//      and sends override_name plus any subset of the other override fields.
//   2. Correction of an EHR row. The client sends the EHR row's existing
//      practitioner_ref and only override_phone/email/address/note fields.
//
// Auth: verify_jwt: true. RLS on person_care_team_overrides gates the write
// to callers who own the Person OR are accepted care-circle members
// (see 2026-09-10 person_care_team_overrides_care_circle_rls migration).
//
// EHR-precedence hard rule (enforced here, not just in the client):
//   If a person_care_team row already exists for this (person_id,
//   practitioner_ref), the request MAY NOT set any of the four identity
//   fields (override_name, override_role, override_credential,
//   override_specialty) to a non-null value. The identity fields belong to
//   the EHR row; a caregiver override can only add contact/note on top.
//   Violation returns 400 with error='ehr_precedence_violation'.
//
// Spec: plans/block-24a-manual-add-provider_2026-09-10.md
// Deploy target path: supabase/functions/write-person-care-team-override/index.ts

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// CORS
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

// Types
type WriteBody = {
  person_id?: unknown;
  practitioner_ref?: unknown;
  override_name?: unknown;
  override_role?: unknown;
  override_credential?: unknown;
  override_specialty?: unknown;
  override_phone?: unknown;
  override_phone_label?: unknown;
  override_email?: unknown;
  override_address?: unknown;
  note?: unknown;
};

type ValidatedBody = {
  person_id: string;
  practitioner_ref: string;
  override_name: string | null;
  override_role: string | null;
  override_credential: string | null;
  override_specialty: string | null;
  override_phone: string | null;
  override_phone_label: string | null;
  override_email: string | null;
  override_address: Record<string, unknown> | null;
  note: string | null;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function optString(v: unknown, max: number): string | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return 'invalid';
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return 'invalid';
  return trimmed;
}

function optObject(v: unknown): Record<string, unknown> | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  return v as Record<string, unknown>;
}

function validate(raw: WriteBody): ValidatedBody | { error: string; detail?: string } {
  if (typeof raw.person_id !== 'string' || !UUID_RE.test(raw.person_id)) {
    return { error: 'bad_request', detail: 'person_id must be a uuid' };
  }
  if (typeof raw.practitioner_ref !== 'string' || raw.practitioner_ref.length === 0 || raw.practitioner_ref.length > 200) {
    return { error: 'bad_request', detail: 'practitioner_ref required, max 200 chars' };
  }

  const fields: Record<string, string | null | 'invalid'> = {
    override_name:        optString(raw.override_name, 120),
    override_role:        optString(raw.override_role, 80),
    override_credential:  optString(raw.override_credential, 40),
    override_specialty:   optString(raw.override_specialty, 80),
    override_phone:       optString(raw.override_phone, 40),
    override_phone_label: optString(raw.override_phone_label, 40),
    override_email:       optString(raw.override_email, 200),
    note:                 optString(raw.note, 500),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === 'invalid') return { error: 'bad_request', detail: `${k} invalid` };
  }
  if (fields.override_email && !EMAIL_RE.test(fields.override_email as string)) {
    return { error: 'bad_request', detail: 'override_email invalid format' };
  }

  const addr = optObject(raw.override_address);
  if (addr === 'invalid') return { error: 'bad_request', detail: 'override_address invalid' };

  return {
    person_id: raw.person_id,
    practitioner_ref: raw.practitioner_ref,
    override_name:        fields.override_name as string | null,
    override_role:        fields.override_role as string | null,
    override_credential:  fields.override_credential as string | null,
    override_specialty:   fields.override_specialty as string | null,
    override_phone:       fields.override_phone as string | null,
    override_phone_label: fields.override_phone_label as string | null,
    override_email:       fields.override_email as string | null,
    override_address:     addr,
    note:                 fields.note as string | null,
  };
}

// Handler
serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405, cors);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return jsonResponse({ error: 'missing_auth' }, 401, cors);

  let raw: WriteBody;
  try {
    raw = await req.json();
  } catch {
    return jsonResponse({ error: 'bad_request', detail: 'body must be json' }, 400, cors);
  }

  const validated = validate(raw);
  if ('error' in validated) return jsonResponse(validated, 400, cors);

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    return jsonResponse({ error: 'server_misconfigured' }, 500, cors);
  }

  // Resolve caller uid from the JWT (used for created_by_user_id and for
  // an explicit membership check on the EHR-precedence lookup below).
  const authClient = createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userErr } = await authClient.auth.getUser();
  if (userErr || !userData?.user) return jsonResponse({ error: 'unauthenticated' }, 401, cors);
  const callerUid = userData.user.id;

  // EHR-precedence check. The RLS-scoped anon client here means the caller
  // sees person_care_team only if they are the owner or an accepted circle
  // member. If they aren't, this lookup returns 0 rows and we fall through
  // to the upsert, where person_care_team_overrides' RLS will reject with
  // a 403-equivalent (PGRST) and we translate to 'forbidden' below.
  const wantsIdentityFields =
    validated.override_name !== null ||
    validated.override_role !== null ||
    validated.override_credential !== null ||
    validated.override_specialty !== null;

  if (wantsIdentityFields) {
    const { data: base, error: baseErr } = await authClient
      .from('person_care_team')
      .select('id')
      .eq('person_id', validated.person_id)
      .eq('practitioner_ref', validated.practitioner_ref)
      .maybeSingle();
    if (baseErr && baseErr.code !== 'PGRST116') {
      // PGRST116 = no rows; anything else is a real error.
      return jsonResponse({ error: 'server_error', detail: baseErr.message }, 500, cors);
    }
    if (base) {
      return jsonResponse(
        {
          error: 'ehr_precedence_violation',
          detail:
            'An EHR row exists for this practitioner_ref. Identity fields (name, role, credential, specialty) belong to the EHR row. Send only override_phone/email/address/note on this practitioner_ref.',
        },
        400,
        cors,
      );
    }
  }

  // Upsert on (person_id, practitioner_ref). RLS enforces circle-membership.
  const upsertPayload = {
    person_id: validated.person_id,
    practitioner_ref: validated.practitioner_ref,
    override_name: validated.override_name,
    override_role: validated.override_role,
    override_credential: validated.override_credential,
    override_specialty: validated.override_specialty,
    override_phone: validated.override_phone,
    override_phone_label: validated.override_phone_label,
    override_email: validated.override_email,
    override_address: validated.override_address,
    note: validated.note,
    created_by_user_id: callerUid,
    updated_at: new Date().toISOString(),
  };

  const { data: written, error: writeErr } = await authClient
    .from('person_care_team_overrides')
    .upsert(upsertPayload, { onConflict: 'person_id,practitioner_ref' })
    .select()
    .single();

  if (writeErr) {
    // PostgREST returns a 403-ish PGRST error when RLS rejects; treat any
    // permission-adjacent code as forbidden.
    if (writeErr.code === '42501' || writeErr.code === 'PGRST301') {
      return jsonResponse({ error: 'forbidden' }, 403, cors);
    }
    // CHECK-constraint violations on the length caps become 23514.
    if (writeErr.code === '23514') {
      return jsonResponse({ error: 'bad_request', detail: writeErr.message }, 400, cors);
    }
    return jsonResponse({ error: 'server_error', detail: writeErr.message }, 500, cors);
  }

  return jsonResponse({ ok: true, override: written }, 200, cors);
});