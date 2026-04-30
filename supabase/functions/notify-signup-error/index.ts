// notify-signup-error: invoked by a Postgres trigger whenever a row with
// severity='critical' lands in public.signup_error_log. Sends an immediate
// email to betsy.eble@gmail.com via Brevo SMTP, mirroring the proven
// send-bug-report SMTP wiring exactly (denomailer 1.6.0, port 587, tls:false).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";

const SUPPORT_EMAIL = "betsy.eble@gmail.com";
const EXPECTED_SECRET = "qb_kV4W79wW57U9vx1VgoksvpIJ_JS6qJmUoEM-_p0w";
const DEDUPE_WINDOW_MINUTES = 30;

function escapeHtml(str: string): string {
  return (str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req) => {
  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const body = await req.json().catch(() => ({}));
    if (String((body as any).signing_secret || "") !== EXPECTED_SECRET) {
      return json({ error: "unauthorized" }, 401);
    }
    const errorId = String((body as any).error_id || "");
    if (!errorId) return json({ error: "error_id is required" }, 400);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const { data: row, error: loadErr } = await admin
      .from("signup_error_log")
      .select("*")
      .eq("id", errorId)
      .single();
    if (loadErr || !row) return json({ error: "not_found", details: loadErr?.message }, 404);

    if (row.notified_at) return json({ ok: true, skipped: "already_notified" });
    if (row.severity !== "critical") {
      await admin.from("signup_error_log")
        .update({ notification_skipped_reason: "tier_below_critical" })
        .eq("id", errorId);
      return json({ ok: true, skipped: "tier_below_critical" });
    }

    // Dedupe: skip if same source+error_code already notified in last 30 min.
    const sinceIso = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60000).toISOString();
    let dedupeQuery = admin
      .from("signup_error_log")
      .select("id")
      .eq("source", row.source)
      .eq("severity", "critical")
      .not("notified_at", "is", null)
      .gte("notified_at", sinceIso)
      .neq("id", row.id)
      .limit(1);
    dedupeQuery = row.error_code
      ? dedupeQuery.eq("error_code", row.error_code)
      : dedupeQuery.is("error_code", null);
    const { data: prior } = await dedupeQuery;
    if (prior && prior.length > 0) {
      await admin.from("signup_error_log")
        .update({ notification_skipped_reason: "deduped_within_30min" })
        .eq("id", errorId);
      return json({ ok: true, skipped: "deduped_within_30min" });
    }

    const smtpHost = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
    const smtpPort = parseInt(Deno.env.get("BREVO_SMTP_PORT") || "587", 10);
    const smtpUser = Deno.env.get("BREVO_SMTP_USER") || "";
    const smtpPass = Deno.env.get("BREVO_SMTP_KEY") || "";

    if (!smtpUser || !smtpPass) {
      await admin.from("signup_error_log")
        .update({ notification_skipped_reason: "smtp_not_configured" })
        .eq("id", errorId);
      return json({ ok: false, skipped: "smtp_not_configured" }, 500);
    }

    const client = new SMTPClient({
      connection: {
        hostname: smtpHost,
        port: smtpPort,
        tls: false,
        auth: { username: smtpUser, password: smtpPass },
      },
    });

    const subject = `Wellet signup error: ${row.source}${row.error_code ? " · " + row.error_code : ""}`;
    const ctxJson = row.context ? JSON.stringify(row.context, null, 2) : "(none)";

    const html = `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#2C2A26;line-height:1.55;"><h2 style="font-family:'DM Serif Display',Georgia,serif;color:#c0392b;margin:0 0 8px;">Signup error · ${escapeHtml(row.source)}</h2><p style="color:#6B6560;margin:0 0 24px;font-size:14px;">A critical signup-path error just fired · ${escapeHtml(row.created_at)}</p><div style="background:#F7F5F0;border-radius:12px;padding:16px 20px;margin-bottom:20px;"><p style="margin:0;white-space:pre-wrap;font-size:15px;">${escapeHtml(row.message || "")}</p></div><table style="width:100%;border-collapse:collapse;font-size:13px;color:#4a453f;"><tr><td style="padding:6px 0;width:140px;color:#8a8580;">Source</td><td><code>${escapeHtml(row.source)}</code></td></tr><tr><td style="padding:6px 0;color:#8a8580;">Severity</td><td>${escapeHtml(row.severity)}</td></tr><tr><td style="padding:6px 0;color:#8a8580;">HTTP</td><td>${escapeHtml(String(row.http_status ?? "—"))}</td></tr><tr><td style="padding:6px 0;color:#8a8580;">Error code</td><td><code>${escapeHtml(row.error_code ?? "—")}</code></td></tr><tr><td style="padding:6px 0;color:#8a8580;">User</td><td>${escapeHtml(row.user_email ?? row.user_id ?? "—")}</td></tr><tr><td style="padding:6px 0;color:#8a8580;">Request ID</td><td><code>${escapeHtml(row.request_id ?? "—")}</code></td></tr><tr><td style="padding:6px 0;color:#8a8580;">Log row id</td><td style="font-family:monospace;">${escapeHtml(row.id)}</td></tr></table><h3 style="margin:24px 0 4px;font-family:'DM Serif Display',Georgia,serif;">Context</h3><pre style="background:#F7F5F0;padding:12px;border-radius:6px;white-space:pre-wrap;word-break:break-word;font-size:12px">${escapeHtml(ctxJson)}</pre><p style="margin-top:32px;color:#8a8580;font-size:12px;">Dedupe window ${DEDUPE_WINDOW_MINUTES}m · key ${escapeHtml(row.source)}|${escapeHtml(row.error_code ?? "")}</p></body></html>`;

    const textBody = [
      "WELLET SIGNUP ERROR",
      "",
      "Source:     " + row.source,
      "Severity:   " + row.severity,
      "When:       " + row.created_at,
      "HTTP:       " + (row.http_status ?? "—"),
      "Error code: " + (row.error_code ?? "—"),
      "User:       " + (row.user_email ?? row.user_id ?? "—"),
      "Request ID: " + (row.request_id ?? "—"),
      "",
      "Message:",
      row.message || "",
      "",
      "Context:",
      ctxJson,
      "",
      "Log row id: " + row.id,
    ].join("\n");

    try {
      await client.send({
        from: "Wellet Alerts <notifications@mywellet.com>",
        to: SUPPORT_EMAIL,
        subject,
        content: textBody,
        html,
      });
      await client.close();
    } catch (mailErr) {
      console.error("notify-signup-error mail send failed:", mailErr);
      await admin.from("signup_error_log")
        .update({ notification_skipped_reason: "smtp_send_failed: " + String(mailErr).slice(0, 200) })
        .eq("id", errorId);
      return json({ error: "send_failed", details: String(mailErr) }, 500);
    }

    await admin.from("signup_error_log")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", errorId);

    return json({ ok: true, notified: true });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("notify-signup-error error:", msg);
    return json({ error: "internal_error", details: msg }, 500);
  }
});
