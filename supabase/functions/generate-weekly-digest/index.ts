// Weekly Digest edge function
// -----------------------------
// Sends a plain-language "what changed this week" email to opted-in users.
//
// Invocation modes:
//   { mode: "cron" }       — service-role only. Iterates all users with
//                            notification_preferences.weekly_digest = true and
//                            last_weekly_digest_sent_at older than 6 days (dedup).
//   { mode: "preview" }    — user JWT. Sends a one-off preview to the caller
//                            using this week's data. Does NOT bump
//                            last_weekly_digest_sent_at so the Sunday cron still
//                            fires normally.
//   { mode: "single", user_id } — service-role only, sends to one user.
//
// Auth:
//   cron / single → Authorization header must equal `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
//   preview       → Authorization header is a user JWT; we derive the caller
//
// Data window: last 7 calendar days (UTC).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { SMTPClient } from "https://deno.land/x/denomailer@1.6.0/mod.ts";
import { getCorsHeaders } from "../_shared/cors.ts";
import { aiChat } from "../_shared/azureOpenAI.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
// AI vendor + keys are now owned by ../_shared/azureOpenAI.ts.
// PHI-touching summaries route through Azure OpenAI (BAA-covered) with
// phi:true. The deterministic buildFallbackSummary path below stays as the
// safety net if the adapter call fails for any reason.
const SMTP_HOST = Deno.env.get("BREVO_SMTP_HOST") || "smtp-relay.brevo.com";
// Hardcoded to 465 (implicit TLS / SMTPS). denomailer 1.6 + tls:true on 587
// produces InvalidContentType (587 expects STARTTLS, not implicit TLS).
const SMTP_PORT = 465;
const SMTP_USER = Deno.env.get("BREVO_SMTP_USER") || "";
const SMTP_PASS = Deno.env.get("BREVO_SMTP_KEY") || "";

interface DigestContext {
  userEmail: string;
  userName: string | null;
  periodStart: string; // ISO date YYYY-MM-DD
  periodEnd: string;
  people: Array<{
    id: string;
    name: string;
    events: any[];
    labs: any[];
    meds: any[];
    vitals: any[];
  }>;
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const mode = (body.mode || "preview") as "cron" | "preview" | "single";
    const authHeader = req.headers.get("Authorization") || "";
    const service = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (mode === "cron" || mode === "single") {
      // Service role only. Accepts header `Bearer ${SERVICE_ROLE}`.
      if (authHeader !== `Bearer ${SERVICE_ROLE}`) {
        return json({ error: "Service role required" }, 401);
      }
    }

    if (mode === "preview") {
      // User JWT path.
      if (!authHeader) return json({ error: "Authorization required" }, 401);
      const anon = createClient(SUPABASE_URL, ANON_KEY, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error: userErr } = await anon.auth.getUser();
      if (userErr || !user) return json({ error: "Unauthorized" }, 401);

      const result = await runForUser(service, user.id, user.email || "", "manual_preview");
      return json(result);
    }

    if (mode === "single") {
      const userId = body.user_id;
      if (!userId) return json({ error: "user_id required" }, 400);
      const { data: auser } = await service.auth.admin.getUserById(userId);
      if (!auser?.user) return json({ error: "User not found" }, 404);
      const result = await runForUser(service, userId, auser.user.email || "", "manual_send");
      return json(result);
    }

    // mode === "cron"
    const { data: prefs, error: prefsErr } = await service
      .from("notification_preferences")
      .select("user_id, weekly_digest, last_weekly_digest_sent_at")
      .eq("weekly_digest", true);

    if (prefsErr) {
      console.error("cron: failed to load prefs", prefsErr);
      return json({ error: prefsErr.message }, 500);
    }

    const results: any[] = [];
    const sixDaysAgo = new Date(Date.now() - 6 * 24 * 3600 * 1000);

