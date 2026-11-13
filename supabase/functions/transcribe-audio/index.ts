// transcribe-audio v20 — Azure OpenAI migration (Path A2)
//
// Changes vs v19:
//   - Whisper: routed through aiTranscribe({ phi: true })
//   - GPT-4o extraction: routed through aiChatJSON({ phi: true })
//   - OPENAI_API_KEY env check replaced with WELLET_AI_VENDOR env check
//   - All surrounding logic (auth, doc lookup, storage download, db updates,
//     CORS, error handling, console.log lines) preserved verbatim
//
// v23 (2026-11-13, security review):
//   - storage_path now comes from the documents row the caller owns. The
//     client's value is ignored, so one user can't transcribe another's file.
//   - Logs no longer include file names or storage paths.
//   - Error responses no longer echo internal or vendor error text.
//   - Files over 25 MB are refused before any AI call.
//   - CORS limited to Wellet's own sites.
//
// Reversibility: set WELLET_AI_VENDOR=openai_direct in Supabase secrets
// and the adapter falls back to the legacy OpenAI direct path automatically.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiTranscribe, aiChatJSON } from "./azureOpenAI.ts";

const ALLOWED_ORIGINS = [
  "https://mywellet.com",
  "https://www.mywellet.com",
  "https://getwellet.com",
  "https://www.getwellet.com",
];
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : "https://mywellet.com",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

