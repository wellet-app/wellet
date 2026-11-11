// supabase/functions/delete-account/index.ts
//
// Hard-deletes a Wellet account. Called by the iOS Settings "Delete account"
// screen and by the web Settings sheet.
//
// Apple App Review Guideline 5.1.1(v): an app that supports account creation
// must let people initiate deletion of the account, and its associated data,
// from inside the app.
// https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion/
//
// Auth: user access token (Authorization: Bearer <token>). verify_jwt is off
// at the gateway so browser preflight works; the token is checked here with
// auth.getUser before anything is touched.
//
// Body (either shape is accepted):
//   { "confirm": "DELETE_MY_ACCOUNT" }   iOS
//   { "confirmation": "DELETE" }         web (assets/wellet.js)
//
// Order:
//   1. Collect the caller's people ids and sharing link ids.
//   2. Ask Terra to stop sending data for the caller's wearable connections.
//   3. Delete Apple Health samples the caller shared into someone else's
//      record (rows tied to the caller's person_data_links).
//   4. Delete person_id tables for the caller's people, then user_id tables
//      (people last). FK cascades remove anything left under people and
//      auth.users.
//   5. Delete rows in other tables that point at the caller, and clear
//      "acted on by" style references on rows that belong to other people,
//      so auth.users deletion is not blocked by NO ACTION foreign keys.
//   6. Remove every storage object under <user_id>/ in every private bucket.
//   7. Write an ops event (user id only, no email) and delete auth.users.
//
// Response: { ok, success, summary }. success is kept for the web client.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// person_id tables, cleared for the caller's people before people rows go.
// Most also cascade from people; listing them keeps counts in the summary.
const PERSON_ID_TABLES = [
  "wishes",
  "wearable_observations",
  "vitals",
  "update_me_summaries",
  "observation_series",
  "medications",
  "lab_results",
  "health_events",
  "documents",
  "ehr_sync_schedule",
  "data_source_invites_pending",
  "data_source_invites",
  "connection_requests",
  "person_data_links",
  "person_care_team_overrides",
  "person_care_team",
  "care_circle_shares",
  "allergies",
];

// user_id tables. people is last; it is the parent of the person_id tables.
const USER_ID_TABLES = [
  "anon_sessions",
  "try_funnel_events",
  "signup_error_log",
  "sms_log",
  "weekly_digest_log",
  "notifications",
  "notification_preferences",
  "push_subscriptions",
  "feedback",
  "bug_reports",
  "contacts",
  "resource_card_events",
  "hospital_connect_requests",
  "user_saved_resources",
  "medication_logs",
  "medication_reminders",
  "health_export_jobs",
  "program_export_jobs",
  "visit_attachments",
  "family_records",
  "family_history_imports",
  "family_member_conditions",
  "family_members",
  "hereditary_pattern_reports",
  "ask_conversations",
  "care_log_entries",
  "shares",
  "stripe_subscriptions",
  "subscriptions",
  "terra_connections",
  "ehr_sync_log",
  "ehr_sync_progress",
  "ehr_source_events",
  "ehr_connections",
  "care_signal_watches",
  "care_circle_members",
  "care_archives",
  "check_ins",
  "user_passkeys",
  "passkey_challenges",
  "people",
];

// Rows in other tables that exist because of the caller. Deleted.
const DELETE_BY_COLUMN: Array<{ table: string; column: string }> = [
  { table: "care_circle_share_replies", column: "author_user_id" },
  { table: "care_circle_shares", column: "sender_user_id" },
  { table: "care_circle_shares", column: "recipient_user_id" },
  { table: "data_source_invites", column: "caregiver_user_id" },
  { table: "data_source_invites", column: "consumed_by_user_id" },
  { table: "data_source_invites_pending", column: "caregiver_user_id" },
  { table: "connection_requests", column: "caregiver_user_id" },
  { table: "care_signals", column: "owner_user_id" },
  { table: "person_data_links", column: "sharer_user_id" },
];

// References on rows that belong to someone else. Cleared, not deleted.
// Several are NO ACTION foreign keys that would block auth.users deletion.
const CLEAR_COLUMN: Array<{ table: string; column: string }> = [
  { table: "care_signals", column: "acted_on_by" },
  { table: "wishes", column: "confirmed_by" },
  { table: "care_circle_members", column: "invited_by" },
  { table: "person_data_links", column: "revoked_by" },
  { table: "person_care_team_overrides", column: "created_by_user_id" },
];

interface DeleteSummary {
  user_id: string;
  table_deletes: Record<string, number>;
  storage_deletes: Record<string, number>;
  terra_deauth: Array<{ status: number; ok: boolean }>;
  errors: string[];
}

