// Stand-in for PostgREST (Supabase DB) and the Stripe API.
const ledger = new Map<string, Record<string, unknown>>();
const subs = new Map<string, Record<string, unknown>>(); // by stripe_subscription_id
const log: string[] = [];
let stripeFail = false;
let stripeState: Record<string, unknown> = {};
const j = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json" } });
Deno.serve({ port: 9999 }, async (req) => {
  const u = new URL(req.url);
  const body = req.method === "GET" ? null : await req.text().then(t => t ? JSON.parse(t) : null).catch(() => null);
  if (u.pathname === "/_ctl") { const c = await Promise.resolve(body); if (c.stripeFail !== undefined) stripeFail = c.stripeFail; if (c.stripeState) stripeState = c.stripeState; if (c.seedSub) subs.set(c.seedSub.stripe_subscription_id, c.seedSub); return j({ ok: true }); }
  if (u.pathname === "/_dump") return j({ ledger: [...ledger.values()], subs: [...subs.values()], log });
  if (u.pathname.startsWith("/v1/subscriptions/")) {
    const id = u.pathname.split("/").pop()!;
    log.push("stripe GET " + id);
    if (stripeFail) return j({ error: { message: "boom" } }, 500);
    return j({ id, ...stripeState });
  }
  if (u.pathname === "/rest/v1/stripe_webhook_events") {
    const idEq = u.searchParams.get("event_id")?.replace(/^eq\./, "");
    if (req.method === "POST") {
      const row = Array.isArray(body) ? body[0] : body;
      if (ledger.has(row.event_id)) return j({ code: "23505", message: "duplicate key" }, 409);
      ledger.set(row.event_id, { attempts: 1, received_at: new Date().toISOString(), ...row }); log.push("ledger insert " + row.event_id);
      return new Response(null, { status: 201 });
    }
    if (req.method === "GET") return j(idEq && ledger.has(idEq) ? [ledger.get(idEq)] : []);
    if (req.method === "PATCH") { const r = ledger.get(idEq!); if (r) Object.assign(r, body); log.push("ledger " + idEq + " -> " + body.status); return new Response(null, { status: 204 }); }
  }
  if (u.pathname === "/rest/v1/subscriptions") {
    if (req.method === "POST") { const row = Array.isArray(body) ? body[0] : body; subs.set(row.stripe_subscription_id, row); log.push("subs upsert " + row.user_id + " " + row.plan + " " + row.status); return new Response(null, { status: 201 }); }
    if (req.method === "PATCH") { const id = u.searchParams.get("stripe_subscription_id")!.replace(/^eq\./, ""); const r = subs.get(id); if (r) Object.assign(r, body); log.push("subs update " + id + " " + body.plan + " " + body.status); return new Response(null, { status: 204 }); }
  }
  return j({ error: "not mocked " + req.method + " " + u.pathname }, 404);
});
