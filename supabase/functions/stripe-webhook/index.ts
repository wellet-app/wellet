/**
 * stripe-webhook — handles Stripe webhook events for subscription lifecycle.
 *
 * Events handled:
 *   - checkout.session.completed — new subscription created
 *   - customer.subscription.updated — plan change, renewal, payment method update
 *   - customer.subscription.deleted — subscription canceled
 *   - invoice.payment_succeeded — successful renewal
 *   - invoice.payment_failed — payment failure
 *
 * No JWT required — Stripe calls this directly. Verified via webhook signature.
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";

const encoder = new TextEncoder();

// ── Stripe signature verification ─────────────────────────────────────
async function verifyStripeSignature(rawBody: string, sigHeader: string): Promise<boolean> {
  if (!sigHeader || !STRIPE_WEBHOOK_SECRET) return false;

  const parts: Record<string, string> = {};
  for (const pair of sigHeader.split(",")) {
    const [key, val] = pair.split("=", 2);
    if (key && val) parts[key.trim()] = val.trim();
  }

  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  // Check timestamp freshness (5 min tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const signedPayload = timestamp + "." + rawBody;
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));
  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return diff === 0;
}

// ── Price ID to plan mapping ─────────────────────────────────────────
const PRICE_TO_PLAN: Record<string, { plan: string; interval: string }> = {
  "price_1TNJEkQk7RCcdO4CnH8kmhqX": { plan: "plus", interval: "monthly" },
  "price_1TNJEkQk7RCcdO4CO7oK9fje": { plan: "plus", interval: "annual" },
  "price_1TNJEkQk7RCcdO4CUxM7DeVN": { plan: "pro", interval: "monthly" },
  "price_1TNJElQk7RCcdO4Ca4Qsbg6U": { plan: "pro", interval: "annual" },
};

function getPlanFromPriceId(priceId: string): { plan: string; interval: string } {
  return PRICE_TO_PLAN[priceId] || { plan: "free", interval: "monthly" };
}

// ── Stripe API helper ─────────────────────────────────────────────
async function stripeGet(endpoint: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.stripe.com/v1${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
  });
  return await res.json() as Record<string, unknown>;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "stripe-signature, content-type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";

  // Verify webhook signature
  const verified = await verifyStripeSignature(rawBody, sigHeader);
  if (!verified) {
    console.warn("Stripe webhook: signature verification failed");
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400 });
  }

  const db = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const eventType = event.type as string;
  const obj = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;

  console.log(`Stripe webhook: ${eventType}`);

  try {
    // ── Checkout completed ──────────────────────────────────────────
    if (eventType === "checkout.session.completed") {
      const metadata = obj.metadata as Record<string, string> | undefined;
      const userId = metadata?.supabase_user_id;
      const subscriptionId = obj.subscription as string;
      const customerId = obj.customer as string;

      if (!userId || !subscriptionId) {
        console.warn("Checkout completed but missing userId or subscriptionId");
        return new Response(JSON.stringify({ received: true }), { status: 200 });
      }

      // Fetch the subscription to get the price/plan details
      const sub = await stripeGet(`/subscriptions/${subscriptionId}`);
      const items = sub.items as Record<string, unknown>;
      const data = (items?.data as Record<string, unknown>[]) || [];
      const priceId = data.length > 0
        ? ((data[0].price as Record<string, string>)?.id || "")
        : "";
      const { plan, interval } = getPlanFromPriceId(priceId);

      const currentPeriodStart = sub.current_period_start
        ? new Date((sub.current_period_start as number) * 1000).toISOString()
        : null;
      const currentPeriodEnd = sub.current_period_end
        ? new Date((sub.current_period_end as number) * 1000).toISOString()
        : null;

      await db.from("subscriptions").upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        plan,
        interval,
        status: "active",
        source: "stripe",
        current_period_start: currentPeriodStart,
        current_period_end: currentPeriodEnd,
        cancel_at_period_end: false,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });

      console.log(`Subscription activated: ${userId} -> ${plan} (${interval})`);
    }

    // ── Subscription updated ────────────────────────────────────────
    else if (eventType === "customer.subscription.updated") {
      const subId = obj.id as string;
      const customerId = obj.customer as string;
      const status = obj.status as string;
      const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean;

      const items = obj.items as Record<string, unknown>;
      const data = (items?.data as Record<string, unknown>[]) || [];
      const priceId = data.length > 0
        ? ((data[0].price as Record<string, string>)?.id || "")
        : "";
      const { plan, interval } = getPlanFromPriceId(priceId);

      const currentPeriodEnd = obj.current_period_end
        ? new Date((obj.current_period_end as number) * 1000).toISOString()
        : null;

      // Map Stripe status to our status
      let ourStatus = "active";
      if (status === "past_due") ourStatus = "past_due";
      else if (status === "canceled" || status === "unpaid") ourStatus = "canceled";
      else if (status === "trialing") ourStatus = "trialing";

      await db.from("subscriptions")
        .update({
          plan,
          interval,
          status: ourStatus,
          cancel_at_period_end: cancelAtPeriodEnd,
          current_period_end: currentPeriodEnd,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subId);

      console.log(`Subscription updated: ${subId} -> ${plan} (${ourStatus})`);
    }

    // ── Subscription deleted ────────────────────────────────────────
    else if (eventType === "customer.subscription.deleted") {
      const subId = obj.id as string;

      await db.from("subscriptions")
        .update({
          plan: "free",
          status: "canceled",
          cancel_at_period_end: false,
          updated_at: new Date().toISOString(),
        })
        .eq("stripe_subscription_id", subId);

      console.log(`Subscription canceled: ${subId}`);
    }

    // ── Invoice payment failed ──────────────────────────────────────
    else if (eventType === "invoice.payment_failed") {
      const customerId = obj.customer as string;
      const subId = obj.subscription as string;

      if (subId) {
        await db.from("subscriptions")
          .update({
            status: "past_due",
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subId);

        console.log(`Payment failed for subscription: ${subId}`);
      }
    }

    // ── Invoice payment succeeded (renewal) ───────────────────────
    else if (eventType === "invoice.payment_succeeded") {
      const subId = obj.subscription as string;
      if (subId) {
        // Re-fetch subscription to get updated period
        const sub = await stripeGet(`/subscriptions/${subId}`);
        const currentPeriodEnd = sub.current_period_end
          ? new Date((sub.current_period_end as number) * 1000).toISOString()
          : null;

        await db.from("subscriptions")
          .update({
            status: "active",
            current_period_end: currentPeriodEnd,
            updated_at: new Date().toISOString(),
          })
          .eq("stripe_subscription_id", subId);

        console.log(`Payment succeeded for subscription: ${subId}`);
      }
    }
  } catch (e) {
    console.error(`Error processing ${eventType}:`, e);
    // Still return 200 so Stripe doesn't retry
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
