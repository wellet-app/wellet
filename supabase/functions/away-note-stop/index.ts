// away-note-stop: one-click stop for the monthly quiet-mode note (2026-10-21).
//
// The token is signed, so no sign-in is needed. It only turns away_note off for
// the user it was signed for. It cannot read data or change anything else.
//
// POST ?t=<token>           RFC 8058 one-click (Gmail / Apple Mail "Unsubscribe")
// POST {"t": "<token>"}     getwellet.com/stop page button
// GET  ?t=<token>           redirects to getwellet.com/stop?t=<token> (a page with a
//                           button), so link scanners that prefetch GETs never stop it.
//
// Deploy with verify_jwt = false. The HMAC token is the authorization.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STOP_PAGE = "https://getwellet.com/stop";
const ALLOWED_ORIGINS = new Set(["https://getwellet.com", "https://www.getwellet.com"]);

function cors(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { "Vary": "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    h["Access-Control-Allow-Origin"] = origin;
    h["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    h["Access-Control-Allow-Headers"] = "content-type";
  }
  return h;
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 ? "=".repeat(4 - (s.length % 4)) : "";
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function verify(token: string): Promise<string | null> {
  const [u, sig] = token.split(".");
  if (!u || !sig) return null;
  let userId: string;
  try { userId = new TextDecoder().decode(b64urlDecode(u)); } catch { return null; }
  if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SERVICE_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  let sigBytes: Uint8Array;
  try { sigBytes = b64urlDecode(sig); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", key, sigBytes, new TextEncoder().encode("away_note_stop:v1:" + userId));
  return ok ? userId : null;
}

function json(body: unknown, status: number, extra: Record<string, string>) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const origin = req.headers.get("origin");
  const h = cors(origin);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });

  if (req.method === "GET") {
    const t = url.searchParams.get("t") || "";
    return new Response(null, { status: 302, headers: { Location: `${STOP_PAGE}?t=${encodeURIComponent(t)}` } });
  }

  if (req.method !== "POST") return json({ status: "error", reason: "method" }, 405, h);

  let token = url.searchParams.get("t") || "";
  let check = false;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    try {
      const body = await req.json();
      if (!token) token = String(body?.t || "");
      check = body?.check === true;
    } catch { /* empty */ }
  }

  const userId = token ? await verify(token) : null;
  if (!userId) return json({ status: "error", reason: "invalid_link" }, 400, h);
  // {"check": true} confirms a link is valid without stopping anything (used for testing).
  if (check) return json({ status: "valid" }, 200, h);

  const svc = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const { error } = await svc.from("notification_preferences").update({ away_note: false }).eq("user_id", userId);
  if (error) return json({ status: "error", reason: "update_failed" }, 500, h);

  return json({ status: "stopped" }, 200, h);
});
