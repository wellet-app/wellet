// Run: deno test --allow-env supabase/functions/ask-wellet/pause.test.ts
import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { countLastHour, DEFAULT_PER_HOUR, isPaused, pauseThreshold } from "./pause.ts";

Deno.test("threshold defaults to 200 and ignores low or bad values", () => {
  assertEquals(pauseThreshold(undefined), DEFAULT_PER_HOUR);
  assertEquals(pauseThreshold("abc"), DEFAULT_PER_HOUR);
  assertEquals(pauseThreshold("10"), DEFAULT_PER_HOUR);
  assertEquals(pauseThreshold("300"), 300);
});

Deno.test("pauses only at or above the hourly threshold", () => {
  assertEquals(isPaused(199, 200), false);
  assertEquals(isPaused(200, 200), true);
  assertEquals(isPaused(null, 200), false); // fails open
});

Deno.test("reads the count from content-range and fails open", async () => {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test");
  const ok = (() => Promise.resolve(new Response(null, { status: 200, headers: { "content-range": "*/57" } }))) as typeof fetch;
  assertEquals(await countLastHour("u1", ok), 57);
  const bad = (() => Promise.resolve(new Response(null, { status: 500 }))) as typeof fetch;
  assertEquals(await countLastHour("u1", bad), null);
  const boom = (() => Promise.reject(new Error("down"))) as typeof fetch;
  assertEquals(await countLastHour("u1", boom), null);
  assertEquals(await countLastHour(null, ok), null);
});
