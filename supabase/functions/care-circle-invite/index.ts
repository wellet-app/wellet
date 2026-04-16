// Care Circle Invite Edge Function
// Actions: create, accept, lookup
// Deployed with verify_jwt=false (lookup needs to work without auth)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, member_id, invite_token } = await req.json()
    const supabase = createClient(supabaseUrl, serviceKey)

    // ── CREATE: Generate invite token and return invite link ──
    if (action === 'create') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Auth required' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Verify the user
      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authError } = await userClient.auth.getUser()
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Invalid auth' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (!member_id) {
        return new Response(JSON.stringify({ error: 'member_id required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Get the member record
      const { data: member, error: memberErr } = await supabase
        .from('care_circle_members')
        .select('*, people!inner(name, user_id)')
        .eq('id', member_id)
        .single()

      if (memberErr || !member) {
        return new Response(JSON.stringify({ error: 'Member not found' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Verify the requesting user owns this person
      if (member.people.user_id !== user.id) {
        return new Response(JSON.stringify({ error: 'Not authorized' }), {
          status: 403,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Generate a unique invite token
      const token = crypto.randomUUID()

      // Update the member record with invite info
      const { error: updateErr } = await supabase
        .from('care_circle_members')
        .update({
          invite_token: token,
          invited_at: new Date().toISOString(),
          invited_by: user.id,
          invite_status: 'invited',
        })
        .eq('id', member_id)

      if (updateErr) {
        return new Response(JSON.stringify({ error: 'Failed to create invite: ' + updateErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const inviteLink = `https://mywellet.com?invite=${token}`

      return new Response(JSON.stringify({
        success: true,
        invite_link: inviteLink,
        person_name: member.people.name,
        member_name: member.member_name,
        member_email: member.email,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── LOOKUP: Public lookup of invite metadata (no auth needed) ──
    if (action === 'lookup') {
      if (!invite_token) {
        return new Response(JSON.stringify({ error: 'invite_token required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const { data: member, error: lookupErr } = await supabase
        .from('care_circle_members')
        .select('member_name, role, email, invite_status, invited_by, people!inner(name)')
        .eq('invite_token', invite_token)
        .single()

      if (lookupErr || !member) {
        return new Response(JSON.stringify({ error: 'Invalid invite' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (member.invite_status === 'accepted') {
        return new Response(JSON.stringify({ error: 'This invite has already been accepted' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Get inviter name
      let inviterName = 'Someone'
      if (member.invited_by) {
        const { data: inviter } = await supabase.auth.admin.getUserById(member.invited_by)
        if (inviter?.user) {
          inviterName = inviter.user.user_metadata?.full_name || inviter.user.email?.split('@')[0] || 'Someone'
        }
      }

      return new Response(JSON.stringify({
        success: true,
        person_name: member.people.name,
        member_name: member.member_name,
        member_role: member.role,
        inviter_name: inviterName,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── ACCEPT: Link the authenticated user to the member record ──
    if (action === 'accept') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) {
        return new Response(JSON.stringify({ error: 'Auth required' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authError } = await userClient.auth.getUser()
      if (authError || !user) {
        return new Response(JSON.stringify({ error: 'Invalid auth' }), {
          status: 401,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (!invite_token) {
        return new Response(JSON.stringify({ error: 'invite_token required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Find the member record by token
      const { data: member, error: findErr } = await supabase
        .from('care_circle_members')
        .select('id, invite_status, person_id')
        .eq('invite_token', invite_token)
        .single()

      if (findErr || !member) {
        return new Response(JSON.stringify({ error: 'Invalid invite token' }), {
          status: 404,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      if (member.invite_status === 'accepted') {
        return new Response(JSON.stringify({ error: 'Already accepted' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Update the member record to link this user
      const { error: acceptErr } = await supabase
        .from('care_circle_members')
        .update({
          user_id: user.id,
          invite_status: 'accepted',
          status: 'signed_up',
        })
        .eq('id', member.id)

      if (acceptErr) {
        return new Response(JSON.stringify({ error: 'Failed to accept: ' + acceptErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      return new Response(JSON.stringify({
        success: true,
        person_id: member.person_id,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
