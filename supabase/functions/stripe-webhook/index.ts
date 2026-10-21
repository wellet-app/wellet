/**
 * stripe-webhook: handles Stripe webhook events for subscription lifecycle.
 *
 * Events handled:
 *   - checkout.session.completed: new subscription created
 *   - customer.subscription.updated / .deleted
 *   - invoice.payment_succeeded / .payment_failed
 *
 * No JWT. Stripe calls this directly; every request is signature-verified.
 *
 * v17 (2026-10-21) safety changes:
 *   - Event ledger: every event.id is recorded in stripe_webhook_events
 *     (PRIMARY KEY) before any write. An event already processed is skipped.
 *   - Retries: if processing fails, the event is marked failed and Stripe gets
 *     a 500, so it retries. Before, errors returned 200 and were lost.
 *   - Order: subscription state is always re-read from the Stripe API, so an
 *     older event arriving late cannot roll a plan back.
 *   - Signature: any v1 signature in the header is accepted (secret rotation).
 *   - Unknown price IDs fail loudly instead of silently becoming "free".
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") || "";
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
const STRIPE_API_BASE = Deno.env.get("STRIPE_API_BASE") || "https://api.stripe.com/v1";
const PROCESSING_STALE_MS = 2 * 60 * 1000;

const encoder = new TextEncoder();

// ── Stripe signature verification ─────────────────────────────────────
async function verifyStripeSignature(rawBody: string, sigHeader: string): Promise<boolean> {
  if (!sigHeader || !STRIPE_WEBHOOK_SECRET) return false;

  let timestamp = "";
  const signatures: string[] = [];
  for (const pair of sigHeader.split(",")) {
    const idx = pair.indexOf("=");
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key === "t") timestamp = val;
    else if (key === "v1" && val) signatures.push(val);
  }
  if (!timestamp || signatures.length === 0) return false;

  // Timestamp freshness (5 min tolerance)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - parseInt(timestamp, 10)) > 300) return false;

  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(STRIPE_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(timestamp + "." + rawBody));
  const expected = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");

  let ok = false;
  for (const sig of signatures) {
    if (sig.length !== expected.length) continue;
    let diff = 0;
    for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
    if (diff === 0) ok = true;
  }
  return ok;
}

// ── Price ID to plan mapping ─────────────────────────────────────────
const PRICE_TO_PLAN: Record<string, { plan: string; interval: string }> = {
  "price_1TNJEkQk7RCcdO4CnH8kmhqX": { plan: "plus", interval: "monthly" },
  "price_1TNJEkQk7RCcdO4CO7oK9fje": { plan: "plus", interval: "annual" },
  "price_1TNJEkQk7RCcdO4CUxM7DeVN": { plan: "pro", interval: "monthly" },
  "price_1TNJElQk7RCcdO4Ca4Qsbg6U": { plan: "pro", interval: "annual" },
};

function getPlanFromPriceId(priceId: string): { plan: string; interval: string } {
  const mapped = PRICE_TO_PLAN[priceId];
  if (!mapped) throw new Error(`unmapped_price:${priceId || "none"}`);
  return mapped;
}

// ── Stripe API helper ─────────────────────────────────────────────
async function stripeGet(endpoint: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${STRIPE_API_BASE}${endpoint}`, {
    headers: { "Authorization": `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const body = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(`stripe_get_${res.status}`);
  return body;
}

function iso(sec: unknown): string | null {
  return typeof sec === "number" ? new Date(sec * 1000).toISOString() : null;
}

function mapStatus(stripeStatus: string): string {
  if (stripeStatus === "past_due") return "past_due";
  if (stripeStatus === "canceled" || stripeStatus === "unpaid" || stripeStatus === "incomplete_expired") return "canceled";
  if (stripeStatus === "trialing") return "trialing";
  return "active";
}

// Current subscription state from Stripe, mapped to our columns.
function subscriptionFields(sub: Record<string, unknown>) {
  const items = sub.items as Record<string, unknown> | undefined;
  const data = (items?.data as Record<string, unknown>[]) || [];
  const priceId = data.length > 0 ? ((data[0].price as Record<string, string>)?.id || "") : "";
  const status = mapStatus(String(sub.status || ""));
  const canceled = status === "canceled";
  const { plan, interval } = canceled ? { plan: "free", interval: null as unknown as string } : getPlanFromPriceId(priceId);
  return {
    plan,
    interval: canceled ? null : interval,
    status,
    stripe_price_id: priceId || null,
    cancel_at_period_end: canceled ? false : !!sub.cancel_at_period_end,
    current_period_start: iso(sub.current_period_start),
    current_period_end: iso(sub.current_period_end),
    updated_at: new Date().toISOString(),
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") || "";
  if (!(await verifyStripeSignature(rawBody, sigHeader))) {
    console.warn("Stripe webhook: signature verification failed");
    return json({ error: "Invalid signature" }, 401);
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(rawBody); } catch { return json({ error: "Invalid JSON" }, 400); }

  const eventId = typeof event.id === "string" ? event.id : "";
  const eventType = String(event.type || "");
  if (!eventId) return json({ error: "Missing event id" }, 400);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  // ── Event ledger: claim this event before doing anything ─────────────
  const { error: claimErr } = await db.from("stripe_webhook_events").insert({
    event_id: eventId,
    type: eventType,
    stripe_created_at: iso(event.created),
    status: "processing",
  });
  if (claimErr) {
    if ((claimErr as { code?: string }).code !== "23505") {
      console.error("Stripe webhook: ledger insert failed", claimErr.message);
      return json({ error: "ledger_unavailable" }, 500);
    }
    const { data: prior } = await db.from("stripe_webhook_events")
      .select("status, received_at, attempts").eq("event_id", eventId).maybeSingle();
    if (prior?.status === "processed") {
      console.log(`Stripe webhook: duplicate ${eventId} skipped`);
      return json({ received: true, duplicate: true });
    }
    const age = prior?.received_at ? Date.now() - new Date(prior.received_at).getTime() : Infinity;
    if (prior?.status === "processing" && age < PROCESSING_STALE_MS) {
      // Another delivery of the same event is running now. Ask Stripe to retry later.
      return json({ error: "in_progress" }, 409);
    }
    await db.from("stripe_webhook_events").update({
      status: "processing", received_at: new Date().toISOString(),
      attempts: (prior?.attempts || 1) + 1, error: null,
    }).eq("event_id", eventId);
  }

  const obj = (event.data as Record<string, unknown>)?.object as Record<string, unknown>;
  console.log(`Stripe webhook: ${eventType} ${eventId}`);

  try {
    let note = "ignored";

    if (eventType === "checkout.session.completed") {
      const userId = (obj.metadata as Record<string, string> | undefined)?.supabase_user_id;
      const subscriptionId = obj.subscription as string;
      if (!userId || !subscriptionId) {
        note = "missing_user_or_subscription";
      } else {
        const sub = await stripeGet(`/subscriptions/${subscriptionId}`);
        const { error } = await db.from("subscriptions").upsert({
          user_id: userId,
          stripe_customer_id: obj.customer as string,
          stripe_subscription_id: subscriptionId,
          source: "stripe",
          ...subscriptionFields(sub),
        }, { onConflict: "user_id" });
        if (error) throw new Error(`db_upsert: ${error.message}`);
        note = "activated";
      }
    } else if (
      eventType === "customer.subscription.updated" ||
      eventType === "customer.subscription.deleted" ||
      eventType === "invoice.payment_succeeded" ||
      eventType === "invoice.payment_failed"
    ) {
      const subId = (eventType.startsWith("invoice.") ? obj.subscription : obj.id) as string;
      if (!subId) {
        note = "no_subscription";
      } else {
        // Always use Stripe's current state, never the (possibly stale) payload.
        const sub = await stripeGet(`/subscriptions/${subId}`);
        const { error } = await db.from("subscriptions")
          .update(subscriptionFields(sub))
          .eq("stripe_subscription_id", subId);
        if (error) throw new Error(`db_update: ${error.message}`);
        note = "synced";
      }
    }

    await db.from("stripe_webhook_events").update({
      status: "processed", processed_at: new Date().toISOString(), outcome: note, error: null,
    }).eq("event_id", eventId);
    return json({ received: true });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 300);
    console.error(`Stripe webhook: ${eventType} ${eventId} failed`, msg);
    await db.from("stripe_webhook_events").update({ status: "failed", error: msg }).eq("event_id", eventId);
    // Non-2xx so Stripe retries (it retries for up to 3 days).
    return json({ error: "processing_failed" }, 500);
  }
});