    for (const p of prefs || []) {
      // Dedup: skip if we sent one in the last 6 days.
      if (
        p.last_weekly_digest_sent_at &&
        new Date(p.last_weekly_digest_sent_at) > sixDaysAgo
      ) {
        results.push({ user_id: p.user_id, status: "skipped_dup" });
        continue;
      }
      try {
        const { data: auser } = await service.auth.admin.getUserById(p.user_id);
        if (!auser?.user?.email) {
          results.push({ user_id: p.user_id, status: "skipped_no_email" });
          continue;
        }
        const r = await runForUser(service, p.user_id, auser.user.email, "cron");
        results.push({ user_id: p.user_id, ...r });
      } catch (e) {
        console.error("cron: user failed", p.user_id, e);
        results.push({
          user_id: p.user_id,
          status: "failed",
          error: (e as Error).message,
        });
      }
    }

    return json({ success: true, results, processed: results.length });
  } catch (e) {
    console.error("generate-weekly-digest error:", e);
    return json({ error: (e as Error).message || "Internal error" }, 500);
  }
});

async function runForUser(
  service: ReturnType<typeof createClient>,
  userId: string,
  userEmail: string,
  source: "cron" | "manual_preview" | "manual_send",
) {
  const periodEnd = new Date();
  const periodStart = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const periodStartISO = periodStart.toISOString().slice(0, 10);
  const periodEndISO = periodEnd.toISOString().slice(0, 10);

  // People this user manages
  const { data: people } = await service
    .from("people")
    .select("id, name")
    .eq("user_id", userId)
    .order("sort_order", { ascending: true });

  if (!people || people.length === 0) {
    await logDigest(service, {
      user_id: userId,
      trigger_source: source,
      period_start: periodStartISO,
      period_end: periodEndISO,
      status: "skipped_empty",
      people_count: 0,
      events_count: 0,
    });
    return { status: "skipped_empty", reason: "no_people" };
  }

  const ctx: DigestContext = {
    userEmail,
    userName: null,
    periodStart: periodStartISO,
    periodEnd: periodEndISO,
    people: [],
  };

  let totalEvents = 0;
  for (const person of people) {
    const [events, labs, meds, vitals] = await Promise.all([
      service
        .from("health_events")
        .select("event_type, title, description, event_date, source")
        .eq("person_id", person.id)
        .gte("event_date", periodStart.toISOString())
        .order("event_date", { ascending: false })
        .limit(25),
      service
        .from("lab_results")
        .select("test_name, value, unit, reference_range, flag, observed_at, source")
        .eq("person_id", person.id)
        .gte("observed_at", periodStart.toISOString())
        .order("observed_at", { ascending: false })
        .limit(25),
      service
        .from("medications")
        .select("name, dose, frequency, active, created_at, updated_at")
        .eq("person_id", person.id)
        .or(
          `created_at.gte.${periodStart.toISOString()},updated_at.gte.${periodStart.toISOString()}`,
        )
        .limit(25),
      service
        .from("vitals")
        .select("kind, value, unit, observed_at, source")
        .eq("person_id", person.id)
        .gte("observed_at", periodStart.toISOString())
        .order("observed_at", { ascending: false })
        .limit(25),
    ]);

    const e = events.data || [];
    const l = labs.data || [];
    const m = meds.data || [];
    const v = vitals.data || [];
    totalEvents += e.length + l.length + m.length + v.length;

    ctx.people.push({
      id: person.id,
      name: person.name,
      events: e,
      labs: l,
      meds: m,
      vitals: v,
    });
  }

  if (totalEvents === 0) {
    await logDigest(service, {
      user_id: userId,
      trigger_source: source,
      period_start: periodStartISO,
      period_end: periodEndISO,
      status: "skipped_empty",
      people_count: people.length,
      events_count: 0,
    });
    return { status: "skipped_empty", reason: "no_activity_this_week" };
  }

  // Summarize via Azure OpenAI (falls back to deterministic copy on any
  // adapter error — network, vendor guardrail trip, deployment misconfig).
  // The fallback path is what keeps the Sunday digest sending even if AI is
  // briefly unavailable, so do not remove it.
  let summaryText = "";
  try {
    summaryText = await generateAISummary(ctx);
  } catch (e) {
    console.error("AI summary failed, falling back to deterministic:", e);
    summaryText = "";
  }
  if (!summaryText) {
    summaryText = buildFallbackSummary(ctx);
  }

  // Send email via Brevo SMTP.
  if (!SMTP_USER || !SMTP_PASS) {
    await logDigest(service, {
      user_id: userId,
      trigger_source: source,
      period_start: periodStartISO,
      period_end: periodEndISO,
      status: "failed",
      people_count: people.length,
      events_count: totalEvents,
      summary_preview: summaryText.slice(0, 280),
      error_message: "SMTP credentials not configured",
    });
    return { status: "failed", reason: "smtp_not_configured" };
  }

  const subject = buildSubject(ctx, source);
  const html = buildDigestHtml(ctx, summaryText, source);

  const client = new SMTPClient({
    connection: {
      hostname: SMTP_HOST,
      port: SMTP_PORT,
      tls: true,
      auth: { username: SMTP_USER, password: SMTP_PASS },
    },
  });

  await client.send({
    // hello@getwellet.com is verified in Brevo; mywellet.com domain isn't auth'd yet.
    from: "Wellet <hello@getwellet.com>",
    to: userEmail,
    subject,
    content: "auto",
    html,
  });
  await client.close();

  // Only bump the dedup timestamp for cron + manual_send (not preview).
  if (source === "cron" || source === "manual_send") {
    await service
      .from("notification_preferences")
      .update({ last_weekly_digest_sent_at: new Date().toISOString() })
      .eq("user_id", userId);
  }

  await logDigest(service, {
    user_id: userId,
    trigger_source: source,
    period_start: periodStartISO,
    period_end: periodEndISO,
    status: "sent",
    people_count: people.length,
    events_count: totalEvents,
    summary_preview: summaryText.slice(0, 280),
  });

  return {
    status: "sent",
    people_count: people.length,
    events_count: totalEvents,
  };
}