Deno.serve(async (req) => {
  const CORS_HEADERS = corsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const aiVendor = Deno.env.get("WELLET_AI_VENDOR") ?? "azure";

    // Env sanity: ensure the vendor's required secrets exist.
    if (aiVendor === "azure") {
      if (!Deno.env.get("AZURE_OPENAI_ENDPOINT") || !Deno.env.get("AZURE_OPENAI_API_KEY")) {
        return json({ error: "AZURE_OPENAI_ENDPOINT/API_KEY not configured", step: "env_check" }, 503);
      }
    } else if (aiVendor === "openai_direct") {
      if (!Deno.env.get("OPENAI_API_KEY")) {
        return json({ error: "OPENAI_API_KEY not configured", step: "env_check" }, 503);
      }
    }

    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header", step: "auth" }, 401);
    }

    const anonClient = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser();
    if (userError || !user) {
      return json({ error: "Unauthorized", step: "auth" }, 401);
    }

    const db = createClient(supabaseUrl, supabaseServiceKey);

    // storage_path from the client is accepted for older web builds but never used.
    const { document_id } = await req.json();
    if (!document_id) {
      return json({ error: "document_id required", step: "input" }, 400);
    }

    console.log(`[transcribe] Starting: doc=${document_id}, vendor=${aiVendor}`);

    // Verify the document belongs to a person owned by this user
    const { data: doc, error: docErr } = await db
      .from("documents")
      .select("id, person_id, file_name, storage_path, people!inner(user_id)")
      .eq("id", document_id)
      .single();

    if (docErr || !doc) {
      console.error("[transcribe] Doc lookup failed:", docErr?.message);
      return json({ error: "Document not found", step: "doc_lookup" }, 404);
    }
    if ((doc as any).people.user_id !== user.id) {
      return json({ error: "Not authorized", step: "ownership" }, 403);
    }

    const storage_path: string = (doc as any).storage_path;
    if (!storage_path) {
      return json({ error: "Document has no file", step: "doc_lookup" }, 404);
    }
    console.log("[transcribe] Doc verified");

    // Mark as processing
    await db
      .from("documents")
      .update({ extraction_status: "processing" })
      .eq("id", document_id);

    // Download the audio file from Supabase Storage
    console.log("[transcribe] Downloading from storage");
    const { data: fileData, error: dlError } = await db.storage
      .from("documents")
      .download(storage_path);

    if (dlError || !fileData) {
      console.error("[transcribe] Storage download failed:", dlError?.message);
      await db
        .from("documents")
        .update({ extraction_status: "failed" })
        .eq("id", document_id);
      return json({ error: "Failed to download audio", step: "storage_download" }, 500);
    }

    const fileSize = fileData.size;
    console.log(`[transcribe] Downloaded ${fileSize} bytes`);
    if (fileSize > MAX_AUDIO_BYTES) {
      await db.from("documents").update({ extraction_status: "failed" }).eq("id", document_id);
      return json({ error: "Recording is too long to transcribe (25 MB limit)", step: "size_check" }, 413);
    }

    // Determine MIME type from extension
    const ext = storage_path.split(".").pop()?.toLowerCase() || "m4a";
    const mimeMap: Record<string, string> = {
      m4a: "audio/mp4",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      ogg: "audio/ogg",
      webm: "audio/webm",
    };
    const mimeType = mimeMap[ext] || "audio/mp4";
    // Generic name: the original file name can carry a person's name.
    const fileName = `recording.${ext}`;

    // === PHI call #1 — transcription ===
    // Routed through aiTranscribe. With WELLET_AI_VENDOR=azure this hits
    // Azure Whisper on the East US 2 secondary resource (BAA-covered).
    console.log(`[transcribe] Calling aiTranscribe (${mimeType}, ${fileSize} bytes)`);
    let transcript = "";
    try {
      const audioBlob = new Blob([fileData], { type: mimeType });
      const tr = await aiTranscribe({
        audio: audioBlob,
        filename: fileName,
        response_format: "text",
        phi: true,
      });
      transcript = tr.text;
      console.log(`[transcribe] aiTranscribe (${tr.vendor}/${tr.model}) returned ${transcript.length} chars`);
    } catch (e) {
      console.error("[transcribe] aiTranscribe error:", (e as Error).message);
      await db
        .from("documents")
        .update({ extraction_status: "failed" })
        .eq("id", document_id);
      return json({ error: "Transcription failed", step: "whisper" }, 500);
    }

    // === PHI call #2 — structured extraction ===
    // Routed through aiChatJSON. With WELLET_AI_VENDOR=azure this hits
    // Azure gpt-4o-prod (East US, BAA-covered).
    const systemPrompt = [
      "You are a medical data extractor for a caregiver health app.",
      "Given a transcript of a doctor visit recording, extract structured health information.",
      "",
      "Return ONLY valid JSON with this structure:",
      '{',
      '  "summary": "Brief 1-2 sentence summary of the visit",',
      '  "items": [',
      '    { "type": "medication", "title": "Drug name", "detail": "Dosage and instructions" },',
      '    { "type": "condition", "title": "Condition name", "detail": "Notes or status" },',
      '    { "type": "appointment", "title": "Follow-up type", "detail": "When and with whom" },',
      '    { "type": "lab_result", "title": "Lab test ordered", "detail": "Details" },',
      '    { "type": "note", "title": "Action item", "detail": "What the caregiver should do" }',
      '  ]',
      '}',
      "",
      "Rules:",
      "- Extract medications mentioned (new, changed, or continued) with dosages",
      "- Extract diagnoses or conditions discussed",
      "- Extract follow-up appointments scheduled",
      "- Extract lab tests ordered or results discussed",
      "- Extract action items for the caregiver (e.g., pick up prescription, schedule appointment)",
      "- Use type values: medication, condition, appointment, lab_result, note",
      "- If nothing is found for a category, omit it from items",
      "- Be precise: only include information clearly stated in the transcript",
    ].join("\n");

    let extracted: { summary?: string; items?: unknown[]; transcript?: string } = {
      transcript,
      summary: "",
      items: [],
    };

    try {
      console.log("[transcribe] Calling aiChatJSON for extraction");
      const res = await aiChatJSON<{ summary?: string; items?: unknown[] }>({
        model: "gpt-4o",
        max_tokens: 2000,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              "Extract health information from this doctor visit transcript:\n\n" +
              transcript,
          },
        ],
        phi: true,
      });
      console.log(`[transcribe] aiChatJSON (${res.vendor}/${res.model}) returned ${res.raw.length} chars`);
      extracted = {
        transcript,
        summary: res.data.summary || "",
        items: Array.isArray(res.data.items) ? res.data.items : [],
      };
    } catch (e) {
      console.error("[transcribe] aiChatJSON extraction error:", (e as Error).message);
      // Fall through with the empty extracted object — the transcript is still saved.
    }

    // Store results in the documents table
    console.log(`[transcribe] Saving results: ${extracted.items?.length || 0} items`);
    const { error: updateErr } = await db
      .from("documents")
      .update({
        extracted_events: extracted,
        extraction_status: "completed",
      })
      .eq("id", document_id);

    if (updateErr) {
      console.error("[transcribe] DB update failed:", updateErr.message);
      return json({ error: "Failed to save results", step: "db_update" }, 500);
    }

    console.log("[transcribe] Success!");
    return json({
      success: true,
      transcript_length: transcript.length,
      items_count: extracted.items?.length || 0,
      ai_vendor: aiVendor,
    });
  } catch (e) {
    console.error("[transcribe] Unhandled error:", e);
    return json({ error: "Something went wrong", step: "unhandled" }, 500);
  }
});

