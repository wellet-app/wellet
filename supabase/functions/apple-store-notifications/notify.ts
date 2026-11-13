// notify.ts — turns an App Store Server Notification (V2) into one action.
// Both the notification and the transaction inside it are Apple-signed JWS,
// and both are checked against the pinned Apple root.

import { BUNDLE_ID, RECORDS_PRODUCT_ID, VerificationError, verifyAppleSignedData } from "./verify.ts";

export type NotificationAction =
  | { kind: "refund"; originalTransactionId: string; refundedAt: Date; environment: string; notificationUUID: string }
  | { kind: "refund_reversed"; originalTransactionId: string; environment: string; notificationUUID: string }
  | { kind: "ignore"; reason: string; notificationType: string; notificationUUID: string };

export async function parseNotification(
  signedPayload: string,
  roots?: Uint8Array[],
  now: Date = new Date(),
): Promise<NotificationAction> {
  const n = await verifyAppleSignedData(signedPayload, roots, now);
  const type = String(n.notificationType ?? "");
  const uuid = String(n.notificationUUID ?? "");
  const data = (n.data ?? {}) as Record<string, unknown>;
  const ignore = (reason: string): NotificationAction => ({ kind: "ignore", reason, notificationType: type, notificationUUID: uuid });

  if (type === "TEST") return ignore("test");
  if (data.bundleId !== BUNDLE_ID) return ignore("other_app");
  if (type !== "REFUND" && type !== "REFUND_REVERSED") return ignore("not_a_refund");
  if (typeof data.signedTransactionInfo !== "string") throw new VerificationError("missing_transaction");

  const tx = await verifyAppleSignedData(data.signedTransactionInfo, roots, now);
  if (tx.bundleId !== BUNDLE_ID) return ignore("other_app");
  if (tx.productId !== RECORDS_PRODUCT_ID) return ignore("other_product");
  if (typeof tx.originalTransactionId !== "string") throw new VerificationError("missing_transaction");
  const environment = String(tx.environment ?? data.environment ?? "");

  if (type === "REFUND") {
    const at = typeof tx.revocationDate === "number" ? new Date(tx.revocationDate) : now;
    return { kind: "refund", originalTransactionId: tx.originalTransactionId, refundedAt: at, environment, notificationUUID: uuid };
  }
  return { kind: "refund_reversed", originalTransactionId: tx.originalTransactionId, environment, notificationUUID: uuid };
}
