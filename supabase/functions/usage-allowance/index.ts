// usage-allowance — read-only. Tells the app where a caregiver stands on the
// free plan so it can show "3 of 5 free questions left" before they ask.
// Never blocks anything itself; the AI functions enforce the limits.
//
// POST { person_id?: string }
// -> { enforced, plan, ask, document_read, home_summary? }

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkAllowance, limitsEnforced } from "./allowance.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return json({ error: "Unauthorized" }, 401);

    let personId: string | null = null;
    try {
      const body = await req.json();
      if (typeof body?.person_id === "string") personId = body.person_id;
    } catch (_) { /* empty body is fine */ }

    // Only report on a loved one this caregiver can read (RLS decides).
    if (personId) {
      const { data } = await supabase.from("people").select("id").eq("id", personId).maybeSingle();
      if (!data) personId = null;
    }

    const [ask, documentRead, summary] = await Promise.all([
      checkAllowance(user.id, "ask"),
      checkAllowance(user.id, "document_read"),
      personId ? checkAllowance(user.id, "home_summary", personId) : Promise.resolve(null),
    ]);

    return json({
      enforced: limitsEnforced(),
      plan: ask.plan,
      ask,
      document_read: documentRead,
      home_summary: summary,
    });
  } catch (e) {
    return json({ error: "Could not read allowance", details: String(e) }, 500);
  }
});
