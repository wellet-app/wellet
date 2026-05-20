// ask-wellet-save v1 — Voice v1 BDB
//
// Save an Ask Wellet conversation to the loved one's timeline as a
// health_event of type 'ask_wellet_conversation', and upload the full
// transcript JSON to the ask-transcripts bucket.
//
// Request:
//   POST /functions/v1/ask-wellet-save
//   Authorization: Bearer <user JWT>
//   Body: {
//     conversation_id: uuid,
//     title?: string,           // optional human title; we'll generate one if missing
//     summary?: string,         // optional one-line summary
//     event_date?: string,      // ISO; defaults to conversation.ended_at || now()
//   }
//
// Response:
//   { ok: true, event_id, transcript_path, transcript_url }
//
// Side effects:
//   - Inserts row into public.health_events (event_type='ask_wellet_conversation')
//   - Uploads {person_id}/{conversation_id}.json to ask-transcripts bucket
//   - Updates ask_conversations.save_state='saved', saved_event_id, saved_at
//
// Voice rules: 'loved one' / 'family member' / 'notices' / 'watches for'.
// CareSignals is ONE WORD.

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

function buildTitle(messages: any[], explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim().slice(0, 120);
  // Take the first user message as the seed.
  const firstUser = messages.find((m: any) => m.role === 'user');
  const raw = (firstUser?.content || '').toString().trim();
  if (!raw) return 'Ask Wellet conversation';
  // Strip trailing punctuation, cap length.
  const first = raw.split(/[.!?\n]/)[0].trim();
  return first.length > 120 ? first.slice(0, 117) + '…' : first || 'Ask Wellet conversation';
}

function buildSummary(messages: any[], counts: any, explicit?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const obs = counts?.observations_count || 0;
  const prep = counts?.prep_count || 0;
  const lookups = counts?.lookup_count || 0;
  const total = messages.filter((m: any) => m.role === 'user').length;
  const parts: string[] = [];
  if (obs > 0) parts.push(`${obs} observation${obs === 1 ? '' : 's'}`);
  if (prep > 0) parts.push(`${prep} prep note${prep === 1 ? '' : 's'}`);
  if (lookups > 0 && parts.length === 0) parts.push(`${lookups} question${lookups === 1 ? '' : 's'}`);
  if (parts.length === 0) parts.push(`${total} message${total === 1 ? '' : 's'}`);
  return parts.join(' · ');
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
    const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    // Use the user's JWT for RLS-enforced reads; service role for the write
    // to the transcript bucket and the health_events insert (we'll still
    // double-check ownership before either).
    const supabase = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 1. Load the conversation. RLS will enforce that the requester owns it.
    const { data: conv, error: convErr } = await supabase
      .from('ask_conversations')
      .select('*')
      .eq('id', conversation_id)
      .maybeSingle();

    if (convErr) {
      console.warn('conv read error:', convErr.message);
    }
    if (!conv) {
      return new Response(
        JSON.stringify({ error: 'conversation not found or not owned' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 2. Defense in depth: confirm conv.user_id matches jwt.sub.
    if (conv.user_id !== jwtSub) {
      return new Response(
        JSON.stringify({ error: 'forbidden' }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 3. Idempotency: if already saved, return the existing linkage.
    if (conv.save_state === 'saved' && conv.saved_event_id) {
      return new Response(
        JSON.stringify({
          ok: true,
          event_id: conv.saved_event_id,
          already_saved: true,
        }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 4. Load messages (chronological).
    const { data: msgs, error: msgsErr } = await supabase
      .from('ask_messages')
      .select('id, role, content, modality, classification, model, live_ehr_used, created_at')
      .eq('conversation_id', conversation_id)
      .order('created_at', { ascending: true });

    if (msgsErr) {
      console.warn('msgs read error:', msgsErr.message);
      return new Response(
        JSON.stringify({ error: 'could not load messages' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }
    const messages = msgs || [];

    if (messages.length === 0) {
      return new Response(
        JSON.stringify({ error: 'conversation has no messages' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 5. Build title + summary + event_date.
    const title = buildTitle(messages, body?.title);
    const summary = buildSummary(messages, conv, body?.summary);
    const event_date = body?.event_date || conv.ended_at || new Date().toISOString();

    // 6. Build transcript JSON and upload to ask-transcripts/{person_id}/{conversation_id}.json
    //    Service role can write; RLS on the bucket will enforce reads.
    const transcript = {
      conversation_id: conv.id,
      person_id: conv.person_id,
      started_at: conv.started_at,
      ended_at: conv.ended_at,
      modality: conv.modality,
      counts: {
        observations: conv.observations_count,
        prep: conv.prep_count,
        lookup: conv.lookup_count,
        other: conv.other_count,
      },
      messages: messages.map((m: any) => ({
        role: m.role,
        content: m.content,
        modality: m.modality,
        classification: m.classification,
        model: m.model,
        live_ehr_used: m.live_ehr_used,
        created_at: m.created_at,
      })),
      saved_at: new Date().toISOString(),
      schema_version: 1,
    };
    const transcriptPath = `${conv.person_id}/${conv.id}.json`;
    const transcriptBytes = new TextEncoder().encode(JSON.stringify(transcript, null, 2));

    const { error: uploadErr } = await admin.storage
      .from('ask-transcripts')
      .upload(transcriptPath, transcriptBytes, {
        contentType: 'application/json',
        upsert: true,
      });

    if (uploadErr) {
      console.warn('transcript upload error:', uploadErr.message);
      // Don't fail the whole save — we can still record the event without
      // a transcript. UI will show "transcript unavailable" if missing.
    }

    // 7. Insert health_events row.
    const eventInsert = {
      person_id: conv.person_id,
      event_type: 'ask_wellet_conversation',
      event_date,
      title,
      notes: summary,
      source: 'ask_wellet',
      accepted: true,
      conversation_id: conv.id,
      transcript_url: uploadErr ? null : transcriptPath,
    };

    const { data: ev, error: evErr } = await admin
      .from('health_events')
      .insert(eventInsert)
      .select('id')
      .single();

    if (evErr || !ev) {
      console.error('health_events insert error:', evErr?.message);
      return new Response(
        JSON.stringify({ error: 'could not save to timeline', details: evErr?.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // 8. Update ask_conversations.save_state='saved'.
    const { error: updErr } = await admin
      .from('ask_conversations')
      .update({
        save_state: 'saved',
        saved_event_id: ev.id,
        saved_at: new Date().toISOString(),
        ended_at: conv.ended_at || new Date().toISOString(),
        title,
        summary,
      })
      .eq('id', conv.id);

    if (updErr) {
      console.warn('conv save_state update error:', updErr.message);
      // Event row already exists, so we'll still return success.
    }

    return new Response(
      JSON.stringify({
        ok: true,
        event_id: ev.id,
        transcript_path: uploadErr ? null : transcriptPath,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (err) {
    console.error('ask-wellet-save v1 error:', err);
    return new Response(
      JSON.stringify({ error: 'Internal error', details: String(err) }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } }
    );
  }
});
