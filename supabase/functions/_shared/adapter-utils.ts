// Shared utilities for hospital directory adapters.
//
// Extracted verbatim from duke.ts as the first non-Duke adapter (UNC)
// goes in. Behavior is intentionally identical to the original Duke
// inline versions so the prep extraction is observably a no-op.
//
// Each helper here is small, pure, and side-effect-free except for
// timedFetch, which adds an AbortController timeout + a Wellet
// User-Agent header. Keep it that way — adapters compose these, they
// don't subclass.

const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT =
  "Wellet/1.0 (+https://getwellet.com; contact@getwellet.com) provider-directory-lookup";

/** Fetch with an 8s timeout and the Wellet UA stamped on every request. */
export async function timedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Split a display name like "Jane Smith, MD" into {first, last, credential}. */
export function splitName(display: string): { first: string; last: string; credential: string } {
  if (!display) return { first: "", last: "", credential: "" };
  const m = display.match(/^(.+?)(?:,\s*)?\b(MD|DO|DDS|DMD|PA-C|PA|NP|APRN|RN|PhD|PsyD|MSN|MPH|MBA)\b\.?\s*$/i);
  let core = display;
  let credential = "";
  if (m) {
    core = m[1].trim().replace(/,+$/, "").trim();
    credential = m[2].toUpperCase();
  }
  core = core.replace(/\s+/g, " ").trim();
  const parts = core.split(" ").filter(Boolean);
  if (parts.length === 0) return { first: "", last: "", credential };
  if (parts.length === 1) return { first: "", last: parts[0], credential };
  return { first: parts[0], last: parts[parts.length - 1], credential };
}

/** URL-safe slug: lowercase, ASCII-fold, dashes only. */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

/** Strip HTML tags and collapse whitespace. */
export function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

/** Decode the small set of HTML entities we actually see in directory pages. */
export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&rsquo;/g, "\u2019")
    .replace(/&lsquo;/g, "\u2018")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&nbsp;/g, " ");
}

/**
 * Format a US phone number as 555-555-5555.
 * Accepts any input; returns null if it can't be parsed as US 10/11-digit.
 */
export function formatPhoneUS(input: string): string | null {
  const d = input.replace(/\D/g, "");
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1")) {
    return `${d.slice(1, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
  }
  return null;
}
