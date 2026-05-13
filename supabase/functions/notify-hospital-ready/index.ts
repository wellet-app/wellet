// notify-hospital-ready
// Closes the loop on a hospital_connect_requests row by emailing the user
// that their hospital is now available in Wellet, then flipping the row to
// status='resolved' so it doesn't get double-sent.
//
// Protected by service_role key (mirroring manage-allowlist) — only Betsy
// or automation can call this. Mistakes are reversible: status flip is in
// the same function and the email content is logged in triage_notes.
//
// POST body:
//   {
//     "request_id": "uuid",       // required
//     "preview": true | false,    // optional, default false — if true, returns
//                                 // the rendered email html and does NOT send.
//     "force": true | false       // optional, default false — if true, will
//                                 // send even if the row is already resolved
//                                 // (use if the first email bounced).
//   }
//
// Success response: { success: true, sent_to: "...", request_id: "..." }
// Idempotency: if status is already 'resolved' and force is not set, returns
// { skipped: true, reason: "already_resolved" } with HTTP 200.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

// Same verified sender as submit-connect-request — mywellet.com is not
// domain-auth'd in Brevo yet, so we send from hello@getwellet.com and set
// Reply-To: betsy@getwellet.com so user replies land in Betsy's inbox.
const FROM_ADDRESS = "Wellet <hello@getwellet.com>";
const REPLY_TO = "Betsy at Wellet <betsy@getwellet.com>";

function escHtml(s: string): string {
  return (s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Service-role-only auth. We do NOT want any logged-in user to be able
    // to mark requests resolved or fire emails — that's an admin action.
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "missing_authorization" }, 401);
    }
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (token !== serviceKey) {
      return json({ error: "forbidden_service_role_required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const requestId: string | null = typeof body.request_id === "string"
      ? body.request_id.trim()
      : null;
    const preview: boolean = body.preview === true;
    const force: boolean = body.force === true;

    if (!requestId) {
      return json({ error: "request_id is required" }, 400);
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Pull the request row.
    const { data: row, error: fetchErr } = await admin
      .from("hospital_connect_requests")
      .select(
        "id, user_id, hospital_name, city, state, contact_email, status, resolved_at, created_at",
      )
      .eq("id", requestId)
      .maybeSingle();

    if (fetchErr) {
      console.error("[notify-hospital-ready] fetch error", fetchErr);
      return json({ error: "could_not_fetch_request" }, 500);
    }
    if (!row) {
      return json({ error: "request_not_found", request_id: requestId }, 404);
    }

    // Idempotency: don't double-send unless force=true.
    if (row.status === "resolved" && !force) {
      return json({
        skipped: true,
        reason: "already_resolved",
        resolved_at: row.resolved_at,
        request_id: row.id,
      });
    }

    // Resolve recipient. Prefer contact_email on the row (what the user typed
    // into the form). If that's missing or invalid, fall back to the auth.users
    // email for the user_id on the row. If neither exists, return a 422 so
    // Betsy can manually email them from triage.
    let recipient: string | null = null;
    let recipientSource: "form" | "auth" = "form";
    if (row.contact_email && isValidEmail(row.contact_email)) {
      recipient = row.contact_email;
    } else if (row.user_id) {
      const { data: authUser, error: authErr } = await admin
        .auth.admin.getUserById(row.user_id);
      if (authErr) {
        console.warn("[notify-hospital-ready] auth lookup failed", authErr);
      }
      const email = authUser?.user?.email;
      if (email && isValidEmail(email)) {
        recipient = email;
        recipientSource = "auth";
      }
    }
    if (!recipient) {
      return json({
        error: "no_valid_recipient",
        message:
          "Neither contact_email on the row nor the auth user has a usable email. Reach out manually.",
        request_id: row.id,
      }, 422);
    }

    const html = buildEmailHtml({
      hospital_name: row.hospital_name,
      city: row.city,
      state: row.state,
    });
    const subject = `Your hospital is on Wellet: ${row.hospital_name}`;

    if (preview) {
      return json({
        preview: true,
        recipient,
        recipient_source: recipientSource,
        subject,
        html,
        request: {
          id: row.id,
          hospital_name: row.hospital_name,
          city: row.city,
          state: row.state,
          status: row.status,
          created_at: row.created_at,
        },
      });
    }

    // Send via the same Brevo SMTP creds as submit-connect-request.
    const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
    const smtpPort = 465;
    const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
    const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";

    if (!smtpUser || !smtpPass) {
      console.error("[notify-hospital-ready] SMTP creds missing — cannot send");
      return json({ error: "smtp_not_configured" }, 500);
    }

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
        to: recipient,
        replyTo: REPLY_TO,
        subject,
        content: "auto",
        html,
      });
      await client.close();
    } catch (e) {
      console.error("[notify-hospital-ready] email send failed", e);
      return json({
        error: "email_send_failed",
        detail: String(e?.message || e),
        request_id: row.id,
      }, 502);
    }

    // Email sent — flip the row. We don't fail the request if this update
    // errors; the email already went out, and Betsy can clean up by hand.
    const triageStamp =
      `[${new Date().toISOString()}] notify-hospital-ready sent to ${recipient}` +
      (recipientSource === "auth" ? " (auth fallback)" : "") +
      (force ? " (force=true)" : "");
    const { error: updErr } = await admin
      .from("hospital_connect_requests")
      .update({
        status: "resolved",
        resolved_at: new Date().toISOString(),
        triage_notes: row.triage_notes
          ? `${row.triage_notes}\n${triageStamp}`
          : triageStamp,
        updated_at: new Date().toISOString(),
      } as Record<string, unknown>)
      .eq("id", row.id);
    if (updErr) {
      console.warn("[notify-hospital-ready] update failed (email already sent)", updErr);
    }

    return json({
      success: true,
      sent_to: recipient,
      recipient_source: recipientSource,
      request_id: row.id,
      hospital_name: row.hospital_name,
    });
  } catch (e) {
    console.error("[notify-hospital-ready] unexpected error", e);
    return json({ error: "internal_error", detail: String((e as Error)?.message || e) }, 500);
  }
});

