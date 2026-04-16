/**
 * Apple Health XML Parser — extracts wearable/device health data from export.xml.
 *
 * Parses:
 *   - Record elements: vitals (HR, BP, SpO2, temp, resp rate, weight, height)
 *   - Record elements: activity (steps, distance, calories, exercise time) → daily aggregates
 *   - Record elements: sleep analysis
 *   - Workout elements
 *   - ActivitySummary elements (daily rings)
 *   - Me element (DOB, biological sex → metadata only)
 *
 * Sampling strategy for large exports (500K+ records):
 *   - Heart rate: last 90 days, one reading per hour
 *   - Steps/distance/calories/exercise: last 90 days, aggregated to daily totals
 *   - BP/SpO2/weight/temp/resp rate/height: all records (infrequent)
 *   - Sleep/workouts: all records
 *
 * Uses Deno's built-in DOMParser (same as ccda-parser.ts).
 */

import type { ParsedVital, ParsedCondition } from "./ccda-parser.ts";

// ── HealthKit type → vital mapping ──────────────────────────────────────────

interface VitalMapping {
  vital_type: string;
  unit: string;
  loinc: string | null;
  /** If true, use the unit from the Record element instead of the fixed unit */
  useRecordUnit?: boolean;
}

const VITAL_TYPE_MAP: Record<string, VitalMapping> = {
  "HKQuantityTypeIdentifierHeartRate": {
    vital_type: "Heart Rate",
    unit: "bpm",
    loinc: "8867-4",
  },
  "HKQuantityTypeIdentifierRestingHeartRate": {
    vital_type: "Resting Heart Rate",
    unit: "bpm",
    loinc: "40443-4",
  },
  "HKQuantityTypeIdentifierBloodPressureSystolic": {
    vital_type: "Blood Pressure Systolic",
    unit: "mmHg",
    loinc: "8480-6",
  },
  "HKQuantityTypeIdentifierBloodPressureDiastolic": {
    vital_type: "Blood Pressure Diastolic",
    unit: "mmHg",
    loinc: "8462-4",
  },
  "HKQuantityTypeIdentifierOxygenSaturation": {
    vital_type: "SpO2",
    unit: "%",
    loinc: "2708-6",
  },
  "HKQuantityTypeIdentifierBodyTemperature": {
    vital_type: "Temperature",
    unit: "°F",
    loinc: "8310-5",
    useRecordUnit: true,
  },
  "HKQuantityTypeIdentifierRespiratoryRate": {
    vital_type: "Respiratory Rate",
    unit: "breaths/min",
    loinc: "9279-1",
  },
  "HKQuantityTypeIdentifierBodyMass": {
    vital_type: "Weight",
    unit: "lb",
    loinc: "29463-7",
    useRecordUnit: true,
  },
  "HKQuantityTypeIdentifierHeight": {
    vital_type: "Height",
    unit: "in",
    loinc: "8302-2",
    useRecordUnit: true,
  },
};

/** High-frequency types that need sampling (last 90 days, hourly for HR) */
const HIGH_FREQ_VITAL = new Set([
  "HKQuantityTypeIdentifierHeartRate",
]);

/** Activity types aggregated to daily totals */
const ACTIVITY_TYPES = new Set([
  "HKQuantityTypeIdentifierStepCount",
  "HKQuantityTypeIdentifierDistanceWalkingRunning",
  "HKQuantityTypeIdentifierActiveEnergyBurned",
  "HKQuantityTypeIdentifierAppleExerciseTime",
]);

const ACTIVITY_LABELS: Record<string, { label: string; unit: string }> = {
  "HKQuantityTypeIdentifierStepCount": { label: "Steps", unit: "steps" },
  "HKQuantityTypeIdentifierDistanceWalkingRunning": { label: "Distance", unit: "mi" },
  "HKQuantityTypeIdentifierActiveEnergyBurned": { label: "Active Calories", unit: "kcal" },
  "HKQuantityTypeIdentifierAppleExerciseTime": { label: "Exercise Time", unit: "min" },
};

const SLEEP_TYPE = "HKCategoryTypeIdentifierSleepAnalysis";

// ── Workout type display names ──────────────────────────────────────────────

