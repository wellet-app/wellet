// twilio-status-webhook — receive delivery status callbacks from Twilio.
//
// Twilio POSTs application/x-www-form-urlencoded to this URL whenever a
// message changes state (queued → sent → delivered, or → failed/undelivered).
// We verify the X-Twilio-Signature HMAC, look up the matching sms_log row by
// MessageSid, and update twilio_status + the appropriate timestamp.
//
// Auth: verify_jwt=false (Twilio cannot send a Supabase JWT). We replace
// JWT auth with HMAC signature verification using TWILIO_AUTH_TOKEN.
//
// Idempotent: Twilio retries on non-2xx, so multiple callbacks for the same
// state are safe — we only overwrite delivered_at/failed_at if not already set.
//
// Configure in Twilio: Messaging Service → Integration → Status Callback URL:
//   https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/twilio-status-webhook

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { logSignupError } from '../_shared/log-signup-error.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Statuses Twilio sends. We map each to a sms_log.status (our internal enum)
// and decide which timestamp to stamp.
//   queued, sending, sent → 'sent'
//   delivered             → 'delivered'  (also stamps delivered_at)
//   failed, undelivered   → 'failed'     (also stamps failed_at)
//   read (WhatsApp only)  → ignored, we keep 'delivered'
function mapStatus(twilioStatus: string): {
  status: string | null
  stampDelivered: boolean
  stampFailed: boolean
} {
  switch (twilioStatus) {
    case 'queued':
    case 'sending':
    case 'sent':
    case 'accepted':
      return { status: 'sent', stampDelivered: false, stampFailed: false }
    case 'delivered':
      return { status: 'delivered', stampDelivered: true, stampFailed: false }
    case 'failed':
    case 'undelivered':
      return { status: 'failed', stampDelivered: false, stampFailed: true }
    default:
      // 'read' (WhatsApp), 'received' (inbound), unknown — leave status alone
      return { status: null, stampDelivered: false, stampFailed: false }
  }
}

// Twilio signs requests by computing HMAC-SHA1 over (full URL + sorted form
// params concatenated as key+value), base64-encoded, and sends it in the
// X-Twilio-Signature header.
// Docs: https://www.twilio.com/docs/usage/security#validating-requests
async function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: URLSearchParams,
  signatureHeader: string,
): Promise<boolean> {
  // Build the canonical string: URL + (sorted key + value) concatenated
  const sorted: [string, string][] = [...params.entries()].sort(
    ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
  )
  let payload = fullUrl
  for (const [k, v] of sorted) payload += k + v

  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const computed = btoa(String.fromCharCode(...new Uint8Array(sig)))

  // Constant-time compare
  if (computed.length !== signatureHeader.length) return false
  let diff = 0
  for (let i = 0; i < computed.length; i++) {
    diff |= computed.charCodeAt(i) ^ signatureHeader.charCodeAt(i)
  }
  return diff === 0
}

Deno.serve(async (req) => {
  // No CORS — Twilio is server-to-server, never browser
  if (req.method !== 'POST') {
    return new Response('method_not_allowed', { status: 405 })
  }

  const admin = createClient(supabaseUrl, serviceKey)

  try {
    // ── Read raw form body ──────────────────────────────────────────
    const rawBody = await req.text()
    const params = new URLSearchParams(rawBody)

    const messageSid = params.get('MessageSid')
    const messageStatus = params.get('MessageStatus')
    const errorCode = params.get('ErrorCode')
    const errorMessage = params.get('ErrorMessage')

    if (!messageSid || !messageStatus) {
      return new Response('missing_fields', { status: 400 })
    }

    // ── Verify Twilio signature ─────────────────────────────────────
    const signatureHeader = req.headers.get('X-Twilio-Signature') ?? ''
    if (!signatureHeader) {
      return new Response('missing_signature', { status: 401 })
    }

    const { data: authToken } = await admin.rpc('get_vault_secret', {
      secret_name: 'TWILIO_AUTH_TOKEN',
    })
    if (!authToken) {
      throw new Error('twilio_auth_token_missing_in_vault')
    }

    // Reconstruct the URL Twilio signed. Twilio uses the URL it called,
    // including protocol + host + path + query. Edge Runtime gives us the
    // full URL on req.url, but behind Supabase's proxy we should rebuild
    // from x-forwarded headers to match what Twilio actually saw.
    const proto = req.headers.get('x-forwarded-proto') ?? 'https'
    const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? ''
    const url = new URL(req.url)
    const fullUrl = `${proto}://${host}${url.pathname}${url.search}`

    const valid = await verifyTwilioSignature(
      authToken,
      fullUrl,
      params,
      signatureHeader,
    )
    if (!valid) {
      // Don't echo signature data — just refuse.
      return new Response('invalid_signature', { status: 401 })
    }

    // ── Map status and update sms_log ───────────────────────────────
    const { status, stampDelivered, stampFailed } = mapStatus(messageStatus)
    const nowIso = new Date().toISOString()

    // Build patch — only set status/stamps when we have meaningful values.
    // Always update twilio_status and last_status_at so we have a fresh
    // breadcrumb even for transitional states.
    const patch: Record<string, unknown> = {
      twilio_status: messageStatus,
      last_status_at: nowIso,
    }
    if (status) patch.status = status
    if (stampDelivered) patch.delivered_at = nowIso
    if (stampFailed) {
      patch.failed_at = nowIso
      if (errorCode) patch.twilio_error_code = Number(errorCode) || null
      if (errorMessage) patch.twilio_error_message = errorMessage
    }

    const { data: updated, error: updateErr } = await admin
      .from('sms_log')
      .update(patch)
      .eq('message_sid', messageSid)
      .select('id, status')

    if (updateErr) {
      throw new Error('sms_log_update_failed: ' + updateErr.message)
    }

    if (!updated || updated.length === 0) {
      // No matching row — could be a callback for a pre-existing test
      // message or a race. Log to context but return 200 so Twilio doesn't
      // retry forever.
      console.warn(
        `[twilio-status-webhook] no sms_log row for MessageSid=${messageSid}`,
      )
    }

    // Critical-severity escalation when a delivery fails outright. We only
    // alert on terminal failures, not transient 'queued'→'sending' churn.
    if (stampFailed) {
      await logSignupError({
        source: 'twilio-status-webhook',
        severity: 'critical',
        error: new Error(
          `SMS delivery failed: ${errorCode ?? '?'} ${errorMessage ?? '(no message)'}`,
        ),
        request: req,
        context: {
          phase: 'delivery_callback',
          message_sid: messageSid,
          twilio_status: messageStatus,
          twilio_error_code: errorCode,
          twilio_error_message: errorMessage,
        },
      })
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    await logSignupError({
      source: 'twilio-status-webhook',
      severity: 'critical',
      error: e,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    })
    // Return 500 so Twilio retries (max ~10x over 1 hour with backoff).
    return new Response('internal_error', { status: 500 })
  }
})
