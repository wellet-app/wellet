// Supabase Edge Function: create-share
// Generates a unique share token and stores a health summary snapshot.
// POST body: { person_id, person_name, summary_text, recent_events, medications, appointments, include_notes, include_meds }
// Returns: { token, share_url, expires_at }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function generateToken(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  const arr = new Uint8Array(24);
  crypto.getRandomValues(arr);
  for (let i = 0; i < 24; i++) {
    token += chars[arr[i] % chars.length];
  }
  return token;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';

    // Verify the user with their JWT
    const userClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const {
      person_id,
      person_name,
      summary_text,
      recent_events,
      medications,
      appointments,
      include_notes,
      include_meds,
    } = body;

    if (!person_id || !person_name) {
      return new Response(JSON.stringify({ error: 'person_id and person_name are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const token = generateToken();
    const expires_at = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Use service role to insert (bypasses RLS for server-side operations)
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await adminClient.from('shares').insert({
      token,
      user_id: user.id,
      person_id,
      person_name,
      summary_text: summary_text || null,
      recent_events: recent_events || [],
      medications: medications || [],
      appointments: appointments || [],
      include_notes: include_notes || false,
      include_meds: include_meds !== false,
      expires_at,
    }).select().single();

    if (error) {
      console.error('Insert error:', error);
      return new Response(JSON.stringify({ error: 'Failed to create share' }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Log the share creation event
    await adminClient.from('share_events').insert({
      share_id: data.id,
      event_type: 'created',
    });

    // Build the share URL relative to the app origin
    const origin = req.headers.get('origin') || req.headers.get('referer')?.replace(/\/[^/]*$/, '') || '';
    const share_url = origin ? `${origin}/share.html?token=${token}` : `share.html?token=${token}`;

    return new Response(JSON.stringify({
      token,
      share_url,
      expires_at,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
