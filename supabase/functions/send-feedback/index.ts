import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'No authorization header' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { message, page } = await req.json();
    if (!message) {
      return new Response(JSON.stringify({ error: 'message required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Save to feedback table
    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    await adminClient.from('feedback').insert({
      user_id: user.id,
      email: user.email,
      message: message,
      page: page || 'unknown'
    });

    // Send email notification via the Brevo API (2026-10-21). This replaces
    // an SMTP password that was written into this file. BREVO_API_KEY is the
    // restricted, transactional-only key also used by send-away-note.
    try {
      const brevoKey = Deno.env.get('BREVO_API_KEY') ?? '';
      if (!brevoKey) throw new Error('BREVO_API_KEY not set');
      const when = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'Wellet', email: 'hello@getwellet.com' },
          to: [{ email: 'betsy.eble@gmail.com' }],
          subject: `Wellet Feedback from ${user.email}`,
          textContent: `New feedback from ${user.email}:\n\nPage: ${page || 'unknown'}\nTime: ${when}\n\n${message}`,
        }),
      });
      if (!res.ok) throw new Error(`brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } catch (emailErr) {
      console.error('Email send error:', emailErr);
      // Don't fail the request if email fails — feedback is already saved
    }

    return new Response(JSON.stringify({ success: true }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});