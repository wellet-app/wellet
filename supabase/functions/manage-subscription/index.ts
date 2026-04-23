/**
 * manage-subscription — handles subscription management actions.
 *
 * Actions:
 *   status  — returns current subscription status for the authenticated user.
 *             On first call, auto-grants founding/early waitlist members.
 *   portal  — creates a Stripe Customer Portal session (manage billing)
 *   grant   — grants a free plan to a user (admin only, checks allowlist)
 *   revoke  — revokes a granted plan back to free
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "./_shared/cors.ts";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

// Admin users who can grant plans
const ADMIN_EMAILS = ["betsy.eble@gmail.com"];

async function stripePost(endpoint: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  return await res.json() as Record<string, unknown>;
}

/**
 * Auto-grant a founding/early waitlist member if they've signed up for the app.
 * Returns the granted subscription row, or null if no grant applied.
 */
async function autoGrantFromWaitlist(
  // deno-lint-ignore no-explicit-any
  db: any,
  userId: string,
  email: string,
) {
  if (!email) return null;
  const normalizedEmail = email.toLowerCase().trim();

  const { data: waitRow } = await db
    .from("waitlist")
    .select("reward_tier, signed_up_at")
    .ilike("email", normalizedEmail)
    .maybeSingle();

  if (!waitRow || !waitRow.reward_tier) return null;

  const tier = String(waitRow.reward_tier).toLowerCase();
  let plan: string | null = null;
  let periodEnd: string | null = null;
  let reason = "";

  if (tier === "founding") {
    plan = "connect";
    periodEnd = null; // forever
    reason = "Founding 50 member";
  } else if (tier === "early") {
    plan = "connect";
    const end = new Date();
    end.setDate(end.getDate() + 365);
    periodEnd = end.toISOString();
    reason = "Early 100 member — 12 months";
  } else if (tier === "beta") {
    plan = "supporter";
    const end = new Date();
    end.setDate(end.getDate() + 365);
    periodEnd = end.toISOString();
    reason = "Beta 250 member — 12 months";
  } else {
    return null;
  }

  const row = {
    user_id: userId,
    plan,
    status: "granted",
    source: "granted",
    granted_by: "auto-waitlist",
    granted_reason: reason,
    current_period_start: new Date().toISOString(),
    current_period_end: periodEnd,
    cancel_at_period_end: false,
    updated_at: new Date().toISOString(),
  };

  await db.from("subscriptions").upsert(row, { onConflict: "user_id" });
  return row;
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
    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } }
    );
    const { data: { user }, error: userError } = await anonClient.auth.getUser();
    if (userError || !user) return json({ error: "Unauthorized" }, 401);

    const db = createClient(supabaseUrl, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const body = await req.json();
    const { action } = body;

    // ── Status ───────────────────────────────────────────────────────
    if (action === "status") {
      let { data: sub } = await db
        .from("subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      // First-time login: check if user is a founding/early/beta waitlist member
      // and auto-grant their reward.
      if (!sub && user.email) {
        const granted = await autoGrantFromWaitlist(db, user.id, user.email);
        if (granted) {
          sub = granted;
        }
      }

      if (!sub) {
        return json({
          plan: "free",
          status: "active",
          source: "default",
          interval: null,
          cancel_at_period_end: false,
          current_period_end: null,
        });
      }

      // Check if granted plan has expired
      if (sub.source === "granted" && sub.current_period_end) {
        const endDate = new Date(sub.current_period_end);
        if (endDate < new Date()) {
          // Grant expired — revert to free
          await db.from("subscriptions").update({
            plan: "free",
            status: "active",
            source: "stripe",
            updated_at: new Date().toISOString(),
          }).eq("user_id", user.id);

          return json({
            plan: "free",
            status: "active",
            source: "expired_grant",
            interval: null,
            cancel_at_period_end: false,
            current_period_end: null,
          });
        }
      }

      return json({
        plan: sub.plan,
        status: sub.status,
        source: sub.source,
        interval: sub.interval,
        cancel_at_period_end: sub.cancel_at_period_end,
        current_period_end: sub.current_period_end,
        granted_reason: sub.granted_reason,
      });
    }

    // ── Customer Portal ────────────────────────────────────────────
    if (action === "portal") {
      const { data: sub } = await db
        .from("subscriptions")
        .select("stripe_customer_id")
        .eq("user_id", user.id)
        .single();

      if (!sub?.stripe_customer_id) {
        return json({ error: "No billing account found" }, 404);
      }

      const session = await stripePost("/billing_portal/sessions", {
        customer: sub.stripe_customer_id,
        return_url: body.return_url || "https://mywellet.com",
      });

      if (session.error) {
        return json({ error: "Failed to create portal session" }, 500);
      }

      return json({ url: session.url });
    }

    // ── Grant Plan (admin only) ────────────────────────────────────
    if (action === "grant") {
      if (!ADMIN_EMAILS.includes(user.email || "")) {
        return json({ error: "Not authorized to grant plans" }, 403);
      }

      const { target_email, plan, duration_days, reason } = body;
      if (!target_email || !plan) {
        return json({ error: "target_email and plan required" }, 400);
      }

      if (!["plus", "pro", "connect", "supporter"].includes(plan)) {
        return json({ error: "plan must be 'plus', 'pro', 'connect', or 'supporter'" }, 400);
      }

      // Find the target user
      const { data: users } = await db.auth.admin.listUsers();
      const targetUser = users?.users?.find(
        (u: { email?: string }) => u.email === target_email
      );

      if (!targetUser) {
        return json({ error: "User not found: " + target_email }, 404);
      }

      // Calculate expiry
      let periodEnd: string | null = null;
      if (duration_days && duration_days > 0) {
        const end = new Date();
        end.setDate(end.getDate() + duration_days);
        periodEnd = end.toISOString();
      }
      // duration_days = 0 or null means forever

      await db.from("subscriptions").upsert({
        user_id: targetUser.id,
        plan,
        status: "granted",
        source: "granted",
        granted_by: user.email,
        granted_reason: reason || "Manual grant",
        current_period_start: new Date().toISOString(),
        current_period_end: periodEnd,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      return json({
        success: true,
        granted: {
          email: target_email,
          plan,
          expires: periodEnd || "never",
          reason: reason || "Manual grant",
        },
      });
    }

    // ── Revoke Grant (admin only) ──────────────────────────────────
    if (action === "revoke") {
      if (!ADMIN_EMAILS.includes(user.email || "")) {
        return json({ error: "Not authorized" }, 403);
      }

      const { target_email } = body;
      if (!target_email) return json({ error: "target_email required" }, 400);

      const { data: users } = await db.auth.admin.listUsers();
      const targetUser = users?.users?.find(
        (u: { email?: string }) => u.email === target_email
      );

      if (!targetUser) {
        return json({ error: "User not found" }, 404);
      }

      await db.from("subscriptions")
        .update({
          plan: "free",
          status: "active",
          source: "stripe",
          granted_by: null,
          granted_reason: null,
          current_period_end: null,
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", targetUser.id);

      return json({ success: true, revoked: target_email });
    }

    return json({ error: "Unknown action: " + action }, 400);
  } catch (e) {
    console.error("manage-subscription error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
