// Supabase Edge Function: read-person-care-team (v2, 2026-09-10)
//
// v2 changes on top of v1 (2026-09-05):
//   - person_care_team_overrides read now selects override_name, override_role,
//     override_credential, override_specialty (added by 2026-09-10 migration).
//   - Override-only rows (caregiver-added manual providers, no EHR base row)
//     use the override's own identity fields when present, falling back to
//     'Provider (you added)' only if the caregiver left name blank.
//   - Every MergedRow gains `provider_source: 'caregiver' | null`. It is
//     'caregiver' for override-only rows and null for EHR/enrichment rows,
//     so the iOS list can show a "You added this" badge without re-deriving.
//   - Merged rows that combine an EHR base row + a caregiver correction stay
//     `provider_source: null` because the identity still belongs to the EHR.
//
// Backward-compat: the v1 response shape is preserved; v2 only adds fields.
// Existing v1 clients (SPA, wellet-connect-ios) ignore the new field.
//
// Auth: verify_jwt: true. RLS gates the read.
//
// Spec: plans/block-24a-manual-add-provider_2026-09-10.md
// Deploy target path: supabase/functions/read-person-care-team/index.ts

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
type PersonCareTeamRow = {
  id: string;
  person_id: string;
  practitioner_ref: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  role: string | null;
  provider: string | null;
  phones: string[];
  emails: string[];
  fax: string | null;
  addresses: Array<Record<string, unknown>>;
  photo_url: string | null;
  source: 'ehr' | 'enrichment';
  enrichment_source_name: string | null;
  enrichment_source_url: string | null;
  last_ehr_sync_at: string;
  updated_at: string;
};

type OverrideRow = {
  id: string;
  person_id: string;
  practitioner_ref: string;
  // v2 additions (2026-09-10 migration):
  override_name: string | null;
  override_role: string | null;
  override_credential: string | null;
  override_specialty: string | null;
  // v1 fields:
  override_phone: string | null;
  override_phone_label: string | null;
  override_email: string | null;
  override_address: Record<string, unknown> | null;
  note: string | null;
  updated_at: string;
};

type ContactValue<TValue> = {
  value: TValue;
  label: string | null;
  source: 'caregiver' | 'ehr' | 'enrichment';
  source_name?: string | null;
};

type MergedRow = {
  person_id: string;
  practitioner_ref: string;
  name: string;
  credential: string | null;
  specialty: string | null;
  role: string | null;
  provider: string | null;
  photo_url: string | null;
  contact: {
    phones: ContactValue<string>[];
    emails: ContactValue<string>[];
    addresses: ContactValue<Record<string, unknown>>[];
  };
  note: string | null;
  note_source: 'caregiver' | null;
  // v2 addition: identifies who owns this row's identity (name/role/etc).
  // 'caregiver' means the row exists only in person_care_team_overrides.
  // null means an EHR/enrichment base row supplies the identity, even if a
  // caregiver correction adds contact/note on top.
  provider_source: 'caregiver' | null;
  server_last_ehr_sync_at: string;
  override_updated_at: string | null;
};

// UUID guard
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Merge
function mergeRow(base: PersonCareTeamRow, override: OverrideRow | undefined): MergedRow {
  const sourceLabel = base.source === 'ehr'
    ? (base.provider ? `${base.provider}` : 'EHR')
    : (base.enrichment_source_name ? `${base.enrichment_source_name}` : 'Directory');

  // Phones: caregiver first, then EHR/enrichment values.
  const phones: ContactValue<string>[] = [];
  if (override?.override_phone) {
    phones.push({
      value: override.override_phone,
      label: override.override_phone_label || 'You added this',
      source: 'caregiver',
    });
  }
  for (const p of base.phones || []) {
    if (!p) continue;
    phones.push({
      value: p,
      label: base.source === 'enrichment'
        ? `Practice line (${sourceLabel})`
        : `Practice line (${sourceLabel})`,
      source: base.source,
      source_name: base.source === 'enrichment' ? base.enrichment_source_name : base.provider,
    });
  }

  // Emails: caregiver first, then EHR/enrichment.
  const emails: ContactValue<string>[] = [];
  if (override?.override_email) {
    emails.push({
      value: override.override_email,
      label: 'You added this',
      source: 'caregiver',
    });
  }
  for (const e of base.emails || []) {
    if (!e) continue;
    emails.push({
      value: e,
      label: sourceLabel,
      source: base.source,
      source_name: base.source === 'enrichment' ? base.enrichment_source_name : base.provider,
    });
  }

  // Addresses: caregiver first, then EHR/enrichment.
  const addresses: ContactValue<Record<string, unknown>>[] = [];
  if (override?.override_address) {
    addresses.push({
      value: override.override_address,
      label: 'You added this',
      source: 'caregiver',
    });
  }
  for (const a of base.addresses || []) {
    if (!a || typeof a !== 'object') continue;
    addresses.push({
      value: a,
      label: sourceLabel,
      source: base.source,
      source_name: base.source === 'enrichment' ? base.enrichment_source_name : base.provider,
    });
  }

  return {
    person_id: base.person_id,
    practitioner_ref: base.practitioner_ref,
    name: base.name,
    credential: base.credential,
    specialty: base.specialty,
    role: base.role,
    provider: base.provider,
    photo_url: base.photo_url,
    contact: { phones, emails, addresses },
    note: override?.note || null,
    note_source: override?.note ? 'caregiver' : null,
    // EHR base row supplies identity; provider_source is null even with
    // caregiver contact/note corrections layered on top.
    provider_source: null,
    server_last_ehr_sync_at: base.last_ehr_sync_at,
    override_updated_at: override?.updated_at || null,
  };
}

