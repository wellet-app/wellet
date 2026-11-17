// pause.ts: a guard against scripts and bots, not a usage limit.
//
// Ask Wellet has no monthly cap on any plan. This only pauses an account
// that sends more questions in one hour than a person could type
// (ASK_PAUSE_PER_HOUR, default 200). The pause lifts on its own as the
// hour rolls forward. Counts come from public.ai_usage_events, which
// holds token counts only, never question or answer text.
//
// It fails open: if the count can't be read, the question goes through.

export const DEFAULT_PER_HOUR = 200;
const COUNTED_FEATURES = ["ask", "ask_watch"]; // one row per question

export function pauseThreshold(raw: string | undefined | null): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 50 ? Math.floor(n) : DEFAULT_PER_HOUR;
}

export function isPaused(countLastHour: number | null, threshold: number): boolean {
  if (countLastHour === null) return false;
  return countLastHour >= threshold;
}

// Returns the number of questions this account sent in the last hour,
// or null when it can't tell (no account id, network or database error).
export async function countLastHour(
  userId: string | null,
  fetchImpl: typeof fetch = fetch,
  now: Date = new Date(),
): Promise<number | null> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key || !userId) return null;
    const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
    const q = `${url}/rest/v1/ai_usage_events?select=id` +
      `&user_id=eq.${encodeURIComponent(userId)}` +
      `&feature=in.(${COUNTED_FEATURES.join(",")})` +
      `&created_at=gte.${encodeURIComponent(since)}`;
    const r = await fetchImpl(q, {
      method: "HEAD",
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact" },
    });
    if (!r.ok) return null;
    const range = r.headers.get("content-range") ?? ""; // "0-24/25" or "*/0"
    const total = Number(range.split("/")[1]);
    return Number.isFinite(total) ? total : null;
  } catch (_) {
    return null;
  }
}

export const PAUSE_MESSAGE =
  "Wellet is taking a short pause on questions for this account. Please try again in a little while.";
