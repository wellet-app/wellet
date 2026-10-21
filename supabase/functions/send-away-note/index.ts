// send-away-note: monthly "what happened in the records" email (quiet mode, 2026-10-08; v4 2026-10-21 counts by clinical date).
//
// Deterministic counts only. No AI, no lab values, no clinician names.
// Opt-in via notification_preferences.away_note = true.
//
// Modes:
//   { mode: "cron" }                 service role. Previous calendar month (UTC).
//   { mode: "single", user_id, window?: "last30" }  service role. One user.
//
// Auth: service-role key, verified (see isAuthorized).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Brevo HTTP API (same as send-share-email). The SMTP credentials returned
// 535 auth failures on 2026-10-08.
const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") || "";
const APP_URL = "https://mywellet.com";

// Same verification as background-ehr-sync: exact match with this function's
// service key, or a token Supabase Auth's admin endpoint accepts.
const verifiedTokens = new Set<string>();
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function isAuthorized(req: Request): Promise<boolean> {
  const auth = req.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;
  if (SERVICE_ROLE && timingSafeEqual(token, SERVICE_ROLE)) return true;
  if (verifiedTokens.has(token)) return true;
  try {
    const res = await fetch(`${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/admin/users?page=1&per_page=1`, {
      headers: { apikey: token, Authorization: `Bearer ${token}` },
    });
    await res.body?.cancel();
    if (res.status === 200) { verifiedTokens.add(token); return true; }
    return false;
  } catch { return false; }
}

type Svc = ReturnType<typeof createClient>;

interface PersonNote {
  name: string;
  visits: string[];      // ISO dates
  meds: number;
  labs: number;
  labDates: string[];
  notes: number;
  noteKinds: Record<string, number>;
  currentAsOf: string | null;
}

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json" } });

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

