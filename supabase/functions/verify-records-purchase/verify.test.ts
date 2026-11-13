// deno test -A supabase/functions/verify-records-purchase/verify.test.ts
// Builds a stand-in Apple chain (same OIDs) and checks every rejection path.

import { assertEquals, assertRejects, assertThrows } from "jsr:@std/assert@1";
import * as x509 from "npm:@peculiar/x509@1.12.3";
import { checkRecordsClaims, VerificationError, verifyAppleSignedData } from "./verify.ts";

x509.cryptoProvider.set(crypto);
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const notBefore = new Date("2020-01-01"), notAfter = new Date("2040-01-01");

async function makeChain(opts: { leafOid?: boolean; intOid?: boolean } = {}) {
  const rootKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const intKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const leafKeys = await crypto.subtle.generateKey(alg, true, ["sign", "verify"]);
  const root = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01", name: "CN=Test Root", notBefore, notAfter, keys: rootKeys, signingAlgorithm: alg,
    extensions: [new x509.BasicConstraintsExtension(true, undefined, true)],
  });
  const intExt: x509.Extension[] = [new x509.BasicConstraintsExtension(true, 0, true)];
  if (opts.intOid !== false) intExt.push(new x509.Extension("1.2.840.113635.100.6.2.1", false, new Uint8Array([5, 0])));
  const inter = await x509.X509CertificateGenerator.create({
    serialNumber: "02", subject: "CN=Test WWDR", issuer: root.subject, notBefore, notAfter,
    publicKey: intKeys.publicKey, signingKey: rootKeys.privateKey, signingAlgorithm: alg, extensions: intExt,
  });
  const leafExt: x509.Extension[] = [];
  if (opts.leafOid !== false) leafExt.push(new x509.Extension("1.2.840.113635.100.6.11.1", false, new Uint8Array([5, 0])));
  const leaf = await x509.X509CertificateGenerator.create({
    serialNumber: "03", subject: "CN=Test StoreKit", issuer: inter.subject, notBefore, notAfter,
    publicKey: leafKeys.publicKey, signingKey: intKeys.privateKey, signingAlgorithm: alg, extensions: leafExt,
  });
  return { root, inter, leaf, leafKey: leafKeys.privateKey };
}

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const derB64 = (c: x509.X509Certificate) => btoa(String.fromCharCode(...new Uint8Array(c.rawData)));

async function sign(chain: Awaited<ReturnType<typeof makeChain>>, payload: unknown) {
  const h = enc({ alg: "ES256", x5c: [chain.leaf, chain.inter, chain.root].map(derB64) });
  const p = enc(payload);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, chain.leafKey, new TextEncoder().encode(h + "." + p)));
  return `${h}.${p}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

const RUTH = "f9732803-9ea5-4e4b-a869-09a43ff11cb1";
const good = {
  bundleId: "com.getwellet.ios", productId: "com.getwellet.ios.records.person", type: "Consumable",
  environment: "Sandbox", appAccountToken: RUTH.toUpperCase(), originalTransactionId: "2000000812345678",
  transactionId: "2000000812345678", purchaseDate: Date.parse("2026-11-20T15:00:00Z"),
  signedDate: Date.parse("2026-11-20T15:00:01Z"), price: 9990, currency: "USD",
};
const now = new Date("2026-11-21");
const rootOf = (c: Awaited<ReturnType<typeof makeChain>>) => [new Uint8Array(c.root.rawData)];
const code = async (p: Promise<unknown>, expected: string) => {
  const e = await assertRejects(() => p, VerificationError);
  assertEquals((e as VerificationError).code, expected);
};

Deno.test("valid purchase verifies and maps", async () => {
  const c = await makeChain();
  const p = await verifyAppleSignedData(await sign(c, good), rootOf(c), now);
  const claims = checkRecordsClaims(p, RUTH);
  assertEquals(claims.priceCents, 999);
  assertEquals(claims.environment, "Sandbox");
  assertEquals(claims.originalTransactionId, "2000000812345678");
});

Deno.test("real Apple root is required by default", async () => {
  const c = await makeChain();
  await code(verifyAppleSignedData(await sign(c, good), undefined, now), "untrusted_root");
});

Deno.test("tampered payload fails signature", async () => {
  const c = await makeChain();
  const [h, , s] = (await sign(c, good)).split(".");
  await code(verifyAppleSignedData(`${h}.${enc({ ...good, price: 0 })}.${s}`, rootOf(c), now), "bad_signature");
});

Deno.test("chain from another root fails", async () => {
  const c = await makeChain(), other = await makeChain();
  await code(verifyAppleSignedData(await sign(c, good), rootOf(other), now), "untrusted_root");
});

Deno.test("missing Apple OIDs fail", async () => {
  const noLeaf = await makeChain({ leafOid: false });
  await code(verifyAppleSignedData(await sign(noLeaf, good), rootOf(noLeaf), now), "bad_leaf");
  const noInt = await makeChain({ intOid: false });
  await code(verifyAppleSignedData(await sign(noInt, good), rootOf(noInt), now), "bad_intermediate");
});

Deno.test("future signedDate fails", async () => {
  const c = await makeChain();
  await code(verifyAppleSignedData(await sign(c, { ...good, signedDate: Date.parse("2027-01-01") }), rootOf(c), now), "signed_in_future");
});

Deno.test("claims: wrong app, product, type, loved one, refunded", () => {
  const bad = (p: Record<string, unknown>, c: string) => {
    const e = assertThrows(() => checkRecordsClaims(p, RUTH), VerificationError);
    assertEquals((e as VerificationError).code, c);
  };
  bad({ ...good, bundleId: "com.other.app" }, "wrong_app");
  bad({ ...good, productId: "com.getwellet.ios.ai.monthly" }, "wrong_product");
  bad({ ...good, type: "Non-Consumable" }, "wrong_product_type");
  bad({ ...good, appAccountToken: "00000000-0000-0000-0000-000000000000" }, "wrong_loved_one");
  bad({ ...good, appAccountToken: undefined }, "wrong_loved_one");
  bad({ ...good, revocationDate: 1 }, "refunded");
  bad({ ...good, environment: "Xcode" }, "wrong_environment");
});
