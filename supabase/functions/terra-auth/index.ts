/**
 * terra-auth — manages Terra API user authentication.
 *
 * Actions:
 *   generate  — creates a Terra widget session URL for wearable connection
 *   store     — saves the connection after successful widget auth
 *   list      — returns active connections for a person
 *   disconnect — deactivates a connection
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { logSignupError } from "../_shared/log-signup-error.ts";

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
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    const body = await req.json();
    const { action, person_id } = body;

    if (!action) {
      return json({ error: "action required" }, 400);
    }

    // ── Generate Widget Session ───────────────────────────────────────────
    if (action === "generate") {
      if (!person_id) {
        return json({ error: "person_id required" }, 400);
      }

      // Verify the person belongs to this user
      const { data: person, error: personErr } = await db
        .from("people")
        .select("id")
        .eq("id", person_id)
        .eq("user_id", user.id)
        .single();

      if (personErr || !person) {
        return json({ error: "Person not found" }, 404);
      }

      const terraApiKey = Deno.env.get("TERRA_API_KEY");
      const terraDevId = Deno.env.get("TERRA_DEV_ID");
      if (!terraApiKey || !terraDevId) {
        return json({ error: "Terra API not configured" }, 500);
      }

      // Generate widget session via Terra API
      const terraRes = await fetch("https://api.tryterra.co/v2/auth/generateWidgetSession", {
        method: "POST",
        headers: {
          "dev-id": terraDevId,
          "x-api-key": terraApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          reference_id: user.id + ":" + person_id,
          auth_success_redirect_url: "https://mywellet.com/?terra_auth=success",
          auth_failure_redirect_url: "https://mywellet.com/?terra_auth=failure",
          language: "en",
        }),
      });

      if (!terraRes.ok) {
        const errText = await terraRes.text();
        console.error("Terra generateWidgetSession error:", terraRes.status, errText);
        return json({ error: "Failed to create widget session" }, 502);
      }

      const terraData = await terraRes.json();
      return json({
        widget_url: terraData.url,
        session_id: terraData.session_id,
      });
    }

    // ── Store Connection ──────────────────────────────────────────────────
    if (action === "store") {
      const { terra_user_id, provider } = body;
      if (!person_id || !terra_user_id) {
        return json({ error: "person_id and terra_user_id required" }, 400);
      }

      // Verify the person belongs to this user
      const { data: person, error: personErr } = await db
        .from("people")
        .select("id")
        .eq("id", person_id)
        .eq("user_id", user.id)
        .single();

      if (personErr || !person) {
        return json({ error: "Person not found" }, 404);
      }

      // Upsert connection (in case of reconnection)
      const { data: conn, error: connErr } = await db
        .from("terra_connections")
        .upsert(
          {
            user_id: user.id,
            person_id: person_id,
            terra_user_id: terra_user_id,
            provider: provider || "unknown",
            status: "active",
            connected_at: new Date().toISOString(),
            disconnected_at: null,
          },
          { onConflict: "terra_user_id" },
        )
        .select()
        .single();

      if (connErr) {
        console.error("Terra store connection error:", connErr.message);
        return json({ error: "Failed to store connection" }, 500);
      }

      return json({ success: true, connection: conn });
    }

    // ── List Connections ──────────────────────────────────────────────────
    if (action === "list") {
      if (!person_id) {
        return json({ error: "person_id required" }, 400);
      }

      const { data: connections, error: listErr } = await db
        .from("terra_connections")
        .select("id, provider, status, last_data_at, connected_at")
        .eq("user_id", user.id)
        .eq("person_id", person_id)
        .order("connected_at", { ascending: false });

      if (listErr) {
        return json({ error: "Failed to list connections" }, 500);
      }

      return json({ connections: connections || [] });
    }

    // ── Disconnect ───────────────────────────────────────────────────────
    if (action === "disconnect") {
      const { connection_id } = body;
      if (!connection_id) {
        return json({ error: "connection_id required" }, 400);
      }

      // Verify ownership
      const { data: conn } = await db
        .from("terra_connections")
        .select("id, terra_user_id")
        .eq("id", connection_id)
        .eq("user_id", user.id)
        .single();

      if (!conn) {
        return json({ error: "Connection not found" }, 404);
      }

      // Deauth via Terra API
      const terraApiKey = Deno.env.get("TERRA_API_KEY");
      const terraDevId = Deno.env.get("TERRA_DEV_ID");
      if (terraApiKey && terraDevId) {
        await fetch("https://api.tryterra.co/v2/auth/deauthenticateUser", {
          method: "DELETE",
          headers: {
            "dev-id": terraDevId,
            "x-api-key": terraApiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ user_id: conn.terra_user_id }),
        }).catch((e) => console.error("Terra deauth error:", e));
      }

      // Update local status
      await db
        .from("terra_connections")
        .update({
          status: "disconnected",
          disconnected_at: new Date().toISOString(),
        })
        .eq("id", connection_id);

      return json({ success: true });
    }

    return json({ error: "Unknown action: " + action }, 400);
  } catch (e) {
    console.error("terra-auth error:", e);
    await logSignupError({
      source: 'terra-auth',
      severity: 'critical',
      error: e,
      httpStatus: 500,
      request: req,
      context: { phase: 'top_level_catch' },
    });
    return json({ error: (e as Error).message }, 500);
  }
});
