// allowance.ts — free-plan allowances for Wellet 1.1.
//
// Free plan (approved Nov 13, 2026):
//   ask            5 questions a month
//   document_read  3 document reads a month
//   home_summary   first summary for each loved one
// Wellet AI ($10/month) removes all three limits.
// Viewing, sharing, exporting and the emergency summary are never limited,
// so nothing here is called from those functions.
//
// Counts come from public.ai_usage_events (written by meter.ts), so a call
// that failed before reaching the AI never uses up an allowance.
//
// Enforcement is OFF unless the FREE_LIMITS_ENFORCED secret is "true".
// While it is off, checkAllowance always allows and reports the counts,
// so Wellet stays free while we launch.

export type AllowanceFeature = "ask" | "document_read" | "home_summary";

export const FREE_LIMITS: Record<AllowanceFeature, number> = {
  ask: 5,
  document_read: 3,
  home_summary: 1, // per loved one, lifetime
};

// Statuses in public.subscriptions that include Wellet AI.
const PAID_STATUSES = ["active", "trialing", "granted"];

export interface Allowance {
  feature: AllowanceFeature;
  enforced: boolean;
  plan: "free" | "wellet_ai";
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null;
  allowed: boolean;
  resets_on: string | null; // YYYY-MM-DD, America/New_York; null for summaries
}

export function limitsEnforced(): boolean {
  return (Deno.env.get("FREE_LIMITS_ENFORCED") ?? "").toLowerCase() === "true";
}

function rest(path: string, init: RequestInit = {}) {
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, ...(init.headers ?? {}) },
  });
}

// First day of the current and next month in America/New_York, as UTC ISO.
export function monthWindow(now = new Date()): { start: string; resetsOn: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit",
  }).formatToParts(now);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  // Midnight Eastern = 05:00Z (EST) or 04:00Z (EDT). Use 04:00Z so a
  // question asked just after midnight on the 1st always counts toward
  // the new month; the hour of overlap in winter favors the caregiver.
  const start = new Date(Date.UTC(y, m - 1, 1, 4, 0, 0)).toISOString();
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  const resetsOn = `${ny}-${String(nm).padStart(2, "0")}-01`;
  return { start, resetsOn };
}

async function countEvents(q: string): Promise<number> {
  const r = await rest(`ai_usage_events?select=id&${q}`, {
    method: "HEAD",
    headers: { Prefer: "count=exact", Range: "0-0" },
  });
  const cr = r.headers.get("content-range") ?? "";
  const total = Number(cr.split("/")[1]);
  return Number.isFinite(total) ? total : 0;
}

export async function hasWelletAi(userId: string): Promise<boolean> {
  try {
    const r = await rest(
      `subscriptions?select=status,current_period_end&user_id=eq.${encodeURIComponent(userId)}` +
        `&status=in.(${PAID_STATUSES.join(",")})&limit=5`,
    );
    if (!r.ok) return false;
    const rows = (await r.json()) as { status: string; current_period_end: string | null }[];
    const now = Date.now();
    return rows.some((s) =>
      s.status === "granted" || !s.current_period_end || new Date(s.current_period_end).getTime() > now
    );
  } catch (_) {
    return false;
  }
}

export async function checkAllowance(
  userId: string | null,
  feature: AllowanceFeature,
  personId?: string | null,
): Promise<Allowance> {
  const enforced = limitsEnforced();
  const limit = FREE_LIMITS[feature];
  const open: Allowance = {
    feature, enforced, plan: "free", used: 0, limit, remaining: limit, allowed: true,
    resets_on: null,
  };
  // No account id (should not happen behind verify_jwt): never block.
  if (!userId) return open;
  try {
    const paid = await hasWelletAi(userId);
    const uid = `user_id=eq.${encodeURIComponent(userId)}`;
    let used = 0;
    let resetsOn: string | null = null;
    if (feature === "home_summary") {
      if (!personId) return { ...open, plan: paid ? "wellet_ai" : "free" };
      used = await countEvents(`feature=eq.home_summary&person_id=eq.${encodeURIComponent(personId)}`);
    } else {
      const w = monthWindow();
      resetsOn = w.resetsOn;
      used = await countEvents(`feature=eq.${feature}&${uid}&created_at=gte.${encodeURIComponent(w.start)}`);
    }
    if (paid) {
      return { feature, enforced, plan: "wellet_ai", used, limit: null, remaining: null, allowed: true, resets_on: resetsOn };
    }
    const remaining = Math.max(0, limit - used);
    return {
      feature, enforced, plan: "free", used, limit, remaining,
      allowed: !enforced || remaining > 0,
      resets_on: resetsOn,
    };
  } catch (_) {
    // A counting failure must never block a caregiver.
    return open;
  }
}

// Standard 402 body the iOS app reads to show the right sheet.
export function limitResponse(a: Allowance, cors: Record<string, string>): Response {
  return new Response(
    JSON.stringify({
      error: "free_limit",
      code: "free_limit",
      feature: a.feature,
      used: a.used,
      limit: a.limit,
      resets_on: a.resets_on,
    }),
    { status: 402, headers: { ...cors, "Content-Type": "application/json" } },
  );
}
