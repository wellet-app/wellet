// family-record-url — exchange a public share token for a short-lived signed URL
// to a Family Record PDF in the private `family-records` bucket.
//
// Called by the public viewer at /family-record.html.
//
// Flow:
//   1. Receive { token } in POST body.
//   2. Look up family_records by share_token (must be unexpired).
//   3. Mint a signed URL via storage admin API.
//   4. Log a view event.
//   5. Return { ok, signed_url, expires_at, person_name, snapshot, counts }.
//
// Read-only against family_records. Only write is the view log.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const SIGNED_URL_TTL_SECONDS = 600; // 10 minutes

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { token } = await req.json().catch(() => ({}));
    if (!token || typeof token !== 'string') {
      return json({ ok: false, error: 'missing_token' }, 400);
    }

    const url = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!url || !serviceKey) {
      return json({ ok: false, error: 'server_misconfigured' }, 500);
    }

    const admin = createClient(url, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Look up the record (and confirm it's unexpired).
    const { data: rec, error: recErr } = await admin
      .from('family_records')
      .select('id, person_name, storage_path, wishes_count, conditions_count, medications_count, events_count, snapshot, generated_at, expires_at')
      .eq('share_token', token)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();

    if (recErr) {
      console.error('family-record-url lookup error', recErr);
      return json({ ok: false, error: 'lookup_failed' }, 500);
    }
    if (!rec) {
      return json({ ok: false, error: 'not_found_or_expired' }, 404);
    }

    // Mint signed URL.
    const { data: signed, error: signErr } = await admin
      .storage
      .from('family-records')
      .createSignedUrl(rec.storage_path, SIGNED_URL_TTL_SECONDS);

    if (signErr || !signed?.signedUrl) {
      console.error('family-record-url sign error', signErr);
      return json({ ok: false, error: 'sign_failed' }, 500);
    }

    // Best-effort view log; don't fail the request if this errors.
    try {
      await admin.from('family_record_events').insert({
        family_record_id: rec.id,
        event_type: 'view',
        viewer_ip: req.headers.get('x-forwarded-for') || null,
      });
      await admin.from('family_records').update({
        view_count: (rec as any).view_count != null ? (rec as any).view_count + 1 : 1,
        last_viewed_at: new Date().toISOString(),
      }).eq('id', rec.id);
    } catch (logErr) {
      console.warn('family-record-url log skipped', logErr);
    }

    return json({
      ok: true,
      signed_url: signed.signedUrl,
      url_expires_in: SIGNED_URL_TTL_SECONDS,
      person_name: rec.person_name,
      generated_at: rec.generated_at,
      expires_at: rec.expires_at,
      snapshot: rec.snapshot || {},
      counts: {
        wishes: rec.wishes_count || 0,
        conditions: rec.conditions_count || 0,
        medications: rec.medications_count || 0,
        events: rec.events_count || 0,
      },
    });
  } catch (err) {
    console.error('family-record-url fatal', err);
    return json({ ok: false, error: 'unexpected' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' },
  });
}
