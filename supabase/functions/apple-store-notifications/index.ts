// apple-store-notifications — App Store Server Notifications V2 endpoint.
//
// Apple POSTs { signedPayload } here (set in App Store Connect > App
// Information, Version 2, same URL for Production and Sandbox). No Supabase
// JWT: deployed with verify_jwt = false. Trust comes only from Apple's
// signature, checked against the pinned Apple Root CA - G3.
//
//   REFUND           sets records_purchases.refunded_at. Records already saved
//                    for the loved one stay; only automatic updates stop.
//   REFUND_REVERSED  clears refunded_at, unless the loved one has since been
//                    bought for again.
//   Anything else    200, no change (TEST, CONSUMPTION_REQUEST, other products).
//
// Replies 200 once handled so Apple stops retrying; 400 for anything not
// signed by Apple; 500 on a database error so Apple retries.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { parseNotification } from "./notify.ts";
import { VerificationError } from "./verify.ts";

const ok = (body: unknown = { ok: true }) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const fail = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return fail(405, "method_not_allowed");

  let signedPayload: unknown;
  try {
    signedPayload = (await req.json())?.signedPayload;
  } catch {
    return fail(400, "invalid_json");
  }
  if (typeof signedPayload !== "string") return fail(400, "missing_signed_payload");

  let action;
  try {
    action = await parseNotification(signedPayload);
  } catch (e) {
    const code = e instanceof VerificationError ? e.code : "verification_failed";
    console.warn("apple-store-notifications rejected", { code });
    return fail(400, code);
  }

  if (action.kind === "ignore") {
    console.log("apple-store-notifications ignored", { type: action.notificationType, reason: action.reason, uuid: action.notificationUUID });
    return ok();
  }

  const admin = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "", {
    auth: { persistSession: false },
  });

  if (action.kind === "refund") {
    const { data, error } = await admin
      .from("records_purchases")
      .update({ refunded_at: action.refundedAt.toISOString() })
      .eq("original_transaction_id", action.originalTransactionId)
      .is("refunded_at", null)
      .select("id");
    if (error) {
      console.error("apple-store-notifications refund update failed", error.message);
      return fail(500, "server_error");
    }
    // No row: already refunded (Apple retry) or never recorded by the app.
    console.log("apple-store-notifications refund", { uuid: action.notificationUUID, env: action.environment, updated: data?.length ?? 0 });
    return ok();
  }

  // REFUND_REVERSED
  const { data, error } = await admin
    .from("records_purchases")
    .update({ refunded_at: null })
    .eq("original_transaction_id", action.originalTransactionId)
    .not("refunded_at", "is", null)
    .select("id");
  if (error) {
    if (error.code === "23505") {
      // The loved one was bought for again after the refund; keep the newer purchase.
      console.warn("apple-store-notifications reversal skipped, newer purchase active", { uuid: action.notificationUUID });
      return ok();
    }
    console.error("apple-store-notifications reversal update failed", error.message);
    return fail(500, "server_error");
  }
  console.log("apple-store-notifications refund reversed", { uuid: action.notificationUUID, env: action.environment, updated: data?.length ?? 0 });
  return ok();
});
