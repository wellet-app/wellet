// Shared helper for signup-path edge functions to log errors into
// public.signup_error_log. Critical-severity rows trigger an immediate
// email via notify-signup-error (see migrations: signup_error_log_*).
//
// This helper NEVER throws — logging failure should not mask the original
// error path. All errors are swallowed and console.error'd.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export type SignupErrorSeverity = "critical" | "warn" | "info";

export interface LogSignupErrorParams {
  source: string;
  severity: SignupErrorSeverity;
  error?: unknown;
  message?: string;
  errorCode?: string;
  httpStatus?: number;
  userId?: string | null;
  userEmail?: string | null;
  request?: Request;
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
