// deno test -A supabase/functions/apple-store-notifications/notify.test.ts
import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import * as x509 from "npm:@peculiar/x509@1.12.3";
import { parseNotification } from "./notify.ts";
import { VerificationError } from "./verify.ts";

x509.cryptoProvider.set(crypto);
const alg = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" };
const nb = new Date("2020-01-01"), na = new Date("2040-01-01");

async function chain() {
  const [rk, ik, lk] = await Promise.all([0, 1, 2].map(() => crypto.subtle.generateKey(alg, true, ["sign", "verify"])));
  const root = await x509.X509CertificateGenerator.createSelfSigned({ serialNumber: "01", name: "CN=Test Root", notBefore: nb, notAfter: na, keys: rk, signingAlgorithm: alg, extensions: [new x509.BasicConstraintsExtension(true, undefined, true)] });
  const inter = await x509.X509CertificateGenerator.create({ serialNumber: "02", subject: "CN=Int", issuer: root.subject, notBefore: nb, notAfter: na, publicKey: ik.publicKey, signingKey: rk.privateKey, signingAlgorithm: alg, extensions: [new x509.BasicConstraintsExtension(true, 0, true), new x509.Extension("1.2.840.113635.100.6.2.1", false, new Uint8Array([5, 0]))] });
  const leaf = await x509.X509CertificateGenerator.create({ serialNumber: "03", subject: "CN=Leaf", issuer: inter.subject, notBefore: nb, notAfter: na, publicKey: lk.publicKey, signingKey: ik.privateKey, signingAlgorithm: alg, extensions: [new x509.Extension("1.2.840.113635.100.6.11.1", false, new Uint8Array([5, 0]))] });
  return { certs: [leaf, inter, root], key: lk.privateKey, roots: [new Uint8Array(root.rawData)] };
}
const u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = (o: unknown) => u(new TextEncoder().encode(JSON.stringify(o)));
async function sign(c: Awaited<ReturnType<typeof chain>>, payload: unknown) {
  const h = enc({ alg: "ES256", x5c: c.certs.map((x) => btoa(String.fromCharCode(...new Uint8Array(x.rawData)))) });
  const p = enc(payload);
  const s = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, c.key, new TextEncoder().encode(h + "." + p)));
  return `${h}.${p}.${u(s)}`;
}
const now = new Date("2026-12-01");
const tx = { bundleId: "com.getwellet.ios", productId: "com.getwellet.ios.records.person", type: "Consumable", environment: "Sandbox", originalTransactionId: "2000000812345678", transactionId: "2000000812345678", signedDate: Date.parse("2026-11-30"), revocationDate: Date.parse("2026-11-29T12:00:00Z") };
const note = (type: string, t: unknown, bundle = "com.getwellet.ios") => ({ notificationType: type, notificationUUID: "n-1", signedDate: Date.parse("2026-11-30"), data: { bundleId: bundle, environment: "Sandbox", signedTransactionInfo: t } });

Deno.test("REFUND marks the purchase refunded at Apple's revocation date", async () => {
  const c = await chain();
  const a = await parseNotification(await sign(c, note("REFUND", await sign(c, tx))), c.roots, now);
  assertEquals(a.kind, "refund");
  if (a.kind === "refund") {
    assertEquals(a.originalTransactionId, "2000000812345678");
    assertEquals(a.refundedAt.toISOString(), "2026-11-29T12:00:00.000Z");
  }
});

Deno.test("REFUND_REVERSED", async () => {
  const c = await chain();
  const a = await parseNotification(await sign(c, note("REFUND_REVERSED", await sign(c, { ...tx, revocationDate: undefined }))), c.roots, now);
  assertEquals(a.kind, "refund_reversed");
});

Deno.test("TEST, other app, other product and other types are ignored", async () => {
  const c = await chain();
  const t = await sign(c, tx);
  assertEquals((await parseNotification(await sign(c, { notificationType: "TEST", notificationUUID: "t", signedDate: Date.parse("2026-11-30"), data: {} }), c.roots, now)).kind, "ignore");
  assertEquals((await parseNotification(await sign(c, note("REFUND", t, "com.other.app")), c.roots, now)).kind, "ignore");
  assertEquals((await parseNotification(await sign(c, note("REFUND", await sign(c, { ...tx, productId: "com.getwellet.ios.ai.monthly" }))), c.roots, now)).kind, "ignore");
  assertEquals((await parseNotification(await sign(c, note("CONSUMPTION_REQUEST", t)), c.roots, now)).kind, "ignore");
});

Deno.test("a genuine notice wrapping a forged transaction is rejected", async () => {
  const c = await chain(), other = await chain();
  const e = await assertRejects(async () => parseNotification(await sign(c, note("REFUND", "not.a-jws")), c.roots, now), VerificationError);
  assertEquals((e as VerificationError).code, "malformed_jws");
  const forged = await sign(other, tx);
  const e2 = await assertRejects(async () => parseNotification(await sign(c, note("REFUND", forged)), c.roots, now), VerificationError);
  assertEquals((e2 as VerificationError).code, "untrusted_root");
});

Deno.test("unsigned notices are rejected against the real Apple root", async () => {
  const c = await chain();
  const e = await assertRejects(async () => parseNotification(await sign(c, note("REFUND", await sign(c, tx))), undefined, now), VerificationError);
  assertEquals((e as VerificationError).code, "untrusted_root");
});