// Handler
serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'No authorization header' }, 401, cors);

    // Use the caller's JWT so RLS enforces access. NEVER use service role here.
    const client = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: userError } = await client.auth.getUser();
    if (userError || !user) return jsonResponse({ error: 'Unauthorized' }, 401, cors);

    let body: { person_id?: string };
    try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400, cors); }
    if (!body.person_id || typeof body.person_id !== 'string' || !UUID_RE.test(body.person_id)) {
      return jsonResponse({ error: 'person_id (uuid) required' }, 400, cors);
    }

    // Parallel reads. RLS gates both.
    const [baseRes, overrideRes] = await Promise.all([
      client
        .from('person_care_team')
        .select('id,person_id,practitioner_ref,name,credential,specialty,role,provider,phones,emails,fax,addresses,photo_url,source,enrichment_source_name,enrichment_source_url,last_ehr_sync_at,updated_at')
        .eq('person_id', body.person_id)
        .order('name', { ascending: true }),
      client
        .from('person_care_team_overrides')
        .select('id,person_id,practitioner_ref,override_name,override_role,override_credential,override_specialty,override_phone,override_phone_label,override_email,override_address,note,updated_at')
        .eq('person_id', body.person_id),
    ]);

    if (baseRes.error) {
      console.error('[read-person-care-team] person_care_team read failed', { person_id: body.person_id, error: baseRes.error.message });
      return jsonResponse({ error: 'read failed', detail: baseRes.error.message }, 500, cors);
    }
    if (overrideRes.error) {
      console.error('[read-person-care-team] overrides read failed', { person_id: body.person_id, error: overrideRes.error.message });
      // Non-fatal: return base rows without overrides so the card at least renders.
    }

    const baseRows = (baseRes.data || []) as PersonCareTeamRow[];
    const overrideRows = (overrideRes.data || []) as OverrideRow[];

    // Index overrides by practitioner_ref
    const overrideByRef = new Map<string, OverrideRow>();
    for (const o of overrideRows) overrideByRef.set(o.practitioner_ref, o);

    // Base rows + overrides where they match
    const merged: MergedRow[] = baseRows.map((row) => mergeRow(row, overrideByRef.get(row.practitioner_ref)));
    const usedRefs = new Set(baseRows.map((r) => r.practitioner_ref));

    // Overrides for practitioners with NO base row (caregiver-added manual
    // provider, or an override that outlived its EHR row). Surface them so
    // the caregiver's work isn't hidden. In v2 the caregiver's own name/
    // role/credential/specialty is honored; we only fall back to the
    // placeholder if they left name blank.
    for (const o of overrideRows) {
      if (usedRefs.has(o.practitioner_ref)) continue;
      merged.push({
        person_id: o.person_id,
        practitioner_ref: o.practitioner_ref,
        name: o.override_name || 'Provider (you added)',
        credential: o.override_credential,
        specialty: o.override_specialty,
        role: o.override_role,
        provider: null,
        photo_url: null,
        contact: {
          phones: o.override_phone ? [{ value: o.override_phone, label: o.override_phone_label || 'You added this', source: 'caregiver' }] : [],
          emails: o.override_email ? [{ value: o.override_email, label: 'You added this', source: 'caregiver' }] : [],
          addresses: o.override_address ? [{ value: o.override_address, label: 'You added this', source: 'caregiver' }] : [],
        },
        note: o.note,
        note_source: o.note ? 'caregiver' : null,
        // Override-only row: identity belongs to the caregiver.
        provider_source: 'caregiver',
        server_last_ehr_sync_at: o.updated_at,
        override_updated_at: o.updated_at,
      });
    }

    return jsonResponse({ care_team: merged, count: merged.length }, 200, cors);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[read-person-care-team] threw', { error: msg });
    return jsonResponse({ error: 'read-person-care-team failed', detail: msg }, 500, getCorsHeaders(req));
  }
});