// supabase/functions/approve-connection-request/index.ts
// Wellet Ask Mom v3.2 — loved one taps Approve (or Decline) on /approve/[token].
// v3.2 PATH A BRIDGE: on approved, mints a data_source_invites row via
// data-source-invite?action=create_from_approval and returns redirect_url so
// the browser hands off into the existing mywellet.com/?dsinvite={token}
// OAuth flow.
// verify_jwt = false (public, by token).

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

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "*";
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

const SOURCE_LABELS: Record<string, string> = {
  hospital: "hospital records",
  va: "VA records",
  wearable: "wearable data",
  google_health: "Google Health",
  document: "document upload",
  apple_health: "Apple Health",
};

// v3.2: Map connection_requests.source → data_source_invites.data_source.
// hospital / va → 'ehr' (FHIR OAuth via epic-auth / etc.)
// wearable     → 'wearable' (Terra OAuth)
// google_health, document → no clean dsinvite mapping; skip bridge (caller
//   will just see the approved notification and open Wellet directly).
// apple_health → BLOCKED per v3.2 constraint (Wellet Connect iOS only).
function mapSourceToDataSource(source: string): { dataSource: "ehr" | "wearable" | null; skip: boolean; reason?: string } {
  const s = (source || "").toLowerCase();
  if (s === "hospital" || s === "va") return { dataSource: "ehr", skip: false };
  if (s === "wearable") return { dataSource: "wearable", skip: false };
  if (s === "document") return { dataSource: null, skip: true, reason: "document_upload_no_oauth" };
  if (s === "google_health") return { dataSource: null, skip: true, reason: "google_health_no_dsinvite_path_yet" };
  if (s === "apple_health") return { dataSource: null, skip: true, reason: "apple_health_uses_wellet_connect_ios" };
  return { dataSource: null, skip: true, reason: "unknown_source" };
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
    await client.send({ from: `${fromName} <${fromAddr}>`, to, subject, content: plaintext, html });
    await client.close();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

async function insertNotificationWithFallback(admin: any, payload: any): Promise<{ ok: boolean; error?: string }> {
  let { error } = await admin.from("notifications").insert(payload);
  if (error && /type/i.test(error.message)) {
    const fallback = { ...payload, type: "care_circle" };
    const r2 = await admin.from("notifications").insert(fallback);
    if (r2.error) return { ok: false, error: r2.error.message };
    return { ok: true };
  }
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// v3.2 Path A: call data-source-invite?action=create_from_approval with
// service-role auth to mint a dsinvite row. Best-effort — failures don't
// block approval, they just mean we won't have a redirect_url and the user
// will see the standard approved screen.
async function mintDsinvite(opts: {
  row: any;
  dataSource: "ehr" | "wearable";
}): Promise<{ ok: boolean; token?: string; id?: string; link?: string; error?: string }> {
  try {
    const payload: Record<string, any> = {
      action: "create_from_approval",
      person_id: opts.row.person_id,
      caregiver_user_id: opts.row.caregiver_user_id,
      data_source: opts.dataSource,
      hospital_name: opts.row.source_label || null,
      fhir_base_url: opts.row.metadata?.fhir_base_url || null,
      target_contact: opts.row.recipient || null,
      origin_connection_request_id: opts.row.id,
    };
    if (opts.dataSource === "wearable" && opts.row.metadata?.wearable_provider) {
      payload.wearable_provider = opts.row.metadata.wearable_provider;
    }
    const res = await fetch(`${SUPABASE_URL}/functions/v1/data-source-invite`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify(payload),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j?.ok) {
      return { ok: false, error: j?.error || `http_${res.status}` };
    }
    return { ok: true, token: j.invite_token, id: j.invite_id, link: j.invite_link };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, cors);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400, cors); }

  const token = body?.token?.toString().trim();
  const decision = (body?.decision?.toString().trim() || "approved").toLowerCase();

  if (!token) return json({ error: "token required" }, 400, cors);
  if (decision !== "approved" && decision !== "declined") {
    return json({ error: "decision must be 'approved' or 'declined'" }, 400, cors);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: row, error: readErr } = await admin
    .from("connection_requests")
    .select("id, caregiver_user_id, person_id, source, source_label, channel, status, expires_at, metadata, recipient")
    .eq("token", token)
    .maybeSingle();
  if (readErr) return json({ error: `db error: ${readErr.message}` }, 500, cors);
  if (!row) return json({ error: "not_found" }, 404, cors);

  if (new Date(row.expires_at) < new Date()) {
    return json({ error: "expired" }, 410, cors);
  }
  if (row.status === "approved" || row.status === "declined") {
    return json({ error: `already ${row.status}` }, 409, cors);
  }

  const now = new Date().toISOString();
  const updates: Record<string, any> = { status: decision };
  if (decision === "approved") updates.approved_at = now;
  if (decision === "declined") updates.declined_at = now;

  const { error: updErr } = await admin.from("connection_requests").update(updates).eq("id", row.id);
  if (updErr) return json({ error: `update failed: ${updErr.message}` }, 500, cors);

  // v3.2 PATH A: on approval, mint a dsinvite for the matching data source
  // so the browser can be redirected into the existing OAuth handoff.
  let redirectUrl: string | null = null;
  let dsinviteResult: any = { skipped: true };
  if (decision === "approved") {
    const mapping = mapSourceToDataSource(row.source);
    if (mapping.skip) {
      dsinviteResult = { skipped: true, reason: mapping.reason };
    } else if (mapping.dataSource) {
      const minted = await mintDsinvite({ row, dataSource: mapping.dataSource });
      if (minted.ok && minted.token && minted.link) {
        redirectUrl = minted.link;
        dsinviteResult = { ok: true, dsinvite_id: minted.id, dsinvite_token: minted.token, link: minted.link };
        // Persist the bridge link on the connection_request row.
        await admin
          .from("connection_requests")
          .update({ dsinvite_id: minted.id, dsinvite_token: minted.token })
          .eq("id", row.id);
      } else {
        dsinviteResult = { ok: false, error: minted.error };
      }
    }
  }

  // Load caregiver email + person name for notification + email
  const { data: caregiverData } = await admin.auth.admin.getUserById(row.caregiver_user_id);
  const caregiverEmail = caregiverData?.user?.email || null;
  const md = caregiverData?.user?.user_metadata || {};
  const caregiverFirstName = md.first_name || md.full_name?.split(" ")[0] || (caregiverEmail ? caregiverEmail.split("@")[0] : "there");

  const { data: person } = await admin.from("people").select("name").eq("id", row.person_id).maybeSingle();
  const lovedOneName = (row.metadata?.loved_one_name as string) || person?.name || "your loved one";
  const sourceWhat = row.source_label || SOURCE_LABELS[row.source] || row.source;

  // In-app notification
  const notifBody = decision === "approved"
    ? `${lovedOneName} said yes to connecting ${sourceWhat}. We'll take it from here.`
    : `${lovedOneName} declined the request to connect ${sourceWhat}. No worries — you can try again or send a different note.`;

  await insertNotificationWithFallback(admin, {
    user_id: row.caregiver_user_id,
    person_id: row.person_id,
    type: "invite_consumed",
    title: decision === "approved" ? `${lovedOneName} approved` : `${lovedOneName} declined`,
    body: notifBody,
    read: false,
  });

  // Email caregiver (best-effort)
  let emailResult: any = { skipped: true };
  if (caregiverEmail) {
    const subject = decision === "approved"
      ? `${lovedOneName} approved your request`
      : `${lovedOneName} declined your request`;
    const plaintext = `Hi ${caregiverFirstName},\n\n${notifBody}\n\nOpen Wellet to see what's next:\nhttps://mywellet.com\n\n\u2014 Wellet`;
    const html = `<!DOCTYPE html><html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 560px; margin: 0 auto; padding: 32px 20px; color: #1a1a1a; line-height: 1.6;">
<div style="font-size: 17px;">Hi ${caregiverFirstName},</div>
<div style="font-size: 16px; margin-top: 16px;">${notifBody}</div>
<div style="margin: 32px 0;">
  <a href="https://mywellet.com" style="background: #0a0a0a; color: #fff; text-decoration: none; padding: 14px 28px; border-radius: 8px; font-weight: 600; display: inline-block;">Open Wellet</a>
</div>
<div style="font-size: 12px; color: #999; margin-top: 24px;">\u2014 Wellet</div>
</body></html>`;
    emailResult = await sendBrevoEmail(caregiverEmail, subject, plaintext, html);
  }

  return json({
    ok: true,
    token,
    status: decision,
    timestamp: now,
    notification_inserted: true,
    email_result: emailResult,
    redirect_url: redirectUrl,
    dsinvite: dsinviteResult,
  }, 200, cors);
});
