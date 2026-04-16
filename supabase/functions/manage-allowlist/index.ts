// Supabase Edge Function: manage-allowlist
// Admin helper to add or remove emails from the alpha allowlist.
// Protected by service_role key — only callable by Betsy or automation.
// POST body: { action: "add" | "remove", email: string, notes?: string }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { getCorsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Verify service_role authorization
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing authorization header' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    // Only allow service_role key — reject anon/user JWTs
    const token = authHeader.replace('Bearer ', '');
    if (token !== supabaseServiceKey) {
      return new Response(JSON.stringify({ error: 'Forbidden — service_role key required' }), {
        status: 403,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json();
    const { action, email, notes } = body;

    if (!action || !email) {
      return new Response(JSON.stringify({ error: 'action and email are required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!['add', 'remove'].includes(action)) {
      return new Response(JSON.stringify({ error: 'action must be "add" or "remove"' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const adminClient = createClient(supabaseUrl, supabaseServiceKey);
    const normalizedEmail = email.toLowerCase().trim();

    if (action === 'add') {
      const { data, error } = await adminClient
        .from('alpha_allowlist')
        .upsert(
          { email: normalizedEmail, notes: notes || null, invited_at: new Date().toISOString() },
          { onConflict: 'email' }
        )
        .select()
        .single();

      if (error) {
        return new Response(JSON.stringify({ error: 'Failed to add email', detail: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, action: 'added', email: normalizedEmail, record: data }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'remove') {
      const { error } = await adminClient
        .from('alpha_allowlist')
        .delete()
        .eq('email', normalizedEmail);

      if (error) {
        return new Response(JSON.stringify({ error: 'Failed to remove email', detail: error.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ success: true, action: 'removed', email: normalizedEmail }), {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  } catch (err) {
    console.error('Edge function error:', err);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