const WORKOUT_NAMES: Record<string, string> = {
  "HKWorkoutActivityTypeWalking": "Walking",
  "HKWorkoutActivityTypeRunning": "Running",
  "HKWorkoutActivityTypeCycling": "Cycling",
  "HKWorkoutActivityTypeSwimming": "Swimming",
  "HKWorkoutActivityTypeHiking": "Hiking",
  "HKWorkoutActivityTypeYoga": "Yoga",
  "HKWorkoutActivityTypeFunctionalStrengthTraining": "Strength Training",
  "HKWorkoutActivityTypeTraditionalStrengthTraining": "Strength Training",
  "HKWorkoutActivityTypeElliptical": "Elliptical",
  "HKWorkoutActivityTypeCoreTraining": "Core Training",
  "HKWorkoutActivityTypePilates": "Pilates",
  "HKWorkoutActivityTypeDance": "Dance",
  "HKWorkoutActivityTypeMixedCardio": "Mixed Cardio",
  "HKWorkoutActivityTypeHighIntensityIntervalTraining": "HIIT",
  "HKWorkoutActivityTypeStairClimbing": "Stair Climbing",
  "HKWorkoutActivityTypeTennis": "Tennis",
  "HKWorkoutActivityTypeGolf": "Golf",
  "HKWorkoutActivityTypeSoccer": "Soccer",
  "HKWorkoutActivityTypeBasketball": "Basketball",
  "HKWorkoutActivityTypeOther": "Workout",
};

// ── Sleep value mapping ─────────────────────────────────────────────────────

const SLEEP_VALUES: Record<string, string> = {
  "HKCategoryValueSleepAnalysisInBed": "In Bed",
  "HKCategoryValueSleepAnalysisAsleepUnspecified": "Asleep",
  "HKCategoryValueSleepAnalysisAsleep": "Asleep",
  "HKCategoryValueSleepAnalysisAsleepCore": "Core Sleep",
  "HKCategoryValueSleepAnalysisAsleepDeep": "Deep Sleep",
  "HKCategoryValueSleepAnalysisAsleepREM": "REM Sleep",
  "HKCategoryValueSleepAnalysisAwake": "Awake",
};

// ── Date helpers ────────────────────────────────────────────────────────────

/** Parse Apple Health date format: "2024-03-15 08:30:00 -0700" → ISO string */
function parseAhDate(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s) return null;
  // Apple Health format: "YYYY-MM-DD HH:MM:SS -ZZZZ"
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return null;
}

/** Get YYYY-MM-DD from an ISO string or Apple Health date */
function dateOnly(isoStr: string): string {
  return isoStr.substring(0, 10);
}

/** Get YYYY-MM-DDTHH key for hourly bucketing */
function hourKey(isoStr: string): string {
  return isoStr.substring(0, 13);
}

/** Duration in minutes between two ISO dates */
function durationMinutes(start: string, end: string): number {
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (isNaN(s) || isNaN(e)) return 0;
  return Math.round((e - s) / 60000);
}

// ── Output type ─────────────────────────────────────────────────────────────

export interface AppleHealthParseResult {
  vitals: ParsedVital[];
  conditions: ParsedCondition[];
  errors: { section: string; error: string }[];
  metadata: {
    dob?: string;
    biological_sex?: string;
  };
}

// ── Main Parser ─────────────────────────────────────────────────────────────

