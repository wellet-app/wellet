// verify.ts — checks an App Store signed transaction (StoreKit 2 JWS).
//
// Same checks as Apple's App Store Server Library SignedDataVerifier:
//   1. Header is ES256 with a three-certificate x5c chain.
//   2. The chain's root is byte-for-byte Apple Root CA - G3 (pinned below).
//   3. Intermediate carries Apple's WWDR OID, leaf carries the App Store
//      receipt-signing OID, each is signed by the one above, and both are
//      valid at the transaction's signedDate.
//   4. The JWS signature verifies with the leaf's key.
// Then checkRecordsClaims() checks the purchase is ours and for this loved one.

import * as x509 from "npm:@peculiar/x509@1.12.3";

x509.cryptoProvider.set(crypto);

// Apple Root CA - G3, from https://www.apple.com/certificateauthority/
// SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79
export const APPLE_ROOT_CA_G3_B64 =
  "MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==";

const LEAF_OID = "1.2.840.113635.100.6.11.1";
const INTERMEDIATE_OID = "1.2.840.113635.100.6.2.1";

export const BUNDLE_ID = "com.getwellet.ios";
export const RECORDS_PRODUCT_ID = "com.getwellet.ios.records.person";

export class VerificationError extends Error {
  constructor(public code: string) {
    super(code);
  }
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  return b64ToBytes(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function decodeJSON(part: string): Record<string, unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(part)));
  } catch {
    throw new VerificationError("malformed_jws");
  }
}

export async function verifyAppleSignedData(
  jws: string,
  rootsDer: Uint8Array[] = [b64ToBytes(APPLE_ROOT_CA_G3_B64)],
  now: Date = new Date(),
): Promise<Record<string, unknown>> {
  if (typeof jws !== "string") throw new VerificationError("malformed_jws");
  const parts = jws.split(".");
  if (parts.length !== 3) throw new VerificationError("malformed_jws");

  const header = decodeJSON(parts[0]);
  if (header.alg !== "ES256") throw new VerificationError("unsupported_alg");
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === "string")) {
    throw new VerificationError("bad_chain");
  }

  let leaf: x509.X509Certificate, intermediate: x509.X509Certificate, root: x509.X509Certificate;
  try {
    [leaf, intermediate, root] = (x5c as string[]).map((c) => new x509.X509Certificate(b64ToBytes(c)));
  } catch {
    throw new VerificationError("bad_chain");
  }

  // Root must be Apple's own certificate, not just one with the same name.
  const rootBytes = new Uint8Array(root.rawData);
  if (!rootsDer.some((r) => bytesEqual(r, rootBytes))) throw new VerificationError("untrusted_root");

  if (!leaf.getExtension(LEAF_OID)) throw new VerificationError("bad_leaf");
  if (!intermediate.getExtension(INTERMEDIATE_OID)) throw new VerificationError("bad_intermediate");
  const bc = intermediate.getExtension(x509.BasicConstraintsExtension);
  if (!bc || !bc.ca) throw new VerificationError("bad_intermediate");

  // Validity is checked at signedDate (as Apple's library does without online
  // checks), so an older purchase can still be restored after a leaf rotates.
  // The signature check below proves signedDate is Apple's.
  const unverified = decodeJSON(parts[1]);
  const signedMs = typeof unverified.signedDate === "number" ? unverified.signedDate : now.getTime();
  if (signedMs > now.getTime() + 5 * 60_000) throw new VerificationError("signed_in_future");
  const at = new Date(signedMs);

  const okIntermediate = await intermediate.verify({ publicKey: root.publicKey, date: at });
  const okLeaf = await leaf.verify({ publicKey: intermediate.publicKey, date: at });
  const okRoot = await root.verify({ date: at });
  if (!okIntermediate || !okLeaf || !okRoot) throw new VerificationError("chain_invalid");

  const key = await leaf.publicKey.export({ name: "ECDSA", namedCurve: "P-256" }, ["verify"]);
  const okSig = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    b64urlToBytes(parts[2]),
    new TextEncoder().encode(parts[0] + "." + parts[1]),
  );
  if (!okSig) throw new VerificationError("bad_signature");

  return unverified;
}

export interface RecordsClaims {
  originalTransactionId: string;
  transactionId: string;
  environment: "Production" | "Sandbox";
  purchasedAt: Date;
  priceCents: number | null;
  currency: string | null;
}

/** Null-safe checks that this is a Wellet hospital-records purchase for this loved one. */
export function checkRecordsClaims(p: Record<string, unknown>, personId: string): RecordsClaims {
  if (p.bundleId !== BUNDLE_ID) throw new VerificationError("wrong_app");
  if (p.productId !== RECORDS_PRODUCT_ID) throw new VerificationError("wrong_product");
  if (p.type !== "Consumable") throw new VerificationError("wrong_product_type");
  if (p.environment !== "Production" && p.environment !== "Sandbox") throw new VerificationError("wrong_environment");
  // The app sets appAccountToken to the loved one's id at purchase time,
  // so a purchase can't be moved to another loved one.
  if (typeof p.appAccountToken !== "string" || p.appAccountToken.toLowerCase() !== personId.toLowerCase()) {
    throw new VerificationError("wrong_loved_one");
  }
  if (p.revocationDate != null) throw new VerificationError("refunded");
  if (typeof p.originalTransactionId !== "string" || typeof p.transactionId !== "string") {
    throw new VerificationError("missing_transaction");
  }
  if (typeof p.purchaseDate !== "number") throw new VerificationError("missing_transaction");
  return {
    originalTransactionId: p.originalTransactionId,
    transactionId: p.transactionId,
    environment: p.environment,
    purchasedAt: new Date(p.purchaseDate),
    // Apple sends price in milliunits (9990 = 9.99).
    priceCents: typeof p.price === "number" ? Math.round(p.price / 10) : null,
    currency: typeof p.currency === "string" ? p.currency : null,
  };
}
