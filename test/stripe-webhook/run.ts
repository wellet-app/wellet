const SECRET = "whsec_test_local";
const F = "http://localhost:8000/";
const M = "http://localhost:9999";
const enc = new TextEncoder();
async function sign(body: string, extraBadSig = false) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + body)))).map(b => b.toString(16).padStart(2, "0")).join("");
  return extraBadSig ? `t=${t},v1=${"0".repeat(64)},v1=${mac}` : `t=${t},v1=${mac}`;
}
async function send(ev: unknown, opts: { bad?: boolean; rot?: boolean } = {}) {
  const b = JSON.stringify(ev);
  const sig = opts.bad ? `t=${Math.floor(Date.now()/1000)},v1=${"a".repeat(64)}` : await sign(b, opts.rot);
  const r = await fetch(F, { method: "POST", headers: { "stripe-signature": sig, "content-type": "application/json" }, body: b });
  return r.status + " " + (await r.text());
}
const ctl = (c: unknown) => fetch(M + "/_ctl", { method: "POST", body: JSON.stringify(c) }).then(r => r.text());
const PLUS_M = "price_1TNJEkQk7RCcdO4CnH8kmhqX", PRO_M = "price_1TNJEkQk7RCcdO4CUxM7DeVN";
const st = (price: string, status = "active", extra = {}) => ({ status, cancel_at_period_end: false, current_period_start: 1790000000, current_period_end: 1792600000, items: { data: [{ price: { id: price } }] }, ...extra });
const res: string[] = [];
const ok = (name: string, cond: boolean, got: string) => res.push(`${cond ? "PASS" : "FAIL"}  ${name}  (${got})`);

let r = await send({ id: "evt_bad", type: "checkout.session.completed" }, { bad: true });
ok("bad signature rejected", r.startsWith("401"), r);

await ctl({ stripeState: st(PLUS_M) });
const checkout = { id: "evt_1", type: "checkout.session.completed", created: 1790000000, data: { object: { metadata: { supabase_user_id: "u1" }, subscription: "sub_1", customer: "cus_1" } } };
r = await send(checkout); ok("checkout processed", r.startsWith("200") && !r.includes("duplicate"), r);
r = await send(checkout); ok("same event again is skipped", r.includes("duplicate"), r);
r = await send(checkout, { rot: true }); ok("rotation header (2 sigs) accepted", r.startsWith("200"), r);

// Out of order: Stripe now says pro; an OLD 'updated' event arrives whose payload says plus/canceled
await ctl({ stripeState: st(PRO_M) });
r = await send({ id: "evt_2", type: "customer.subscription.updated", created: 1789999999, data: { object: { id: "sub_1", status: "canceled", items: { data: [{ price: { id: PLUS_M } }] } } } });
let d = await (await fetch(M + "/_dump")).json();
const s1 = d.subs.find((x: any) => x.stripe_subscription_id === "sub_1");
ok("stale payload ignored; Stripe's current state used", r.startsWith("200") && s1.plan === "pro" && s1.status === "active", `${s1.plan}/${s1.status}`);

// Failure path: Stripe API down -> 500 + ledger failed, then retry succeeds
await ctl({ stripeFail: true });
r = await send({ id: "evt_3", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } });
d = await (await fetch(M + "/_dump")).json();
ok("failure returns 500 so Stripe retries", r.startsWith("500") && d.ledger.find((x: any) => x.event_id === "evt_3").status === "failed", r);
await ctl({ stripeFail: false, stripeState: st(PRO_M, "past_due") });
r = await send({ id: "evt_3", type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } });
d = await (await fetch(M + "/_dump")).json();
const l3 = d.ledger.find((x: any) => x.event_id === "evt_3");
ok("retry of failed event is processed", r.startsWith("200") && l3.status === "processed" && l3.attempts === 2, `${l3.status}, attempts ${l3.attempts}`);
ok("past_due applied", d.subs.find((x: any) => x.stripe_subscription_id === "sub_1").status === "past_due", d.subs[0].status);

// Unknown price fails loudly
await ctl({ stripeState: st("price_unknown") });
r = await send({ id: "evt_4", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } });
d = await (await fetch(M + "/_dump")).json();
ok("unknown price fails loudly, row unchanged", r.startsWith("500") && d.ledger.find((x: any) => x.event_id === "evt_4").error.startsWith("unmapped_price") && d.subs[0].plan === "pro", r);

// Deleted -> free/canceled
await ctl({ stripeState: st(PRO_M, "canceled") });
r = await send({ id: "evt_5", type: "customer.subscription.deleted", data: { object: { id: "sub_1" } } });
d = await (await fetch(M + "/_dump")).json();
ok("canceled -> free", r.startsWith("200") && d.subs[0].plan === "free" && d.subs[0].status === "canceled", `${d.subs[0].plan}/${d.subs[0].status}`);

// Concurrent duplicate deliveries: only one write
await ctl({ stripeState: st(PLUS_M) });
const ev6 = { id: "evt_6", type: "customer.subscription.updated", data: { object: { id: "sub_1" } } };
const both = await Promise.all([send(ev6), send(ev6)]);
d = await (await fetch(M + "/_dump")).json();
const writes6 = d.log.filter((x: string) => x.startsWith("ledger insert evt_6")).length;
ok("two simultaneous deliveries -> one processed", writes6 === 1 && both.some(x => x.startsWith("200")), both.join(" | "));

console.log(res.join("\n"));