async function logDigest(service: any, row: Record<string, any>) {
  try {
    await service.from("weekly_digest_log").insert(row);
  } catch (e) {
    console.error("weekly_digest_log insert failed:", e);
  }
}

function buildSubject(ctx: DigestContext, source: string): string {
  const prefix = source === "manual_preview" ? "Preview: " : "";
  const names = ctx.people.map((p) => p.name).slice(0, 2);
  const rest = ctx.people.length - names.length;
  let who = names.join(" & ");
  if (rest > 0) who += ` +${rest} more`;
  if (!who) who = "your care circle";
  return `${prefix}This week in Wellet — ${who}`;
}

function buildFallbackSummary(ctx: DigestContext): string {
  // Deterministic bullet summary if OpenAI is unavailable.
  const lines: string[] = [];
  for (const p of ctx.people) {
    const parts: string[] = [];
    if (p.events.length) parts.push(`${p.events.length} new event${p.events.length === 1 ? "" : "s"}`);
    if (p.labs.length) parts.push(`${p.labs.length} lab result${p.labs.length === 1 ? "" : "s"}`);
    if (p.meds.length) parts.push(`${p.meds.length} medication update${p.meds.length === 1 ? "" : "s"}`);
    if (p.vitals.length) parts.push(`${p.vitals.length} vital reading${p.vitals.length === 1 ? "" : "s"}`);
    if (parts.length) {
      lines.push(`For ${p.name}: ${parts.join(", ")}.`);
    }
  }
  if (!lines.length) lines.push("Nothing new this week.");
  lines.push("Open Wellet to review the details.");
  return lines.join("\n\n");
}

