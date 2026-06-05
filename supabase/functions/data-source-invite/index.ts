// Wellet · data-source-invite edge function v8 — consume accepts optional wearable_provider
//
// One edge function, six actions.
//
// v6 changes vs v5:
//   - Adds 'wearable' as a third data_source alongside apple_health + ehr.
//     create accepts wearable_provider (optional; null = let loved one pick
//     from Terra's full provider list on the landing page).
//   - smsBody now frames wearable connects as "your Fitbit/Garmin/etc" or
//     "your wearable device" when no provider is specified yet.
//   - notifyCaregiverOfConsume + lookup carry wearable_provider through.
//
// v5 changes vs v4:
//   - Service-role check now accepts BOTH the new sb_secret_... key AND the
//     legacy HS256 service_role JWT.
//   - notifyCaregiverOfConsume falls back to type='care_circle' if the
//     notifications_type_check rejects 'invite_consumed' on some env.
//
// Voice: "loved one" / "family member", never "parent".
// CareSignals is ONE WORD.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!

const legacyServiceKey = Deno.env.get('LEGACY_SERVICE_ROLE_KEY') || ''

// ---------- inlined helpers ------------------------------------------------
const ALLOWED_ORIGINS = [
  'https://mywellet.com',
  'https://www.mywellet.com',
  'https://getwellet.com',
  'https://www.getwellet.com',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
]

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : '',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.')
    if (parts.length !== 3) return null
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[1].length + (4 - (parts[1].length % 4)) % 4, '=')
    return JSON.parse(atob(b64))
  } catch { return null }
}

function isServiceRoleAuth(authHeader: string): boolean {
  if (!authHeader.startsWith('Bearer ')) return false
  const token = authHeader.slice(7).trim()
  if (!token) return false
  if (token === serviceKey) return true
  if (legacyServiceKey && token === legacyServiceKey) return true
  if (token.includes('.')) {
    const payload = decodeJwtPayload(token)
    const projectRef = supabaseUrl.match(/\/\/([^.]+)\.supabase\.co/)?.[1] || ''
    if (payload && payload.role === 'service_role' && payload.ref === projectRef) {
      const exp = typeof payload.exp === 'number' ? payload.exp : 0
      if (exp > Math.floor(Date.now() / 1000)) return true
    }
  }
  return false
}

type SignupErrorSeverity = 'critical' | 'warn' | 'info'
interface LogSignupErrorParams {
  source: string
  severity: SignupErrorSeverity
  error?: unknown
  message?: string
  errorCode?: string
  httpStatus?: number
  userId?: string | null
  userEmail?: string | null
  request?: Request
  context?: Record<string, unknown>
}

function _extractRequestId(req?: Request): string | null {
  if (!req) return null
  return req.headers.get('x-request-id') || req.headers.get('cf-ray') || req.headers.get('x-supabase-request-id') || null
}
function _errorToMessage(error: unknown): string {
  if (!error) return ''
  if (error instanceof Error) return [error.message, error.stack].filter(Boolean).join('\n').slice(0, 8000)
  try { return String(error).slice(0, 8000) } catch { return '(unstringifiable error)' }
}
async function logSignupError(params: LogSignupErrorParams): Promise<string | null> {
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !key) { console.error('[logSignupError] missing env'); return null }
    const admin = createClient(url, key)
    const row = {
      source: params.source,
      severity: params.severity,
      http_status: params.httpStatus ?? null,
      error_code: params.errorCode ?? null,
      message: (params.message || _errorToMessage(params.error)) || null,
      user_id: params.userId ?? null,
      user_email: params.userEmail ?? null,
      request_id: _extractRequestId(params.request),
      context: params.context ?? null,
    }
    const { data, error } = await admin.from('signup_error_log').insert(row).select('id').single()
    if (error) { console.error('[logSignupError] insert failed:', error.message); return null }
    return data?.id ?? null
  } catch (e) { console.error('[logSignupError] threw:', String(e)); return null }
}

// ---------- helpers --------------------------------------------------------

type DataSource = 'apple_health' | 'ehr' | 'wearable'

function jsonResponse(body: unknown, status: number, corsHeaders: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

function normalizeE164(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) return null
  return trimmed
}

function prettyWearable(provider: string | null | undefined): string {
  if (!provider) return 'your wearable'
  const p = provider.toLowerCase()
  const map: Record<string, string> = {
    fitbit: 'your Fitbit',
    garmin: 'your Garmin',
    oura: 'your Oura ring',
    whoop: 'your Whoop',
    withings: 'your Withings',
    polar: 'your Polar',
    google: 'your Google Fit',
    peloton: 'your Peloton',
    apple: 'your Apple Watch',
    samsung: 'your Samsung Health',
  }
  return map[p] || ('your ' + provider.charAt(0).toUpperCase() + provider.slice(1))
}

