// Apple Health context for ask-wellet.
//
// Samples from the Wellet iOS app (and older Wellet Connect builds) land in
// wearable_observations, one row per HealthKit sample. ask-wellet v39 never
// read that table, so Ask Wellet answered "the chart doesn't mention Apple
// Health" even when thousands of samples were on file.
//
// This module reads the last LOOKBACK_DAYS of samples per type and rolls
// them up by day (America/New_York) into short lines the model can read:
//
//   - Totals (steps, sleep minutes, falls, active energy): summed per day,
//     per device, and the larger device total is kept. iPhone and Apple
//     Watch both write steps for the same walk, so a plain sum double counts.
//     HealthKit's own de-duplication is not available server-side; the
//     larger single-device total is a close, conservative stand-in.
//   - Readings (heart rate, HRV, blood oxygen, walking metrics, ...): daily
//     average, low and high.
//   - Events (walking steadiness drops): count per day.
//
// Read-only. Uses the caller's JWT, so RLS on wearable_observations decides
// what is visible, same as every other table ask-wellet reads.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export const LOOKBACK_DAYS = 30;
export const DAYS_SHOWN = 14;
const PAGE = 1000; // PostgREST max rows per request
const MAX_ROWS_PER_TYPE = 6000;

type Rollup = "total" | "reading" | "event";

export interface HealthTypeInfo {
  label: string;
  rollup: Rollup;
  unit: string;
  decimals: number;
}

export const HEALTH_TYPES: Record<string, HealthTypeInfo> = {
  HKQuantityTypeIdentifierStepCount: { label: "Steps", rollup: "total", unit: "steps", decimals: 0 },
  HKCategoryTypeIdentifierSleepAnalysis: { label: "Sleep (time asleep)", rollup: "total", unit: "min", decimals: 0 },
  HKQuantityTypeIdentifierRestingHeartRate: { label: "Resting heart rate", rollup: "reading", unit: "bpm", decimals: 0 },
  HKQuantityTypeIdentifierHeartRate: { label: "Heart rate", rollup: "reading", unit: "bpm", decimals: 0 },
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: { label: "Heart rate variability (SDNN)", rollup: "reading", unit: "ms", decimals: 0 },
  HKQuantityTypeIdentifierOxygenSaturation: { label: "Blood oxygen", rollup: "reading", unit: "%", decimals: 0 },
  HKQuantityTypeIdentifierRespiratoryRate: { label: "Breathing rate", rollup: "reading", unit: "breaths/min", decimals: 1 },
  HKQuantityTypeIdentifierAppleWalkingSteadiness: { label: "Walking steadiness", rollup: "reading", unit: "%", decimals: 0 },
  HKCategoryTypeIdentifierAppleWalkingSteadinessEvent: { label: "Walking steadiness drop notices", rollup: "event", unit: "", decimals: 0 },
  HKQuantityTypeIdentifierWalkingSpeed: { label: "Walking speed", rollup: "reading", unit: "m/s", decimals: 2 },
  HKQuantityTypeIdentifierWalkingStepLength: { label: "Step length", rollup: "reading", unit: "cm", decimals: 0 },
  HKQuantityTypeIdentifierWalkingAsymmetryPercentage: { label: "Walking asymmetry", rollup: "reading", unit: "%", decimals: 1 },
  HKQuantityTypeIdentifierWalkingDoubleSupportPercentage: { label: "Double support time", rollup: "reading", unit: "%", decimals: 1 },
  HKQuantityTypeIdentifierNumberOfTimesFallen: { label: "Falls recorded", rollup: "total", unit: "", decimals: 0 },
  HKQuantityTypeIdentifierActiveEnergyBurned: { label: "Active energy", rollup: "total", unit: "kcal", decimals: 0 },
};

export interface HealthSample {
  hk_type: string;
  start_at: string;
  end_at?: string | null;
  value: number | string | null;
  unit?: string | null;
  device_source?: string | null;
}

