// supabase/functions/create-connection-request/index.ts
// Wellet Ask Mom v3.1 — caregiver sends a warm request to a loved one to connect a data source.
// Channels: sms (Twilio), email (Brevo SMTP), copy (returns link only).
// Auth: requires caller JWT. Caller must own the target person_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = new Set([
  "https://mywellet.com",
  "https://www.mywellet.com",
  "https://getwellet.com",
  "https://www.getwellet.com",
  "http://localhost:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
]);

const VALID_SOURCES = new Set(["hospital", "va", "wearable", "google_health", "document", "apple_health"]);
const VALID_CHANNELS = new Set(["sms", "email", "copy"]);

const APPROVE_BASE = "https://getwellet.com/approve";

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://mywellet.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

function normalizeE164(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\+[1-9]\d{6,14}$/.test(trimmed)) return trimmed;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

function genToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += b.toString(36).padStart(2, "0");
  return out;
}

async function callTwilioSendSms(authHeader: string, to: string, body: string): Promise<{ ok: boolean; sms_log_id?: string; message_sid?: string; error?: string }> {
  try {
    const resp = await fetch(`${SUPABASE_URL}/functions/v1/twilio-send-sms`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": authHeader },
      body: JSON.stringify({ to, body }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data?.success === false) {
      return { ok: false, error: data?.error || `Twilio HTTP ${resp.status}` };
    }
    return { ok: true, sms_log_id: data.sms_log_id, message_sid: data.message_sid };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function sendBrevoEmail(to: string, subject: string, plaintext: string, html: string): Promise<{ ok: boolean; error?: string }> {
  const user = Deno.env.get("BREVO_SMTP_USER");
  const key = Deno.env.get("BREVO_SMTP_KEY");
  const host = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
  const fromAddr = Deno.env.get("BREVO_FROM_ADDRESS") || "alerts@mywellet.com";
  const fromName = Deno.env.get("BREVO_FROM_NAME") || "Wellet";
  if (!user || !key) return { ok: false, error: "Brevo SMTP not configured" };
  try {
    const { SMTPClient } = await import("https://deno.land/x/denomailer@1.6.0/mod.ts");
    const client = new SMTPClient({
      connection: { hostname: host, port: 465, tls: true, auth: { username: user, password: key } },
    });
    await client.send({
      from: `${fromName} <${fromAddr}>`,
      to,
      subject,
      content: plaintext,
      html,
    });
    await client.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;" } as any)[c]);
}

function emailHtml(noteBody: string, approveUrl: string): string {
  const noteHtml = escapeHtml(noteBody).replace(/\n/g, "<br>");
  return `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 20px; color: #1a1a1a; line-height: 1.6;">
<div style="font-size: 16px; white-space: pre-wrap;">${noteHtml}</div>
<div style="margin: 32px 0;">
  <a href="${approveUrl}" style="background: #0a0a0a; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; display: inline-block;">Open in Wellet</a>
</div>
<div style="font-size: 13px; color: #666; margin-top: 32px; padding-top: 16px; border-top: 1px solid #e5e5e5;">
  Or open this link directly:<br>
  <a href="${approveUrl}" style="color: #0a0a0a; word-break: break-all;">${approveUrl}</a>
</div>
<div style="font-size: 12px; color: #999; margin-top: 24px;">Sent via Wellet. If you didn't expect this, you can ignore it.</div>
</body></html>`;
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  const authHeader = req.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) return json({ error: "Missing bearer token" }, 401, cors);

  const userClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "Invalid auth" }, 401, cors);
  const user = userData.user;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, cors); }

  const personId = body?.person_id?.toString().trim();
  const source = body?.source?.toString().trim();
  const sourceLabel = body?.source_label?.toString().trim() || null;
  const channel = body?.channel?.toString().trim();
  const recipientRaw = body?.recipient?.toString().trim() || "";
  const noteBody = body?.note_body?.toString() || "";
  const endpointId = body?.endpoint_id?.toString().trim() || null;
  const lovedOneName = body?.loved_one_name?.toString().trim() || null;

  if (!personId) return json({ error: "person_id required" }, 400, cors);
  if (!VALID_SOURCES.has(source)) return json({ error: `invalid source: ${source}` }, 400, cors);
  if (!VALID_CHANNELS.has(channel)) return json({ error: `invalid channel: ${channel}` }, 400, cors);
  if (!noteBody || noteBody.length < 5) return json({ error: "note_body required (min 5 chars)" }, 400, cors);
  if (noteBody.length > 1200) return json({ error: "note_body too long (max 1200)" }, 400, cors);

  let recipient: string | null = null;
  if (channel === "sms") {
    recipient = normalizeE164(recipientRaw);
    if (!recipient) return json({ error: "Invalid phone for SMS (need E.164)" }, 400, cors);
  } else if (channel === "email") {
    if (!isEmail(recipientRaw)) return json({ error: "Invalid email address" }, 400, cors);
    recipient = recipientRaw;
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: person, error: personErr } = await admin
    .from("people")
    .select("id, user_id, name")
    .eq("id", personId)
    .maybeSingle();
  if (personErr) return json({ error: `db error: ${personErr.message}` }, 500, cors);
  if (!person) return json({ error: "person not found" }, 404, cors);
  if (person.user_id !== user.id) return json({ error: "forbidden" }, 403, cors);

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount, error: rateErr } = await admin
    .from("connection_requests")
    .select("id", { count: "exact", head: true })
    .eq("caregiver_user_id", user.id)
    .eq("person_id", personId)
    .eq("source", source)
    .gte("created_at", oneHourAgo);
  if (rateErr) return json({ error: `rate check failed: ${rateErr.message}` }, 500, cors);
  if ((recentCount ?? 0) >= 5) return json({ error: "rate limit: 5/hour for this person+source" }, 429, cors);

  const token = genToken();
  const approveUrl = `${APPROVE_BASE}/${token}`;
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  const insertPayload: Record<string, any> = {
    caregiver_user_id: user.id,
    person_id: personId,
    source,
    source_label: sourceLabel,
    endpoint_id: endpointId,
    channel,
    recipient,
    note_body: noteBody,
    token,
    status: "sent",
    expires_at: expiresAt,
    metadata: { loved_one_name: lovedOneName },
  };

  const { data: inserted, error: insErr } = await admin
    .from("connection_requests")
    .insert(insertPayload)
    .select("id, token, created_at, expires_at")
    .single();
  if (insErr || !inserted) return json({ error: `insert failed: ${insErr?.message}` }, 500, cors);

  let finalBody = noteBody;
  const placeholderRe = /(https?:\/\/)?wellet\.app\/approve\/\S+/g;
  if (placeholderRe.test(finalBody)) {
    finalBody = finalBody.replace(placeholderRe, approveUrl);
  } else if (!finalBody.includes(approveUrl)) {
    finalBody = `${finalBody.trimEnd()}\n\n${approveUrl}`;
  }

  let channelResult: Record<string, any> = { channel };

  if (channel === "sms") {
    const sms = await callTwilioSendSms(authHeader, recipient!, finalBody);
    channelResult = { channel: "sms", ...sms };
    if (sms.ok) {
      const updates: Record<string, any> = {};
      if (sms.sms_log_id) updates.sms_log_id = sms.sms_log_id;
      if (sms.message_sid) updates.metadata = { loved_one_name: lovedOneName, twilio_message_sid: sms.message_sid };
      if (Object.keys(updates).length) {
        await admin.from("connection_requests").update(updates).eq("id", inserted.id);
      }
    } else {
      await admin.from("connection_requests")
        .update({ status: "failed", metadata: { loved_one_name: lovedOneName, failure_reason: sms.error ?? "sms send failed" } })
        .eq("id", inserted.id);
    }
  } else if (channel === "email") {
    const subject = `${person.name ? person.name + " — " : ""}a quick note from someone who's helping`;
    const html = emailHtml(finalBody, approveUrl);
    const result = await sendBrevoEmail(recipient!, subject, finalBody, html);
    channelResult = { channel: "email", ...result };
    if (!result.ok) {
      await admin.from("connection_requests")
        .update({ status: "failed", metadata: { loved_one_name: lovedOneName, failure_reason: result.error ?? "email send failed" } })
        .eq("id", inserted.id);
    }
  } else {
    channelResult = { channel: "copy", ok: true, link: approveUrl };
  }

  return json({
    request_id: inserted.id,
    token: inserted.token,
    approve_url: approveUrl,
    expires_at: inserted.expires_at,
    channel_result: channelResult,
  }, 200, cors);
});
