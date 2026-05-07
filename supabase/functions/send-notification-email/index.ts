import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

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

  try {
    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const { type, recipient_email, recipient_name, person_name, details } =
      body;

    if (!type || !recipient_email) {
      return json(
        { error: "type and recipient_email are required" },
        400,
      );
    }

    // Build subject line
    let subject: string;
    const title = details?.title || "";
    switch (type) {
      case "med_reminder":
        subject = `Reminder: ${person_name}'s ${title} — Time to take`;
        break;
      case "appointment":
        subject = `Tomorrow: ${person_name} has ${title}`;
        break;
      case "pattern_alert":
        subject = `Wellet noticed something about ${person_name}`;
        break;
      default:
        subject = `Wellet notification for ${person_name}`;
    }

    // Build HTML email
    const emailBody = details?.body || title;
    const html = buildEmailHtml(type, person_name, title, emailBody);

    // Send via Brevo SMTP (credentials set via supabase secrets)
    const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
    // Hardcoded to 465 (implicit TLS / SMTPS). denomailer 1.6 + tls:true on 587
    // produces InvalidContentType. 465 + tls:true is the working combo.
    const smtpPort = 465;
    const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
    const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";

    if (!smtpUser || !smtpPass) {
      return json({ error: "SMTP credentials not configured" }, 500);
    }

    const client = new SMTPClient({
      connection: {
        hostname: smtpHost,
        port: smtpPort,
        tls: true,
        auth: {
          username: smtpUser,
          password: smtpPass,
        },
      },
    });

    await client.send({
      // hello@getwellet.com is the verified Brevo sender; mywellet.com isn't domain-auth'd yet.
      from: "Wellet <hello@getwellet.com>",
      to: recipient_email,
      subject: subject,
      content: "auto",
      html: html,
    });

    await client.close();

    return json({ success: true });
  } catch (e) {
    console.error("send-notification-email error:", e);
    return json({ error: e.message || "Internal error" }, 500);
  }
});

function buildEmailHtml(
  type: string,
  personName: string,
  title: string,
  body: string,
): string {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  let iconEmoji = "🔔";
  let accentBg = "#F0F7F4";
  if (type === "med_reminder") {
    iconEmoji = "💊";
    accentBg = "#FFF8E6";
  }
  if (type === "appointment") {
    iconEmoji = "📅";
    accentBg = "#F0F7F4";
  }
  if (type === "pattern_alert") {
    iconEmoji = "⚠️";
    accentBg = "#FEF0EE";
  }

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin:0; padding:0; background:#F5F5F5; font-family:'DM Sans',Arial,Helvetica,sans-serif; }
    .container { max-width:560px; margin:0 auto; padding:24px 16px; }
    .card { background:white; border-radius:16px; padding:32px 28px; }
    .logo { font-family:'DM Serif Display',Georgia,serif; font-size:22px; color:#608F7C; margin-bottom:24px; }
    .icon-row { display:flex; align-items:center; gap:10px; margin-bottom:16px; }
    .icon-badge { width:40px; height:40px; border-radius:10px; background:${accentBg}; display:flex; align-items:center; justify-content:center; font-size:20px; }
    .title { font-size:17px; font-weight:600; color:#1a1a1a; line-height:1.4; }
    .body-text { font-size:14px; color:#555; line-height:1.6; margin:12px 0 0; }
    .person { font-size:13px; color:#608F7C; font-weight:500; margin-top:16px; }
    .divider { border:none; border-top:1px solid #eee; margin:24px 0; }
    .footer { font-size:11px; color:#999; line-height:1.6; text-align:center; }
    .footer a { color:#608F7C; text-decoration:none; }
  </style>
</head>
<body>
  <div class="container">
    <div class="card">
      <div class="logo">Wellet</div>
      <div class="icon-row">
        <div class="icon-badge">${iconEmoji}</div>
        <div class="title">${esc(title)}</div>
      </div>
      <div class="body-text">${esc(body)}</div>
      <div class="person">For ${esc(personName)}</div>
      <hr class="divider">
      <div class="footer">
        You're receiving this because you're part of ${esc(personName)}'s care circle on Wellet.<br>
        <a href="https://mywellet.com">Manage preferences at mywellet.com</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
