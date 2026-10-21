// Shared helper for signup-path edge functions to log errors into
// public.signup_error_log. Critical-severity rows trigger an immediate
// email via notify-signup-error (see migrations: signup_error_log_*).
//
// Use in a top-level catch like:
//   } catch (e) {
//     await logSignupError({
//       source: "epic-auth",
//       severity: "critical",
//       error: e,
//       request: req,
//       context: { stage: "token_exchange" },
//     });
//     return new Response(...);
//   }
//
// This helper NEVER throws — logging failure should not mask the original
// error path. All errors are swallowed and console.error'd.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SignupErrorSeverity = "critical" | "warn" | "info";

export interface LogSignupErrorParams {
  /** Function slug, e.g. "epic-auth". Used for dedupe keying. */
  source: string;
  /** "critical" → immediate email; "warn"/"info" → silent log. */
  severity: SignupErrorSeverity;
  /** The thrown error (Error, string, or anything). */
  error?: unknown;
  /** Optional override for the message. Defaults to error.message. */
  message?: string;
  /** Optional short stable code for dedupe, e.g. "TOKEN_EXCHANGE_FAILED". */
  errorCode?: string;
  /** Optional HTTP status the function will return. */
  httpStatus?: number;
  /** Optional user_id (auth.users.id). */
  userId?: string | null;
  /** Optional user email. */
  userEmail?: string | null;
  /** Optional incoming request. We extract request_id from headers. */
  request?: Request;
  /** Free-form context — keep small (< 4 KB JSON). */
  context?: Record<string, unknown>;
}

function extractRequestId(req?: Request): string | null {
  if (!req) return null;
  return (
    req.headers.get("x-request-id") ||
    req.headers.get("cf-ray") ||
    req.headers.get("x-supabase-request-id") ||
    null
  );
}

function errorToMessage(error: unknown): string {
  if (!error) return "";
  if (error instanceof Error) {
    return [error.message, error.stack].filter(Boolean).join("\n").slice(0, 8000);
  }
  try {
    return String(error).slice(0, 8000);
  } catch {
    return "(unstringifiable error)";
  }
}

/**
 * Insert a row into public.signup_error_log. Never throws — logging failures
 * are swallowed and console.error'd so the caller's catch path is unaffected.
 * Returns the inserted row id, or null on failure.
 */
export async function logSignupError(
  params: LogSignupErrorParams,
): Promise<string | null> {
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceKey) {
      console.error("[logSignupError] missing SUPABASE_URL or SERVICE_ROLE_KEY env");
      return null;
    }
    const admin = createClient(supabaseUrl, serviceKey);

    const message = params.message || errorToMessage(params.error);
    const requestId = extractRequestId(params.request);

    const row = {
      source: params.source,
      severity: params.severity,
      http_status: params.httpStatus ?? null,
      error_code: params.errorCode ?? null,
      message: message || null,
      user_id: params.userId ?? null,
      user_email: params.userEmail ?? null,
      request_id: requestId,
      context: params.context ?? null,
    };

    const { data, error } = await admin
      .from("signup_error_log")
      .insert(row)
      .select("id")
      .single();

    if (error) {
      console.error("[logSignupError] insert failed:", error.message);
      return null;
    }
    return data?.id ?? null;
  } catch (e) {
    console.error("[logSignupError] threw:", String(e));
    return null;
  }
}
