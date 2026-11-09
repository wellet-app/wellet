// parse-document v29 — Chunked PDF extraction (no page cap)
//
// v28 hard-capped every PDF at 30 pages OR 50K chars, whichever hit first.
// That assumption held for after-visit summaries but broke the first time
// a real caregiver uploaded a real MyChart full-history export. Emma
// (31yo, healthy) uploaded a 150-page record; we read pages 1–30, missed
// 120 pages of her history, and Ask Wellet had nothing to reference.
//
// v29 removes the caps:
//   • Extract text from EVERY page of the PDF
//   • Split into ~40K-char chunks with a small overlap so a medication
//     line that straddles a chunk boundary still appears in at least one
//     chunk's window
//   • Call Azure GPT-4o on each chunk in PARALLEL (Promise.all). Azure
//     handles concurrency comfortably; total wall time ≈ slowest chunk,
//     not sum of chunks.
//   • Merge items[] across chunks, dedupe by (type|title|date) signature
//   • Synthesize a single document-level summary from the per-chunk
//     summaries via one final cheap call
//
// Safety rails:
//   • Hard ceiling: 50 chunks (~2M chars / ~600 pages) to prevent
//     runaway cost on a malicious or pathological upload. If hit, we
//     extract from the first 50 chunks and append a note to the summary.
//   • Per-page cleanup() to release pdfjs operator lists between pages —
//     same as v28, prevents WORKER_RESOURCE_LIMIT OOM on big docs.
//   • Per-chunk try/catch — one chunk failing the JSON parse doesn't
//     nuke the whole extraction. We log + skip + keep going.
//
// Same security posture as v28: PHI flows through Azure OpenAI (BAA-covered).

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { aiChatJSON, aiVision, aiChat } from "../_shared/azureOpenAI.ts";
// unpdf — Deno/serverless-friendly fork of pdfjs-dist with the canvas
// dependency stripped out. Verified locally against a 115-page MyChart
// export: 1.5s extraction, full text fidelity.
import { getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const VERSION = "29";

// ── Tunables ────────────────────────────────────────────────────────────────
// CHUNK_CHARS: target size of each LLM input. 40K chars ≈ ~10K tokens of
// document content, leaving plenty of room under GPT-4o's 128K window for
// system prompt + JSON output. Smaller chunks = more parallel calls; bigger
// chunks = fewer calls but slower per-call.
const CHUNK_CHARS = 40_000;
// CHUNK_OVERLAP: small overlap so a clinical fact straddling a boundary
// shows up in at least one chunk's window. Dedup catches the duplicates.
const CHUNK_OVERLAP = 2_000;
// MAX_CHUNKS: hard ceiling on number of LLM calls per document. 50 chunks ≈
// 2M chars ≈ ~600 pages. Protects cost on pathological inputs.
const MAX_CHUNKS = 50;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SYSTEM_PROMPT = `You are Wellet, an AI health document parser for family caregivers. Your job is to extract structured health information from medical documents.

Return ONLY valid JSON with this exact structure:
{
  "summary": "A 1-2 sentence plain-language summary of what this document contains, written for a family caregiver (not a clinician)",
  "items": [
    {
      "type": "medication|lab_result|appointment|diagnosis|note",
      "title": "Short title (e.g. medication name, lab test name, appointment type)",
      "detail": "Plain-language detail (e.g. dose, result value + meaning, date + provider, condition name)",
      "date": "YYYY-MM-DD if found, or null",
      "values": { "dose": "25mg", "frequency": "daily" }
    }
  ]
}

Rules:
- Extract EVERY medication mentioned (name, dose, frequency, prescriber if shown)
- Extract EVERY lab result (test name, value, unit, reference range, whether normal/abnormal)
- Extract appointments (provider, date, purpose)
- Extract diagnoses (condition name, status: active/resolved/monitoring)
- Write details in plain language a non-medical person can understand
- If a lab value is abnormal, explain what that means simply
- "values" field is optional — include dose/frequency for medications, numeric values for labs
- Return empty items array if nothing can be extracted
- NEVER include any text outside the JSON object`;

const CHUNK_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

IMPORTANT: This is ONE CHUNK of a larger medical document. The same medication, lab, or diagnosis may appear in multiple chunks — extract everything you see in THIS chunk; the system will deduplicate across chunks. Do not skip an item because it "looks like" you already covered it. If a fact is incomplete because it was cut off at a chunk boundary, extract what you can see and leave missing fields null.`;

const SUMMARY_SYNTHESIS_PROMPT = `You are Wellet. You will receive several short summaries, each describing one chunk of the same medical document. Write ONE 1–2 sentence plain-language summary of the WHOLE document for a family caregiver. Do not enumerate the chunks. Return ONLY the summary text, no JSON, no quotes.`;

type ExtractedItem = {
  type: string;
  title: string;
  detail: string;
  date: string | null;
  values?: Record<string, unknown>;
};

type ExtractedPayload = {
  summary: string;
  items: ExtractedItem[];
};

function mimeForExt(ext: string): string {
  switch (ext) {
    case "jpg":
    case "jpeg": return "image/jpeg";
    case "png":  return "image/png";
    case "gif":  return "image/gif";
    case "webp": return "image/webp";
    default:     return "application/octet-stream";
  }
}

// Convert Uint8Array → base64 without blowing the call stack on big files.
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// v29: extract text from EVERY page of the PDF. No char or page cap here —
// caps live in the chunking step. Returns "" on failure.
async function extractAllPdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  try {
    const pdf = await getDocumentProxy(bytes);
    const pages = pdf.numPages;
    let text = "";
    for (let p = 1; p <= pages; p++) {
      const page = await pdf.getPage(p);
      const tc = await page.getTextContent();
      // deno-lint-ignore no-explicit-any
      const pageText = tc.items.map((it: any) => it.str ?? "").join(" ");
      text += pageText + "\n";
      // Release page-level resources before loading the next one. pdfjs
      // holds operator lists + font references per page; without cleanup
      // the heap grows linearly and the worker OOMs on big docs.
      // deno-lint-ignore no-explicit-any
      (page as any).cleanup?.();
    }
    // deno-lint-ignore no-explicit-any
    (pdf as any).cleanup?.();
    return { text: text.trim(), pages };
  } catch (err) {
    console.error(`[parse-document v${VERSION}] unpdf extract failed:`, err);
    return { text: "", pages: 0 };
  }
}

// Split text into overlapping chunks. We try to break on a newline within the
// last 1K chars of the target window to avoid splitting mid-line. Falls back
// to a hard cut if no newline is nearby.
function chunkText(text: string, size: number, overlap: number): string[] {
  if (text.length <= size) return [text];
  const chunks: string[] = [];
  let pos = 0;
  while (pos < text.length) {
    let end = Math.min(pos + size, text.length);
    if (end < text.length) {
      // Look for a newline in the last 1K chars to break cleanly.
      const nlSearchStart = Math.max(pos + size - 1000, pos);
      const lastNl = text.lastIndexOf("\n", end);
      if (lastNl > nlSearchStart) end = lastNl;
    }
    chunks.push(text.slice(pos, end));
    if (end >= text.length) break;
    pos = end - overlap;
    if (pos < 0) pos = 0;
  }
  return chunks;
}

// Dedup signature: same type + same normalized title + same date counts as
// the same item. Title normalization: lowercase, collapse whitespace, strip
// trailing punctuation. This catches "Lisinopril" appearing in two chunks
// without collapsing distinct meds.
function itemKey(item: ExtractedItem): string {
  const title = (item.title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.,;:]+$/, "")
    .trim();
  const date = item.date ?? "";
  return `${item.type}|${title}|${date}`;
}

function dedupItems(items: ExtractedItem[]): ExtractedItem[] {
  const seen = new Map<string, ExtractedItem>();
  for (const it of items) {
    const key = itemKey(it);
    const prior = seen.get(key);
    if (!prior) {
      seen.set(key, it);
      continue;
    }
    // Merge: prefer the version with more detail / more values. We keep the
    // longer `detail` string and merge `values` shallowly.
    const merged: ExtractedItem = {
      ...prior,
      detail: (it.detail?.length ?? 0) > (prior.detail?.length ?? 0) ? it.detail : prior.detail,
      values: { ...(prior.values ?? {}), ...(it.values ?? {}) },
    };
    seen.set(key, merged);
  }
  return Array.from(seen.values());
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Env check on every cold start — surface misconfig fast.
  const envCheck = {
    vendor: Deno.env.get("WELLET_AI_VENDOR") ?? "azure",
    has_azure_endpoint: !!Deno.env.get("AZURE_OPENAI_ENDPOINT"),
    has_azure_key: !!Deno.env.get("AZURE_OPENAI_API_KEY"),
    chat_deployment: Deno.env.get("AZURE_OPENAI_DEPLOYMENT_GPT4O") ?? "(unset)",
  };
  console.log(`[parse-document v${VERSION}] env_check`, JSON.stringify(envCheck));

  try {
    // ── Manual auth verification (verify_jwt is off at gateway) ──
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("Missing or malformed Authorization header");
      return new Response(
        JSON.stringify({ error: "Missing authorization", step: "auth" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      console.error("Auth verification failed:", authError);
      return new Response(
        JSON.stringify({ error: "Unauthorized", step: "auth" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { document_id, file_name, document_type, storage_path } = await req.json();
    if (!document_id || !storage_path) {
      return new Response(
        JSON.stringify({ error: "document_id and storage_path are required" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // VAULT v0.5: Critical documents (advance directives, insurance cards,
    // photo IDs, etc.) are stored as-is — short-circuit AI.
    if (typeof document_type === "string" && document_type.startsWith("vault_")) {
      const vaultMeta = {
        source: "vault",
        document_type,
        file_name,
        processed_at: new Date().toISOString(),
        function_version: VERSION,
        items: [],
        summary: "Stored in Vault — not analyzed.",
      };
      await supabase.from("documents").update({
        extraction_status: "completed",
        extracted_events: vaultMeta,
      }).eq("id", document_id);
      return new Response(
        JSON.stringify({ success: true, document_id, vault: true, extraction_status: "completed" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Update status to processing
    await supabase.from("documents").update({
      extraction_status: "processing",
    }).eq("id", document_id);

    // Download the file from storage
    const { data: fileData, error: downloadError } = await supabase.storage
      .from("documents")
      .download(storage_path);

    if (downloadError) {
      console.error("Download error:", downloadError);
      await supabase.from("documents").update({
        extraction_status: "failed",
        extracted_events: { error: "Could not download file: " + downloadError.message },
      }).eq("id", document_id);
      return new Response(
        JSON.stringify({ error: "Failed to download file", details: downloadError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const ext = (file_name?.toLowerCase().split(".").pop() || "") as string;
    const isImage = ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);

    let extraction: ExtractedPayload;
    let aiVendor = "";
    let aiModel = "";
    let aiUsage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null = null;
    // v29 telemetry: full picture of chunking + dedup.
    const debugMeta: Record<string, unknown> = {};

    try {
      if (isImage) {
        // ── Image path: Azure GPT-4o vision (unchanged from v28) ──
        const bytes = new Uint8Array(await fileData.arrayBuffer());
        const base64 = bytesToBase64(bytes);
        const mime = mimeForExt(ext);
        const dataUrl = `data:${mime};base64,${base64}`;

        const prompt = `This is a ${document_type || "medical"} document image named "${file_name}". Please extract all health information from it. Respond with ONLY the JSON object described in the system prompt.`;

        const res = await aiVision({
          model: "gpt-4o",
          systemPrompt: SYSTEM_PROMPT,
          prompt,
          imageDataUrl: dataUrl,
          max_tokens: 4000,
          phi: true,
        });
        aiVendor = res.vendor;
        aiModel = res.model;
        aiUsage = res.usage;
        debugMeta.path = "image_vision";

        extraction = parseExtractionJson(res.content);
        console.log(
          `[parse-document v${VERSION}] aiVision (${res.vendor}/${res.model}) returned ${res.content.length} chars, items=${extraction.items.length}`,
        );
      } else {
        // ── Text path: extract ALL text, chunk, fan out to GPT-4o, merge ──
        let documentContent = "";
        let pdfPages = 0;

        if (ext === "pdf") {
          const bytes = new Uint8Array(await fileData.arrayBuffer());
          const t0 = Date.now();
          const { text, pages } = await extractAllPdfText(bytes);
          pdfPages = pages;
          documentContent = text;
          debugMeta.pdf_extract_ms = Date.now() - t0;
          debugMeta.pdf_pages = pages;
          debugMeta.pdf_chars_total = text.length;
          console.log(
            `[parse-document v${VERSION}] pdfjs extracted ${text.length} chars from ${pages} pages in ${debugMeta.pdf_extract_ms}ms`,
          );

          // Scanned-paper PDF (no extractable text layer) — short-circuit
          // with a helpful summary so the user knows to upload a photo.
          if (!documentContent || documentContent.length < 50) {
            const scannedExtraction: ExtractedPayload = {
              summary: pages > 0
                ? "This PDF appears to be a scanned image without searchable text. For the best summary, take a photo of each page and upload it instead."
                : "We could not read this PDF. It may be password-protected or corrupted. Try saving it again, or upload a photo of each page instead.",
              items: [],
            };
            const finalExtraction = {
              ...scannedExtraction,
              source: `pdfjs/scanned`,
              model: "pdfjs",
              ai_vendor: "pdfjs",
              processed_at: new Date().toISOString(),
              document_type,
              file_name,
              function_version: VERSION,
              usage: null,
              debug: { ...debugMeta, path: "pdf_scanned_no_text" },
            };
            await supabase.from("documents").update({
              extraction_status: "completed",
              extracted_events: finalExtraction,
            }).eq("id", document_id);
            return new Response(
              JSON.stringify({ success: true, document_id, extraction_status: "completed", extracted_events: finalExtraction }),
              { headers: { ...corsHeaders, "Content-Type": "application/json" } },
            );
          }
          debugMeta.path = "pdf_text_chunked";
        } else {
          // Plain text file (txt, md, csv, etc.) — no per-file cap; chunker
          // will handle whatever size shows up.
          documentContent = await fileData.text();
          debugMeta.path = "plain_text_chunked";
        }

        // ── Chunk + fan-out to Azure GPT-4o ──
        let chunks = chunkText(documentContent, CHUNK_CHARS, CHUNK_OVERLAP);
        let truncatedAt: number | null = null;
        if (chunks.length > MAX_CHUNKS) {
          truncatedAt = chunks.length;
          chunks = chunks.slice(0, MAX_CHUNKS);
          console.warn(
            `[parse-document v${VERSION}] document hit MAX_CHUNKS=${MAX_CHUNKS} (had ${truncatedAt}); truncating`,
          );
        }
        debugMeta.chunks = chunks.length;
        debugMeta.chunks_original = truncatedAt ?? chunks.length;

        const chunkT0 = Date.now();
        const chunkResults = await Promise.all(
          chunks.map(async (chunk, idx): Promise<{
            payload: ExtractedPayload;
            usage: ChatUsage | null;
            vendor: string;
            model: string;
            ok: boolean;
            err?: string;
          }> => {
            try {
              const userMessage = `This is a ${document_type || "medical"} document named "${file_name}"${pdfPages ? ` (${pdfPages} pages)` : ""}. This is chunk ${idx + 1} of ${chunks.length}. Extract all health information from the following text:\n\n${chunk}`;
              const res = await aiChatJSON<ExtractedPayload>({
                model: "gpt-4o",
                messages: [
                  { role: "system", content: CHUNK_SYSTEM_PROMPT },
                  { role: "user", content: userMessage },
                ],
                max_tokens: 4000,
                temperature: 0.1,
                phi: true,
              });
              return {
                payload: normalizeExtraction(res.data),
                usage: res.usage,
                vendor: res.vendor,
                model: res.model,
                ok: true,
              };
            } catch (chunkErr) {
              console.error(
                `[parse-document v${VERSION}] chunk ${idx + 1}/${chunks.length} failed:`,
                chunkErr,
              );
              return {
                payload: { summary: "", items: [] },
                usage: null,
                vendor: "",
                model: "",
                ok: false,
                err: String(chunkErr),
              };
            }
          }),
        );
        debugMeta.chunk_ai_ms = Date.now() - chunkT0;

        // Aggregate usage + vendor/model (vendor/model are constant across
        // chunks; just take the first successful one).
        const okChunks = chunkResults.filter((r) => r.ok);
        const failedChunks = chunkResults.length - okChunks.length;
        debugMeta.chunks_ok = okChunks.length;
        debugMeta.chunks_failed = failedChunks;
        if (truncatedAt !== null) debugMeta.truncated_chunks = truncatedAt - MAX_CHUNKS;

        if (okChunks.length === 0) {
          throw new Error(`All ${chunks.length} chunks failed to extract`);
        }
        aiVendor = okChunks[0].vendor;
        aiModel = okChunks[0].model;
        aiUsage = okChunks.reduce<ChatUsage>(
          (acc, r) => ({
            prompt_tokens: acc.prompt_tokens + (r.usage?.prompt_tokens ?? 0),
            completion_tokens: acc.completion_tokens + (r.usage?.completion_tokens ?? 0),
            total_tokens: acc.total_tokens + (r.usage?.total_tokens ?? 0),
          }),
          { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        );

        // Merge items, dedupe.
        const allItems = okChunks.flatMap((r) => r.payload.items ?? []);
        debugMeta.items_pre_dedup = allItems.length;
        const dedupedItems = dedupItems(allItems);
        debugMeta.items_post_dedup = dedupedItems.length;

        // Synthesize a single document-level summary from per-chunk
        // summaries. Skip if only one chunk — just use its summary.
        let finalSummary = "";
        const chunkSummaries = okChunks.map((r) => r.payload.summary).filter(Boolean);
        if (chunkSummaries.length === 0) {
          finalSummary = "";
        } else if (chunkSummaries.length === 1) {
          finalSummary = chunkSummaries[0];
        } else {
          try {
            const sumRes = await aiChat({
              model: "gpt-4o",
              messages: [
                { role: "system", content: SUMMARY_SYNTHESIS_PROMPT },
                { role: "user", content: chunkSummaries.map((s, i) => `Chunk ${i + 1}: ${s}`).join("\n") },
              ],
              max_tokens: 300,
              temperature: 0.2,
              phi: true,
            });
            finalSummary = sumRes.content.trim().replace(/^["']|["']$/g, "");
            if (sumRes.usage) {
              aiUsage = {
                prompt_tokens: aiUsage.prompt_tokens + sumRes.usage.prompt_tokens,
                completion_tokens: aiUsage.completion_tokens + sumRes.usage.completion_tokens,
                total_tokens: aiUsage.total_tokens + sumRes.usage.total_tokens,
              };
            }
          } catch (sumErr) {
            console.error(`[parse-document v${VERSION}] summary synthesis failed:`, sumErr);
            // Fall back: join the per-chunk summaries.
            finalSummary = chunkSummaries.join(" ");
          }
        }

        // If we truncated, be honest about it in the user-visible summary.
        // Voice rule: no fluff, no exclamation points. Plain note.
        if (truncatedAt !== null) {
          finalSummary = (finalSummary ? finalSummary + " " : "") +
            `Note: this document is very large (${pdfPages || "?"} pages) and we summarized the first ${MAX_CHUNKS} sections; some later content may not be included.`;
        }

        extraction = { summary: finalSummary, items: dedupedItems };
        console.log(
          `[parse-document v${VERSION}] chunked extraction: ${okChunks.length}/${chunks.length} chunks ok, ${allItems.length} items pre-dedup → ${dedupedItems.length} post-dedup`,
        );
      }
    } catch (aiErr) {
      console.error(`[parse-document v${VERSION}] AI call failed:`, aiErr);
      await supabase.from("documents").update({
        extraction_status: "failed",
        extracted_events: { error: "AI parsing failed: " + String(aiErr), debug: debugMeta },
      }).eq("id", document_id);
      return new Response(
        JSON.stringify({ error: "AI parsing failed", details: String(aiErr), step: "ai" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const finalExtraction = {
      ...extraction,
      source: `${aiVendor}/${aiModel}`,
      model: aiModel,
      ai_vendor: aiVendor,
      processed_at: new Date().toISOString(),
      document_type,
      file_name,
      function_version: VERSION,
      usage: aiUsage,
      debug: debugMeta,
    };

    const { error: updateError } = await supabase.from("documents").update({
      extraction_status: "completed",
      extracted_events: finalExtraction,
    }).eq("id", document_id);

    if (updateError) {
      console.error("Update error:", updateError);
      return new Response(
        JSON.stringify({ error: "Failed to save extraction", details: updateError.message }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        document_id,
        extraction_status: "completed",
        extracted_events: finalExtraction,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    console.error(`[parse-document v${VERSION}] Parse error:`, err);
    return new Response(
      JSON.stringify({ error: "Internal error", details: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});

// ────────────────────────────────────────────────────────────────────────────

type ChatUsage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

function parseExtractionJson(raw: string): ExtractedPayload {
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON object found in response");
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeExtraction(parsed);
  } catch (e) {
    console.error("[parse-document] vision JSON parse error:", e, "Raw:", raw.slice(0, 500));
    return {
      summary: "Document was analyzed but results could not be structured. Raw analysis: " + raw.slice(0, 500),
      items: [],
    };
  }
}

function normalizeExtraction(obj: unknown): ExtractedPayload {
  const o = (obj ?? {}) as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary : "";
  const items = Array.isArray(o.items) ? (o.items as ExtractedItem[]) : [];
  return { summary, items };
}
