// meter.ts — records AI token counts per call into public.ai_usage_events.
// Counts only. Never pass prompt text, answers or health details here.
// Failures are swallowed: metering must never break a caregiver's request.

const RATES: Record<string, { in: number; out: number }> = {
  // USD per 1M tokens (Azure OpenAI list prices, Nov 2026)
  "gpt-4o": { in: 2.5, out: 10 },
  // The original May 2024 gpt-4o release is priced higher.
  "gpt-4o-2024-05-13": { in: 5, out: 15 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 },
  "sonar": { in: 1, out: 1 },
  "sonar-pro": { in: 3, out: 15 },
};

function rateFor(model: string | undefined) {
  const m = (model || "").toLowerCase();
  if (m.includes("2024-05-13") && !m.includes("mini")) return RATES["gpt-4o-2024-05-13"];
  if (m.includes("mini")) return RATES["gpt-4o-mini"];
  if (m.includes("sonar-pro")) return RATES["sonar-pro"];
  if (m.includes("sonar")) return RATES["sonar"];
  return RATES["gpt-4o"];
}

export interface MeterContext {
  feature: string;
  userId?: string | null;
  personId?: string | null;
}

// deno-lint-ignore no-explicit-any
export function meterAi(res: any, ctx: MeterContext): void {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key || !res) return;
    const p = Number(res?.usage?.prompt_tokens ?? 0) || 0;
    const c = Number(res?.usage?.completion_tokens ?? 0) || 0;
    // Price and log the model that actually answered, not the name we asked for.
    const model = res?.served_model || res?.model || null;
    const r = rateFor(model ?? undefined);
    const row = {
      user_id: ctx.userId || null,
      person_id: ctx.personId || null,
      feature: ctx.feature,
      vendor: res?.vendor ?? null,
      model,
      prompt_tokens: p,
      completion_tokens: c,
      est_cost_usd: Number(((p * r.in + c * r.out) / 1_000_000).toFixed(6)),
    };
    const job = fetch(`${url}/rest/v1/ai_usage_events`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    }).then(async (r) => {
      if (!r.ok) {
        // A bad person_id (FK) should not lose the count: retry without it.
        if (row.person_id) {
          await fetch(`${url}/rest/v1/ai_usage_events`, {
            method: "POST",
            headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
            body: JSON.stringify({ ...row, person_id: null }),
          }).catch(() => {});
        }
      }
    }).catch(() => {});
    // deno-lint-ignore no-explicit-any
    const er = (globalThis as any).EdgeRuntime;
    if (er?.waitUntil) er.waitUntil(job);
  } catch (_) { /* never throw */ }
}

// Reads the account id from a Supabase JWT without verifying it.
// Only used to label usage rows; the gateway has already verified the JWT.
export function jwtSub(authHeader: string | null | undefined): string | null {
  try {
    const tok = (authHeader || "").replace(/^Bearer\s+/i, "");
    const part = tok.split(".")[1];
    if (!part) return null;
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return typeof json.sub === "string" ? json.sub : null;
  } catch (_) {
    return null;
  }
}
