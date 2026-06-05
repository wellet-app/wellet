// care-signal-action v1 — owner-initiated state transitions on care_signals
//
// Caregivers can dismiss, mark-handled, snooze, or restore a CareSignal.
// All transitions enforced server-side with RLS doing ownership; this fn
// adds validation, sets the right timestamp fields, and is idempotent.
//
// Request:
//   POST /functions/v1/care-signal-action
//   Authorization: Bearer <user JWT>
//   Body: { signal_id: uuid, action: 'acted_on'|'dismissed'|'snoozed'|'restore', note?: string }
//
// Response: { ok: true, status: '<new status>', status_changed_at: iso }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const ACTION_TO_STATUS: Record<string, string> = {
  acted_on:  'acted_on',
  dismissed: 'dismissed',
  snoozed:   'snoozed',
  restore:   'active',
};

function decodeJwtSub(hdr: string): string | null {
  try {
    const tok = hdr.replace(/^Bearer\s+/i, '').trim();
    const parts = tok.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.sub || null;
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const signal_id = body?.signal_id;
    const action    = body?.action;
    const note      = typeof body?.note === 'string' ? body.note.slice(0, 1000) : null;

    if (!signal_id || typeof signal_id !== 'string') {
      return new Response(
        JSON.stringify({ error: 'signal_id is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    if (!action || !(action in ACTION_TO_STATUS)) {
      return new Response(
        JSON.stringify({ error: 'invalid action', allowed: Object.keys(ACTION_TO_STATUS) }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing Authorization header' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const jwtSub = decodeJwtSub(authHeader);
    if (!jwtSub) {
      return new Response(
        JSON.stringify({ error: 'Invalid Authorization token' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
    const ANON_KEY     = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // Owner-only read; RLS will return null if the user does not own the row.
    const { data: existing, error: readErr } = await supabase
      .from('care_signals')
      .select('id, owner_user_id, status')
      .eq('id', signal_id)
      .maybeSingle();

    if (readErr) {
      console.warn('care-signal-action read error:', readErr.message);
    }
    if (!existing || existing.owner_user_id !== jwtSub) {
      return new Response(
        JSON.stringify({ error: 'signal not found or not owned' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const newStatus = ACTION_TO_STATUS[action];
    const nowIso = new Date().toISOString();

    // Idempotent: if already in target state, just return.
    if (existing.status === newStatus) {
      return new Response(
        JSON.stringify({ ok: true, status: newStatus, status_changed_at: nowIso, idempotent: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const patch: Record<string, unknown> = {
      status: newStatus,
      status_changed_at: nowIso,
      updated_at: nowIso,
    };

    if (action === 'acted_on') {
      patch.acted_on_at = nowIso;
      patch.acted_on_by = jwtSub;
      if (note) patch.acted_on_note = note;
    } else if (action === 'restore') {
      // Clear handled fields so the card looks fresh again.
      patch.acted_on_at = null;
      patch.acted_on_by = null;
      patch.acted_on_note = null;
    }

    const { error: updErr } = await supabase
      .from('care_signals')
      .update(patch)
      .eq('id', signal_id);

    if (updErr) {
      console.warn('care-signal-action update error:', updErr.message);
      return new Response(
        JSON.stringify({ error: 'could not update', details: updErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true, status: newStatus, status_changed_at: nowIso }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('care-signal-action v1 error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error', details: String(err) }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