function smsBody(opts: { caregiverName: string; dataSource: DataSource; hospitalName?: string | null; wearableProvider?: string | null; link: string }): string {
  let what: string
  if (opts.dataSource === 'apple_health') what = 'your Apple Health'
  else if (opts.dataSource === 'wearable') what = prettyWearable(opts.wearableProvider)
  else what = opts.hospitalName ? `your ${opts.hospitalName}` : 'your hospital chart'
  return `${opts.caregiverName} is helping look after your health and would love ${what} to be in one place. Open: ${opts.link}\n\nReply STOP to opt out.`
}

async function callTwilioSendSms(opts: { authHeader: string; to: string; body: string; context: Record<string, unknown> }): Promise<{ sent: boolean; message_sid?: string; sms_log_id?: string; error?: string }> {
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/twilio-send-sms`, {
      method: 'POST',
      headers: { Authorization: opts.authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: opts.to, body: opts.body, context: { source: 'data-source-invite', ...opts.context } }),
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok) return { sent: false, error: json?.error ?? `http_${res.status}` }
    return { sent: true, message_sid: json?.message_sid, sms_log_id: json?.sms_log_id ?? json?.id }
  } catch (e) { return { sent: false, error: e instanceof Error ? e.message : String(e) } }
}

async function caregiverName(supabase: any, userId: string): Promise<string> {
  const { data: u } = await supabase.auth.admin.getUserById(userId)
  const meta = u?.user?.user_metadata ?? {}
  return (typeof meta.full_name === 'string' && meta.full_name.trim()) || (typeof meta.first_name === 'string' && meta.first_name.trim()) || (u?.user?.email?.split('@')[0]) || 'A family member'
}

async function notifyCaregiverOfConsume(supabase: any, opts: { caregiverUserId: string; personId: string; dataSource: DataSource; hospitalName?: string | null; wearableProvider?: string | null }): Promise<{ inAppOk: boolean; emailOk: boolean; error?: string }> {
  let inAppOk = false
  let emailOk = false
  let errorMsg: string | undefined

  let lovedName = 'your family member'
  try {
    const { data: p } = await supabase.from('people').select('name').eq('id', opts.personId).maybeSingle()
    if (p?.name) lovedName = p.name
  } catch { /* ignore */ }

  let caregiverEmail: string | null = null
  try {
    const { data: u } = await supabase.auth.admin.getUserById(opts.caregiverUserId)
    caregiverEmail = u?.user?.email ?? null
  } catch { /* ignore */ }

  let sourceLabel: string
  if (opts.dataSource === 'apple_health') sourceLabel = 'Apple Health'
  else if (opts.dataSource === 'wearable') sourceLabel = opts.wearableProvider ? (opts.wearableProvider.charAt(0).toUpperCase() + opts.wearableProvider.slice(1).toLowerCase()) : 'a wearable'
  else sourceLabel = opts.hospitalName || 'their hospital chart'

  const title = `${lovedName} just connected ${sourceLabel}`
  const body = `Wellet now notices ${lovedName}'s ${sourceLabel} updates. Open the app to see the first records flow in.`

  const tryInsert = async (typeVal: string) => {
    const { error } = await supabase.from('notifications').insert({ user_id: opts.caregiverUserId, person_id: opts.personId, type: typeVal, title, body })
    return error
  }
  try {
    let err = await tryInsert('invite_consumed')
    if (err && err.message && err.message.includes('notifications_type_check')) {
      err = await tryInsert('care_circle')
    }
    if (!err) inAppOk = true
    else errorMsg = `in_app_insert: ${err.message}`
  } catch (e) { errorMsg = `in_app_throw: ${e instanceof Error ? e.message : String(e)}` }

  if (caregiverEmail) {
    try {
      const smtpUser = Deno.env.get('BREVO_SMTP_USER') || ''
      const smtpPass = Deno.env.get('BREVO_SMTP_KEY') || ''
      const smtpHost = Deno.env.get('BREVO_SMTP_HOST') || 'smtp-relay.brevo.com'
      const fromAddress = Deno.env.get('BREVO_FROM_ADDRESS') || 'alerts@mywellet.com'
      const fromName = Deno.env.get('BREVO_FROM_NAME') || 'Wellet'
      if (smtpUser && smtpPass) {
        const { SMTPClient } = await import('https://deno.land/x/denomailer@1.6.0/mod.ts')
        const client = new SMTPClient({ connection: { hostname: smtpHost, port: 465, tls: true, auth: { username: smtpUser, password: smtpPass } } })
        const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text',sans-serif;color:#1d1d1f;line-height:1.6;padding:32px;max-width:520px;margin:0 auto;"><div style="font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:#86868b;margin-bottom:16px;">Wellet</div><h1 style="font-size:24px;font-weight:600;margin:0 0 16px;">${title}</h1><p style="font-size:16px;color:#1d1d1f;margin:0 0 24px;">${body}</p><p style="margin:0 0 32px;"><a href="https://mywellet.com" style="background:#0a84ff;color:#fff;padding:12px 24px;border-radius:999px;text-decoration:none;font-weight:500;">Open Wellet</a></p><p style="font-size:12px;color:#86868b;margin:0;">You're getting this because you sent ${lovedName} a connect link from Wellet.</p></body></html>`
        await client.send({ from: `${fromName} <${fromAddress}>`, to: caregiverEmail, subject: title, content: body, html })
        await client.close()
        emailOk = true
      }
    } catch (e) { errorMsg = `${errorMsg ? errorMsg + '; ' : ''}email: ${e instanceof Error ? e.message : String(e)}` }
  }

  return { inAppOk, emailOk, error: errorMsg }
}

// ---------- main -----------------------------------------------------------
Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const url = new URL(req.url)
    let payload: Record<string, unknown> = {}
    if (req.method === 'GET') payload = Object.fromEntries(url.searchParams.entries())
    else payload = await req.json().catch(() => ({}))
    const action = String(payload.action || url.searchParams.get('action') || '').toLowerCase()
    const supabase = createClient(supabaseUrl, serviceKey)

    if (action === 'lookup') {
      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)
      const { data: invite, error } = await supabase.from('data_source_invites').select('id, token, person_id, caregiver_user_id, data_source, hospital_name, wearable_provider, expires_at, consumed_at, people:person_id(name)').eq('token', token).maybeSingle()
      if (error || !invite) return jsonResponse({ error: 'invalid' }, 404, corsHeaders)
      if (new Date(invite.expires_at).getTime() < Date.now()) return jsonResponse({ error: 'expired' }, 410, corsHeaders)
      const cname = await caregiverName(supabase, invite.caregiver_user_id)
      // @ts-ignore
      const lovedOne = invite.people?.name ?? null
      return jsonResponse({ token: invite.token, data_source: invite.data_source, hospital_name: invite.hospital_name, wearable_provider: invite.wearable_provider, caregiver_name: cname, loved_one_name: lovedOne, consumed_at: invite.consumed_at }, 200, corsHeaders)
    }

    if (action === 'create') {
      const authHeader = req.headers.get('Authorization')
      if (!authHeader) return jsonResponse({ error: 'Auth required' }, 401, corsHeaders)
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: { user }, error: authErr } = await userClient.auth.getUser()
      if (authErr || !user) return jsonResponse({ error: 'Invalid auth' }, 401, corsHeaders)
      const personId = String(payload.person_id || '')
      const dataSource = String(payload.data_source || '')
      const channel = String(payload.channel || 'sms')
      const targetContact = String(payload.target_contact || '').trim()
      const hospitalName = payload.hospital_name ? String(payload.hospital_name) : null
      const fhirBaseUrl = payload.fhir_base_url ? String(payload.fhir_base_url) : null
      const wearableProvider = payload.wearable_provider ? String(payload.wearable_provider).toLowerCase().slice(0, 32) : null
      if (!personId) return jsonResponse({ error: 'person_id required' }, 400, corsHeaders)
      if (!['apple_health', 'ehr', 'wearable'].includes(dataSource)) return jsonResponse({ error: 'data_source must be apple_health, ehr, or wearable' }, 400, corsHeaders)
      if (channel !== 'sms') return jsonResponse({ error: 'only sms supported in v1' }, 400, corsHeaders)
      const to = normalizeE164(targetContact)
      if (!to) return jsonResponse({ error: 'target_contact must be E.164 (+1xxxxxxxxxx)' }, 400, corsHeaders)
      const { data: person, error: personErr } = await supabase.from('people').select('id, name, user_id, is_self, phone').eq('id', personId).maybeSingle()
      if (personErr || !person) return jsonResponse({ error: 'person not found' }, 404, corsHeaders)
      if (person.user_id !== user.id) return jsonResponse({ error: 'Not authorized' }, 403, corsHeaders)
      if (person.is_self) return jsonResponse({ error: 'is_self_person_uses_direct_flow' }, 400, corsHeaders)
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString()
      const { count: recentCount } = await supabase.from('data_source_invites').select('id', { count: 'exact', head: true }).eq('caregiver_user_id', user.id).eq('person_id', personId).eq('data_source', dataSource).gte('created_at', oneHourAgo)
      if ((recentCount ?? 0) >= 5) return jsonResponse({ error: 'rate_limited' }, 429, corsHeaders)
      const insertRow: Record<string, unknown> = { person_id: personId, caregiver_user_id: user.id, data_source: dataSource, hospital_name: hospitalName, fhir_base_url: fhirBaseUrl, channel, target_contact: to }
      if (dataSource === 'wearable') insertRow.wearable_provider = wearableProvider
      const { data: invite, error: insertErr } = await supabase.from('data_source_invites').insert(insertRow).select('id, token, expires_at').single()
      if (insertErr || !invite) return jsonResponse({ error: 'insert_failed: ' + (insertErr?.message ?? 'unknown') }, 500, corsHeaders)
      if (!person.phone) await supabase.from('people').update({ phone: to }).eq('id', personId)
      const link = `https://mywellet.com/?dsinvite=${invite.token}`
      const cname = await caregiverName(supabase, user.id)
      const sms = await callTwilioSendSms({ authHeader, to, body: smsBody({ caregiverName: cname, dataSource: dataSource as DataSource, hospitalName, wearableProvider, link }), context: { invite_id: invite.id, person_id: personId, data_source: dataSource } })
      if (sms.sms_log_id) await supabase.from('data_source_invites').update({ sms_log_id: sms.sms_log_id }).eq('id', invite.id)
      return jsonResponse({ invite_id: invite.id, invite_link: link, invite_token: invite.token, expires_at: invite.expires_at, person_name: person.name, sms }, 200, corsHeaders)
    }

    if (action === 'resend') {
      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)
      const { data: invite, error } = await supabase.from('data_source_invites').select('id, token, caregiver_user_id, target_contact, data_source, hospital_name, wearable_provider, expires_at, consumed_at, resend_count, last_resent_at').eq('token', token).maybeSingle()
      if (error || !invite) return jsonResponse({ error: 'invalid' }, 404, corsHeaders)
      if (invite.consumed_at) return jsonResponse({ error: 'already_used' }, 410, corsHeaders)
      if (new Date(invite.expires_at).getTime() < Date.now()) return jsonResponse({ error: 'expired' }, 410, corsHeaders)
      if ((invite.resend_count ?? 0) >= 3) return jsonResponse({ error: 'resend_limit' }, 429, corsHeaders)
      if (invite.last_resent_at) {
        const sinceLast = Date.now() - new Date(invite.last_resent_at).getTime()
        if (sinceLast < 60_000) return jsonResponse({ error: 'too_soon', retry_in_seconds: Math.ceil((60_000 - sinceLast) / 1000) }, 429, corsHeaders)
      }
      const cname = await caregiverName(supabase, invite.caregiver_user_id)
      const link = `https://mywellet.com/?dsinvite=${invite.token}`
      const sms = await callTwilioSendSms({ authHeader: `Bearer ${serviceKey}`, to: invite.target_contact, body: smsBody({ caregiverName: cname, dataSource: invite.data_source as DataSource, hospitalName: invite.hospital_name, wearableProvider: invite.wearable_provider, link }), context: { invite_id: invite.id, kind: 'resend' } })
      await supabase.from('data_source_invites').update({ resend_count: (invite.resend_count ?? 0) + 1, last_resent_at: new Date().toISOString(), ...(sms.sms_log_id ? { sms_log_id: sms.sms_log_id } : {}) }).eq('id', invite.id)
      return jsonResponse({ ok: sms.sent, sms }, 200, corsHeaders)
    }

    if (action === 'auto_resend_due') {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (!isServiceRoleAuth(authHeader)) return jsonResponse({ error: 'service_role_only' }, 403, corsHeaders)
      const { data: due, error: dueErr } = await supabase.from('data_source_invites').select('id, token, caregiver_user_id, target_contact, data_source, hospital_name, wearable_provider, expires_at, resend_count, last_resent_at').is('consumed_at', null).gt('expires_at', new Date().toISOString()).lt('expires_at', new Date(Date.now() + 60 * 60 * 1000).toISOString()).order('expires_at', { ascending: true }).limit(20)
      if (dueErr) return jsonResponse({ error: dueErr.message }, 500, corsHeaders)
      if (!due || due.length === 0) return jsonResponse({ ok: true, nudged: 0 }, 200, corsHeaders)
      let nudged = 0
      const errors: string[] = []
      for (const inv of due) {
        if (inv.last_resent_at) {
          const sinceLast = Date.now() - new Date(inv.last_resent_at).getTime()
          if (sinceLast < 90 * 60 * 1000) continue
        }
        if ((inv.resend_count ?? 0) >= 3) continue
        const cname = await caregiverName(supabase, inv.caregiver_user_id)
        const link = `https://mywellet.com/?dsinvite=${inv.token}`
        const sms = await callTwilioSendSms({ authHeader: `Bearer ${serviceKey}`, to: inv.target_contact, body: smsBody({ caregiverName: cname, dataSource: inv.data_source as DataSource, hospitalName: inv.hospital_name, wearableProvider: inv.wearable_provider, link }), context: { invite_id: inv.id, kind: 'auto_resend_23h' } })
        if (sms.sent) nudged++
        else errors.push(`${inv.id}: ${sms.error}`)
        await supabase.from('data_source_invites').update({ resend_count: (inv.resend_count ?? 0) + 1, last_resent_at: new Date().toISOString(), ...(sms.sms_log_id ? { sms_log_id: sms.sms_log_id } : {}) }).eq('id', inv.id)
      }
      return jsonResponse({ ok: true, nudged, candidates: due.length, errors }, 200, corsHeaders)
    }

    if (action === 'consume_self') {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (!authHeader.startsWith('Bearer ')) return jsonResponse({ error: 'Auth required' }, 401, corsHeaders)
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } })
      const { data: { user }, error: authErr } = await userClient.auth.getUser()
      if (authErr || !user) return jsonResponse({ error: 'Invalid auth' }, 401, corsHeaders)
      const token = String(payload.token || '')
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)
      const { data: invite, error } = await supabase.from('data_source_invites').update({ consumed_at: new Date().toISOString(), consumed_by_user_id: user.id }).eq('token', token).is('consumed_at', null).select('id, person_id, caregiver_user_id, data_source, hospital_name, wearable_provider').maybeSingle()
      if (error || !invite) return jsonResponse({ error: 'invalid_or_already_consumed' }, 404, corsHeaders)
      const notify = await notifyCaregiverOfConsume(supabase, { caregiverUserId: invite.caregiver_user_id, personId: invite.person_id, dataSource: invite.data_source as DataSource, hospitalName: invite.hospital_name, wearableProvider: invite.wearable_provider })
      return jsonResponse({ ok: true, invite_id: invite.id, person_id: invite.person_id, notify }, 200, corsHeaders)
    }

    if (action === 'consume') {
      const authHeader = req.headers.get('Authorization') ?? ''
      if (!isServiceRoleAuth(authHeader)) return jsonResponse({ error: 'service_role_only' }, 403, corsHeaders)
      const token = String(payload.token || '')
      const consumedByUserId = payload.consumed_by_user_id ? String(payload.consumed_by_user_id) : null
      // Optional: caller (e.g. terra-webhook) can pass wearable_provider to set
      // it at consume time when the invite was open-ended.
      const wearableProviderAtConsume = payload.wearable_provider ? String(payload.wearable_provider).toLowerCase().slice(0, 32) : null
      if (!token) return jsonResponse({ error: 'token required' }, 400, corsHeaders)
      const updateRow: Record<string, unknown> = { consumed_at: new Date().toISOString(), consumed_by_user_id: consumedByUserId }
      if (wearableProviderAtConsume) updateRow.wearable_provider = wearableProviderAtConsume
      const { data: invite, error } = await supabase.from('data_source_invites').update(updateRow).eq('token', token).is('consumed_at', null).select('id, person_id, caregiver_user_id, data_source, hospital_name, wearable_provider').maybeSingle()
      if (error || !invite) return jsonResponse({ error: 'invalid_or_already_consumed' }, 404, corsHeaders)
      const notify = await notifyCaregiverOfConsume(supabase, { caregiverUserId: invite.caregiver_user_id, personId: invite.person_id, dataSource: invite.data_source as DataSource, hospitalName: invite.hospital_name, wearableProvider: invite.wearable_provider })
      return jsonResponse({ ok: true, invite_id: invite.id, person_id: invite.person_id, notify }, 200, corsHeaders)
    }

    return jsonResponse({ error: 'Unknown action: ' + action }, 400, corsHeaders)
  } catch (e) {
    await logSignupError({ source: 'data-source-invite', severity: 'critical', error: e, httpStatus: 500, request: req, context: { phase: 'top_level_catch' } })
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, corsHeaders)
  }
})
