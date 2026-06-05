// ask-wellet-dismiss-save v1 — Voice v1 BDB
//
// User dismissed the save-to-timeline prompt. Mark the conversation as
// dismissed so we don't re-prompt and so we know to roll it up later.
//
// Request:
//   POST /functions/v1/ask-wellet-dismiss-save
//   Authorization: Bearer <user JWT>
//   Body: { conversation_id: uuid }
//
// Response: { ok: true }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

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
    const body = await req.json();
    const conversation_id = body?.conversation_id;
    if (!conversation_id) {
      return new Response(
        JSON.stringify({ error: 'conversation_id is required' }),
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
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });

    // RLS will enforce ownership.
    const { data: conv, error: readErr } = await supabase
      .from('ask_conversations')
      .select('id, user_id, save_state')
      .eq('id', conversation_id)
      .maybeSingle();

    if (readErr) console.warn('dismiss-save read error:', readErr.message);
    if (!conv || conv.user_id !== jwtSub) {
      return new Response(
        JSON.stringify({ error: 'conversation not found or not owned' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Idempotent: don't override 'saved'.
    if (conv.save_state === 'saved') {
      return new Response(
        JSON.stringify({ ok: true, already_saved: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { error: updErr } = await supabase
      .from('ask_conversations')
      .update({
        save_state: 'dismissed',
        ended_at: new Date().toISOString(),
      })
      .eq('id', conversation_id);

    if (updErr) {
      console.warn('dismiss-save update error:', updErr.message);
      return new Response(
        JSON.stringify({ error: 'could not update', details: updErr.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ ok: true }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('ask-wellet-dismiss-save v1 error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error', details: String(err) }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
