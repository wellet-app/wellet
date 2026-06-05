// _shared/ehr-persist.ts — persist FHIR-derived data into Wellet tables.
//
// Before this module existed, fetch-ehr-data pulled Medications, Conditions,
// Observations, Immunizations, Encounters, DiagnosticReports, and Allergies
// from the patient's EHR, mapped them into display-friendly JSON, and returned
// the JSON to the frontend WITHOUT writing anything to the database. That left
// `medications`, `allergies`, `health_events`, `lab_results`, and `vitals`
// completely empty for every user, which is why Emergency Summary and any
// other feature that reads from those tables (Update Me, Care Team enrichment,
// visit history) showed "None reported" even though the sync log claimed
// hundreds of resources were fetched.
//
// This module takes the already-mapped result shapes produced by
// fetch-ehr-data's `map*` helpers and upserts them into the canonical tables.
// Upserts are keyed on (person_id, source_fingerprint) with a partial unique
// index, so re-running a sync replaces the row in place instead of duplicating.
//
// The fingerprint is a stable hash of source_system + resource_type + key
// fields (code/name/date). Two MedicationRequests for the same drug with the
// same authoredOn date will collide and that's fine — the mapper already dedups
// by lowercased name before we get here.

type SupaClient = {
  // Intentionally loose — we only call .from().upsert() / .delete()
  from: (table: string) => any;
};

// Legacy default kept for the fingerprint salt only — do NOT change. Existing
// rows were fingerprinted with the literal 'epic' before this module became
// multi-EHR aware. Bumping this string would invalidate every dedup key in the
// database and cause every re-sync to duplicate rows. The per-row ehr_system
// LABEL is now derived per-connection via deriveEhrSystem() and threaded in
// from the caller; the fingerprint salt stays constant on purpose.
const FP_SALT = 'epic';
const SOURCE_LABEL = 'ehr'; // matches the `source` column semantics in existing tables

// Derive a short ehr_system label from a FHIR base URL. This is the value that
// lands in medications.ehr_system, health_events.ehr_system, etc. It is
// user-visible via the provider pill on records and analytics filters, so we
// keep the set small and stable. New EHRs get added here as we onboard them.
// Defaults to 'epic' so legacy Epic syncs (and any unrecognized URL) keep
// their current label.
export function deriveEhrSystem(fhirBaseUrl: string | null | undefined): string {
  if (!fhirBaseUrl || typeof fhirBaseUrl !== 'string') return 'epic';
  const u = fhirBaseUrl.toLowerCase();
  if (u.includes('va.gov')) return 'va';
  if (u.includes('cerner.com') || u.includes('oracle.com') || u.includes('oraclecloud')) return 'cerner';
  // Everything else (fhir.epic.com, dukehealth.org behind Epic, unchealth.org
  // behind Epic, sandbox-fhir.epic.com, etc.) is Epic-flavored FHIR.
  return 'epic';
}

// ---------------------------------------------------------------------------
// Fingerprint helpers
// ---------------------------------------------------------------------------