function buildEmailHtml(fields: {
  hospital_name: string;
  city: string | null;
  state: string | null;
}): string {
  const location = [fields.city, fields.state].filter(Boolean).join(", ");
  // Editorial, kind, short. Matches the rest of Wellet's voice — "watches for",
  // "loved one", and no "track/monitor/parent".
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:white;border-radius:16px;padding:32px;">
      <div style="font-family:'DM Serif Display',Georgia,serif;font-size:24px;color:#608F7C;margin-bottom:24px;">Wellet</div>
      <div style="font-size:20px;font-weight:600;color:#1a1a1a;margin-bottom:16px;line-height:1.3;">
        Good news — ${escHtml(fields.hospital_name)} is on Wellet.
      </div>
      <div style="font-size:15px;color:#333;line-height:1.6;margin-bottom:20px;">
        You asked us to add <strong>${escHtml(fields.hospital_name)}</strong>${location ? ` in ${escHtml(location)}` : ""} so you could connect your loved one&rsquo;s chart. It&rsquo;s ready now.
      </div>
      <div style="font-size:15px;color:#333;line-height:1.6;margin-bottom:24px;">
        Here&rsquo;s how to try it:
      </div>
      <ol style="font-size:15px;color:#333;line-height:1.7;padding-left:20px;margin:0 0 28px;">
        <li>Open <a href="https://mywellet.com" style="color:#608F7C;">mywellet.com</a> on your phone or laptop.</li>
        <li>Sign in with the email you used before.</li>
        <li>Tap <strong>+ Add a chart</strong> and search for <strong>${escHtml(fields.hospital_name)}</strong>.</li>
        <li>Sign in with your patient portal when prompted.</li>
      </ol>
      <div style="font-size:15px;color:#333;line-height:1.6;margin-bottom:24px;">
        If anything looks off — wrong hospital, login that won&rsquo;t go through, records that don&rsquo;t come across — just reply to this email. It goes straight to me.
      </div>
      <div style="font-size:15px;color:#333;line-height:1.6;margin-bottom:8px;">
        Thanks for waiting.
      </div>
      <div style="font-size:15px;color:#333;line-height:1.6;">
        — Betsy
      </div>
      <hr style="border:none;border-top:1px solid #eee;margin:32px 0 16px;">
      <div style="font-size:11px;color:#999;text-align:center;line-height:1.6;">
        Wellet · health that pays attention<br>
        You&rsquo;re receiving this because you asked us to add your hospital. We don&rsquo;t send marketing email.
      </div>
    </div>
  </div>
</body>
</html>`;
}
