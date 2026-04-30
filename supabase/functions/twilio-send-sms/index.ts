// twilio-send-sms — send SMS via Twilio Messaging Service
//
// Auth: verify_jwt=true (only authenticated Wellet users can trigger sends).
// Sends through TWILIO_MESSAGING_SERVICE_SID, which wraps the Wellet Connect
// number (+1 743 500 2846) and is bound to the A2P 10DLC campaign.
// Logs every attempt to public.sms_log; on Twilio API failure also relays
// to signup_error_log via logSignupError so we get email alerts on outages.
//
// Request body: { to: string (E.164), body: string, member_id?: uuid }
// Response: { success: true, message_sid, sms_log_id } on send,
//           { error, sms_log_id? } with appropriate HTTP status on failure.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { logSignupError } from '../_shared/log-signup-error.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01'
const MAX_BODY_LEN = 1600 // carrier hard cap (10 segments × 160 chars GSM-7)
const SOFT_RATE_LIMIT_PER_RECIPIENT_PER_HOUR = 3

// Normalize/validate an E.164 phone number. Returns the normalized form
// (e.g. "+14155551212") or null if invalid. Keeps it conservative — we
// only accept already-formatted E.164 to avoid Twilio billing surprises
// from accidentally messaging the wrong country.
function normalizeE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null
  return trimmed
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
      status: 405,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }

  const admin = createClient(supabaseUrl, serviceKey)
  let smsLogId: string | null = null

  try {
    // ── Auth ──────────────────────────────────────────────────────────
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'auth_required' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: { user }, error: authError } = await userClient.auth.getUser()
    if (authError || !user) {
      return new Response(JSON.stringify({ error: 'invalid_auth' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Validate request body ─────────────────────────────────────────
    const payload = await req.json().catch(() => ({}))
    const toRaw = payload?.to
    const bodyRaw = payload?.body
    const memberId = typeof payload?.member_id === 'string' ? payload.member_id : null

    const to = normalizeE164(toRaw)
    if (!to) {
      return new Response(JSON.stringify({
        error: 'invalid_to',
        details: 'to must be E.164 format (e.g. +14155551212)',
      }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    if (typeof bodyRaw !== 'string' || bodyRaw.trim().length === 0) {
      return new Response(JSON.stringify({ error: 'invalid_body' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }
    const body = bodyRaw.slice(0, MAX_BODY_LEN)

    // ── Soft rate limit: per recipient per hour ───────────────────────
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const { count: recentCount } = await admin
      .from('sms_log')
      .select('id', { count: 'exact', head: true })
      .eq('to_number', to)
      .gte('created_at', oneHourAgo)
      .in('status', ['sent', 'delivered', 'pending'])
    if ((recentCount ?? 0) >= SOFT_RATE_LIMIT_PER_RECIPIENT_PER_HOUR) {
      return new Response(JSON.stringify({
        error: 'rate_limited',
        details: `Already sent ${recentCount} messages to ${to} in the last hour`,
      }), {
        status: 429,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Insert pending sms_log row ────────────────────────────────────
    const fromNumber = await admin
      .rpc('get_vault_secret', { secret_name: 'TWILIO_FROM_NUMBER' })
      .then((r: { data: string | null }) => r.data ?? null)

    const { data: logRow, error: insertErr } = await admin
      .from('sms_log')
      .insert({
        user_id: user.id,
        member_id: memberId,
        source: 'wellet-connect-invite',
        to_number: to,
        from_number: fromNumber,
        body,
        body_length: body.length,
        status: 'pending',
      })
      .select('id')
      .single()
    if (insertErr || !logRow) {
      throw new Error('failed_to_log_pending: ' + (insertErr?.message ?? 'unknown'))
    }
    smsLogId = logRow.id

    // ── Fetch Twilio creds ────────────────────────────────────────────
    const [{ data: accountSid }, { data: authToken }, { data: msgServiceSid }] =
      await Promise.all([
        admin.rpc('get_vault_secret', { secret_name: 'TWILIO_ACCOUNT_SID' }),
        admin.rpc('get_vault_secret', { secret_name: 'TWILIO_AUTH_TOKEN' }),
        admin.rpc('get_vault_secret', { secret_name: 'TWILIO_MESSAGING_SERVICE_SID' }),
      ])
    if (!accountSid || !authToken || !msgServiceSid) {
      throw new Error('twilio_creds_missing_in_vault')
    }

    // ── Call Twilio Messages API ──────────────────────────────────────
    const url = `${TWILIO_API_BASE}/Accounts/${accountSid}/Messages.json`
    // StatusCallback tells Twilio where to POST delivery state changes.
    // The receiving function (twilio-status-webhook) verifies the HMAC
    // signature and updates sms_log with delivered_at / failed_at.
    const statusCallback = `${supabaseUrl}/functions/v1/twilio-status-webhook`
    const formBody = new URLSearchParams({
      MessagingServiceSid: msgServiceSid,
      To: to,
      Body: body,
      StatusCallback: statusCallback,
    })
    const basicAuth = btoa(`${accountSid}:${authToken}`)
    const twilioRes = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formBody.toString(),
    })
    const twilioJson = await twilioRes.json().catch(() => ({}))
    const twilioRequestId = twilioRes.headers.get('twilio-request-id') ?? null

    if (!twilioRes.ok) {
      // Twilio error: code/message live in the JSON body.
      // Still log to sms_log for audit, AND escalate to signup_error_log
      // so Brevo emails Betsy if Twilio is down or our brand is rejected.
      await admin
        .from('sms_log')
        .update({
          status: 'failed',
          twilio_status: 'failed',
          twilio_error_code: twilioJson?.code ?? null,
          twilio_error_message: twilioJson?.message ?? null,
          request_id: twilioRequestId,
          failed_at: new Date().toISOString(),
          last_status_at: new Date().toISOString(),
          context: { http_status: twilioRes.status },
        })
        .eq('id', smsLogId)

      await logSignupError({
        source: 'twilio-send-sms',
        severity: 'critical',
        error: new Error(`Twilio API ${twilioRes.status}: ${twilioJson?.message ?? 'unknown'}`),
        httpStatus: twilioRes.status,
        request: req,
        context: {
          phase: 'twilio_api_call',
          twilio_code: twilioJson?.code,
          twilio_message: twilioJson?.message,
          twilio_more_info: twilioJson?.more_info,
          to_country_code: to.slice(0, 4),
          sms_log_id: smsLogId,
        },
      })

      return new Response(JSON.stringify({
        error: 'twilio_send_failed',
        twilio_code: twilioJson?.code ?? null,
        twilio_message: twilioJson?.message ?? null,
        sms_log_id: smsLogId,
      }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // ── Success — record SID and Twilio's initial status ──────────────
    const messageSid: string | null = twilioJson?.sid ?? null
    const twilioStatus: string | null = twilioJson?.status ?? null
    const segments: number | null = twilioJson?.num_segments
      ? Number(twilioJson.num_segments)
      : null

    await admin
      .from('sms_log')
      .update({
        message_sid: messageSid,
        twilio_status: twilioStatus,
        segments,
        status: 'sent',
        request_id: twilioRequestId,
        last_status_at: new Date().toISOString(),
      })
      .eq('id', smsLogId)

    return new Response(JSON.stringify({
      success: true,
      message_sid: messageSid,
      twilio_status: twilioStatus,
      sms_log_id: smsLogId,
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })

  } catch (e) {
    // Top-level catch — record on the sms_log row if we have one,
    // and always relay to signup_error_log for email alerting.
    const message = e instanceof Error ? e.message : String(e)
    if (smsLogId) {
      await admin
        .from('sms_log')
        .update({
          status: 'failed',
          twilio_error_message: 'edge_function_exception: ' + message,
          failed_at: new Date().toISOString(),
          last_status_at: new Date().toISOString(),
        })
        .eq('id', smsLogId)
        .then(() => null, () => null)
    }
    await logSignupError({
      source: 'twilio-send-sms',
      severity: 'critical',
      error: e,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch', sms_log_id: smsLogId },
    })
    return new Response(JSON.stringify({
      error: 'internal_error',
      details: message,
      sms_log_id: smsLogId,
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