// Clinical dates are calendar days. Format the YYYY-MM-DD part in UTC so a
// midnight-UTC timestamp is not shown as the previous day in Eastern time.
function fmtDay(iso: string): string {
  const day = String(iso).slice(0, 10);
  return new Date(day + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

// Timestamps such as last_synced_at are moments, so they use Eastern time.
function fmtMoment(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function windowFor(kind: string): { start: Date; end: Date; label: string } {
  const now = new Date();
  if (kind === "last30") {
    const start = new Date(now.getTime() - 30 * 86400000);
    return { start, end: now, label: "the last 30 days" };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const month = start.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  return { start, end, label: month };
}

async function buildPerson(svc: Svc, p: { id: string; name: string }, start: Date, end: Date): Promise<PersonNote> {
  const s = start.toISOString(), e = end.toISOString();
  const [visits, meds, labs, notes, conns] = await Promise.all([
    // v4: count by when the visit, lab or note happened, not by when it was imported.
    // A reconnect or a larger import can bring in years of history at once.
    svc.from("health_events").select("event_date").eq("person_id", p.id).eq("event_type", "visit").gte("event_date", s).lt("event_date", e).order("event_date", { ascending: false }).limit(1000),
    svc.from("medications").select("id", { count: "exact", head: true }).eq("person_id", p.id).gte("start_date", s.slice(0, 10)).lt("start_date", e.slice(0, 10)),
    svc.from("lab_results").select("effective_date").eq("person_id", p.id).gte("effective_date", s).lt("effective_date", e).limit(5000),
    svc.from("health_events").select("title").eq("person_id", p.id).eq("event_type", "note").gte("event_date", s).lt("event_date", e).limit(1000),
    svc.from("ehr_connections").select("last_synced_at").eq("person_id", p.id).eq("status", "connected").order("last_synced_at", { ascending: false }).limit(1),
  ]);
  const labRows = (labs.data || []) as { effective_date: string | null }[];
  const labDates = Array.from(new Set(labRows.map((r) => r.effective_date).filter(Boolean).map((d) => String(d).slice(0, 10)))).sort();
  return {
    name: p.name,
    visits: ((visits.data || []) as { event_date: string | null }[]).map((v) => v.event_date).filter(Boolean).map((d) => String(d).slice(0, 10)) as string[],
    meds: meds.count || 0,
    labs: labRows.length,
    labDates,
    notes: (notes.data || []).length,
    noteKinds: kindCounts((notes.data || []) as { title: string | null }[]),
    currentAsOf: (conns.data?.[0] as { last_synced_at?: string } | undefined)?.last_synced_at || null,
  };
}

function personBlock(n: PersonNote): string {
  const rows: string[] = [];
  const row = (title: string, sub: string) =>
    `<tr><td style="padding:10px 0;border-top:1px solid #ECECE6;font:15px/1.4 Inter,Arial,sans-serif;color:#1C2826">${esc(title)}<div style="font-size:13px;color:#6B7773">${esc(sub)}</div></td></tr>`;
  if (n.visits.length) {
    // Distinct visit days, newest first.
    const uniqueDays = Array.from(new Set(n.visits)).sort().reverse();
    const days = uniqueDays.slice(0, 4).map(fmtDay).join(", ");
    rows.push(row(`${n.visits.length} visit${n.visits.length === 1 ? "" : "s"}`, uniqueDays.length > 4 ? `Most recent: ${days}` : days));
  }
  if (n.meds) rows.push(row(`${n.meds} medication${n.meds === 1 ? "" : "s"} added to the list`, "Open Wellet to see the details."));
  if (n.labs) {
    const d = n.labDates.length === 1 ? `From ${fmtDay(n.labDates[0])}` : `Across ${n.labDates.length} dates`;
    rows.push(row(`${n.labs} lab result${n.labs === 1 ? "" : "s"}`, `${d}. Open Wellet to see the values and ranges.`));
  }
  // Epic note titles are source labels such as "Patient Message", "Telephone" and "Refill".
  for (const [kind, count] of Object.entries(n.noteKinds)) {
    rows.push(row(noteLabel(kind, count), `Open Wellet to read ${count === 1 ? "it" : "them"}.`));
  }
  const asOf = n.currentAsOf ? `<div style="font:12px/1.5 Inter,Arial,sans-serif;color:#6B7773;margin-top:6px">Records current as of ${esc(fmtMoment(n.currentAsOf))}.</div>` : "";
  return `<div style="font:600 17px/1.3 Georgia,serif;color:#11443B;margin:18px 0 4px">${esc(n.name)}</div><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows.join("")}</table>${asOf}`;
}

const NOTE_KINDS: Record<string, [string, string]> = {
  message: ["message", "messages"],
  call: ["phone call", "phone calls"],
  refill: ["refill request", "refill requests"],
  other: ["other note", "other notes"],
};
function noteKind(title: string | null): string {
  const t = (title || "").toLowerCase();
  if (t.includes("message")) return "message";
  if (t.includes("telephone") || t.includes("phone")) return "call";
  if (t.includes("refill")) return "refill";
  return "other";
}
function kindCounts(rows: { title: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(NOTE_KINDS)) {
    const c = rows.filter((r) => noteKind(r.title) === k).length;
    if (c) out[k] = c;
  }
  return out;
}
function noteLabel(kind: string, count: number): string {
  const [one, many] = NOTE_KINDS[kind] || NOTE_KINDS.other;
  return `${count} ${count === 1 ? one : many}`;
}

function hasNews(n: PersonNote) { return n.visits.length + n.meds + n.labs + n.notes > 0; }

function buildHtml(firstName: string, label: string, people: PersonNote[]): string {
  const names = people.map((p) => p.name);
  const who = names.length === 1 ? `${esc(names[0])}'s records` : "your loved ones' records";
  return `<!doctype html><html><body style="margin:0;background:#E7E7DF;padding:24px 12px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:14px" cellspacing="0" cellpadding="0"><tr><td style="padding:24px">
<img src="https://getwellet.com/assets/wellet-logo-email.png" width="120" height="34" alt="Wellet" style="display:block;border:0;outline:none;text-decoration:none;width:120px;height:34px">
<p style="font:15px/1.55 Inter,Arial,sans-serif;color:#3A4A45;margin:14px 0 0">Hi ${esc(firstName)}. Here's what happened in ${who} in ${esc(label)}, so you have the context if you need it.</p>
${people.map(personBlock).join("")}
<div style="margin-top:22px"><a href="${APP_URL}" style="display:block;text-align:center;background:#11443B;color:#ffffff;text-decoration:none;border-radius:12px;padding:13px;font:500 15px Inter,Arial,sans-serif">See it in Wellet</a></div>
<p style="font:12px/1.5 Inter,Arial,sans-serif;color:#6B7773;margin:16px 0 0">You get this note once a month when something new happens in these records. To stop it, email hello@getwellet.com.</p>
</td></tr></table></td></tr></table></body></html>`;
}

async function runForUser(svc: Svc, userId: string, email: string, kind: string, source: string) {
  const { start, end, label } = windowFor(kind);
  const { data: people } = await svc.from("people").select("id, name, is_self").eq("user_id", userId).order("sort_order", { ascending: true });
  const lovedOnes = ((people || []) as { id: string; name: string; is_self: boolean | null }[]).filter((p) => !p.is_self);
  const notes: PersonNote[] = [];
  for (const p of lovedOnes) {
    const n = await buildPerson(svc, p, start, end);
    if (hasNews(n)) notes.push(n);
  }
  if (!notes.length) return { status: "skipped", reason: "nothing_new" };
  if (!BREVO_API_KEY) return { status: "failed", reason: "brevo_not_configured" };

  const { data: auser } = await svc.auth.admin.getUserById(userId);
  const meta = (auser?.user?.user_metadata || {}) as Record<string, string>;
  // Auth metadata usually has no name. Fall back to the caregiver's own Person row.
  let nameSource = meta.first_name || meta.full_name || meta.name || "";
  if (!nameSource) {
    const { data: selfRow } = await svc.from("people").select("name").eq("user_id", userId).eq("is_self", true).limit(1).maybeSingle();
    nameSource = (selfRow as { name?: string } | null)?.name || "";
  }
  const firstName = nameSource.trim().split(/\s+/)[0] || "there";
  const subject = notes.length === 1 ? `What happened in ${notes[0].name}'s records in ${label}` : `What happened in your loved ones' records in ${label}`;

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      sender: { name: "Wellet", email: "hello@getwellet.com" },
      to: [{ email }],
      subject,
      htmlContent: buildHtml(firstName, label, notes),
      tags: ["away-note"],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { status: "failed", reason: `brevo_${res.status}`, detail: t.slice(0, 200) };
  }

  if (source === "cron") {
    await svc.from("notification_preferences").update({ last_away_note_sent_at: new Date().toISOString() }).eq("user_id", userId);
  }
  return { status: "sent", people: notes.length };
}

Deno.serve(async (req: Request) => {
  try {
    if (!(await isAuthorized(req))) return json({ error: "Service role required" }, 401);
    const body = await req.json().catch(() => ({}));
    const svc = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (body.mode === "single") {
      if (!body.user_id) return json({ error: "user_id required" }, 400);
      const { data: u } = await svc.auth.admin.getUserById(body.user_id);
      if (!u?.user?.email) return json({ error: "User not found" }, 404);
      return json(await runForUser(svc, body.user_id, u.user.email, body.window || "month", "single"));
    }

    if (body.mode !== "cron") return json({ error: "Unknown mode" }, 400);
    const { data: prefs, error } = await svc.from("notification_preferences").select("user_id, last_away_note_sent_at").eq("away_note", true);
    if (error) return json({ error: error.message }, 500);
    const cutoff = new Date(Date.now() - 20 * 86400000);
    const results: unknown[] = [];
    for (const p of prefs || []) {
      if (p.last_away_note_sent_at && new Date(p.last_away_note_sent_at) > cutoff) { results.push({ user_id: p.user_id, status: "skipped", reason: "recent" }); continue; }
      const { data: u } = await svc.auth.admin.getUserById(p.user_id);
      if (!u?.user?.email) continue;
      try { results.push({ user_id: p.user_id, ...(await runForUser(svc, p.user_id, u.user.email, "month", "cron")) }); }
      catch (e) { results.push({ user_id: p.user_id, status: "failed", reason: String((e as Error).message).slice(0, 200) }); }
    }
    return json({ ok: true, results });
  } catch (e) {
    return json({ error: String((e as Error).message).slice(0, 300) }, 500);
  }
});
