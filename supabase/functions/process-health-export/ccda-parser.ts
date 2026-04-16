/**
 * C-CDA XML Parser — extracts structured clinical data from CDA documents.
 *
 * Parses these C-CDA sections by LOINC code:
 *   - Medications   (10160-0)
 *   - Allergies      (48765-2)
 *   - Lab Results    (30954-2)
 *   - Vitals         (8716-3)
 *   - Conditions     (11450-4)
 *
 * Uses Deno's built-in DOMParser — no external CDA libraries.
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface ParsedMedication {
  name: string;
  dose: string | null;
  frequency: string | null;
  active: boolean;
  source: "ehr";
  ehr_system: string;
}

export interface ParsedAllergy {
  substance: string;
  reaction: string | null;
  severity: string | null;
  clinical_status: string;
  source: "ehr";
  source_system: string;
}

export interface ParsedLabResult {
  test_name: string;
  value: string | null;
  unit: string | null;
  reference_range: string | null;
  status: "normal" | "abnormal" | "critical" | "unknown";
  effective_date: string | null;
  loinc_code: string | null;
  category: "laboratory";
  source: "ehr";
}

export interface ParsedVital {
  vital_type: string;
  value: string;
  unit: string | null;
  effective_date: string | null;
  loinc_code: string | null;
  source: "ehr";
}

export interface ParsedCondition {
  event_type: "condition";
  title: string;
  event_date: string | null;
  source: "ehr";
  ehr_system: string;
}

export interface CcdaParseResult {
  medications: ParsedMedication[];
  allergies: ParsedAllergy[];
  lab_results: ParsedLabResult[];
  vitals: ParsedVital[];
  conditions: ParsedCondition[];
  errors: { section: string; error: string }[];
}

// ── Section LOINC Codes ──────────────────────────────────────────────────────

const SECTION_CODES = {
  medications: "10160-0",
  allergies: "48765-2",
  labs: "30954-2",
  vitals: "8716-3",
  conditions: "11450-4",
} as const;

// ── Vital type mapping by LOINC ──────────────────────────────────────────────

const VITAL_LOINC_MAP: Record<string, string> = {
  "8480-6": "Systolic BP",
  "8462-4": "Diastolic BP",
  "8867-4": "Heart Rate",
  "8310-5": "Temperature",
  "29463-7": "Weight",
  "8302-2": "Height",
  "39156-5": "BMI",
  "2708-6": "SpO2",
  "59408-5": "SpO2",
  "9279-1": "Respiratory Rate",
};

// ── Date Parsing ─────────────────────────────────────────────────────────────

/** Parse CDA date formats: yyyyMMddHHmmss, yyyyMMdd, or ISO */
function parseCdaDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (s.length === 0) return null;

  // yyyyMMddHHmmss or yyyyMMdd
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/);
  if (m) {
    const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4] || "00"}:${m[5] || "00"}:${m[6] || "00"}Z`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }

  // Already ISO or parseable
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();

  return null;
}

// ── Helper: get text content from element ────────────────────────────────────

function getText(el: Element | null): string {
  if (!el) return "";
  return (el.textContent || "").trim();
}

function getAttr(el: Element | null, attr: string): string {
  if (!el) return "";
  return (el.getAttribute(attr) || "").trim();
}

/** Check if element has nullFlavor — means "no information" */
function hasNullFlavor(el: Element | null): boolean {
  if (!el) return true;
  return !!el.getAttribute("nullFlavor");
}

/** Check negationInd — "patient does NOT have this" */
function isNegated(el: Element): boolean {
  return el.getAttribute("negationInd") === "true";
}

/**
 * Get display name from a CDA element — handles Epic's originalText/reference
 * pattern and falls back to displayName attribute.
 */
function getDisplayName(el: Element, doc: Document): string {
  // Try displayName attribute first (most common)
  const displayName = el.getAttribute("displayName");
  if (displayName && displayName.trim()) return displayName.trim();

  // Try originalText child — Epic uses this with reference pointers
  const origText = el.querySelector("originalText");
  if (origText) {
    const ref = origText.querySelector("reference");
    if (ref) {
      const refValue = ref.getAttribute("value");
      if (refValue && refValue.startsWith("#")) {
        // Resolve the reference in the document
        const target = doc.getElementById(refValue.substring(1));
        if (target) {
          const text = getText(target);
          if (text) return text;
        }
      }
    }
    const text = getText(origText);
    if (text) return text;
  }

  // Try text child
  const textChild = el.querySelector("text");
  if (textChild) {
    const text = getText(textChild);
    if (text) return text;
  }

  return "";
}

/** Find a section by its LOINC code */
function findSection(doc: Document, loincCode: string): Element | null {
  const sections = doc.querySelectorAll("section");
  for (const section of sections) {
    const code = section.querySelector(":scope > code");
    if (code && getAttr(code, "code") === loincCode) {
      return section;
    }
  }
  return null;
}

// ── Section Parsers ──────────────────────────────────────────────────────────

function parseMedications(doc: Document, sourceSystem: string): ParsedMedication[] {
  const section = findSection(doc, SECTION_CODES.medications);
  if (!section) return [];

  const results: ParsedMedication[] = [];
  const entries = section.querySelectorAll(":scope > entry");

  for (const entry of entries) {
    const substAdmin = entry.querySelector("substanceAdministration");
    if (!substAdmin) continue;
    if (isNegated(substAdmin)) continue;
    if (hasNullFlavor(substAdmin)) continue;

    // Status
    const statusCode = substAdmin.querySelector("statusCode");
    const statusVal = getAttr(statusCode, "code") || "active";

    // Medication name — in manufacturedProduct/manufacturedMaterial/code
    const matCode = substAdmin.querySelector(
      "consumable manufacturedProduct manufacturedMaterial code"
    );
    let name = "";
    if (matCode) {
      name = getDisplayName(matCode, doc);
      if (!name) name = getAttr(matCode, "displayName");
    }

    // Fallback: try the text content of manufacturedMaterial
    if (!name) {
      const matName = substAdmin.querySelector(
        "consumable manufacturedProduct manufacturedMaterial name"
      );
      if (matName) name = getText(matName);
    }

    if (!name) continue; // Can't record without a name

    // Dose
    const doseEl = substAdmin.querySelector("doseQuantity");
    let dose: string | null = null;
    if (doseEl && !hasNullFlavor(doseEl)) {
      const val = getAttr(doseEl, "value");
      const unit = getAttr(doseEl, "unit");
      if (val) dose = val + (unit ? " " + unit : "");
    }

    // Frequency — from effectiveTime with operator="A" (periodic)
    let frequency: string | null = null;
    const effTimes = substAdmin.querySelectorAll("effectiveTime");
    for (const et of effTimes) {
      if (getAttr(et, "operator") === "A" || et.querySelector("period")) {
        const period = et.querySelector("period");
        if (period) {
          const pVal = getAttr(period, "value");
          const pUnit = getAttr(period, "unit");
          if (pVal && pUnit) {
            frequency = "Every " + pVal + " " + pUnit;
          }
        }
      }
    }

    results.push({
      name,
      dose,
      frequency,
      active: statusVal === "active" || statusVal === "completed",
      source: "ehr",
      ehr_system: sourceSystem,
    });
  }

  return results;
}

function parseAllergies(doc: Document, sourceSystem: string): ParsedAllergy[] {
  const section = findSection(doc, SECTION_CODES.allergies);
  if (!section) return [];

  const results: ParsedAllergy[] = [];
  const entries = section.querySelectorAll(":scope > entry");

  for (const entry of entries) {
    const act = entry.querySelector("act");
    if (!act) continue;
    if (isNegated(act)) continue;

    const obs = act.querySelector("entryRelationship observation");
    if (!obs) continue;
    if (isNegated(obs)) continue;
    if (hasNullFlavor(obs)) continue;

    // Substance — from participant/participantRole/playingEntity/code
    // or from observation/value
    let substance = "";
    const participant = obs.querySelector(
      "participant participantRole playingEntity code"
    );
    if (participant) {
      substance = getDisplayName(participant, doc);
    }
    if (!substance) {
      const obsValue = obs.querySelector("value");
      if (obsValue) {
        substance = getDisplayName(obsValue, doc);
      }
    }
    if (!substance) continue;

    // Reaction
    let reaction: string | null = null;
    const reactionObs = obs.querySelector(
      "entryRelationship observation value"
    );
    if (reactionObs) {
      reaction = getDisplayName(reactionObs, doc) || null;
    }

    // Severity
    let severity: string | null = null;
    const severityObs = obs.querySelectorAll("entryRelationship observation");
    for (const so of severityObs) {
      const soCode = so.querySelector("code");
      if (soCode && getAttr(soCode, "code") === "SEV") {
        const sevVal = so.querySelector("value");
        if (sevVal) {
          const sevDisplay = getAttr(sevVal, "displayName")?.toLowerCase();
          if (sevDisplay && ["mild", "moderate", "severe"].includes(sevDisplay)) {
            severity = sevDisplay;
          }
        }
      }
    }

    // Clinical status
    const statusCode = act.querySelector("statusCode");
    const clinicalStatus = getAttr(statusCode, "code") || "active";

    results.push({
      substance,
      reaction,
      severity,
      clinical_status: clinicalStatus,
      source: "ehr",
      source_system: sourceSystem,
    });
  }

  return results;
}

function parseLabResults(doc: Document): ParsedLabResult[] {
  const section = findSection(doc, SECTION_CODES.labs);
  if (!section) return [];

  const results: ParsedLabResult[] = [];
  const entries = section.querySelectorAll(":scope > entry");

  for (const entry of entries) {
    // Lab panels are organizers containing component observations
    const organizer = entry.querySelector("organizer");
    const observations = organizer
      ? organizer.querySelectorAll("component observation")
      : entry.querySelectorAll("observation");

    for (const obs of observations) {
      if (isNegated(obs)) continue;
      if (hasNullFlavor(obs)) continue;

      const code = obs.querySelector(":scope > code");
      if (!code) continue;

      const testName = getDisplayName(code, doc) || getAttr(code, "displayName");
      if (!testName) continue;

      const loincCode = getAttr(code, "code") || null;

      // Value
      const valueEl = obs.querySelector(":scope > value");
      let value: string | null = null;
      let unit: string | null = null;
      if (valueEl && !hasNullFlavor(valueEl)) {
        value = getAttr(valueEl, "value") || getText(valueEl) || null;
        unit = getAttr(valueEl, "unit") || null;
      }

      // Reference range
      let referenceRange: string | null = null;
      const refRange = obs.querySelector("referenceRange observationRange");
      if (refRange) {
        const low = refRange.querySelector("low");
        const high = refRange.querySelector("high");
        const lowVal = low ? getAttr(low, "value") : "";
        const highVal = high ? getAttr(high, "value") : "";
        const rangeUnit = low ? getAttr(low, "unit") : high ? getAttr(high, "unit") : "";
        if (lowVal || highVal) {
          referenceRange = (lowVal || "?") + " - " + (highVal || "?");
          if (rangeUnit) referenceRange += " " + rangeUnit;
        }
        // Text-based reference range
        if (!referenceRange) {
          const rangeText = refRange.querySelector("text, value");
          if (rangeText) referenceRange = getText(rangeText) || null;
        }
      }

      // Status — interpretationCode
      let status: ParsedLabResult["status"] = "unknown";
      const interp = obs.querySelector("interpretationCode");
      if (interp) {
        const interpCode = getAttr(interp, "code")?.toUpperCase();
        if (interpCode === "N" || interpCode === "NRM") status = "normal";
        else if (interpCode === "A" || interpCode === "H" || interpCode === "L" || interpCode === "AB") status = "abnormal";
        else if (interpCode === "HH" || interpCode === "LL" || interpCode === "AA") status = "critical";
      }

      // Effective date
      const effTime = obs.querySelector(":scope > effectiveTime");
      const effectiveDate = parseCdaDate(getAttr(effTime, "value"));

      results.push({
        test_name: testName,
        value,
        unit,
        reference_range: referenceRange,
        status,
        effective_date: effectiveDate,
        loinc_code: loincCode,
        category: "laboratory",
        source: "ehr",
      });
    }
  }

  return results;
}

function parseVitals(doc: Document): ParsedVital[] {
  const section = findSection(doc, SECTION_CODES.vitals);
  if (!section) return [];

  const results: ParsedVital[] = [];
  const entries = section.querySelectorAll(":scope > entry");

  for (const entry of entries) {
    const organizer = entry.querySelector("organizer");
    const observations = organizer
      ? organizer.querySelectorAll("component observation")
      : entry.querySelectorAll("observation");

    // Date from the organizer's effectiveTime
    const orgEffTime = organizer
      ? organizer.querySelector(":scope > effectiveTime")
      : null;
    const orgDate = parseCdaDate(getAttr(orgEffTime, "value"));

    for (const obs of observations) {
      if (isNegated(obs)) continue;
      if (hasNullFlavor(obs)) continue;

      const code = obs.querySelector(":scope > code");
      if (!code) continue;

      const loincCode = getAttr(code, "code") || null;
      let vitalType = VITAL_LOINC_MAP[loincCode || ""] ||
        getDisplayName(code, doc) ||
        getAttr(code, "displayName") ||
        "";
      if (!vitalType) continue;

      const valueEl = obs.querySelector(":scope > value");
      if (!valueEl || hasNullFlavor(valueEl)) continue;

      const value = getAttr(valueEl, "value");
      if (!value) continue;

      const unit = getAttr(valueEl, "unit") || null;

      // Per-observation date or fall back to organizer date
      const obsEffTime = obs.querySelector(":scope > effectiveTime");
      const effectiveDate = parseCdaDate(getAttr(obsEffTime, "value")) || orgDate;

      results.push({
        vital_type: vitalType,
        value,
        unit,
        effective_date: effectiveDate,
        loinc_code: loincCode,
        source: "ehr",
      });
    }
  }

  return results;
}

function parseConditions(doc: Document, sourceSystem: string): ParsedCondition[] {
  const section = findSection(doc, SECTION_CODES.conditions);
  if (!section) return [];

  const results: ParsedCondition[] = [];
  const entries = section.querySelectorAll(":scope > entry");

  for (const entry of entries) {
    const act = entry.querySelector("act");
    const obs = act
      ? act.querySelector("entryRelationship observation")
      : entry.querySelector("observation");
    if (!obs) continue;
    if (isNegated(obs)) continue;
    if (hasNullFlavor(obs)) continue;

    // Condition name from value element
    const valueEl = obs.querySelector(":scope > value");
    let title = "";
    if (valueEl) {
      title = getDisplayName(valueEl, doc);
    }
    if (!title) {
      const codeEl = obs.querySelector(":scope > code");
      if (codeEl) title = getDisplayName(codeEl, doc);
    }
    if (!title) continue;

    // Onset date from effectiveTime/low
    const effTime = obs.querySelector("effectiveTime");
    let eventDate: string | null = null;
    if (effTime) {
      const low = effTime.querySelector("low");
      eventDate = parseCdaDate(getAttr(low, "value")) || parseCdaDate(getAttr(effTime, "value"));
    }

    // Skip resolved/inactive conditions where status is "completed" and there's an end date
    // but still include them — caregivers should see full history

    results.push({
      event_type: "condition",
      title,
      event_date: eventDate,
      source: "ehr",
      ehr_system: sourceSystem,
    });
  }

  return results;
}

// ── Main Parser ──────────────────────────────────────────────────────────────

export function parseCcdaXml(xmlString: string, sourceFile: string): CcdaParseResult {
  const result: CcdaParseResult = {
    medications: [],
    allergies: [],
    lab_results: [],
    vitals: [],
    conditions: [],
    errors: [],
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  if (!doc || !doc.documentElement) {
    result.errors.push({ section: "document", error: "Failed to parse XML" });
    return result;
  }

  // Check for parser errors
  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    result.errors.push({ section: "document", error: "XML parse error: " + getText(parseError) });
    return result;
  }

  // Detect source system from the document
  let sourceSystem = "unknown";
  const custodian = doc.querySelector("custodian assignedCustodian representedCustodianOrganization name");
  if (custodian) {
    const custName = getText(custodian).toLowerCase();
    if (custName.includes("epic") || custName.includes("mychart")) {
      sourceSystem = "mychart";
    } else if (custName.includes("cerner")) {
      sourceSystem = "cerner";
    } else {
      sourceSystem = getText(custodian) || "unknown";
    }
  }

  // Parse each section — partial failures must not block others
  const sections: [string, () => void][] = [
    ["medications", () => { result.medications = parseMedications(doc, sourceSystem); }],
    ["allergies", () => { result.allergies = parseAllergies(doc, sourceSystem); }],
    ["lab_results", () => { result.lab_results = parseLabResults(doc); }],
    ["vitals", () => { result.vitals = parseVitals(doc); }],
    ["conditions", () => { result.conditions = parseConditions(doc, sourceSystem); }],
  ];

  for (const [sectionName, parseFn] of sections) {
    try {
      parseFn();
    } catch (e) {
      result.errors.push({
        section: sectionName,
        error: (e as Error).message,
      });
      console.error(`[ccda-parser] Error parsing ${sectionName} from ${sourceFile}:`, e);
    }
  }

  return result;
}
