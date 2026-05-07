// submit-connect-request
// Accepts a "can't connect my hospital" report from the app, stores it in
// public.hospital_connect_requests, and emails support@getwellet.com via Brevo.
//
// Gateway config: verify_jwt = false. We validate the user via anonClient.auth.getUser()
// because Supabase's new asymmetric (ES256) JWTs trip the gateway's HS256 verifier.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPPORT_TO = "support@getwellet.com";
// hello@getwellet.com is the verified Brevo sender; mywellet.com isn't domain-auth'd yet.
const FROM_ADDRESS = "Wellet <hello@getwellet.com>";

const ALLOWED_ISSUE_TYPES = new Set([
  "not_found",
  "unsupported_version",
  "oauth_error",
  "connected_no_data",
  "other",
]);

function escHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function trim(s: unknown, max = 2000): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  if (!t) return null;
  return t.length > max ? t.substring(0, max) : t;
}

function isValidEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Auth — optional. Users can submit anonymously (e.g., if auth session flaked),
    // but if they are logged in we attach their user_id for follow-up.
    let userId: string | null = null;
    const authHeader = req.headers.get("Authorization");
    if (authHeader) {
      const anonClient = createClient(supabaseUrl, anonKey, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user } } = await anonClient.auth.getUser();
      if (user) userId = user.id;
    }

    const body = await req.json().catch(() => ({}));

    const hospital_name = trim(body.hospital_name, 200);
    const issue_type = trim(body.issue_type, 40);
    if (!hospital_name) {
      return json({ error: "hospital_name is required" }, 400);
    }
    if (!issue_type || !ALLOWED_ISSUE_TYPES.has(issue_type)) {
      return json({ error: "invalid issue_type" }, 400);
    }

    const city = trim(body.city, 100);
    const state = trim(body.state, 50);
    const notes = trim(body.notes, 4000);
    const contact_email_raw = trim(body.contact_email, 200);
    const contact_email = contact_email_raw && isValidEmail(contact_email_raw)
      ? contact_email_raw
      : null;
    const fhir_base_url = trim(body.fhir_base_url, 500);
    const error_code = trim(body.error_code, 100);
    const error_message = trim(body.error_message, 1000);
    const person_id = trim(body.person_id, 64);
    const user_agent = trim(req.headers.get("user-agent"), 500);

    // Insert via service role so RLS doesn't reject anonymous submissions.
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: inserted, error: insertErr } = await admin
      .from("hospital_connect_requests")
      .insert({
        user_id: userId,
        person_id: person_id,
        hospital_name,
        city,
        state,
        issue_type,
        notes,
        contact_email,
        fhir_base_url,
        error_code,
        error_message,
        user_agent,
      })
      .select("id, created_at")
      .single();

    if (insertErr) {
      console.error("[submit-connect-request] insert failed", insertErr);
      return json({ error: "could not save request" }, 500);
    }

    // Fire email to support — non-blocking on user response. If SMTP fails,
    // we still 200 the user; the row is persisted and we can alert later.
    const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
    // Hardcoded to 465 (implicit TLS / SMTPS). denomailer 1.6 + tls:true on 587
    // produces InvalidContentType. 465 + tls:true is the working combo.
    const smtpPort = 465;
    const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
    const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";

    if (smtpUser && smtpPass) {
      try {
        const client = new SMTPClient({
          connection: {
            hostname: smtpHost,
            port: smtpPort,
            tls: true,
            auth: { username: smtpUser, password: smtpPass },
          },
        });
        await client.send({
          from: FROM_ADDRESS,
          to: SUPPORT_TO,
          subject: `New hospital connect request: ${hospital_name}`,
          content: "auto",
          html: buildEmailHtml({
            hospital_name,
            city,
            state,
            issue_type,
            notes,
            contact_email,
            fhir_base_url,
            error_code,
            error_message,
            user_id: userId,
            request_id: inserted.id,
          }),
        });
        await client.close();
      } catch (e) {
        // Log but don't fail the request — row is already saved.
        console.error("[submit-connect-request] email send failed", e);
      }
    } else {
      console.warn("[submit-connect-request] SMTP creds missing; email skipped");
    }

    return json({ success: true, request_id: inserted.id });
  } catch (e) {
    console.error("[submit-connect-request] unexpected error", e);
    return json({ error: "internal_error" }, 500);
  }
});

function buildEmailHtml(fields: {
  hospital_name: string;
  city: string | null;
  state: string | null;
  issue_type: string;
  notes: string | null;
  contact_email: string | null;
  fhir_base_url: string | null;
  error_code: string | null;
  error_message: string | null;
  user_id: string | null;
  request_id: string;
}): string {
  const issueLabels: Record<string, string> = {
    not_found: "Hospital not in picker",
    unsupported_version: "Unsupported FHIR version (DSTU2)",
    oauth_error: "Error during login",
    connected_no_data: "Connected but no data",
    other: "Other",
  };
  const row = (label: string, value: string | null) =>
    value
      ? `<tr><td style="padding:6px 12px 6px 0;color:#888;font-size:12px;vertical-align:top;white-space:nowrap;">${escHtml(label)}</td><td style="padding:6px 0;font-size:13px;color:#1a1a1a;">${escHtml(value)}</td></tr>`
      : "";

  const location = [fields.city, fields.state].filter(Boolean).join(", ") || null;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:white;border-radius:16px;padding:28px;">
      <div style="font-family:'DM Serif Display',Georgia,serif;font-size:22px;color:#608F7C;margin-bottom:16px;">Wellet</div>
      <div style="font-size:17px;font-weight:600;color:#1a1a1a;margin-bottom:8px;">New hospital connect request</div>
      <div style="font-size:14px;color:#555;margin-bottom:20px;">A user reported they couldn't connect their health system.</div>
      <table style="width:100%;border-collapse:collapse;">
        ${row("Hospital", fields.hospital_name)}
        ${row("Location", location)}
        ${row("Issue", issueLabels[fields.issue_type] || fields.issue_type)}
        ${row("Notes", fields.notes)}
        ${row("Contact", fields.contact_email)}
        ${row("User ID", fields.user_id)}
        ${row("FHIR URL", fields.fhir_base_url)}
        ${row("Error code", fields.error_code)}
        ${row("Error msg", fields.error_message)}
        ${row("Request ID", fields.request_id)}
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <div style="font-size:11px;color:#999;text-align:center;">
        Triage at <a href="https://supabase.com/dashboard/project/nrpdhxygzyfmyljzfexv/editor" style="color:#608F7C;text-decoration:none;">Supabase &rsaquo; hospital_connect_requests</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
