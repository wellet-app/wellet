/**
 * create-checkout-session — creates a Stripe Checkout session for subscription upgrades.
 *
 * Accepts: { price_id: string, success_url?: string, cancel_url?: string,
 *           promo_code?: string, trial_period_days?: number }
 * Returns: { url: string } — the Stripe Checkout URL to redirect the user to
 *
 * trial_period_days is opt-in per request. /me checkout sends 30; Plus/Pro do not
 * send it and continue to charge immediately. Card is collected on day 0 in both
 * flows; with a trial set, Stripe defers the first charge until trial expiry and
 * auto-charges on renewal.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "./_shared/cors.ts";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";

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
    // Authenticate
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
    const { price_id, promo_code, trial_period_days } = body;

    if (!price_id) return json({ error: "price_id required" }, 400);

    // Check if user already has a Stripe customer ID
    const { data: existingSub } = await db
      .from("subscriptions")
      .select("stripe_customer_id")
      .eq("user_id", user.id)
      .single();

    let customerId = existingSub?.stripe_customer_id;

    // Create Stripe customer if needed
    if (!customerId) {
      const customer = await stripePost("/customers", {
        email: user.email || "",
        "metadata[supabase_user_id]": user.id,
      });
      customerId = customer.id as string;

      // Upsert subscription record with customer ID
      await db.from("subscriptions").upsert({
        user_id: user.id,
        stripe_customer_id: customerId,
        plan: "free",
        status: "active",
        source: "stripe",
      }, { onConflict: "user_id" });
    }

    // Build checkout session params
    const sessionParams: Record<string, string> = {
      customer: customerId,
      "line_items[0][price]": price_id,
      "line_items[0][quantity]": "1",
      mode: "subscription",
      success_url: body.success_url || "https://mywellet.com?billing=success",
      cancel_url: body.cancel_url || "https://mywellet.com?billing=canceled",
      "subscription_data[metadata][supabase_user_id]": user.id,
      "metadata[supabase_user_id]": user.id,
    };

    // Optional trial. Only honored when sent by the client (currently /me only).
    // Clamped to 1..730 (Stripe's allowed range). Anything else is ignored.
    if (trial_period_days !== undefined && trial_period_days !== null) {
      const t = Number(trial_period_days);
      if (Number.isFinite(t) && t >= 1 && t <= 730) {
        sessionParams["subscription_data[trial_period_days]"] = String(Math.floor(t));
        // Card required up front so we can auto-charge on day 31. Without this,
        // Stripe defaults to charging only if a payment method is collected,
        // which makes the conversion accidental on long trials.
        sessionParams["payment_method_collection"] = "always";
      }
    }

    // Add promo code if provided
    if (promo_code) {
      sessionParams.allow_promotion_codes = "true";
    }

    const session = await stripePost("/checkout/sessions", sessionParams);

    if (session.error) {
      console.error("Stripe checkout error:", session.error);
      return json({ error: "Failed to create checkout session" }, 500);
    }

    return json({ url: session.url });
  } catch (e) {
    console.error("create-checkout-session error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
