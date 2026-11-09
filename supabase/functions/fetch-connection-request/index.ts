// supabase/functions/fetch-connection-request/index.ts
// Wellet Ask Mom v3.1 — public endpoint: loved one opens /approve/[token], page calls this to load the request.
// Returns sanitized payload (no PII beyond what the caregiver wrote in the note).
// Marks opened_at on first fetch. verify_jwt = false.

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
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function getCaregiverName(admin: any, userId: string): Promise<string> {
  try {
    const { data } = await admin.auth.admin.getUserById(userId);
    const u = data?.user;
    if (!u) return "Someone";
    const md = u.user_metadata || {};
    return md.full_name || md.first_name || md.name || (u.email ? u.email.split("@")[0] : "Someone");
  } catch {
    return "Someone";
  }
}

Deno.serve(async (req) => {
  const cors = getCorsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

  let token: string | null = null;
  if (req.method === "GET") {
    const url = new URL(req.url);
    token = url.searchParams.get("token");
  } else if (req.method === "POST") {
    try {
      const body = await req.json();
      token = body?.token?.toString().trim() || null;
    } catch {
      return json({ error: "Invalid JSON" }, 400, cors);
    }
  } else {
    return json({ error: "Method not allowed" }, 405, cors);
  }

  if (!token) return json({ error: "token required" }, 400, cors);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: row, error: readErr } = await admin
    .from("connection_requests")
    .select("id, caregiver_user_id, person_id, source, source_label, channel, note_body, status, sent_at, opened_at, approved_at, declined_at, expires_at, metadata")
    .eq("token", token)
    .maybeSingle();

  if (readErr) return json({ error: `db error: ${readErr.message}` }, 500, cors);
  if (!row) return json({ error: "not_found" }, 404, cors);

  const now = new Date();
  const expired = new Date(row.expires_at) < now;
  if (expired && row.status === "sent") {
    await admin.from("connection_requests").update({ status: "expired" }).eq("id", row.id);
    row.status = "expired";
  }

  const { data: person } = await admin
    .from("people")
    .select("name")
    .eq("id", row.person_id)
    .maybeSingle();

  const lovedOneName = (row.metadata?.loved_one_name as string) || person?.name || null;
  const caregiverName = await getCaregiverName(admin, row.caregiver_user_id);

  if (!row.opened_at && row.status === "sent") {
    await admin.from("connection_requests")
      .update({ opened_at: now.toISOString(), status: "opened" })
      .eq("id", row.id);
    row.opened_at = now.toISOString();
    row.status = "opened";
  }

  return json({
    token,
    status: row.status,
    source: row.source,
    source_label: row.source_label,
    channel: row.channel,
    note_body: row.note_body,
    loved_one_name: lovedOneName,
    caregiver_name: caregiverName,
    sent_at: row.sent_at,
    opened_at: row.opened_at,
    approved_at: row.approved_at,
    declined_at: row.declined_at,
    expires_at: row.expires_at,
    expired,
  }, 200, cors);
});
