import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import { buildAppleHealthSection, fetchAppleHealth, summarizeSamples, summarizeType } from "./appleHealth.ts";

Deno.test("steps take the larger device total per day, not the sum", () => {
  const s = summarizeType("HKQuantityTypeIdentifierStepCount", [
    { hk_type: "x", start_at: "2026-11-22T15:00:00Z", value: 3000, device_source: "iPhone" },
    { hk_type: "x", start_at: "2026-11-22T16:00:00Z", value: 1000, device_source: "iPhone" },
    { hk_type: "x", start_at: "2026-11-22T15:00:00Z", value: 3500, device_source: "Watch" },
  ])!;
  assertEquals(s.days[0], { date: "2026-11-22", text: "4,000 steps" });
});

Deno.test("days use Eastern time", () => {
  const s = summarizeType("HKQuantityTypeIdentifierStepCount", [
    { hk_type: "x", start_at: "2026-11-23T03:00:00Z", value: 10 }, // 10pm Nov 22 ET
  ])!;
  assertEquals(s.days[0].date, "2026-11-22");
});

Deno.test("sleep is summed by wake-up day and shown in hours", () => {
  const s = summarizeType("HKCategoryTypeIdentifierSleepAnalysis", [
    { hk_type: "x", start_at: "2026-11-22T04:00:00Z", end_at: "2026-11-22T07:00:00Z", value: 180, unit: "min" },
    { hk_type: "x", start_at: "2026-11-22T07:10:00Z", end_at: "2026-11-22T11:00:00Z", value: 230, unit: "min" },
  ])!;
  assertEquals(s.days[0], { date: "2026-11-22", text: "6 h 50 min" });
});

Deno.test("readings show average, low, high", () => {
  const s = summarizeType("HKQuantityTypeIdentifierHeartRate", [
    { hk_type: "x", start_at: "2026-11-22T15:00:00Z", value: 60 },
    { hk_type: "x", start_at: "2026-11-22T16:00:00Z", value: 80 },
  ])!;
  assertEquals(s.days[0].text, "average 70 bpm (low 60, high 80, 2 readings)");
});

Deno.test("section lists types in catalog order and is empty without data", () => {
  const sums = summarizeSamples([
    { hk_type: "HKQuantityTypeIdentifierHeartRate", start_at: "2026-11-22T15:00:00Z", value: 70 },
    { hk_type: "HKQuantityTypeIdentifierStepCount", start_at: "2026-11-22T15:00:00Z", value: 500 },
  ]);
  assertEquals(sums.map((s) => s.label), ["Steps", "Heart rate"]);
  assertStringIncludes(buildAppleHealthSection({ summaries: sums, lastSyncAt: null }), "APPLE HEALTH");
  assertEquals(buildAppleHealthSection({ summaries: [], lastSyncAt: null }), "");
});

Deno.test("fetchAppleHealth reads nothing when no sharing link allows Ask Wellet", async () => {
  const supabase = { from() { throw new Error("should not read"); } } as never;
  const out = await fetchAppleHealth(supabase, "p1", null, new Date(), []);
  assertEquals(out.summaries.length, 0);
});