async function generateAISummary(ctx: DigestContext): Promise<string> {
  // Build a compact, structured context for the model.
  const segments: string[] = [];
  for (const p of ctx.people) {
    const s: string[] = [`=== ${p.name} ===`];
    if (p.events.length) {
      s.push("Health events:");
      p.events.slice(0, 15).forEach((e: any) => {
        const d = (e.event_date || "").slice(0, 10);
        s.push(
          `- [${d}] ${e.event_type || "event"}: ${e.title || ""}${e.description ? " — " + e.description : ""}${e.source ? ` (${e.source})` : ""}`,
        );
      });
    }
    if (p.labs.length) {
      s.push("Lab results:");
      p.labs.slice(0, 15).forEach((l: any) => {
        const d = (l.observed_at || "").slice(0, 10);
        s.push(
          `- [${d}] ${l.test_name}: ${l.value}${l.unit ? " " + l.unit : ""}${l.reference_range ? ` (ref ${l.reference_range})` : ""}${l.flag ? ` [${l.flag}]` : ""}`,
        );
      });
    }
    if (p.meds.length) {
      s.push("Medication changes:");
      p.meds.slice(0, 15).forEach((m: any) => {
        s.push(
          `- ${m.name}${m.dose ? " " + m.dose : ""}${m.frequency ? " " + m.frequency : ""}${m.active === false ? " [stopped]" : ""}`,
        );
      });
    }
    if (p.vitals.length) {
      s.push("Vitals:");
      p.vitals.slice(0, 15).forEach((v: any) => {
        const d = (v.observed_at || "").slice(0, 10);
        s.push(`- [${d}] ${v.kind}: ${v.value}${v.unit ? " " + v.unit : ""}`);
      });
    }
    segments.push(s.join("\n"));
  }

  const context = segments.join("\n\n");
  const systemPrompt =
    `You are Wellet's weekly digest writer. Write a caring, plain-language summary for a family caregiver about what changed in their loved one's health this week (${ctx.periodStart} to ${ctx.periodEnd}).

Rules:
- 2 to 4 short paragraphs. No bullet lists in the output.
- Do NOT give medical advice. Do NOT flag dosing errors or medication interactions. Wellet coordinates care; it does not practice medicine.
- Use gentle language: "noticed", "came in", "you added". Never say "track", "tracking", "monitor", or "keep tabs on".
- If nothing changed, say so plainly and suggest checking Wellet anyway.
- Use the person's first name. If multiple people, organize by person.
- Close with one concrete next step (e.g., "Might be worth asking about X at the next visit") — frame as a question for the care team, never instructions.
- Never recommend specific medications, dosages, or clinical actions.`;

  // PHI: weekly digest summarizes a loved one's health events, labs, meds,
  // and vitals. phi:true engages the adapter's assertVendorAllowedForPhi
  // guardrail — if WELLET_AI_VENDOR is ever flipped away from azure, this
  // call throws and the caller falls back to buildFallbackSummary.
  const result = await aiChat({
    model: "gpt-4o-mini",
    temperature: 0.3,
    max_tokens: 500,
    phi: true,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: context },
    ],
  });
  return (result.content || "").trim();
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDigestHtml(ctx: DigestContext, summary: string, source: string): string {
  const previewBanner = source === "manual_preview"
    ? `<div style="background:#FFF8E6;border:1px solid #F2D989;border-radius:10px;padding:10px 14px;font-size:12px;color:#7a5a1a;margin-bottom:20px;">This is a preview. Your regular weekly digest will arrive on Sundays.</div>`
    : "";

  const formattedSummary = esc(summary)
    .split(/\n\n+/)
    .map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:1.65;color:#333;">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");

  const peopleChips = ctx.people
    .map(
      (p) =>
        `<span style="display:inline-block;background:#F0F7F4;color:#446F5B;border-radius:999px;padding:4px 12px;font-size:12px;margin-right:6px;">${esc(p.name)}</span>`,
    )
    .join("");

  const prettyRange = `${ctx.periodStart} → ${ctx.periodEnd}`;

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>This week in Wellet</title>
</head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:'DM Sans',Arial,Helvetica,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:24px 16px;">
    <div style="background:white;border-radius:16px;padding:32px 28px;">
      <div style="font-family:'DM Serif Display',Georgia,serif;font-size:22px;color:#608F7C;margin-bottom:8px;">Wellet</div>
      <div style="font-size:12px;color:#888;margin-bottom:22px;">Weekly digest · ${esc(prettyRange)}</div>
      ${previewBanner}
      <div style="margin-bottom:18px;">${peopleChips}</div>
      ${formattedSummary}
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0;">
      <div style="font-size:12px;color:#666;line-height:1.6;">
        Wellet notices what changed in ${esc(ctx.people[0]?.name || "your care circle")}'s records so you can stop being the memory. This digest is informational — it does not give medical advice or flag dosing errors.
        <br><br>
        <a href="https://mywellet.com" style="color:#608F7C;text-decoration:none;">Open Wellet →</a>
      </div>
      <div style="font-size:11px;color:#999;line-height:1.6;text-align:center;margin-top:24px;">
        You're receiving this because your Wellet weekly digest is on.<br>
        <a href="https://mywellet.com/#settings" style="color:#608F7C;text-decoration:none;">Turn off weekly digest</a>
      </div>
    </div>
  </div>
</body>
</html>`;
}
