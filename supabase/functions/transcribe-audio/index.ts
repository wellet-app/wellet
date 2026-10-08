import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import { aiChat, aiTranscribe } from "../_shared/azureOpenAI.ts";

Deno.serve(async (req) => {
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
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    // AI vendor + keys are owned by ../_shared/azureOpenAI.ts. Both the
    // Whisper transcription call AND the GPT-4o extraction call route
    // through Azure OpenAI (BAA-covered) with phi:true.

    // Authenticate the caller
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "No authorization header" }, 401);
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
      return json({ error: "Unauthorized" }, 401);
    }

    const db = createClient(supabaseUrl, supabaseServiceKey);

    const { document_id, storage_path } = await req.json();
    if (!document_id || !storage_path) {
      return json({ error: "document_id and storage_path required" }, 400);
    }

    // Verify the document belongs to a person owned by this user
    const { data: doc, error: docErr } = await db
      .from("documents")
      .select("id, person_id, file_name, people!inner(user_id)")
      .eq("id", document_id)
      .single();

    if (docErr || !doc) {
      return json({ error: "Document not found" }, 404);
    }
    if ((doc as any).people.user_id !== user.id) {
      return json({ error: "Not authorized" }, 403);
    }

    // Mark as processing
    await db
      .from("documents")
      .update({ extraction_status: "processing" })
      .eq("id", document_id);

    // Download the audio file from Supabase Storage
    const { data: fileData, error: dlError } = await db.storage
      .from("documents")
      .download(storage_path);

    if (dlError || !fileData) {
      await db
        .from("documents")
        .update({ extraction_status: "failed" })
        .eq("id", document_id);
      return json({ error: "Failed to download audio: " + (dlError?.message || "unknown") }, 500);
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
    const fileName = doc.file_name || `recording.${ext}`;

    // Send to Azure Whisper for transcription. Whisper runs on the secondary
    // East US 2 Azure resource (Foundry auto-provisioned there). The adapter
    // handles endpoint/key selection — see _shared/azureOpenAI.ts azureEnv().
    let transcript: string;
    try {
      const audioFile = new File([fileData], fileName, { type: mimeType });
      const tResult = await aiTranscribe({
        audio: audioFile,
        filename: fileName,
        response_format: "text",
        phi: true,
      });
      transcript = (tResult.text || "").trim();
    } catch (whisperErr) {
      console.error("Azure Whisper error:", whisperErr);
      await db
        .from("documents")
        .update({ extraction_status: "failed" })
        .eq("id", document_id);
      return json({ error: "Transcription failed" }, 500);
    }

    // Pass transcript through GPT-4o to extract structured health data
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

    // Extract structured health items from the transcript via GPT-4o.
    // phi:true engages the BAA guardrail. On any failure (network, parse,
    // vendor block) we still save the raw transcript — the user has captured
    // the recording and we don't want to lose that signal.
    let extracted: { summary?: string; items?: unknown[]; transcript?: string } = {
      transcript,
      summary: "",
      items: [],
    };
    try {
      const gptResult = await aiChat({
        model: "gpt-4o",
        max_tokens: 2000,
        phi: true,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content:
              "Extract health information from this doctor visit transcript:\n\n" +
              transcript,
          },
        ],
        response_format: { type: "json_object" },
      });
      const content = gptResult.content;
      if (content) {
        try {
          const parsed = JSON.parse(content);
          extracted = {
            transcript,
            summary: parsed.summary || "",
            items: Array.isArray(parsed.items) ? parsed.items : [],
          };
        } catch {
          // GPT returned non-JSON — store transcript only
          extracted = { transcript, summary: "", items: [] };
        }
      }
    } catch (gptErr) {
      console.error("Azure GPT extraction error:", gptErr);
      // Still save the transcript even if extraction fails
    }

    // Store results in the documents table
    await db
      .from("documents")
      .update({
        extracted_events: extracted,
        extraction_status: "completed",
      })
      .eq("id", document_id);

    return json({ success: true, transcript, extracted });
  } catch (e) {
    console.error("transcribe-audio error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
