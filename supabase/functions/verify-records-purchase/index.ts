// verify-records-purchase — records a $9.99 hospital-records purchase for one loved one.
//
// Called by the iOS app after StoreKit 2 returns a purchase, before it finishes
// the transaction. Also safe to call again to restore (same row comes back).
//
//   POST { signed_transaction: <Transaction.jwsRepresentation>, person_id }
//   200  { status: "active", person_id, purchased_at, environment, already_recorded }
//   400  { error: <code> }   the receipt isn't a valid Wellet records purchase
//   403  { error: "forbidden" }   the loved one isn't the caller's
//   409  { error: "already_purchased" | "transaction_in_use" }
//
// Writes records_purchases with the service role; the app has no write access.
// Holds no health information. Sandbox purchases (TestFlight, App Review) are
// accepted and stored with environment = 'Sandbox'.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { checkRecordsClaims, RECORDS_PRODUCT_ID, VerificationError, verifyAppleSignedData } from "./verify.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(jwt);
  const user = auth?.user;
  if (!user) return json({ error: "unauthorized" }, 401);

  let body: { signed_transaction?: string; person_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const personId = (body.person_id ?? "").trim().toLowerCase();
  if (!UUID_RE.test(personId)) return json({ error: "invalid_person_id" }, 400);
  if (!body.signed_transaction) return json({ error: "missing_signed_transaction" }, 400);

  const { data: person, error: personErr } = await admin
    .from("people").select("id, user_id").eq("id", personId).maybeSingle();
  if (personErr) return json({ error: "server_error" }, 500);
  if (!person || person.user_id !== user.id) return json({ error: "forbidden" }, 403);

  let claims;
  try {
    const payload = await verifyAppleSignedData(body.signed_transaction);
    claims = checkRecordsClaims(payload, personId);
  } catch (e) {
    const code = e instanceof VerificationError ? e.code : "verification_failed";
    console.warn("verify-records-purchase rejected", { code, user_id: user.id });
    return json({ error: code }, 400);
  }

  const active = (row: { person_id: string; purchased_at: string; environment: string }, already: boolean) =>
    json({ status: "active", person_id: row.person_id, purchased_at: row.purchased_at, environment: row.environment, already_recorded: already });

  // Restore or retry: the same Apple purchase was already saved.
  const { data: existing } = await admin
    .from("records_purchases")
    .select("user_id, person_id, purchased_at, environment, refunded_at")
    .eq("original_transaction_id", claims.originalTransactionId)
    .maybeSingle();
  if (existing) {
    if (existing.user_id !== user.id || existing.person_id !== personId) return json({ error: "transaction_in_use" }, 409);
    if (existing.refunded_at) return json({ error: "refunded" }, 400);
    return active(existing, true);
  }

  const insert = await admin
    .from("records_purchases")
    .insert({
      user_id: user.id,
      person_id: personId,
      product_id: RECORDS_PRODUCT_ID,
      original_transaction_id: claims.originalTransactionId,
      environment: claims.environment,
      price_cents: claims.priceCents,
      currency: claims.currency,
      purchased_at: claims.purchasedAt.toISOString(),
    })
    .select("person_id, purchased_at, environment")
    .single();

  if (insert.error) {
    if (insert.error.code === "23505") {
      // Either a parallel retry of this same purchase, or this loved one already
      // has an active purchase (a second charge; Apple handles the refund).
      const { data: again } = await admin
        .from("records_purchases")
        .select("user_id, person_id, purchased_at, environment")
        .eq("original_transaction_id", claims.originalTransactionId)
        .maybeSingle();
      if (again && again.user_id === user.id && again.person_id === personId) return active(again, true);
      console.warn("verify-records-purchase duplicate for loved one", { user_id: user.id, person_id: personId });
      return json({ error: "already_purchased" }, 409);
    }
    console.error("verify-records-purchase insert failed", insert.error.message);
    return json({ error: "server_error" }, 500);
  }

  // Start automatic updates for this loved one on the next hourly run instead
  // of waiting out a not_purchased backoff (up to a day).
  const { error: schedErr } = await admin
    .from("ehr_sync_schedule").update({ next_run_at: new Date().toISOString() }).eq("person_id", personId);
  if (schedErr) console.warn("verify-records-purchase schedule nudge failed", schedErr.message);

  console.log("verify-records-purchase recorded", { user_id: user.id, person_id: personId, environment: claims.environment });
  return active(insert.data, false);
});
