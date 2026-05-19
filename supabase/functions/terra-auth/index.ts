/**
 * terra-auth — manages Terra API user authentication.
 *
 * Actions:
 *   generate              — creates a Terra widget session URL for wearable connection (in-app, requires JWT)
 *   generate_from_invite  — creates a Terra widget session URL from a dsinvite token (no JWT — loved one may have no account)
 *   store                 — saves the connection after successful widget auth (in-app)
 *   list                  — returns active connections for a person
 *   disconnect            — deactivates a connection
 *
 * reference_id format:
 *   in-app:        "{user_id}:{person_id}"
 *   invite-driven: "invite:{token}"
 *
 * terra-webhook parses reference_id on user_auth events to route the new
 * terra_connections row to the right caregiver_user_id + person_id.
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const db = createClient(supabaseUrl, serviceKey);

    const body = await req.json();
    const { action } = body;

    if (!action) {
      return json({ error: "action required" }, 400);
    }

    // ============================================================
    // generate_from_invite — NO JWT required (loved one may have no account)
    // ============================================================
    if (action === "generate_from_invite") {
      const { invite_token, provider } = body;
      if (!invite_token) {
        return json({ error: "invite_token required" }, 400);
      }

      // Look up the invite row via service role
      const { data: invite, error: inviteErr } = await db
        .from("data_source_invites")
        .select("id, token, data_source, caregiver_user_id, person_id, expires_at, consumed_at, wearable_provider")
        .eq("token", invite_token)
        .single();

      if (inviteErr || !invite) {
        return json({ error: "Invite not found" }, 404);
      }

      if (invite.data_source !== "wearable") {
        return json({ error: "Invite is not for a wearable" }, 400);
      }

      if (invite.consumed_at) {
        return json({ error: "Invite already consumed" }, 410);
      }

      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return json({ error: "Invite expired" }, 410);
      }

      const terraApiKey = Deno.env.get("TERRA_API_KEY");
      const terraDevId = Deno.env.get("TERRA_DEV_ID");
      if (!terraApiKey || !terraDevId) {
        return json({ error: "Terra API not configured" }, 500);
      }

      // If a specific provider was passed (or the invite was created with a
      // pre-picked provider), include it to skip Terra's own picker.
      const lockedProvider = provider || invite.wearable_provider || null;

      const terraPayload: Record<string, unknown> = {
        reference_id: "invite:" + invite.token,
        auth_success_redirect_url:
          "https://mywellet.com/dsinvite?token=" + encodeURIComponent(invite.token) + "&terra_auth=success",
        auth_failure_redirect_url:
          "https://mywellet.com/dsinvite?token=" + encodeURIComponent(invite.token) + "&terra_auth=failure",
        language: "en",
      };
      if (lockedProvider) {
        terraPayload.providers = [String(lockedProvider).toUpperCase()];
      }

      const terraRes = await fetch("https://api.tryterra.co/v2/auth/generateWidgetSession", {
        method: "POST",
        headers: {
          "dev-id": terraDevId,
          "x-api-key": terraApiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(terraPayload),
      });

      if (!terraRes.ok) {
        const errText = await terraRes.text();
        console.error("Terra generateWidgetSession (invite) error:", terraRes.status, errText);
        return json({ error: "Failed to create widget session" }, 502);
      }

      const terraData = await terraRes.json();
      return json({
        widget_url: terraData.url,
        session_id: terraData.session_id,
      });
    }

    // ============================================================
    // All other actions require a JWT
    // ============================================================
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header" }, 401);
    }

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

    const { person_id } = body;

    if (action === "generate") {
      if (!person_id) {
        return json({ error: "person_id required" }, 400);
      }

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

    if (action === "store") {
      const { terra_user_id, provider } = body;
      if (!person_id || !terra_user_id) {
        return json({ error: "person_id and terra_user_id required" }, 400);
      }

      const { data: person, error: personErr } = await db
        .from("people")
        .select("id")
        .eq("id", person_id)
        .eq("user_id", user.id)
        .single();

      if (personErr || !person) {
        return json({ error: "Person not found" }, 404);
      }

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

    if (action === "disconnect") {
      const { connection_id } = body;
      if (!connection_id) {
        return json({ error: "connection_id required" }, 400);
      }

      const { data: conn } = await db
        .from("terra_connections")
        .select("id, terra_user_id")
        .eq("id", connection_id)
        .eq("user_id", user.id)
        .single();

      if (!conn) {
        return json({ error: "Connection not found" }, 404);
      }

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
