import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const ALLOWED_ORIGINS = new Set([
  "https://getwellet.com",
  "https://www.getwellet.com",
  "https://mywellet.com",
  "https://www.mywellet.com",
  "http://localhost:3000",
  "http://localhost:4000",
  "http://localhost:8080",
]);

function corsHeaders(origin: string | null) {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "https://getwellet.com";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Secret",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Vary": "Origin",
  };
}

const PATCH_ALLOWED = new Set([
  "incentive_sent",
  "selected_for_followup",
  "followup_completed",
  "followup_notes",
  "admin_tags",
]);

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("origin");
  const headers = { ...corsHeaders(origin), "Content-Type": "application/json" };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  const adminSecret = Deno.env.get("ACL_ADMIN_SECRET");
  if (!adminSecret) {
    return new Response(JSON.stringify({ error: "admin_secret_not_configured" }), { status: 500, headers });
  }
  const provided = req.headers.get("x-admin-secret");
  if (!provided || provided !== adminSecret) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (req.method === "GET") {
    const { data, error } = await sb
      .from("acl_caregiver_survey_responses")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
    const total = data?.length ?? 0;
    const optin = (data ?? []).filter((r: any) => r.followup_optin).length;
    const incentiveSent = (data ?? []).filter((r: any) => r.incentive_sent).length;
    const selectedForFollowup = (data ?? []).filter((r: any) => r.selected_for_followup).length;
    const followupDone = (data ?? []).filter((r: any) => r.followup_completed).length;
    return new Response(
      JSON.stringify({
        ok: true,
        stats: { total, optin, incentive_sent: incentiveSent, selected_for_followup: selectedForFollowup, followup_completed: followupDone },
        rows: data ?? [],
      }),
      { status: 200, headers },
    );
  }

  if (req.method === "POST") {
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400, headers });
    }
    const id = typeof body.id === "string" ? body.id : null;
    const patch = body.patch && typeof body.patch === "object" ? body.patch as Record<string, unknown> : null;
    if (!id || !patch) {
      return new Response(JSON.stringify({ error: "missing_id_or_patch" }), { status: 400, headers });
    }
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCH_ALLOWED.has(k)) continue;
      sanitized[k] = v;
    }
    if (sanitized.incentive_sent === true) {
      sanitized.incentive_sent_at = new Date().toISOString();
    }
    if (Object.keys(sanitized).length === 0) {
      return new Response(JSON.stringify({ error: "no_valid_fields" }), { status: 400, headers });
    }
    const { data, error } = await sb
      .from("acl_caregiver_survey_responses")
      .update(sanitized)
      .eq("id", id)
      .select("*")
      .single();
    if (error) {
      return new Response(JSON.stringify({ error: error.message }), { status: 500, headers });
    }
    return new Response(JSON.stringify({ ok: true, row: data }), { status: 200, headers });
  }

  return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers });
});
