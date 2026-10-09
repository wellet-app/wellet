// supabase/functions/wellet-health-ingest/index.ts
//
// Receives a batch of HealthKit samples from the Wellet Connect iOS app and
// writes them into Wellet's records pipeline.
//
// Build 12 fix: previous version returned HTTP 546 (WORKER_RESOURCE_LIMIT)
// on a fresh 30-day catch-up sync. Two culprits:
//   1. `count: "exact"` on the upsert forces a slow COUNT scan after every
//      INSERT. Switched to `count: undefined` and tally row count ourselves.
//   2. Single giant upsert of thousands of rows blows the edge worker's
//      CPU/wall-clock budget. We now chunk the upsert into batches of 500.
//
// Build 13 (v3, 2026-05-12) — Path C / Security C2: replaced the wildcard
// `Access-Control-Allow-Origin: *` with an explicit allowlist of mywellet.com
// hosts. iOS native POSTs don't send an Origin header, so they're entirely
// unaffected (URLSession never adds Origin for non-browser requests). The
// only behavioral change is that a hostile webpage in a browser can no
// longer make this endpoint respond cross-origin — it'll be blocked by the
// browser's CORS check. iOS path still works exactly the same.
//
// Build 14 (v4, 2026-05-12) — Asymmetric JWT compatibility. The gateway-side
// `verify_jwt` flag uses the HS256 verifier which silently rejects Supabase's
// newer asymmetric (RS256/ES256) session tokens with
// UNAUTHORIZED_ASYMMETRIC_JWT. We were already validating the token in
// function code via `admin.auth.getUser(token)`, so the gateway check was
// redundant — and now harmful. Same pattern create-care-signal-watch /
// ask-wellet use. Flipping `verify_jwt` to false at deploy time, no source
// change required.
//
// Also: stamp `apple_health_last_sync_at` early (right after we know who
// the user is), so even a partially-completed sync shows movement in the
// UI. The final stamp at the end refines the timestamp to the true finish.
//
// Auth: requires the user's Supabase access token in the Authorization
// header. We resolve the user from the token, then look up their self-person
// row to know which person_id to attach the records to.
//
// Idempotency: each sample has a (person_id, hk_type, start_at, source)
// tuple. We upsert on those so re-running a snapshot doesn't create dupes.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

interface SampleIn {
  start: string;
  end: string;
  value: number;
  unit: string;
  source?: string | null;
}

interface IngestPayload {
  source: string;            // "ios-healthkit"
  client_version: string;
  batches: Record<string, SampleIn[]>;
}

// v3 (2026-05-12) — CORS allowlist. iOS doesn't send Origin so it's unaffected.
// Browser-origin requests must match one of these to get a usable
// Access-Control-Allow-Origin echoed back.
const ALLOWED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
];

function getCorsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  // If Origin is missing (iOS native, curl, server-to-server), return "*"
  // for the headers since browsers won't apply CORS to that request anyway.
  // If Origin is set, only echo it back when it's on the allowlist;
  // otherwise return "null" so browsers block it.
  let allowOrigin: string;
  if (!origin) {
    // No Origin header: this is a non-browser request (iOS app, curl, etc.).
    // Returning "*" here is fine because there is no browser CORS check
    // happening on this response. Important: do not pair "*" with
    // credentialed requests — we don't, since iOS sends Bearer not cookies.
    allowOrigin = "*";
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    allowOrigin = origin;
  } else {
    allowOrigin = "null";
  }
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

// Tune this if we see 546 again. 500 keeps each upsert well under a second
// for typical iOS HealthKit data shapes.
const UPSERT_CHUNK_SIZE = 500;

Deno.serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  // Resolve user from bearer
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return json({ error: "missing bearer" }, 401, corsHeaders);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData.user) return json({ error: "auth failed" }, 401, corsHeaders);
  const userId = userData.user.id;

  // Resolve the self-person row
  const { data: selfPerson, error: pErr } = await admin
    .from("people")
    .select("id")
    .eq("user_id", userId)
    .eq("is_self", true)
    .maybeSingle();
  if (pErr) return json({ error: pErr.message }, 500, corsHeaders);
  if (!selfPerson) return json({ error: "no self-person row; finish onboarding first" }, 412, corsHeaders);
  const personId = selfPerson.id;

  // Parse payload
  let payload: IngestPayload;
  try {
    payload = await req.json();
  } catch (e) {
    return json({ error: `bad json: ${e}` }, 400, corsHeaders);
  }
  if (!payload || !payload.batches || typeof payload.batches !== "object") {
    return json({ error: "missing batches" }, 400, corsHeaders);
  }

  // Flatten
  const rows: any[] = [];
  for (const [hkType, samples] of Object.entries(payload.batches)) {
    for (const s of samples) {
      rows.push({
        person_id: personId,
        source: "apple-health",
        hk_type: hkType,
        start_at: s.start,
        end_at: s.end,
        value: s.value,
        unit: s.unit,
        device_source: s.source ?? null,
      });
    }
  }
  if (rows.length === 0) {
    // Stamp anyway — the user did connect, even if Health is empty.
    await admin
      .from("people")
      .update({ apple_health_last_sync_at: new Date().toISOString() })
      .eq("id", personId);
    return json({ ingested: 0 }, 200, corsHeaders);
  }

  // Early stamp: shows movement in the UI even if a later chunk fails.
  // The final stamp at the end will refine the timestamp.
  await admin
    .from("people")
    .update({ apple_health_last_sync_at: new Date().toISOString() })
    .eq("id", personId);

  // Chunked upsert. wearable_observations has a UNIQUE INDEX on
  // (person_id, hk_type, start_at, source) -- see the migration.
  // We deliberately do NOT pass `count: "exact"` here — that forces a
  // post-write COUNT scan which is what was blowing the CPU budget and
  // producing HTTP 546. We tally ingested rows ourselves from the input.
  let ingested = 0;
  for (let i = 0; i < rows.length; i += UPSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + UPSERT_CHUNK_SIZE);
    const { error: insertErr } = await admin
      .from("wearable_observations")
      .upsert(chunk, {
        onConflict: "person_id,hk_type,start_at,source",
        ignoreDuplicates: false,
      });
    if (insertErr) {
      // Partial success: stamp already happened, surface what we got.
      return json(
        {
          error: insertErr.message,
          ingested,
          attempted: rows.length,
        },
        500,
        corsHeaders,
      );
    }
    ingested += chunk.length;
  }

  // Final stamp — refines the timestamp now that everything landed.
  await admin
    .from("people")
    .update({ apple_health_last_sync_at: new Date().toISOString() })
    .eq("id", personId);

  return json({ ingested }, 200, corsHeaders);
});

function json(body: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