Deno.serve(async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);
  const json = (payload: unknown, status = 200) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const auth = req.headers.get("authorization") || "";
  if (!auth.toLowerCase().startsWith("bearer ")) {
    return json({ error: "missing bearer token" }, 401);
  }
  const userJwt = auth.slice("bearer ".length).trim();

  const anon = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });
  const { data: userData, error: userErr } = await anon.auth.getUser(userJwt);
  if (userErr || !userData?.user?.id) return json({ error: "invalid token" }, 401);
  const userId: string = userData.user.id;
  const userEmail: string = (userData.user.email || "").toLowerCase();

  let body: { confirm?: string; confirmation?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  const confirmed = body.confirm === "DELETE_MY_ACCOUNT" || body.confirmation === "DELETE";
  if (!confirmed) {
    return json({ error: "Send confirm: DELETE_MY_ACCOUNT to delete this account." }, 400);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const summary: DeleteSummary = {
    user_id: userId,
    table_deletes: {},
    storage_deletes: {},
    terra_deauth: [],
    errors: [],
  };
  const count = (key: string, n: number | null) => {
    summary.table_deletes[key] = (summary.table_deletes[key] || 0) + (n ?? 0);
  };

  // 1. People and sharing links owned by the caller.
  const { data: ownedPeople, error: peopleErr } = await admin
    .from("people").select("id").eq("user_id", userId);
  if (peopleErr) summary.errors.push(`people select: ${peopleErr.message}`);
  const personIds = (ownedPeople || []).map((r: { id: string }) => r.id);

  const { data: links, error: linksErr } = await admin
    .from("person_data_links").select("id").eq("sharer_user_id", userId);
  if (linksErr) summary.errors.push(`person_data_links select: ${linksErr.message}`);
  const linkIds = (links || []).map((r: { id: string }) => r.id);

  // 2. Terra: stop the vendor feed before the connection rows go.
  const { data: terraRows } = await admin
    .from("terra_connections").select("terra_user_id").eq("user_id", userId);
  for (const row of terraRows || []) {
    if (!row?.terra_user_id) continue;
    summary.terra_deauth.push(await terraDeauth(row.terra_user_id));
  }

  // 3. Apple Health samples the caller shared into another caregiver's record.
  if (linkIds.length > 0) {
    const { count: n, error } = await admin
      .from("wearable_observations").delete({ count: "exact" }).in("link_id", linkIds);
    if (error) summary.errors.push(`wearable_observations by link: ${error.message}`);
    else count("wearable_observations.shared", n);
  }

  // 4a. person_id tables for the caller's people.
  if (personIds.length > 0) {
    for (const t of PERSON_ID_TABLES) {
      const { count: n, error } = await admin
        .from(t).delete({ count: "exact" }).in("person_id", personIds);
      if (error) summary.errors.push(`${t} by person_id: ${error.message}`);
      else count(t, n);
    }
  }

  // 5 (before people). Clear references on other people's rows.
  for (const { table, column } of CLEAR_COLUMN) {
    const { error } = await admin.from(table).update({ [column]: null }).eq(column, userId);
    if (error) summary.errors.push(`${table}.${column} clear: ${error.message}`);
  }
  for (const { table, column } of DELETE_BY_COLUMN) {
    const { count: n, error } = await admin
      .from(table).delete({ count: "exact" }).eq(column, userId);
    if (error) summary.errors.push(`${table}.${column} delete: ${error.message}`);
    else count(`${table}.${column}`, n);
  }

  // 4b. user_id tables, people last.
  for (const t of USER_ID_TABLES) {
    const { count: n, error } = await admin
      .from(t).delete({ count: "exact" }).eq("user_id", userId);
    if (error) summary.errors.push(`${t} by user_id: ${error.message}`);
    else count(t, n);
  }

  // Ops contact row matched by email when it was never linked to the user id.
  if (userEmail) {
    const { count: n, error } = await admin
      .from("contacts").delete({ count: "exact" }).ilike("email", userEmail);
    if (error) summary.errors.push(`contacts by email: ${error.message}`);
    else count("contacts.email", n);
  }

  // 6. Storage under <userId>/ in every bucket.
  const { data: buckets } = await admin.storage.listBuckets();
  for (const b of buckets || []) {
    try {
      summary.storage_deletes[b.id] = await deleteFolder(admin, b.id, userId);
    } catch (e) {
      summary.errors.push(`storage ${b.id}: ${(e as Error).message}`);
    }
  }

  // 7. Ops event without the email, then the auth user.
  const rows = Object.values(summary.table_deletes).reduce((a, b) => a + b, 0);
  await admin.from("wellet_ops_events").insert({
    event_type: "account_deleted",
    severity: summary.errors.length > 0 ? "high" : "info",
    summary: `Account deleted: ${userId}, ${rows} rows, ${summary.errors.length} errors`,
    source: "delete_account_edge_fn",
    payload: summary as unknown as Record<string, unknown>,
  });

  const { error: authDelErr } = await admin.auth.admin.deleteUser(userId, false);
  if (authDelErr) {
    summary.errors.push(`auth.users delete: ${authDelErr.message}`);
    return json({ ok: false, success: false, error: "Could not finish deleting the account.", summary }, 500);
  }

  return json({ ok: true, success: true, summary }, 200);
});

async function terraDeauth(terraUserId: string): Promise<{ ok: boolean; status: number }> {
  const apiKey = Deno.env.get("TERRA_API_KEY");
  const devId = Deno.env.get("TERRA_DEV_ID");
  if (!apiKey || !devId) return { ok: false, status: 0 };
  try {
    const res = await fetch(
      "https://api.tryterra.co/v2/auth/deauthenticateUser?user_id=" + encodeURIComponent(terraUserId),
      { method: "DELETE", headers: { "dev-id": devId, "x-api-key": apiKey } },
    );
    await res.text().catch(() => "");
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// Removes every object under prefix/, walking subfolders. Returns the count.
// Paths are collected first, then removed, so paging is not disturbed.
async function deleteFolder(
  // deno-lint-ignore no-explicit-any
  admin: any,
  bucket: string,
  prefix: string,
): Promise<number> {
  const files: string[] = [];
  const stack = [prefix];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (let offset = 0; ; offset += 1000) {
      const { data: items, error } = await admin.storage
        .from(bucket).list(dir, { limit: 1000, offset });
      if (error || !items || items.length === 0) break;
      for (const item of items) {
        if (item.id === null) stack.push(`${dir}/${item.name}`);
        else files.push(`${dir}/${item.name}`);
      }
      if (items.length < 1000) break;
    }
  }
  for (let i = 0; i < files.length; i += 500) {
    const { error } = await admin.storage.from(bucket).remove(files.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  return files.length;
}
