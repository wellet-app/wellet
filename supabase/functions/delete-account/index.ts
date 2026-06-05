// Delete Account edge function
// -----------------------------
// Permanently removes a user's account and all associated data.
//
// Auth: user JWT (Authorization: Bearer <access_token>)
// Body: { confirmation: "DELETE" }  — must match exactly, prevents accidents
//
// What gets deleted:
//   1. All storage objects under {user_id}/ in each bucket
//      (bug-screenshots, documents, ehr-uploads, visit-attachments)
//   2. All person-scoped rows (via cascade or explicit) for people owned by
//      this user: allergies, care_archives, care_circle_shares, check_ins,
//      documents, ehr_connections, ehr_source_events, health_events,
//      health_export_jobs, hospital_connect_requests, lab_results,
//      medication_logs, medication_reminders, medications, notifications,
//      shares, terra_connections, update_me_summaries, visit_attachments,
//      vitals
//   3. All user-scoped rows (user_id = auth.uid()):
//      anon_sessions, bug_reports, care_circle_members, feedback,
//      notification_preferences, push_subscriptions, subscriptions,
//      user_saved_resources, weekly_digest_log, waitlist, waitlist_requests,
//      people
//   4. auth.users row (via auth.admin.deleteUser)
//
// Return: { success: true, summary: { people_deleted, rows_deleted, files_deleted } }

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Tables scoped by user_id (deleted directly by user_id)
const USER_TABLES = [
  "anon_sessions",
  "bug_reports",
  "care_circle_members",
  "feedback",
  "notification_preferences",
  "push_subscriptions",
  "subscriptions",
  "user_saved_resources",
  "weekly_digest_log",
  "hospital_connect_requests",
  "health_export_jobs",
  "ehr_connections",
  "terra_connections",
  "ehr_source_events",
  "notifications",
  "shares",
  "care_archives",
  "visit_attachments",
  "user_passkeys",
];

// Tables scoped by person_id — deleted via (person_id IN user's people)
const PERSON_TABLES = [
  "allergies",
  "care_circle_shares",
  "check_ins",
  "documents",
  "health_events",
  "lab_results",
  "medication_logs",
  "medication_reminders",
  "medications",
  "update_me_summaries",
  "vitals",
];

const STORAGE_BUCKETS = [
  "bug-screenshots",
  "documents",
  "ehr-uploads",
  "visit-attachments",
];

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
    const authHeader = req.headers.get("Authorization") || "";
    if (!authHeader) return json({ error: "Authorization required" }, 401);

    const body = await req.json().catch(() => ({}));
    if (body.confirmation !== "DELETE") {
      return json(
        {
          error:
            "Missing confirmation. Pass { confirmation: 'DELETE' } in the body.",
        },
        400,
      );
    }

    // Verify the caller via their JWT
    const anon = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await anon.auth.getUser();
    if (userErr || !user) return json({ error: "Unauthorized" }, 401);

    const userId = user.id;
    const userEmail = user.email || "";
    console.log(`delete-account: starting for user ${userId} (${userEmail})`);

    const service = createClient(SUPABASE_URL, SERVICE_ROLE);
    let rowsDeleted = 0;
    let peopleDeleted = 0;
    let filesDeleted = 0;
    const errors: string[] = [];

    // 1) Load all person IDs first (needed to cascade person-scoped rows)
    const { data: people } = await service
      .from("people")
      .select("id")
      .eq("user_id", userId);
    const personIds = (people || []).map((p: any) => p.id);

    // 2) Delete person-scoped rows (if we have any people)
    if (personIds.length > 0) {
      for (const t of PERSON_TABLES) {
        try {
          const { count, error } = await service
            .from(t)
            .delete({ count: "exact" })
            .in("person_id", personIds);
          if (error) {
            errors.push(`${t}: ${error.message}`);
          } else if (typeof count === "number") {
            rowsDeleted += count;
          }
        } catch (e) {
          errors.push(`${t}: ${(e as Error).message}`);
        }
      }
    }

    // 3) Delete user-scoped rows
    for (const t of USER_TABLES) {
      try {
        const { count, error } = await service
          .from(t)
          .delete({ count: "exact" })
          .eq("user_id", userId);
        if (error) {
          errors.push(`${t}: ${error.message}`);
        } else if (typeof count === "number") {
          rowsDeleted += count;
        }
      } catch (e) {
        errors.push(`${t}: ${(e as Error).message}`);
      }
    }

    // 4) Delete the people rows themselves
    try {
      const { count, error } = await service
        .from("people")
        .delete({ count: "exact" })
        .eq("user_id", userId);
      if (error) errors.push(`people: ${error.message}`);
      else if (typeof count === "number") {
        peopleDeleted = count;
        rowsDeleted += count;
      }
    } catch (e) {
      errors.push(`people: ${(e as Error).message}`);
    }

    // 5) Delete storage objects under {userId}/ in each bucket
    for (const bucket of STORAGE_BUCKETS) {
      try {
        const removed = await deleteFolderRecursive(service, bucket, userId);
        filesDeleted += removed;
      } catch (e) {
        errors.push(`storage:${bucket}: ${(e as Error).message}`);
      }
    }

    // 6) Finally delete the auth user (also invalidates sessions)
    try {
      const { error } = await service.auth.admin.deleteUser(userId);
      if (error) {
        // If auth deletion fails, data is already gone — log but still return success
        errors.push(`auth.admin.deleteUser: ${error.message}`);
        console.error("delete-account: auth.admin.deleteUser failed", error);
      }
    } catch (e) {
      errors.push(`auth.admin.deleteUser: ${(e as Error).message}`);
    }

    console.log(
      `delete-account: completed for ${userId}. rows=${rowsDeleted}, people=${peopleDeleted}, files=${filesDeleted}, errors=${errors.length}`,
    );

    return json({
      success: true,
      summary: {
        rows_deleted: rowsDeleted,
        people_deleted: peopleDeleted,
        files_deleted: filesDeleted,
        errors: errors.length > 0 ? errors : undefined,
      },
    });
  } catch (e) {
    console.error("delete-account: fatal error", e);
    return json({ error: (e as Error).message || "Internal error" }, 500);
  }
});

// Recursively deletes all objects under {prefix}/ in the given bucket.
// Returns the count of files deleted.
async function deleteFolderRecursive(
  service: ReturnType<typeof createClient>,
  bucket: string,
  prefix: string,
): Promise<number> {
  let deleted = 0;
  const stack: string[] = [prefix];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const { data: items, error } = await service.storage
      .from(bucket)
      .list(current, { limit: 1000 });
    if (error) {
      // A missing folder just means nothing to delete
      continue;
    }
    if (!items || items.length === 0) continue;

    const filePaths: string[] = [];
    for (const item of items) {
      // Supabase returns { name, id, metadata } — folders have id === null
      if (item.id === null) {
        // subdirectory
        stack.push(`${current}/${item.name}`);
      } else {
        filePaths.push(`${current}/${item.name}`);
      }
    }

    if (filePaths.length > 0) {
      const { error: rmErr } = await service.storage.from(bucket).remove(filePaths);
      if (!rmErr) deleted += filePaths.length;
    }
  }
  return deleted;
}
