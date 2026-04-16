import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getCorsHeaders } from "../_shared/cors.ts";
import JSZip from "https://esm.sh/jszip@3.10.1";
import { parseCcdaXml } from "./ccda-parser.ts";
import { parseAppleHealthXml } from "./apple-health-parser.ts";
import { deduplicateRecords } from "./deduplicator.ts";

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

    const body = await req.json();
    const { job_id, storage_path, xml_paths } = body;
    if (!job_id || (!storage_path && !xml_paths)) {
      return json({ error: "job_id and either storage_path or xml_paths required" }, 400);
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

    const personId = job.person_id;
    const userId = job.user_id;
    let uploadedDocs = 0;
    const uploadErrors: { file: string; error: string }[] = [];

    // ── Shared data structures for XML parsing ─────────────────────────────
    const parsedData = {
      medications: [] as ReturnType<typeof parseCcdaXml>["medications"],
      allergies: [] as ReturnType<typeof parseCcdaXml>["allergies"],
      lab_results: [] as ReturnType<typeof parseCcdaXml>["lab_results"],
      vitals: [] as ReturnType<typeof parseCcdaXml>["vitals"],
      conditions: [] as ReturnType<typeof parseCcdaXml>["conditions"],
    };
    const xmlParseErrors: { file: string; error: string }[] = [];
    let xmlParsed = 0;

    // Track inventory for summary
    let pdfFileCount = 0;
    let xmlFileCount = 0;
    let sourceSystem = "unknown";
    let appleHealthStats = { vitals: 0, activities: 0, sleep: 0, workouts: 0 };

    if (xml_paths && Array.isArray(xml_paths)) {
      // ── New flow: individual XML files already uploaded by client ───────
      // PDFs were handled client-side, so we only process XMLs here
      xmlFileCount = xml_paths.length;

      for (const xmlStoragePath of xml_paths) {
        try {
          const { data: xmlData, error: xmlDlErr } = await db.storage
            .from("documents")
            .download(xmlStoragePath);

          if (xmlDlErr || !xmlData) {
            xmlParseErrors.push({ file: xmlStoragePath, error: "Download failed: " + (xmlDlErr?.message || "unknown") });
            continue;
          }

          const xmlContent = await xmlData.text();

          // Detect Apple Health XML
          const previewSlice = xmlContent.substring(0, 500);
          if (
            previewSlice.includes("<!DOCTYPE HealthData") ||
            previewSlice.includes("<HealthData locale=") ||
            previewSlice.includes("<HealthData")
          ) {
            sourceSystem = "apple_health";
            const ahResult = parseAppleHealthXml(xmlContent);

            parsedData.vitals.push(...ahResult.vitals);
            parsedData.conditions.push(...ahResult.conditions);

            for (const err of ahResult.errors) {
              xmlParseErrors.push({ file: xmlStoragePath + " [" + err.section + "]", error: err.error });
            }

            appleHealthStats.vitals = ahResult.vitals.length;
            appleHealthStats.activities = ahResult.conditions.filter(
              (c) => (c as { event_type: string }).event_type === "activity" || (c as { event_type: string }).event_type === "activity_summary",
            ).length;
            appleHealthStats.sleep = ahResult.conditions.filter(
              (c) => (c as { event_type: string }).event_type === "sleep",
            ).length;
            appleHealthStats.workouts = ahResult.conditions.filter(
              (c) => (c as { event_type: string }).event_type === "workout",
            ).length;
            xmlParsed++;
            continue;
          }

          // Skip non-CDA XMLs (manifest files, metadata, etc.)
          if (!xmlContent.includes("ClinicalDocument")) continue;

          // Detect source system from XML content
          if (sourceSystem === "unknown") {
            if (xmlContent.includes("Epic") || xmlContent.includes("MyChart")) {
              sourceSystem = "mychart";
            } else if (xmlContent.includes("Cerner")) {
              sourceSystem = "cerner";
            } else {
              sourceSystem = "generic";
            }
          }

          const extracted = parseCcdaXml(xmlContent, xmlStoragePath);
          parsedData.medications.push(...extracted.medications);
          parsedData.allergies.push(...extracted.allergies);
          parsedData.lab_results.push(...extracted.lab_results);
          parsedData.vitals.push(...extracted.vitals);
          parsedData.conditions.push(...extracted.conditions);

          for (const err of extracted.errors) {
            xmlParseErrors.push({ file: xmlStoragePath + " [" + err.section + "]", error: err.error });
          }
          xmlParsed++;
        } catch (e) {
          xmlParseErrors.push({ file: xmlStoragePath, error: (e as Error).message });
        }
      }
    } else {
      // ── Legacy flow: download ZIP and process server-side ───────────────
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

      // Inventory: count PDFs, XMLs, detect IHE_XDM and Apple Health
      const pdfFiles: { name: string; relativePath: string }[] = [];
      const xmlFiles: string[] = [];
      let hasIheXdm = false;
      let hasCcdaFolder = false;
      let appleHealthXmlPath: string | null = null;

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
        if (lower.includes("ihe_xdm")) hasIheXdm = true;
        // Detect Apple Health export.xml in root or apple_health_export/ folder
        if (lower === "export.xml" || lower === "apple_health_export/export.xml") {
          appleHealthXmlPath = relativePath;
        }
      });

      if (hasIheXdm) {
        sourceSystem = "mychart";
      } else if (hasCcdaFolder) {
        sourceSystem = "cerner";
      } else if (xmlFiles.length > 0) {
        sourceSystem = "generic";
      }

      // Check if the detected XML is actually Apple Health
      if (appleHealthXmlPath) {
        try {
          const ahPreview = await zip.file(appleHealthXmlPath)!.async("text");
          const previewSlice = ahPreview.substring(0, 500);
          if (
            previewSlice.includes("<!DOCTYPE HealthData") ||
            previewSlice.includes("<HealthData locale=") ||
            previewSlice.includes("<HealthData")
          ) {
            sourceSystem = "apple_health";
          } else {
            appleHealthXmlPath = null; // Not actually Apple Health
          }
        } catch {
          appleHealthXmlPath = null;
        }
      }

      pdfFileCount = pdfFiles.length;
      xmlFileCount = xmlFiles.length;

      // For each PDF found: upload individually to documents bucket, create documents row
      for (const pdf of pdfFiles) {
        try {
          const pdfData = await zip.file(pdf.relativePath)!.async("arraybuffer");
          const pdfBlob = new Blob([pdfData], { type: "application/pdf" });

          const safeName = pdf.name.replace(/[^a-zA-Z0-9._-]/g, "_");
          const pdfStoragePath = userId + "/" + Date.now() + "_" + safeName;

          const { error: uploadErr } = await db.storage
            .from("documents")
            .upload(pdfStoragePath, pdfBlob, { upsert: true, contentType: "application/pdf" });

          if (uploadErr) {
            uploadErrors.push({ file: pdf.name, error: uploadErr.message });
            continue;
          }

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

      // ── Apple Health XML parsing ───────────────────────────────────────
      if (sourceSystem === "apple_health" && appleHealthXmlPath) {
        try {
          const ahContent = await zip.file(appleHealthXmlPath)!.async("text");
          const ahResult = parseAppleHealthXml(ahContent);

          parsedData.vitals.push(...ahResult.vitals);
          parsedData.conditions.push(...ahResult.conditions);

          for (const err of ahResult.errors) {
            xmlParseErrors.push({ file: appleHealthXmlPath + " [" + err.section + "]", error: err.error });
          }

          appleHealthStats.vitals = ahResult.vitals.length;
          appleHealthStats.activities = ahResult.conditions.filter(
            (c) => (c as { event_type: string }).event_type === "activity" || (c as { event_type: string }).event_type === "activity_summary",
          ).length;
          appleHealthStats.sleep = ahResult.conditions.filter(
            (c) => (c as { event_type: string }).event_type === "sleep",
          ).length;
          appleHealthStats.workouts = ahResult.conditions.filter(
            (c) => (c as { event_type: string }).event_type === "workout",
          ).length;
          xmlParsed++;
        } catch (e) {
          xmlParseErrors.push({ file: appleHealthXmlPath, error: (e as Error).message });
        }
      }

      // ── C-CDA XML parsing ─────────────────────────────────────────────
      for (const xmlPath of xmlFiles) {
        try {
          const xmlContent = await zip.file(xmlPath)!.async("text");
          // Skip non-CDA XMLs (manifest files, metadata, Apple Health export.xml)
          if (!xmlContent.includes("ClinicalDocument")) continue;

          const extracted = parseCcdaXml(xmlContent, xmlPath);
          parsedData.medications.push(...extracted.medications);
          parsedData.allergies.push(...extracted.allergies);
          parsedData.lab_results.push(...extracted.lab_results);
          parsedData.vitals.push(...extracted.vitals);
          parsedData.conditions.push(...extracted.conditions);

          for (const err of extracted.errors) {
            xmlParseErrors.push({ file: xmlPath + " [" + err.section + "]", error: err.error });
          }
          xmlParsed++;
        } catch (e) {
          xmlParseErrors.push({ file: xmlPath, error: (e as Error).message });
        }
      }
    }

    // Deduplicate against existing records
    const deduped = await deduplicateRecords(db, personId, parsedData);

    // Batch insert — each table independently, partial failures logged
    const insertErrors: { table: string; error: string }[] = [];

    if (deduped.allergies.length > 0) {
      const rows = deduped.allergies.map((a) => ({
        person_id: personId,
        substance: a.substance,
        reaction: a.reaction,
        severity: a.severity,
        clinical_status: a.clinical_status,
        source: a.source,
        source_system: a.source_system,
        export_job_id: job_id,
      }));
      const { error: err } = await db.from("allergies").insert(rows);
      if (err) insertErrors.push({ table: "allergies", error: err.message });
    }

    if (deduped.lab_results.length > 0) {
      const rows = deduped.lab_results.map((l) => ({
        person_id: personId,
        test_name: l.test_name,
        value: l.value,
        unit: l.unit,
        reference_range: l.reference_range,
        status: l.status,
        effective_date: l.effective_date,
        loinc_code: l.loinc_code,
        category: l.category,
        source: l.source,
        export_job_id: job_id,
      }));
      const { error: err } = await db.from("lab_results").insert(rows);
      if (err) insertErrors.push({ table: "lab_results", error: err.message });
    }

    if (deduped.vitals.length > 0) {
      const rows = deduped.vitals.map((v) => ({
        person_id: personId,
        vital_type: v.vital_type,
        value: v.value,
        unit: v.unit,
        effective_date: v.effective_date,
        loinc_code: v.loinc_code,
        source: v.source,
        export_job_id: job_id,
      }));
      const { error: err } = await db.from("vitals").insert(rows);
      if (err) insertErrors.push({ table: "vitals", error: err.message });
    }

    if (deduped.medications.length > 0) {
      const rows = deduped.medications.map((m) => ({
        person_id: personId,
        name: m.name,
        dose: m.dose,
        frequency: m.frequency,
        active: m.active,
        source: m.source,
        ehr_system: m.ehr_system,
        export_job_id: job_id,
      }));
      const { error: err } = await db.from("medications").insert(rows);
      if (err) insertErrors.push({ table: "medications", error: err.message });
    }

    if (deduped.conditions.length > 0) {
      const rows = deduped.conditions.map((c) => ({
        person_id: personId,
        event_type: c.event_type,
        title: c.title,
        event_date: c.event_date || new Date().toISOString(),
        source: c.source,
        ehr_system: c.ehr_system,
        export_job_id: job_id,
      }));
      const { error: err } = await db.from("health_events").insert(rows);
      if (err) insertErrors.push({ table: "health_events", error: err.message });
    }

    // Build summary
    const summary: Record<string, unknown> = {
      pdf_count: pdfFileCount,
      pdf_stored: uploadedDocs,
      xml_count: xmlFileCount,
      xml_parsed: xmlParsed,
      has_structured_data: xmlParsed > 0,
      source_system: sourceSystem,
      medications_found: parsedData.medications.length,
      medications_new: deduped.medications.length,
      allergies_found: parsedData.allergies.length,
      allergies_new: deduped.allergies.length,
      lab_results_found: parsedData.lab_results.length,
      lab_results_new: deduped.lab_results.length,
      vitals_found: parsedData.vitals.length,
      vitals_new: deduped.vitals.length,
      conditions_found: parsedData.conditions.length,
      conditions_new: deduped.conditions.length,
      ...(sourceSystem === "apple_health" ? {
        apple_health_vitals: appleHealthStats.vitals,
        apple_health_activities: appleHealthStats.activities,
        apple_health_sleep: appleHealthStats.sleep,
        apple_health_workouts: appleHealthStats.workouts,
      } : {}),
    };

    const allErrors = [
      ...uploadErrors.map((e) => ({ ...e, phase: "pdf" })),
      ...xmlParseErrors.map((e) => ({ ...e, phase: "xml_parse" })),
      ...insertErrors.map((e) => ({ ...e, phase: "xml_insert" })),
    ];
    const finalStatus =
      allErrors.length > 0 && uploadedDocs === 0 && xmlParsed === 0
        ? "failed"
        : "completed";

    // Update job with summary
    await db
      .from("health_export_jobs")
      .update({
        status: finalStatus,
        source_system: sourceSystem,
        summary: summary,
        errors: allErrors.length > 0 ? allErrors : [],
        completed_at: new Date().toISOString(),
      })
      .eq("id", job_id);

    return json({
      success: true,
      summary: summary,
      errors: allErrors,
    });
  } catch (e) {
    console.error("process-health-export error:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
