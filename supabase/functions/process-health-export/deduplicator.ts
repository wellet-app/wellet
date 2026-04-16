/**
 * Deduplication logic for C-CDA parsed records.
 *
 * Queries existing records ONCE per table, then filters in-memory.
 * Rules:
 *   - Allergies: match by substance (case-insensitive) per person
 *   - Labs: match by test_name + effective_date (same day) per person
 *   - Medications: match by name (case-insensitive) per person — manual entries always win
 *   - Vitals: insert ALL (multiple readings per day is normal)
 *   - Conditions/health_events: match by title (case-insensitive) + event_type per person
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import type {
  ParsedMedication,
  ParsedAllergy,
  ParsedLabResult,
  ParsedVital,
  ParsedCondition,
} from "./ccda-parser.ts";

export interface DeduplicatedRecords {
  medications: ParsedMedication[];
  allergies: ParsedAllergy[];
  lab_results: ParsedLabResult[];
  vitals: ParsedVital[];
  conditions: ParsedCondition[];
}

/** Normalize string for comparison */
function norm(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

/** Get date-only string (YYYY-MM-DD) from ISO timestamp */
function dateOnly(isoStr: string | null | undefined): string {
  if (!isoStr) return "";
  return isoStr.substring(0, 10);
}

export async function deduplicateRecords(
  db: SupabaseClient,
  personId: string,
  parsed: {
    medications: ParsedMedication[];
    allergies: ParsedAllergy[];
    lab_results: ParsedLabResult[];
    vitals: ParsedVital[];
    conditions: ParsedCondition[];
  },
): Promise<DeduplicatedRecords> {
  // Query all existing records for this person in parallel
  const [allergyRes, labRes, medRes, conditionRes] = await Promise.all([
    db.from("allergies").select("substance").eq("person_id", personId),
    db.from("lab_results").select("test_name, effective_date").eq("person_id", personId),
    db.from("medications").select("name, source").eq("person_id", personId),
    db.from("health_events").select("title, event_type").eq("person_id", personId).eq("event_type", "condition"),
  ]);

  // ── Allergies: dedupe by substance (case-insensitive) ──
  const existingSubstances = new Set(
    (allergyRes.data || []).map((a: { substance: string }) => norm(a.substance)),
  );
  const newAllergies = parsed.allergies.filter(
    (a) => !existingSubstances.has(norm(a.substance)),
  );

  // ── Labs: dedupe by test_name + effective_date (same day) ──
  const existingLabKeys = new Set(
    (labRes.data || []).map(
      (l: { test_name: string; effective_date: string }) =>
        norm(l.test_name) + "|" + dateOnly(l.effective_date),
    ),
  );
  const newLabs = parsed.lab_results.filter(
    (l) => !existingLabKeys.has(norm(l.test_name) + "|" + dateOnly(l.effective_date)),
  );

  // ── Medications: dedupe by name — manual entries always win ──
  const existingMeds = (medRes.data || []) as { name: string; source: string }[];
  const existingMedNames = new Set(existingMeds.map((m) => norm(m.name)));
  // Only add EHR meds that aren't already tracked (manual or EHR)
  const newMeds = parsed.medications.filter(
    (m) => !existingMedNames.has(norm(m.name)),
  );

  // ── Vitals: insert ALL — multiple readings per day is normal ──
  const newVitals = parsed.vitals;

  // ── Conditions: dedupe by title + event_type ──
  const existingCondKeys = new Set(
    (conditionRes.data || []).map(
      (c: { title: string; event_type: string }) => norm(c.title) + "|" + norm(c.event_type),
    ),
  );
  const newConditions = parsed.conditions.filter(
    (c) => !existingCondKeys.has(norm(c.title) + "|" + norm(c.event_type)),
  );

  return {
    medications: newMeds,
    allergies: newAllergies,
    lab_results: newLabs,
    vitals: newVitals,
    conditions: newConditions,
  };
}