export interface DayLine {
  date: string; // YYYY-MM-DD, America/New_York
  text: string;
}

export interface TypeSummary {
  hkType: string;
  label: string;
  days: DayLine[]; // newest first
  overall: string; // one line across the whole lookback
  latestAt: string | null;
}

export interface AppleHealthData {
  summaries: TypeSummary[];
  lastSyncAt: string | null;
  /** Start of the lookback window, ISO. */
  since?: string;
}

const dayFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function etDay(iso: string): string {
  return dayFmt.format(new Date(iso));
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function fmt(n: number, decimals: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: decimals,
  });
}

function withUnit(s: string, unit: string): string {
  return unit ? `${s} ${unit}` : s;
}

function fmtMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h} h ${m} min` : `${m} min`;
}

/** Pure rollup: samples of one type -> daily lines. Exported for tests. */
export function summarizeType(
  hkType: string,
  samples: HealthSample[],
  daysShown = DAYS_SHOWN,
): TypeSummary | null {
  const info = HEALTH_TYPES[hkType] ?? {
    label: hkType.replace(/^HK(Quantity|Category)TypeIdentifier/, ""),
    rollup: "reading" as Rollup,
    unit: samples[0]?.unit ?? "",
    decimals: 1,
  };
  const valid = samples.filter((s) => s.start_at && num(s.value) !== null);
  if (!valid.length) return null;

  // Sleep belongs to the morning you wake up, so bucket it by end time.
  const isSleep = hkType === "HKCategoryTypeIdentifierSleepAnalysis";
  const dayOf = (s: HealthSample) => etDay(isSleep && s.end_at ? s.end_at : s.start_at);

  let latestAt: string | null = null;
  for (const s of valid) {
    const t = s.end_at ?? s.start_at;
    if (!latestAt || t > latestAt) latestAt = t;
  }

  const days: DayLine[] = [];
  let overall = "";

  if (info.rollup === "total") {
    // day -> device -> sum
    const byDay = new Map<string, Map<string, number>>();
    for (const s of valid) {
      const d = dayOf(s);
      const dev = s.device_source ?? "unknown";
      const m = byDay.get(d) ?? new Map<string, number>();
      m.set(dev, (m.get(dev) ?? 0) + (num(s.value) as number));
      byDay.set(d, m);
    }
    const totals = [...byDay.entries()]
      .map(([date, m]) => ({ date, total: Math.max(...m.values()) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
    const show = (n: number) => (isSleep ? fmtMinutes(n) : withUnit(fmt(n, info.decimals), info.unit));
    for (const t of totals.slice(0, daysShown)) days.push({ date: t.date, text: show(t.total) });
    const avg = totals.reduce((a, t) => a + t.total, 0) / totals.length;
    overall = `${totals.length} day${totals.length === 1 ? "" : "s"} with data, daily average ${show(avg)}`;
  } else if (info.rollup === "event") {
    const byDay = new Map<string, number>();
    for (const s of valid) byDay.set(dayOf(s), (byDay.get(dayOf(s)) ?? 0) + 1);
    const rows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    for (const [date, n] of rows.slice(0, daysShown)) days.push({ date, text: `${n}` });
    overall = `${valid.length} in total`;
  } else {
    const byDay = new Map<string, number[]>();
    for (const s of valid) {
      const d = dayOf(s);
      (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(num(s.value) as number);
    }
    const rows = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
    for (const [date, vals] of rows.slice(0, daysShown)) {
      const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
      const lo = Math.min(...vals);
      const hi = Math.max(...vals);
      const text = vals.length === 1
        ? withUnit(fmt(avg, info.decimals), info.unit)
        : `average ${withUnit(fmt(avg, info.decimals), info.unit)} (low ${fmt(lo, info.decimals)}, high ${fmt(hi, info.decimals)}, ${vals.length} readings)`;
      days.push({ date, text });
    }
    const all = valid.map((s) => num(s.value) as number);
    const avg = all.reduce((a, b) => a + b, 0) / all.length;
    overall = `${all.length} reading${all.length === 1 ? "" : "s"} over ${rows.length} day${rows.length === 1 ? "" : "s"}, average ${withUnit(fmt(avg, info.decimals), info.unit)}, low ${fmt(Math.min(...all), info.decimals)}, high ${fmt(Math.max(...all), info.decimals)}`;
  }

  return { hkType, label: info.label, days, overall, latestAt };
}

const TYPE_ORDER = Object.keys(HEALTH_TYPES);

export function summarizeSamples(samples: HealthSample[]): TypeSummary[] {
  const byType = new Map<string, HealthSample[]>();
  for (const s of samples) (byType.get(s.hk_type) ?? byType.set(s.hk_type, []).get(s.hk_type)!).push(s);
  const out: TypeSummary[] = [];
  for (const [t, rows] of byType) {
    const sum = summarizeType(t, rows);
    if (sum) out.push(sum);
  }
  const rank = (t: string) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? 999 : i;
  };
  return out.sort((a, b) => rank(a.hkType) - rank(b.hkType));
}

async function fetchType(
  supabase: SupabaseClient,
  personId: string,
  hkType: string,
  since: string,
  linkIds?: string[],
): Promise<HealthSample[]> {
  const rows: HealthSample[] = [];
  for (let from = 0; from < MAX_ROWS_PER_TYPE; from += PAGE) {
    let q = supabase
      .from("wearable_observations")
      .select("hk_type, start_at, end_at, value, unit, device_source")
      .eq("person_id", personId)
      .eq("hk_type", hkType)
      .is("archived_at", null)
      .gte("start_at", since);
    if (linkIds) q = q.in("link_id", linkIds);
    const { data, error } = await q
      .order("start_at", { ascending: false })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("apple health read failed", hkType, error.message);
      break;
    }
    rows.push(...((data ?? []) as HealthSample[]));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

export async function fetchAppleHealth(
  supabase: SupabaseClient,
  personId: string,
  lastSyncAt: string | null,
  now = new Date(),
  linkIds?: string[],
): Promise<AppleHealthData> {
  const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000).toISOString();
  // linkIds given: read only rows that came through those sharing links.
  // An empty list means nobody has allowed Ask Wellet, so read nothing.
  if (linkIds && linkIds.length === 0) return { summaries: [], lastSyncAt, since };
  try {
    // Which types this person has. One small read; avoids 15 empty queries.
    let pq = supabase
      .from("wearable_observations")
      .select("hk_type")
      .eq("person_id", personId)
      .is("archived_at", null)
      .gte("start_at", since);
    if (linkIds) pq = pq.in("link_id", linkIds);
    const { data: present } = await pq.limit(1);
    if (!present || present.length === 0) return { summaries: [], lastSyncAt, since };

    const lists = await Promise.all(
      TYPE_ORDER.map((t) => fetchType(supabase, personId, t, since, linkIds)),
    );
    return { summaries: summarizeSamples(lists.flat()), lastSyncAt, since };
  } catch (e) {
    // Apple Health is extra context. A failure here must never block an answer.
    console.warn("apple health context skipped:", (e as Error).message);
    return { summaries: [], lastSyncAt };
  }
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "unknown";
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function buildAppleHealthSection(data: AppleHealthData): string {
  if (!data.summaries.length) return "";
  const blocks = data.summaries.map((s) => {
    const lines = s.days.map((d) => `    ${d.date}: ${d.text}`);
    const window = data.since ? `since ${etDay(data.since)}` : `last ${LOOKBACK_DAYS} days`;
    return `  ${s.label} — ${window}: ${s.overall}. Latest sample ${fmtWhen(s.latestAt)}.\n${lines.join("\n")}`;
  });
  return `APPLE HEALTH (shared from an iPhone or Apple Watch, not entered by a clinician; daily values, newest first, dates in Eastern time; last sync ${fmtWhen(data.lastSyncAt)}):\n${blocks.join("\n")}`;
}
