// Wellet · data-source-invite edge function
//
// One edge function, four actions:
//
//   POST { action: 'create', person_id, data_source, hospital_name?, fhir_base_url?, target_contact, channel? }
//     - Auth required. Mints a 24h, one-time token for a loved one to grant
//       access to a specific data source. Sends an SMS to target_contact with
//       the landing link. Returns { invite_link, invite_token, sms }.
//
//   POST/GET { action: 'lookup', token }
//     - No auth required (the loved one has none yet). Returns the metadata
//       the landing page renders: caregiver name, loved one name, data source,
//       hospital name, expires_at, consumed_at. Never returns the token itself
//       in the response, never returns SMS contact info.
//
//   POST { action: 'resend', token }
//     - No auth required. Re-sends the SAME token to the same number (used by
//       the iPad fallback "Text this link to my iPhone"). Rate-limited.
//
//   POST { action: 'consume', token, person_id_returned? }
//     - Internal use: marks the invite consumed_at after the linked OAuth /
//       HealthKit flow successfully completes. Auth required, must match the
//       caregiver who minted it OR the service-role context that processed
//       the callback. NOT directly called from the loved-one's browser.
//
// Deployed with verify_jwt=false because lookup/resend run pre-auth.
// Each branch enforces its own auth requirement.
//
// Voice: "loved one" / "family member", never "parent".
//        "notices" / "watches for", never "track/monitor".
// CareSignals is ONE WORD.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { getCorsHeaders } from '../_shared/cors.ts'
import { logSignupError } from '../_shared/log-signup-error.ts'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

// ---------- helpers --------------------------------------------------------

function jsonResponse(body: unknown, status: number, corsHeaders: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function normalizeE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null
  return trimmed
}

// Build the SMS body. Voice rules apply: never "parent", never "track/monitor".
function smsBody(opts: {
  caregiverName: string
  dataSource: 'apple_health' | 'ehr'
  hospitalName?: string | null
  link: string
}): string {
  const what =
    opts.dataSource === 'apple_health'
      ? 'your Apple Health'
      : opts.hospitalName
        ? `your ${opts.hospitalName}`
        : 'your hospital chart'
  return (
    `${opts.caregiverName} is helping look after your health and would love ${what} ` +
    `to be in one place. Open: ${opts.link}\n\nReply STOP to opt out.`
  )
}

