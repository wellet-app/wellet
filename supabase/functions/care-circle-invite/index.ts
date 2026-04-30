// Care Circle Invite Edge Function
// Actions: create, accept, lookup
// Deployed with verify_jwt=false (lookup needs to work without auth)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { logSignupError } from '../_shared/log-signup-error.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Lightweight E.164 check — same shape as twilio-send-sms.normalizeE164.
// Returns trimmed E.164 or null. We only accept already-formatted numbers
// to avoid Twilio billing surprises from accidental country routing.
function normalizeE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null
  return trimmed
}

// Fire-and-forget invocation of twilio-send-sms. Never throws — SMS failures
// must NOT block invite creation. Returns a small status object the caller
// surfaces in the response so the app can show "Text sent" vs "Couldn't text,
// here's the link to share manually".
async function sendInviteSms(params: {
  authHeader: string
  to: string
  inviterName: string
  inviteLink: string
  memberId: string
}): Promise<{ sent: boolean; message_sid?: string; error?: string }> {
  try {
    const body =
      `${params.inviterName} invited you to Wellet to help coordinate care ` +
      `for a loved one. Open: ${params.inviteLink}\n\nReply STOP to opt out.`

    const res = await fetch(`${supabaseUrl}/functions/v1/twilio-send-sms`, {
      method: 'POST',
      headers: {
        // Forward the inviter's JWT — twilio-send-sms requires verify_jwt
        Authorization: params.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: params.to,
        body,
        member_id: params.memberId,
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { sent: false, error: json?.error ?? `http_${res.status}` }
    return { sent: true, message_sid: json?.message_sid }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { action, member_id, invite_token, short_code } = await req.json()
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

      // Generate a unique invite token (long, used in invite links)
      const token = crypto.randomUUID()

      // Generate a 6-char short code (used by Wellet Connect Flutter app).
      // Best-effort: if the RPC isn't available yet (pre-migration), we
      // continue without a short code rather than failing the whole invite.
      let shortCode: string | null = null
      const { data: shortCodeData, error: shortCodeErr } = await supabase
        .rpc('generate_short_invite_code')
      if (!shortCodeErr && typeof shortCodeData === 'string') {
        shortCode = shortCodeData
      }

      // Update the member record with invite info
      const updatePayload: Record<string, unknown> = {
        invite_token: token,
        invited_at: new Date().toISOString(),
        invited_by: user.id,
        invite_status: 'invited',
      }
      if (shortCode) updatePayload.invite_short_code = shortCode

      const { error: updateErr } = await supabase
        .from('care_circle_members')
        .update(updatePayload)
        .eq('id', member_id)

      if (updateErr) {
        return new Response(JSON.stringify({ error: 'Failed to create invite: ' + updateErr.message }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const inviteLink = `https://mywellet.com?invite=${token}`

      // ── Best-effort SMS to member.phone if present and well-formed ──
      // Failure does NOT block the invite. The user can always share the
      // returned invite_link manually (copy button in the app).
      let smsResult: { sent: boolean; message_sid?: string; error?: string } | null = null
      if (member.phone) {
        const to = normalizeE164(member.phone)
        if (!to) {
          smsResult = { sent: false, error: 'invalid_phone_format' }
        } else {
          const inviterName =
            user.user_metadata?.full_name ||
            user.email?.split('@')[0] ||
            'Someone'
          smsResult = await sendInviteSms({
            authHeader,
            to,
            inviterName,
            inviteLink,
            memberId: member_id,
          })
        }
      }

      return new Response(JSON.stringify({
        success: true,
        invite_link: inviteLink,
        short_code: shortCode,
        person_name: member.people.name,
        member_name: member.member_name,
        member_email: member.email,
        sms: smsResult,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── LOOKUP: Public lookup of invite metadata (no auth needed) ──
    // Accepts either invite_token (UUID, from invite link) or
    // short_code (6-char A-Z/2-9, from Wellet Connect Flutter app).
    if (action === 'lookup' || action === 'lookup_short_code') {
      const isShortCode = action === 'lookup_short_code' || (!invite_token && short_code)
      const lookupValue = isShortCode
        ? (short_code ? String(short_code).trim().toUpperCase() : null)
        : invite_token

      if (!lookupValue) {
        return new Response(JSON.stringify({
          error: isShortCode ? 'short_code required' : 'invite_token required',
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      const lookupColumn = isShortCode ? 'invite_short_code' : 'invite_token'

      const { data: member, error: lookupErr } = await supabase
        .from('care_circle_members')
        .select('member_name, role, email, invite_status, invited_by, invite_token, people!inner(name)')
        .eq(lookupColumn, lookupValue)
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
        // Returned only on short-code lookups so Flutter can call accept
        // with the canonical token afterward.
        invite_token: isShortCode ? member.invite_token : undefined,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── ACCEPT: Link the authenticated user to the member record ──
    // Accepts either invite_token (UUID) or short_code (6-char).
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

      if (!invite_token && !short_code) {
        return new Response(JSON.stringify({ error: 'invite_token or short_code required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        })
      }

      // Find the member record by either token or short code
      const acceptColumn = invite_token ? 'invite_token' : 'invite_short_code'
      const acceptValue = invite_token
        ? invite_token
        : String(short_code).trim().toUpperCase()

      const { data: member, error: findErr } = await supabase
        .from('care_circle_members')
        .select('id, invite_status, person_id')
        .eq(acceptColumn, acceptValue)
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
    await logSignupError({
      source: 'care-circle-invite',
      severity: 'critical',
      error: e,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    });
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