// Short deterministic hash — 16 hex chars is plenty for per-person uniqueness.
// Crypto-grade is unnecessary; we just need stability across sync runs. We use
// FNV-1a 64-bit implemented over BigInt to avoid pulling in a hash library,
// and emit 16 hex chars.
function fp(...parts: (string | null | undefined | number)[]): string {
  const joined = parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('|');
  // FNV-1a 64-bit constants
  const FNV_OFFSET = 0xcbf29ce484222325n;
  const FNV_PRIME = 0x100000001b3n;
  const MASK64 = 0xffffffffffffffffn;
  let h = FNV_OFFSET;
  for (let i = 0; i < joined.length; i++) {
    h ^= BigInt(joined.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

// Normalize a date-ish value to YYYY-MM-DD (or '' if unparseable). Using the
// day-part only keeps fingerprints stable even if the EHR returns a slightly
// different timestamp (e.g. fractional seconds) on a later sync.
function toDateKey(d: unknown): string {
  if (!d || typeof d !== 'string') return '';
  try {
    const dt = new Date(d);
    if (isNaN(dt.getTime())) return '';
    return dt.toISOString().slice(0, 10);
  } catch {
    return '';
  }
}

// Guard an ISO date-ish value before writing to a `timestamp with time zone`
// column. Returns null if the value is empty or malformed.
function toIsoOrNull(d: unknown): string | null {
  if (!d || typeof d !== 'string') return null;
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? null : dt.toISOString();
}

// Guard an ISO date-ish value before writing to a `date` column.
function toDateOrNull(d: unknown): string | null {
  const iso = toIsoOrNull(d);
  return iso ? iso.slice(0, 10) : null;
}

// ---------------------------------------------------------------------------
// Row builders — one per destination table
// ---------------------------------------------------------------------------

// Medications: `active` is derived from the FHIR MedicationRequest status.
// Emergency Summary and the Records page both filter on active=true.
function buildMedicationRows(personId: string, connectionId: string | null, ehrSystem: string, mapped: any[]): Record<string, unknown>[] {
  if (!Array.isArray(mapped)) return [];
  return mapped
    .map((m) => {
      const name = String(m?.name || '').trim();
      if (!name) return null;
      const code = String(m?.code || '');
      const dateKey = toDateKey(m?.date_asserted);
      // MedicationRequest.status values we consider "active": active, on-hold, draft.
      // completed / stopped / cancelled / entered-in-error are NOT active.
      const status = String(m?.status || '').toLowerCase();
      const active = status === 'active' || status === 'on-hold' || status === 'draft' || status === '';
      return {
        person_id: personId,
        connection_id: connectionId,
        name,
        dose: m?.dosage || null,
        frequency: m?.frequency || null,
        prescriber: m?.prescriber_name || null,
        start_date: toDateOrNull(m?.date_asserted),
        active,
        source: SOURCE_LABEL,
        ehr_system: ehrSystem,
        encounter_fhir_id: (m?.encounter_ref as string) || null,
        source_fingerprint: fp(FP_SALT, 'MedicationRequest', name.toLowerCase(), code, dateKey),
      };
    })
    .filter((r) => r !== null) as Record<string, unknown>[];
}

function buildAllergyRows(personId: string, connectionId: string | null, ehrSystem: string, mapped: any[]): Record<string, unknown>[] {
  if (!Array.isArray(mapped)) return [];
  return mapped
    .map((a) => {
      const substance = String(a?.name || '').trim();
      if (!substance || substance === 'Unknown allergen') return null;
      const code = String(a?.code || '');
      const recorded = toDateKey(a?.recorded_date);
      const reactionArr = Array.isArray(a?.reactions) ? a.reactions : [];
      const reactionText = reactionArr.filter(Boolean).join(', ') || null;
      return {
        person_id: personId,
        connection_id: connectionId,
        substance,
        reaction: reactionText,
        severity: a?.severity || null,
        clinical_status: a?.status || null,
        onset_date: toIsoOrNull(a?.recorded_date),
        source: SOURCE_LABEL,
        source_code: code || null,
        source_system: ehrSystem,
        source_fingerprint: fp(FP_SALT, 'AllergyIntolerance', substance.toLowerCase(), code, recorded),
      };
    })
    .filter((r) => r !== null) as Record<string, unknown>[];
}

// health_events is the unified timeline read by Emergency Summary + Update Me.
// We fold in conditions, visits, immunizations, and diagnostic reports as
// distinct event_type values. (Lab results live in `lab_results`, not here.)
function buildHealthEventRows(
  personId: string,
  connectionId: string | null,
  ehrSystem: string,
  conditions: any[],
  visits: any[],
  immunizations: any[],
  diagnosticReports: any[],
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];

  // Conditions → event_type 'condition'. event_date is onset when known,
  // otherwise recordedDate. Skip rows with no usable date — PG requires
  // event_date NOT NULL.
  if (Array.isArray(conditions)) {
    for (const c of conditions) {
      const title = String(c?.name || '').trim();
      if (!title || title === 'Unknown condition') continue;
      const iso = toIsoOrNull(c?.onset_date) || toIsoOrNull(c?.recorded_date);
      if (!iso) continue;
      const code = String(c?.code || '');
      rows.push({
        person_id: personId,
        connection_id: connectionId,
        event_type: 'condition',
        event_date: iso,
        title,
        notes: c?.status ? `Status: ${c.status}` : null,
        source: SOURCE_LABEL,
        ehr_system: ehrSystem,
        accepted: true,
        encounter_fhir_id: (c?.encounter_ref as string) || null,
        source_fingerprint: fp(FP_SALT, 'Condition', title.toLowerCase(), code, iso.slice(0, 10)),
      });
    }
  }

  // Visits → event_type 'visit', except non-visit encounter types (refills,
  // patient messages, phone calls, e-visits, result notes, letters, portal
  // messages) which Epic returns as Encounter resources but which are not
  // real visits. Those are persisted as event_type='note' so the timeline
  // doesn't surface them as Appointments. The detection mirrors the
  // frontend classifier in assets/wellet.js — keep the regex here in sync
  // when adding new patterns there.
  const NON_VISIT_RE = /\b(refill|message|patient message|telephone|phone call|letter|e-?visit|portal|result note)\b/i;
  if (Array.isArray(visits)) {
    for (const v of visits) {
      const title = String(v?.name || v?.reason || 'Visit').trim();
      const iso = toIsoOrNull(v?.start_date) || toIsoOrNull(v?.end_date);
      if (!iso) continue;
      const vid = String(v?.id || '');
      const location = String(v?.location || '');
      // 'type' on the mapped object is either 'encounter' (past) or
      // 'appointment' (future). Appointments must NEVER be reclassified as
      // 'note' — the non-visit regex only applies to historical encounters.
      const sourceKind = String(v?.type || '').toLowerCase();
      const isAppointment = sourceKind === 'appointment';
      const encType = String(v?.encounter_type || (isAppointment ? '' : sourceKind));
      const isNonVisit = !isAppointment && (NON_VISIT_RE.test(title) || NON_VISIT_RE.test(encType));
      // Fingerprint differentiates Encounter vs Appointment so the same Epic
      // resource ID across both types never collides into one row.
      const fhirResource = isAppointment ? 'Appointment' : 'Encounter';
      // Encounter rows store their own FHIR id as the encounter_fhir_id so
      // child rows (labs/vitals/meds/conditions) can join back to the visit
      // they belong to. Appointments are future-only and don't gather child
      // resources, but we still tag them so downstream joins are uniform.
      const classCode = String(v?.class || '');
      const classDisplay = String(v?.class_display || '');
      const serviceProvider = String(v?.service_provider || '');
      const reasonText = String(v?.reason || '');
      rows.push({
        person_id: personId,
        connection_id: connectionId,
        event_type: isNonVisit ? 'note' : 'visit',
        event_date: iso,
        title,
        notes: [v?.reason, location].filter(Boolean).join(' — ') || null,
        source: SOURCE_LABEL,
        ehr_system: ehrSystem,
        accepted: true,
        encounter_fhir_id: vid || null,
        encounter_class_code: classCode || null,
        encounter_class_display: classDisplay || null,
        encounter_service_provider: serviceProvider || null,
        encounter_reason_text: reasonText || null,
        encounter_period_end: toIsoOrNull(v?.end_date),
        source_fingerprint: fp(FP_SALT, fhirResource, vid, iso.slice(0, 10)),
      });
    }
  }

  // Immunizations → event_type 'immunization'.
  if (Array.isArray(immunizations)) {
    for (const im of immunizations) {
      const title = String(im?.name || '').trim();
      if (!title || title === 'Immunization') continue;
      const iso = toIsoOrNull(im?.date);
      if (!iso) continue;
      const code = String(im?.code || '');
      rows.push({
        person_id: personId,
        connection_id: connectionId,
        event_type: 'immunization',
        event_date: iso,
        title,
        notes: im?.lot_number ? `Lot: ${im.lot_number}` : null,
        source: SOURCE_LABEL,
        ehr_system: ehrSystem,
        accepted: true,
        source_fingerprint: fp(FP_SALT, 'Immunization', title.toLowerCase(), code, iso.slice(0, 10)),
      });
    }
  }

  // DiagnosticReports → event_type 'diagnostic_report'. These are often imaging,
  // pathology, cardiology reports — worth surfacing on the timeline so family
  // members can see "Mom had an MRI last month" without digging.
  if (Array.isArray(diagnosticReports)) {
    for (const d of diagnosticReports) {
      const title = String(d?.name || '').trim();
      if (!title || title === 'Diagnostic Report') continue;
      const iso = toIsoOrNull(d?.effective_date) || toIsoOrNull(d?.issued);
      if (!iso) continue;
      const code = String(d?.code || '');
      const conclusion = String(d?.conclusion || '').trim();
      const notes = conclusion
        ? conclusion.length > 500
          ? conclusion.slice(0, 500) + '…'
          : conclusion
        : (d?.category || null);
      rows.push({
        person_id: personId,
        connection_id: connectionId,
        event_type: 'diagnostic_report',
        event_date: iso,
        title,
        notes,
        source: SOURCE_LABEL,
        ehr_system: ehrSystem,
        accepted: true,
        encounter_fhir_id: (d?.encounter_ref as string) || null,
        source_fingerprint: fp(FP_SALT, 'DiagnosticReport', title.toLowerCase(), code, iso.slice(0, 10)),
      });
    }
  }

  return rows;
}

// Observations split into lab_results vs vitals by FHIR category.
// Vital-signs category keys: 'vital-signs'. Lab keys: 'laboratory'.
// When category is missing, fall back to LOINC heuristics:
//   8480-6 / 8462-4 (BP), 8867-4 (HR), 8310-5 (body temp), 29463-7 (weight),
//   8302-2 (height), 39156-5 (BMI), 2708-6 / 59408-5 (O2 sat) → vital
// Otherwise → lab.
const VITAL_LOINC = new Set([
  '8480-6', '8462-4', '8867-4', '8310-5', '29463-7',
  '8302-2', '39156-5', '2708-6', '59408-5', '9279-1',
]);

function isVitalObservation(o: any): boolean {
  const cat = String(o?.category || '').toLowerCase();
  if (cat === 'vital-signs') return true;
  if (cat === 'laboratory') return false;
  const code = String(o?.code || '');
  return VITAL_LOINC.has(code);
}

function buildLabRows(personId: string, connectionId: string | null, _ehrSystem: string, mapped: any[]): Record<string, unknown>[] {
  if (!Array.isArray(mapped)) return [];
  // lab_results table has no ehr_system column today — _ehrSystem is accepted
  // for symmetry with the other row builders and will be wired in once the
  // column is added. Fingerprint still uses FP_SALT for dedup stability.
  return mapped
    .map((o) => {
      if (isVitalObservation(o)) return null;
      const testName = String(o?.name || '').trim();
      if (!testName || testName === 'Lab result') return null;
      const iso = toIsoOrNull(o?.effective_date);
      const code = String(o?.code || '');
      // lab_results.status is an abnormality flag (normal/abnormal/critical/
      // unknown), NOT a FHIR workflow status. Observation.status (final /
      // preliminary / amended / etc.) is workflow state and doesn't map to
      // any of those, so we write null — let the UI render it as unknown.
      return {
        person_id: personId,
        connection_id: connectionId,
        test_name: testName,
        value: o?.value ? String(o.value) : null,
        unit: o?.unit || null,
        reference_range: o?.reference_range || null,
        status: null,
        effective_date: iso,
        loinc_code: code || null,
        category: o?.category || 'laboratory',
        source: SOURCE_LABEL,
        encounter_fhir_id: (o?.encounter_ref as string) || null,
        source_fingerprint: fp(
          FP_SALT,
          'Observation.lab',
          testName.toLowerCase(),
          code,
          iso ? iso.slice(0, 10) : '',
          String(o?.value ?? ''),
        ),
      };
    })
    .filter((r) => r !== null) as Record<string, unknown>[];
}

function buildVitalRows(personId: string, connectionId: string | null, _ehrSystem: string, mapped: any[]): Record<string, unknown>[] {
  if (!Array.isArray(mapped)) return [];
  // vitals table has no ehr_system column today — _ehrSystem is accepted for
  // symmetry. Fingerprint uses FP_SALT for dedup stability.
  return mapped
    .map((o) => {
      if (!isVitalObservation(o)) return null;
      const vitalType = String(o?.name || '').trim();
      if (!vitalType) return null;
      const valueStr = o?.value !== undefined && o?.value !== null ? String(o.value) : '';
      if (!valueStr) return null; // vitals.value is NOT NULL
      const iso = toIsoOrNull(o?.effective_date);
      const code = String(o?.code || '');
      return {
        person_id: personId,
        connection_id: connectionId,
        vital_type: vitalType,
        value: valueStr,
        unit: o?.unit || null,
        effective_date: iso,
        loinc_code: code || null,
        source: SOURCE_LABEL,
        encounter_fhir_id: (o?.encounter_ref as string) || null,
        source_fingerprint: fp(
          FP_SALT,
          'Observation.vital',
          vitalType.toLowerCase(),
          code,
          iso ? iso.slice(0, 10) : '',
          valueStr,
        ),
      };
    })
    .filter((r) => r !== null) as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Batched upsert
// ---------------------------------------------------------------------------

// Dedupe rows by (person_id, source_fingerprint) before handing them to
// upsert. Postgres rejects an upsert whose input batch contains two rows that
// match the same conflict target ("ON CONFLICT DO UPDATE command cannot affect
// row a second time"). FHIR sources can legitimately produce duplicates — e.g.
// two Condition resources for the same problem on the same recordedDate, or
// two DiagnosticReports with the same LOINC code issued the same day. We keep
// the first occurrence; mappers already dedup meaningful cases upstream.
function dedupeByFingerprint(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    // Phase 2: dedupe key includes connection_id so the same med synced from
    // two hospitals on the same day doesn't get squashed in this batch.
    const connKey = r.connection_id == null ? '__null__' : String(r.connection_id);
    const key = `${r.person_id}|${connKey}|${r.source_fingerprint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function upsertBatch(
  admin: SupaClient,
  table: string,
  rowsRaw: Record<string, unknown>[],
): Promise<{ inserted: number; error: string | null }> {
  const rows = dedupeByFingerprint(rowsRaw);
  if (rows.length === 0) return { inserted: 0, error: null };
  // Chunk to keep payloads under Postgres / PostgREST limits. 200 is
  // comfortable for our row sizes (<1kB each) and stays well under the
  // 1MB statement default.
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const { error, count } = await admin
      .from(table)
      .upsert(slice, {
        // Phase 2: matches the new (person_id, connection_id, source_fingerprint)
        // UNIQUE NULLS NOT DISTINCT index. Each connection owns its own
        // fingerprint slot per person; manual rows (connection_id IS NULL)
        // collapse into a single shared slot, preserving the old dedup behavior
        // for CCDA / Apple Health uploads.
        onConflict: 'person_id,connection_id,source_fingerprint',
        count: 'exact',
        ignoreDuplicates: false,
      });
    if (error) {
      return {
        inserted: total,
        error: `${table} upsert chunk ${i}: ${error.message || error.code || 'unknown'}`,
      };
    }
    total += typeof count === 'number' ? count : slice.length;
  }
  return { inserted: total, error: null };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type PersistResult = {
  medications: number;
  allergies: number;
  health_events: number;
  lab_results: number;
  vitals: number;
  errors: string[];
  // Wall time so the sync log can record persistence cost separately from
  // the Duke fetch round-trips.
  duration_ms: number;
};

export async function persistEhrData(
  admin: SupaClient,
  personId: string,
  mapped: {
    medications?: any[];
    allergies?: any[];
    conditions?: any[];
    visits?: any[];
    immunizations?: any[];
    diagnostic_reports?: any[];
    observations?: any[];
  },
  // Phase 2: Source-tag every row with the connection it came from so the
  // hospital pill UI and per-connection reconnect banners can find their data.
  // Pass `null` (the default) for non-EHR persistence paths (manual entry,
  // CCDA upload, Apple Health import) — those rows continue to coexist via
  // the NULLS NOT DISTINCT unique index.
  connectionId: string | null = null,
  // Phase 3: ehr_system label — derived per-connection by the caller (most
  // easily via deriveEhrSystem(conn.fhir_base_url)). Defaults to 'epic' so
  // existing Epic callers don't need to change and so the legacy behavior is
  // preserved if a caller forgets to thread it through. Note: this only
  // affects the row LABEL — the dedup fingerprint is always salted with the
  // legacy 'epic' constant via FP_SALT, so existing rows are not duplicated.
  ehrSystem: string = 'epic',
): Promise<PersistResult> {
  const t0 = Date.now();
  const errors: string[] = [];

  const medRows = buildMedicationRows(personId, connectionId, ehrSystem, mapped.medications || []);
  const allergyRows = buildAllergyRows(personId, connectionId, ehrSystem, mapped.allergies || []);
  const eventRows = buildHealthEventRows(
    personId,
    connectionId,
    ehrSystem,
    mapped.conditions || [],
    mapped.visits || [],
    mapped.immunizations || [],
    mapped.diagnostic_reports || [],
  );
  const labRows = buildLabRows(personId, connectionId, ehrSystem, mapped.observations || []);
  const vitalRows = buildVitalRows(personId, connectionId, ehrSystem, mapped.observations || []);

  // Run each table's upsert sequentially. Could parallelize with Promise.all
  // but sequencing keeps error isolation clean and a typical payload is under
  // 1000 rows total — speed is not the bottleneck here.
  const medRes = await upsertBatch(admin, 'medications', medRows);
  if (medRes.error) errors.push(medRes.error);

  const allergyRes = await upsertBatch(admin, 'allergies', allergyRows);
  if (allergyRes.error) errors.push(allergyRes.error);

  const eventRes = await upsertBatch(admin, 'health_events', eventRows);
  if (eventRes.error) errors.push(eventRes.error);

  const labRes = await upsertBatch(admin, 'lab_results', labRows);
  if (labRes.error) errors.push(labRes.error);

  const vitalRes = await upsertBatch(admin, 'vitals', vitalRows);
  if (vitalRes.error) errors.push(vitalRes.error);

  return {
    medications: medRes.inserted,
    allergies: allergyRes.inserted,
    health_events: eventRes.inserted,
    lab_results: labRes.inserted,
    vitals: vitalRes.inserted,
    errors,
    duration_ms: Date.now() - t0,
  };
}