async function callTwilioSendSms(opts: {
  authHeader: string
  to: string
  body: string
  context: Record<string, unknown>
}): Promise<{ sent: boolean; message_sid?: string; sms_log_id?: string; error?: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/twilio-send-sms`, {
      method: 'POST',
      headers: {
        Authorization: opts.authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        to: opts.to,
        body: opts.body,
        context: { source: 'data-source-invite', ...opts.context },
      }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { sent: false, error: json?.error ?? `http_${res.status}` }
    return {
      sent: true,
      message_sid: json?.message_sid,
      sms_log_id: json?.sms_log_id ?? json?.id,
    }
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Resolve caregiver display name for the SMS body and the landing page.
async function caregiverName(supabase: any, userId: string): Promise<string> {
  const { data: u } = await supabase.auth.admin.getUserById(userId)
  const meta = u?.user?.user_metadata ?? {}
  return (
    (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
    (typeof meta.first_name === 'string' && meta.first_name.trim()) ||
    (u?.user?.email?.split('@')[0]) ||
    'A family member'
  )
}

// Notify the caregiver that their loved one finished connecting. Two channels:
//   1) public.notifications row — lights up the bell in mywellet.com next open
//   2) Brevo SMTP email — hits the caregiver's lock screen via their mail app
//
// V1 deliberately skips Web Push (push_subscriptions table is empty and there
// are no VAPID keys yet). Email is the practical "you find out within seconds"
// path until the PWA push handler ships.
//
// Voice rules apply to every visible string: "loved one"/"family member",
// "notices" not "track", CareSignals one word.
async function notifyCaregiverOfConsume(
  supabase: any,
  opts: { caregiverUserId: string; personId: string; dataSource: 'apple_health' | 'ehr'; hospitalName?: string | null },
): Promise<{ inAppOk: boolean; emailOk: boolean; error?: string }> {
  let inAppOk = false
  let emailOk = false
  let errorMsg: string | undefined

  // Resolve loved one's display name + caregiver's email.
  let lovedName = 'your family member'
  try {
    const { data: p } = await supabase
      .from('people')
      .select('name')
      .eq('id', opts.personId)
      .maybeSingle()
    if (p?.name) lovedName = p.name
  } catch { /* ignore — fall back to default */ }

  let caregiverEmail: string | null = null
  try {
    const { data: u } = await supabase.auth.admin.getUserById(opts.caregiverUserId)
    caregiverEmail = u?.user?.email ?? null
  } catch { /* ignore */ }

  const sourceLabel =
    opts.dataSource === 'apple_health'
      ? 'Apple Health'
      : (opts.hospitalName || 'her hospital chart')

  const title = `${lovedName} just connected ${sourceLabel}`
  const body = `Wellet now notices ${lovedName}'s ${sourceLabel} updates. Open the app to see the first records flow in.`

  // 1) In-app row
  try {
    const { error: insertErr } = await supabase
      .from('notifications')
      .insert({
        user_id: opts.caregiverUserId,
        person_id: opts.personId,
        type: 'invite_consumed',
        title,
        body,
      })
    if (!insertErr) inAppOk = true
    else errorMsg = `in_app_insert: ${insertErr.message}`
  } catch (e) {
    errorMsg = `in_app_throw: ${e instanceof Error ? e.message : String(e)}`
  }

  // 2) Brevo SMTP email (best-effort, never blocks the consume response)
  if (caregiverEmail) {
    try {
      const smtpUser = Deno.env.get('BREVO_SMTP_USER') || ''
      const smtpPass = Deno.env.get('BREVO_SMTP_KEY') || ''
      const smtpHost = Deno.env.get('BREVO_SMTP_HOST') || 'smtp-relay.brevo.com'
      const fromAddress = Deno.env.get('BREVO_FROM_ADDRESS') || 'alerts@mywellet.com'
      const fromName = Deno.env.get('BREVO_FROM_NAME') || 'Wellet'
      if (smtpUser && smtpPass) {
        const { SMTPClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
        const client = new SMTPClient({
          connection: {
            hostname: smtpHost,
            port: 465,
            tls: true,
            auth: { username: smtpUser, password: smtpPass },
          },
        })
        const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;color:#1d1d1f;line-height:1.6;padding:32px;max-width:520px;margin:0 auto;">
          <div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#86868b;margin-bottom:16px;">Wellet</div>
          <h1 style="font-size:24px;font-weight:600;margin:0 0 16px;">${title}</h1>
          <p style="font-size:16px;color:#1d1d1f;margin:0 0 24px;">${body}</p>
          <p style="margin:0 0 32px;"><a href="https://mywellet.com" style="background:#0a84ff;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:500;">Open Wellet</a></p>
          <p style="font-size:12px;color:#86868b;margin:0;">You're getting this because you sent ${lovedName} a connect link from Wellet. Manage notifications in Settings.</p>
        </body></html>`
        await client.send({
          from: `${fromName} <${fromAddress}>`,
          to: caregiverEmail,
          subject: title,
          content: body,
          html,
        })
        await client.close()
        emailOk = true
      }
    } catch (e) {
      errorMsg = `${errorMsg ? errorMsg + '; ' : ''}email: ${e instanceof Error ? e.message : String(e)}`
    }
  }

  return { inAppOk, emailOk, error: errorMsg }
}

// ---------- main -----------------------------------------------------------

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    // Accept GET ?action=lookup&token=... AND POST {action, ...}
    const url = new URL(req.url)
    let payload: Record<string, unknown> = {}
    if (req.method === 'GET') {
      payload = Object.fromEntries(url.searchParams.entries())
    } else {
      payload = await req.json().catch(() => ({}))
    }
    const action = String(payload.action || url.searchParams.get('action') || '').toLowerCase()
    const supabase = createClient(supabaseUrl, serviceKey)

    // ====== LOOKUP =========================================================
    // Public. Returns just enough to render the landing page. Never returns
    // target_contact or fhir_base_url. Returns shape matches what
    // landing_responsive.html expects.
    if (action === 'lookup') {
      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)

      const { data: invite, error } = await supabase
        .from('data_source_invites')
        .select('id, token, person_id, caregiver_user_id, data_source, hospital_name, expires_at, consumed_at, people:person_id(name)')
        .eq('token', token)
        .maybeSingle()

      if (error || !invite) return jsonResponse({ error: 'invalid' }, 404, corsHeaders)
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: 'expired' }, 410, corsHeaders)
      }

      const cname = await caregiverName(supabase, invite.caregiver_user_id)
      // @ts-ignore — people join shape from postgrest
      const lovedOne = invite.people?.name ?? null

      return jsonResponse({
        token: invite.token,
        data_source: invite.data_source,
        hospital_name: invite.hospital_name,
        caregiver_name: cname,
        loved_one_name: lovedOne,
        consumed_at: invite.consumed_at,
      }, 200, corsHeaders)
    }

    // ====== CREATE =========================================================
    // Caregiver-side. Auth required. Mints a token and sends the SMS.
    if (action === 'create') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return jsonResponse({ error: 'Auth required' }, 401, corsHeaders)

      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authErr } = await userClient.auth.getUser()
      if (authErr || !user) return jsonResponse({ error: 'Invalid auth' }, 401, corsHeaders)

      const personId = String(payload.person_id || '')
      const dataSource = String(payload.data_source || '')
      const channel = String(payload.channel || 'sms')
      const targetContact = String(payload.target_contact || '').trim()
      const hospitalName = payload.hospital_name ? String(payload.hospital_name) : null
      const fhirBaseUrl = payload.fhir_base_url ? String(payload.fhir_base_url) : null

      if (!personId) return jsonResponse({ error: 'person_id required' }, 400, corsHeaders)
      if (!['apple_health', 'ehr'].includes(dataSource)) {
        return jsonResponse({ error: 'data_source must be apple_health or ehr' }, 400, corsHeaders)
      }
      if (dataSource === 'ehr' && (!hospitalName || !fhirBaseUrl)) {
        return jsonResponse({ error: 'hospital_name and fhir_base_url required for ehr' }, 400, corsHeaders)
      }
      if (channel !== 'sms') return jsonResponse({ error: 'only sms supported in v1' }, 400, corsHeaders)
      const to = normalizeE164(targetContact)
      if (!to) return jsonResponse({ error: 'target_contact must be E.164 (+1xxxxxxxxxx)' }, 400, corsHeaders)

      // Verify the caller owns this person (defense in depth — RLS also checks).
      const { data: person, error: personErr } = await supabase
        .from('people')
        .select('id, name, user_id, is_self, phone')
        .eq('id', personId)
        .maybeSingle()
      if (personErr || !person) return jsonResponse({ error: 'person not found' }, 404, corsHeaders)
      if (person.user_id !== user.id) return jsonResponse({ error: 'Not authorized' }, 403, corsHeaders)
      if (person.is_self) {
        // is_self people use the on-device flow, not an invite.
        return jsonResponse({ error: 'is_self_person_uses_direct_flow' }, 400, corsHeaders)
      }

      // Throttle: don't let one caregiver mint more than 5 pending invites
      // per person per data source per hour.
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count: recentCount } = await supabase
        .from('data_source_invites')
        .select('id', { count: 'exact', head: true })
        .eq('caregiver_user_id', user.id)
        .eq('person_id', personId)
        .eq('data_source', dataSource)
        .gte('created_at', oneHourAgo)
      if ((recentCount ?? 0) >= 5) {
        return jsonResponse({ error: 'rate_limited' }, 429, corsHeaders)
      }

      // Insert. Token + expires_at default in the DB.
      const { data: invite, error: insertErr } = await supabase
        .from('data_source_invites')
        .insert({
          person_id: personId,
          caregiver_user_id: user.id,
          data_source: dataSource,
          hospital_name: hospitalName,
          fhir_base_url: fhirBaseUrl,
          channel,
          target_contact: to,
        })
        .select('id, token, expires_at')
        .single()
      if (insertErr || !invite) {
        return jsonResponse({ error: 'insert_failed: ' + (insertErr?.message ?? 'unknown') }, 500, corsHeaders)
      }

      // Best-effort: cache the loved one's phone on the person row so we don't
      // ask Betsy for it next time. Never overwrite an existing different value.
      if (!person.phone) {
        await supabase.from('people').update({ phone: to }).eq('id', personId)
      }

      // Send the SMS. Failure does NOT delete the invite — Betsy can re-send.
      const link = `https://mywellet.com/?dsinvite=${invite.token}`
      const cname = await caregiverName(supabase, user.id)
      const sms = await callTwilioSendSms({
        authHeader,
        to,
        body: smsBody({
          caregiverName: cname,
          dataSource: dataSource as 'apple_health' | 'ehr',
          hospitalName,
          link,
        }),
        context: { invite_id: invite.id, person_id: personId, data_source: dataSource },
      })

      if (sms.sms_log_id) {
        await supabase
          .from('data_source_invites')
          .update({ sms_log_id: sms.sms_log_id })
          .eq('id', invite.id)
      }

      return jsonResponse({
        invite_id: invite.id,
        invite_link: link,
        invite_token: invite.token,
        expires_at: invite.expires_at,
        person_name: person.name,
        sms,
      }, 200, corsHeaders)
    }

    // ====== RESEND =========================================================
    // No auth — the loved one tapped "Text this link to my iPhone" on the iPad
    // fallback. Same token, same number. Rate-limited.
    if (action === 'resend') {
      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)

      const { data: invite, error } = await supabase
        .from('data_source_invites')
        .select('id, token, caregiver_user_id, target_contact, data_source, hospital_name, expires_at, consumed_at, resend_count, last_resent_at')
        .eq('token', token)
        .maybeSingle()
      if (error || !invite) return jsonResponse({ error: 'invalid' }, 404, corsHeaders)
      if (invite.consumed_at) return jsonResponse({ error: 'already_used' }, 410, corsHeaders)
      if (new Date(invite.expires_at).getTime() < Date.now()) {
        return jsonResponse({ error: 'expired' }, 410, corsHeaders)
      }

      // Rate-limit: max 3 resends, and at most 1 per 60s.
      if ((invite.resend_count ?? 0) >= 3) {
        return jsonResponse({ error: 'resend_limit' }, 429, corsHeaders)
      }
      if (invite.last_resent_at) {
        const sinceLast = Date.now() - new Date(invite.last_resent_at).getTime()
        if (sinceLast < 60_000) {
          return jsonResponse({ error: 'too_soon', retry_in_seconds: Math.ceil((60_000 - sinceLast) / 1000) }, 429, corsHeaders)
        }
      }

      const cname = await caregiverName(supabase, invite.caregiver_user_id)
      const link = `https://mywellet.com/?dsinvite=${invite.token}`

      // For resend we use a service-account authHeader to call twilio-send-sms
      // (the loved one doesn't have her own JWT). twilio-send-sms is deployed
      // with verify_jwt and will accept the service-role key as a bearer.
      const sms = await callTwilioSendSms({
        authHeader: `Bearer ${serviceKey}`,
        to: invite.target_contact,
        body: smsBody({
          caregiverName: cname,
          dataSource: invite.data_source as 'apple_health' | 'ehr',
          hospitalName: invite.hospital_name,
          link,
        }),
        context: { invite_id: invite.id, kind: 'resend' },
      })

      await supabase
        .from('data_source_invites')
        .update({
          resend_count: (invite.resend_count ?? 0) + 1,
          last_resent_at: new Date().toISOString(),
          ...(sms.sms_log_id ? { sms_log_id: sms.sms_log_id } : {}),
        })
        .eq('id', invite.id)

      return jsonResponse({ ok: sms.sent, sms }, 200, corsHeaders)
    }

    // ====== AUTO_RESEND_DUE ================================================
    // Service-role only. Called from pg_cron every 15 minutes. Finds invites
    // that are within 1h of expiry, unconsumed, and have not yet been
    // auto-nudged, and fires ONE nudge SMS each. Updates resend_count and
    // last_resent_at so the manual resend rate-limit still applies.
    //
    // We identify the nudge with a sentinel last_resent_at *after* an
    // expires_at-1h boundary, plus resend_count >= 1 from this path. The
    // simpler signal: invites whose expires_at is within the next 60 minutes,
    // last_resent_at IS NULL OR last_resent_at < expires_at - interval '2 hours'.
    if (action === 'auto_resend_due') {
      const authHeader = req.headers.get('Authorization') ?? ''
      const isServiceRole = authHeader === `Bearer ${serviceKey}`
      if (!isServiceRole) return jsonResponse({ error: 'service_role_only' }, 403, corsHeaders)

      // Pull candidates: unconsumed, not yet expired, expiring within 60 min,
      // and either never resent OR last resend was before the 23h boundary so
      // we don't double-nudge a token that the loved one already poked.
      const { data: due, error: dueErr } = await supabase
        .from('data_source_invites')
        .select('id, token, caregiver_user_id, target_contact, data_source, hospital_name, expires_at, resend_count, last_resent_at')
        .is('consumed_at', null)
        .gt('expires_at', new Date().toISOString())
        .lt('expires_at', new Date(Date.now() + 60 * 60 * 1000).toISOString())
        .order('expires_at', { ascending: true })
        .limit(20)

      if (dueErr) return jsonResponse({ error: dueErr.message }, 500, corsHeaders)
      if (!due || due.length === 0) return jsonResponse({ ok: true, nudged: 0 }, 200, corsHeaders)

      let nudged = 0
      const errors: string[] = []
      for (const inv of due) {
        // Skip if we've already auto-nudged within the last 90 minutes (idempotent).
        if (inv.last_resent_at) {
          const sinceLast = Date.now() - new Date(inv.last_resent_at).getTime()
          if (sinceLast < 90 * 60 * 1000) continue
        }
        // Respect the same 3-resend cap as the manual path.
        if ((inv.resend_count ?? 0) >= 3) continue

        const cname = await caregiverName(supabase, inv.caregiver_user_id)
        const link = `https://mywellet.com/?dsinvite=${inv.token}`
        const sms = await callTwilioSendSms({
          authHeader: `Bearer ${serviceKey}`,
          to: inv.target_contact,
          body: smsBody({
            caregiverName: cname,
            dataSource: inv.data_source as 'apple_health' | 'ehr',
            hospitalName: inv.hospital_name,
            link,
          }),
          context: { invite_id: inv.id, kind: 'auto_resend_23h' },
        })
        if (sms.sent) nudged++
        else errors.push(`${inv.id}: ${sms.error}`)

        await supabase
          .from('data_source_invites')
          .update({
            resend_count: (inv.resend_count ?? 0) + 1,
            last_resent_at: new Date().toISOString(),
            ...(sms.sms_log_id ? { sms_log_id: sms.sms_log_id } : {}),
          })
          .eq('id', inv.id)
      }

      return jsonResponse({ ok: true, nudged, candidates: due.length, errors }, 200, corsHeaders)
    }

    // ====== CONSUME_SELF ===================================================
    // Called by Wellet Connect (iOS) after the loved one signs in + grants
    // HealthKit. We can't put service_role on the device, so we accept a
    // user JWT here, verify it, and use the authenticated user's id as the
    // consumed_by_user_id. Tokens are unguessable UUIDs delivered only via
    // SMS to the loved one's phone, so the attack surface is: "someone who
    // has the SMS link AND a Supabase user account can flip the invite to
    // consumed." That's exactly the intended actor.
    if (action === 'consume_self') {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (!authHeader.startsWith('Bearer ')) {
        return jsonResponse({ error: 'Auth required' }, 401, corsHeaders)
      }
      const userClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      })
      const { data: { user }, error: authErr } = await userClient.auth.getUser()
      if (authErr || !user) return jsonResponse({ error: 'Invalid auth' }, 401, corsHeaders)

      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)

      const { data: invite, error } = await supabase
        .from('data_source_invites')
        .update({
          consumed_at: new Date().toISOString(),
          consumed_by_user_id: user.id,
        })
        .eq('token', token)
        .is('consumed_at', null)
        .select('id, person_id, caregiver_user_id, data_source, hospital_name')
        .maybeSingle()

      if (error || !invite) {
        return jsonResponse({ error: 'invalid_or_already_consumed' }, 404, corsHeaders)
      }

      // Fire-and-forget caregiver notification (in-app row + Brevo email).
      const notify = await notifyCaregiverOfConsume(supabase, {
        caregiverUserId: invite.caregiver_user_id,
        personId: invite.person_id,
        dataSource: invite.data_source as 'apple_health' | 'ehr',
        hospitalName: invite.hospital_name,
      })

      return jsonResponse({
        ok: true,
        invite_id: invite.id,
        person_id: invite.person_id,
        notify,
      }, 200, corsHeaders)
    }

    // ====== CONSUME ========================================================
    // Marks an invite consumed once the linked OAuth / HealthKit flow has
    // actually persisted data on the loved one's side. Called by:
    //   - the EHR callback edge fn when it stores a fresh access token
    //   - the Apple Health bridge backend after first sample upload
    // Both call with service-role, so we just trust the request body but
    // require it to come from a server (no anon-key invocation allowed).
    if (action === 'consume') {
      const authHeader = req.headers.get('Authorization') ?? ''
      const isServiceRole = authHeader === `Bearer ${serviceKey}`
      if (!isServiceRole) return jsonResponse({ error: 'service_role_only' }, 403, corsHeaders)

      const token = String(payload.token || '')
      const consumedByUserId = payload.consumed_by_user_id ? String(payload.consumed_by_user_id) : null
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)

      const { data: invite, error } = await supabase
        .from('data_source_invites')
        .update({
          consumed_at: new Date().toISOString(),
          consumed_by_user_id: consumedByUserId,
        })
        .eq('token', token)
        .is('consumed_at', null)
        .select('id, person_id, caregiver_user_id, data_source, hospital_name')
        .maybeSingle()

      if (error || !invite) return jsonResponse({ error: 'invalid_or_already_consumed' }, 404, corsHeaders)

      // Tell the caregiver. In-app row + Brevo email. Never blocks success.
      const notify = await notifyCaregiverOfConsume(supabase, {
        caregiverUserId: invite.caregiver_user_id,
        personId: invite.person_id,
        dataSource: invite.data_source as 'apple_health' | 'ehr',
        hospitalName: invite.hospital_name,
      })

      return jsonResponse({
        ok: true,
        invite_id: invite.id,
        person_id: invite.person_id,
        notify,
      }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Unknown action: ' + action }, 400, corsHeaders)

  } catch (e) {
    await logSignupError({
      source: 'data-source-invite',
      severity: 'critical',
      error: e,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    })
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, corsHeaders)
  }
})