export function parseAppleHealthXml(xmlString: string): AppleHealthParseResult {
  const result: AppleHealthParseResult = {
    vitals: [],
    conditions: [],
    errors: [],
    metadata: {},
  };

  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  if (!doc || !doc.documentElement) {
    result.errors.push({ section: "document", error: "Failed to parse Apple Health XML" });
    return result;
  }

  const parseError = doc.querySelector("parsererror");
  if (parseError) {
    result.errors.push({
      section: "document",
      error: "XML parse error: " + (parseError.textContent || "").trim(),
    });
    return result;
  }

  // 90-day cutoff for high-frequency data
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 90);
  const cutoffIso = cutoff.toISOString();

  // ── Parse <Me> element ──────────────────────────────────────────────────
  try {
    const meEl = doc.querySelector("Me");
    if (meEl) {
      const dob = meEl.getAttribute("HKCharacteristicTypeIdentifierDateOfBirth");
      if (dob) result.metadata.dob = dob;
      const sex = meEl.getAttribute("HKCharacteristicTypeIdentifierBiologicalSex");
      if (sex) {
        result.metadata.biological_sex = sex
          .replace("HKBiologicalSex", "")
          .replace("NotSet", "Unknown");
      }
    }
  } catch (e) {
    result.errors.push({ section: "me", error: (e as Error).message });
  }

  // ── Parse <Record> elements ─────────────────────────────────────────────
  try {
    const records = doc.querySelectorAll("Record");
    // Hourly buckets for heart rate sampling
    const hrSeen = new Set<string>();
    // Daily aggregation buckets for activity
    const dailyActivity: Record<string, Record<string, number>> = {};

    for (const rec of records) {
      const type = rec.getAttribute("type") || "";
      const startDate = parseAhDate(rec.getAttribute("startDate"));
      const endDate = parseAhDate(rec.getAttribute("endDate"));
      const valueStr = rec.getAttribute("value") || "";
      const unitAttr = rec.getAttribute("unit") || "";

      if (!startDate) continue;

      // ── Vitals ──────────────────────────────────────────────────────
      const mapping = VITAL_TYPE_MAP[type];
      if (mapping) {
        // High-frequency sampling: skip old data, dedupe by hour
        if (HIGH_FREQ_VITAL.has(type)) {
          if (startDate < cutoffIso) continue;
          const hk = hourKey(startDate);
          if (hrSeen.has(hk)) continue;
          hrSeen.add(hk);
        }

        let value = parseFloat(valueStr);
        if (isNaN(value)) continue;

        // SpO2: Apple stores as decimal (0.98) — convert to percent
        if (type === "HKQuantityTypeIdentifierOxygenSaturation" && value < 1) {
          value = value * 100;
        }

        const unit = mapping.useRecordUnit ? (unitAttr || mapping.unit) : mapping.unit;

        result.vitals.push({
          vital_type: mapping.vital_type,
          value: String(Math.round(value * 100) / 100),
          unit,
          effective_date: startDate,
          loinc_code: mapping.loinc,
          source: "apple_health" as "ehr",
        });
        continue;
      }

      // ── Activity (daily aggregation) ────────────────────────────────
      if (ACTIVITY_TYPES.has(type)) {
        if (startDate < cutoffIso) continue;
        const day = dateOnly(startDate);
        const value = parseFloat(valueStr);
        if (isNaN(value)) continue;

        if (!dailyActivity[type]) dailyActivity[type] = {};
        dailyActivity[type][day] = (dailyActivity[type][day] || 0) + value;
        continue;
      }

      // ── Sleep ───────────────────────────────────────────────────────
      if (type === SLEEP_TYPE) {
        const sleepValue = rec.getAttribute("value") || "";
        const sleepLabel = SLEEP_VALUES[sleepValue] || "Sleep";

        // Skip "In Bed" if we also have "Asleep" — reduces noise
        // Actually keep all — UI can filter
        const duration = endDate && startDate ? durationMinutes(startDate, endDate) : 0;
        const durationStr = duration > 0
          ? Math.floor(duration / 60) + "h " + (duration % 60) + "m"
          : "";

        result.conditions.push({
          event_type: "sleep" as "condition",
          title: sleepLabel + (durationStr ? " (" + durationStr + ")" : ""),
          event_date: startDate,
          source: "apple_health" as "ehr",
          ehr_system: "apple_health",
        });
        continue;
      }
    }

    // ── Flatten daily activity into conditions ──────────────────────────
    for (const type of Object.keys(dailyActivity)) {
      const info = ACTIVITY_LABELS[type];
      if (!info) continue;
      const days = dailyActivity[type];
      for (const day of Object.keys(days)) {
        let val = days[day];
        // Round distance to 1 decimal, others to whole numbers
        if (type === "HKQuantityTypeIdentifierDistanceWalkingRunning") {
          val = Math.round(val * 10) / 10;
        } else {
          val = Math.round(val);
        }
        result.conditions.push({
          event_type: "activity" as "condition",
          title: info.label + ": " + val + " " + info.unit,
          event_date: day + "T00:00:00.000Z",
          source: "apple_health" as "ehr",
          ehr_system: "apple_health",
        });
      }
    }
  } catch (e) {
    result.errors.push({ section: "records", error: (e as Error).message });
  }

  // ── Parse <Workout> elements ────────────────────────────────────────────
  try {
    const workouts = doc.querySelectorAll("Workout");
    for (const w of workouts) {
      const actType = w.getAttribute("workoutActivityType") || "";
      const startDate = parseAhDate(w.getAttribute("startDate"));
      const endDate = parseAhDate(w.getAttribute("endDate"));
      const durationAttr = w.getAttribute("duration") || "";

      if (!startDate) continue;

      const name = WORKOUT_NAMES[actType] || actType.replace("HKWorkoutActivityType", "") || "Workout";
      let durationStr = "";
      if (durationAttr) {
        const mins = Math.round(parseFloat(durationAttr));
        if (mins > 0) {
          durationStr = mins >= 60
            ? Math.floor(mins / 60) + "h " + (mins % 60) + "m"
            : mins + " min";
        }
      } else if (endDate) {
        const mins = durationMinutes(startDate, endDate);
        if (mins > 0) {
          durationStr = mins >= 60
            ? Math.floor(mins / 60) + "h " + (mins % 60) + "m"
            : mins + " min";
        }
      }

      // Collect calories and distance from WorkoutStatistics children
      let extras = "";
      const stats = w.querySelectorAll("WorkoutStatistics");
      for (const stat of stats) {
        const statType = stat.getAttribute("type") || "";
        const sum = stat.getAttribute("sum");
        if (!sum) continue;
        const val = parseFloat(sum);
        if (isNaN(val)) continue;

        if (statType === "HKQuantityTypeIdentifierActiveEnergyBurned") {
          extras += " · " + Math.round(val) + " kcal";
        } else if (statType === "HKQuantityTypeIdentifierDistanceWalkingRunning") {
          extras += " · " + (Math.round(val * 10) / 10) + " mi";
        }
      }

      result.conditions.push({
        event_type: "workout" as "condition",
        title: name + (durationStr ? " (" + durationStr + ")" : "") + extras,
        event_date: startDate,
        source: "apple_health" as "ehr",
        ehr_system: "apple_health",
      });
    }
  } catch (e) {
    result.errors.push({ section: "workouts", error: (e as Error).message });
  }

  // ── Parse <ActivitySummary> elements ─────────────────────────────────────
  try {
    const summaries = doc.querySelectorAll("ActivitySummary");
    for (const s of summaries) {
      const dateStr = s.getAttribute("dateComponents");
      if (!dateStr) continue;
      const isoDate = dateStr + "T00:00:00.000Z";

      const activeEnergy = s.getAttribute("activeEnergyBurned");
      const activeGoal = s.getAttribute("activeEnergyBurnedGoal");
      const exerciseTime = s.getAttribute("appleExerciseTime");
      const exerciseGoal = s.getAttribute("appleExerciseTimeGoal");
      const standHours = s.getAttribute("appleStandHours");
      const standGoal = s.getAttribute("appleStandHoursGoal");

      const parts: string[] = [];
      if (activeEnergy) {
        const pct = activeGoal ? Math.round((parseFloat(activeEnergy) / parseFloat(activeGoal)) * 100) : 0;
        parts.push("Move: " + Math.round(parseFloat(activeEnergy)) + " kcal" + (pct ? " (" + pct + "%)" : ""));
      }
      if (exerciseTime) {
        const pct = exerciseGoal ? Math.round((parseFloat(exerciseTime) / parseFloat(exerciseGoal)) * 100) : 0;
        parts.push("Exercise: " + Math.round(parseFloat(exerciseTime)) + " min" + (pct ? " (" + pct + "%)" : ""));
      }
      if (standHours) {
        const pct = standGoal ? Math.round((parseFloat(standHours) / parseFloat(standGoal)) * 100) : 0;
        parts.push("Stand: " + standHours + " hr" + (pct ? " (" + pct + "%)" : ""));
      }

      if (parts.length > 0) {
        result.conditions.push({
          event_type: "activity_summary" as "condition",
          title: parts.join(" · "),
          event_date: isoDate,
          source: "apple_health" as "ehr",
          ehr_system: "apple_health",
        });
      }
    }
  } catch (e) {
    result.errors.push({ section: "activity_summaries", error: (e as Error).message });
  }

  return result;
}
