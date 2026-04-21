// Bug report handler: receives a short description + optional screenshot path,
// saves it to public.bug_reports (RLS-enforced), and emails Betsy a summary via
// the Brevo SMTP relay that already powers send-notification-email.
//
// Auth: requires a valid Supabase JWT (the client calls this only after login).
// The function re-validates the user via anon client so we can trust user_id.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPPORT_EMAIL = "betsy.eble@gmail.com";

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "No authorization header" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const anonClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => ({}));
    const description = String(body.description || "").trim();
    if (!description) return json({ error: "description is required" }, 400);
    if (description.length > 5000) return json({ error: "description too long" }, 400);

    const screenshotPath = body.screenshot_path ? String(body.screenshot_path).slice(0, 500) : null;
    const url = body.url ? String(body.url).slice(0, 1000) : null;
    const userAgent = body.user_agent ? String(body.user_agent).slice(0, 500) : null;
    const personContext = body.person_context ? String(body.person_context).slice(0, 200) : null;
    const viewContext = body.view_context ? String(body.view_context).slice(0, 200) : null;
    const sessionId = body.session_id ? String(body.session_id).slice(0, 100) : null;
    const appVersion = body.app_version ? String(body.app_version).slice(0, 50) : null;

    // Insert via service-role so we can store even if RLS policy changes later.
    // user_id is derived from the validated JWT, not the client.
    const admin = createClient(supabaseUrl, serviceKey);
    const { data: inserted, error: insertErr } = await admin
      .from("bug_reports")
      .insert({
        user_id: user.id,
        user_email: user.email,
        description,
        screenshot_path: screenshotPath,
        url,
        user_agent: userAgent,
        person_context: personContext,
        view_context: viewContext,
        session_id: sessionId,
        app_version: appVersion,
      })
      .select("id, created_at")
      .single();

    if (insertErr) {
      console.error("bug_reports insert error:", insertErr);
      return json({ error: "Could not save report" }, 500);
    }

    // Signed URL for the screenshot (optional)
    let signedScreenshotUrl: string | null = null;
    if (screenshotPath) {
      const { data: signed } = await admin.storage
        .from("bug-screenshots")
        .createSignedUrl(screenshotPath, 60 * 60 * 24 * 14); // 14 days
      signedScreenshotUrl = signed?.signedUrl || null;
    }

    // Email Betsy
    const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
    const smtpPort = parseInt(Deno.env.get("BREVO_SMTP_PORT") || "587", 10);
    const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
    const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";

    if (smtpUser && smtpPass) {
      const client = new SMTPClient({
        connection: {
          hostname: smtpHost,
          port: smtpPort,
          tls: false,
          auth: { username: smtpUser, password: smtpPass },
        },
      });

      const subject = `Wellet bug: ${description.slice(0, 60)}${description.length > 60 ? "…" : ""}`;

      const html = `
<!doctype html>
<html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2C2A26;line-height:1.55;">
<h2 style="font-family:'DM Serif Display',Georgia,serif;color:#608F7C;margin:0 0 8px;">New bug report</h2>
<p style="color:#6B6560;margin:0 0 24px;font-size:14px;">Submitted from mywellet.com · ${escapeHtml(new Date().toISOString())}</p>

<div style="background:#F7F5F0;border-radius:12px;padding:16px 20px;margin-bottom:20px;">
<p style="margin:0;white-space:pre-wrap;font-size:15px;">${escapeHtml(description)}</p>
</div>

<table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a453f;">
<tr><td style="padding:6px 0;width:140px;color:#8a8580;">From</td><td>${escapeHtml(user.email || "unknown")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">URL</td><td>${escapeHtml(url || "—")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">View</td><td>${escapeHtml(viewContext || "—")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">Person viewed</td><td>${escapeHtml(personContext || "—")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">Browser</td><td style="word-break:break-all;">${escapeHtml(userAgent || "—")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">App version</td><td>${escapeHtml(appVersion || "—")}</td></tr>
<tr><td style="padding:6px 0;color:#8a8580;">Report ID</td><td style="font-family:monospace;">${escapeHtml(inserted?.id || "—")}</td></tr>
</table>

${signedScreenshotUrl ? `
<p style="margin:24px 0 8px;"><strong>Screenshot:</strong></p>
<p><a href="${escapeHtml(signedScreenshotUrl)}" style="color:#608F7C;">View screenshot (link expires in 14 days)</a></p>
<p><img src="${escapeHtml(signedScreenshotUrl)}" alt="screenshot" style="max-width:100%;border-radius:8px;border:1px solid #E5E0D8;" /></p>
` : ""}

<p style="margin-top:32px;color:#8a8580;font-size:12px;">Reply directly to email the reporter. View all reports in Supabase → Table editor → bug_reports.</p>
</body></html>`;

      const textBody = `NEW BUG REPORT

${description}

---
From: ${user.email}
URL: ${url || "—"}
View: ${viewContext || "—"}
Person viewed: ${personContext || "—"}
Browser: ${userAgent || "—"}
Report ID: ${inserted?.id || "—"}
${signedScreenshotUrl ? `Screenshot: ${signedScreenshotUrl}` : ""}`;

      try {
        await client.send({
          from: "Wellet Bugs <notifications@mywellet.com>",
          to: SUPPORT_EMAIL,
          replyTo: user.email || undefined,
          subject,
          content: textBody,
          html,
        });
        await client.close();
      } catch (mailErr) {
        console.error("Bug email send failed (report still saved):", mailErr);
      }
    } else {
      console.warn("BREVO SMTP not configured — report saved but email not sent");
    }

    return json({ success: true, id: inserted?.id });
  } catch (e) {
    console.error("send-bug-report error:", e);
    return json({ error: "Something went wrong" }, 500);
  }
});
