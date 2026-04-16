import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";

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

    const { job_id, storage_path } = await req.json();
    if (!job_id || !storage_path) {
      return json({ error: "job_id and storage_path required" }, 400);
    }

    // Verify the job belongs to this user
    const { data: job, error: jobErr } = await db
      .from("health_export_jobs")
      .select("id, user_id, person_id, file_name")
      .eq("id", job_id)
      .single();

    if (jobErr || !job) {
      return json({ error: "Job not found" }, 404);
    }
    if (job.user_id !== user.id) {
      return json({ error: "Not authorized" }, 403);
    }

    // Mark as processing
    await db
      .from("health_export_jobs")
      .update({ status: "processing" })
      .eq("id", job_id);

    // Download the ZIP from Supabase Storage
    const { data: fileData, error: dlError } = await db.storage
      .from("documents")
      .download(storage_path);

    if (dlError || !fileData) {
      await db
        .from("health_export_jobs")
        .update({
          status: "failed",
          errors: [{ message: "Failed to download file: " + (dlError?.message || "unknown") }],
        })
        .eq("id", job_id);
      return json({ error: "Failed to download file" }, 500);
    }

    // Unzip and inventory contents
    const arrayBuffer = await fileData.arrayBuffer();
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(arrayBuffer);
    } catch (e) {
      await db
        .from("health_export_jobs")
        .update({
          status: "failed",
          errors: [{ message: "Invalid ZIP file: " + (e as Error).message }],
        })
        .eq("id", job_id);
      return json({ error: "Invalid ZIP file" }, 400);
    }

    // Inventory: count PDFs, XMLs, detect IHE_XDM
    const pdfFiles: { name: string; relativePath: string }[] = [];
    const xmlFiles: string[] = [];
    let hasIheXdm = false;
    let hasCcdaFolder = false;

    zip.forEach((relativePath, zipEntry) => {
      if (zipEntry.dir) {
        if (relativePath.toUpperCase().includes("IHE_XDM")) hasIheXdm = true;
        if (relativePath.toUpperCase().includes("CCDA")) hasCcdaFolder = true;
        return;
      }
      const lower = relativePath.toLowerCase();
      if (lower.endsWith(".pdf")) {
        const fileName = relativePath.split("/").pop() || relativePath;
        pdfFiles.push({ name: fileName, relativePath });
      }
      if (lower.endsWith(".xml")) {
        xmlFiles.push(relativePath);
      }
      // Check file paths for IHE_XDM too
      if (lower.includes("ihe_xdm")) hasIheXdm = true;
    });

    // Detect source system
    let sourceSystem = "unknown";
    if (hasIheXdm) {
      sourceSystem = "mychart";
    } else if (hasCcdaFolder) {
      sourceSystem = "cerner";
    } else if (xmlFiles.length > 0) {
      sourceSystem = "generic";
    }

    // For each PDF found: upload individually to documents bucket, create documents row
    const personId = job.person_id;
    const userId = job.user_id;
    let uploadedDocs = 0;
    const uploadErrors: { file: string; error: string }[] = [];

    for (const pdf of pdfFiles) {
      try {
        const pdfData = await zip.file(pdf.relativePath)!.async("arraybuffer");
        const pdfBlob = new Blob([pdfData], { type: "application/pdf" });

        // Upload to storage
        const safeName = pdf.name.replace(/[^a-zA-Z0-9._-]/g, "_");
        const pdfStoragePath = userId + "/" + Date.now() + "_" + safeName;

        const { error: uploadErr } = await db.storage
          .from("documents")
          .upload(pdfStoragePath, pdfBlob, { upsert: true, contentType: "application/pdf" });

        if (uploadErr) {
          uploadErrors.push({ file: pdf.name, error: uploadErr.message });
          continue;
        }

        // Create document record
        const { error: insertErr } = await db.from("documents").insert({
          person_id: personId,
          file_name: pdf.name,
          storage_path: pdfStoragePath,
          document_type: "Health record PDF",
          extraction_status: "stored",
        });

        if (insertErr) {
          uploadErrors.push({ file: pdf.name, error: insertErr.message });
        } else {
          uploadedDocs++;
        }
      } catch (e) {
        uploadErrors.push({ file: pdf.name, error: (e as Error).message });
      }
    }

    // Build summary
    const summary = {
      pdf_count: pdfFiles.length,
      pdf_stored: uploadedDocs,
      xml_count: xmlFiles.length,
      has_structured_data: hasIheXdm || xmlFiles.length > 0,
      source_system: sourceSystem,
    };

    const finalStatus = uploadErrors.length > 0 && uploadedDocs === 0 ? "failed" : "completed";

    // Update job with summary
    await db
      .from("health_export_jobs")
      .update({
        status: finalStatus,
        source_system: sourceSystem,
        summary: summary,
        errors: uploadErrors.length > 0 ? uploadErrors : [],
        completed_at: new Date().toISOString(),
      })
      .eq("id", job_id);

    return json({
      success: true,
      summary: summary,
      errors: uploadErrors,
    });
  } catch (e) {
    console.error("process-health-export error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
