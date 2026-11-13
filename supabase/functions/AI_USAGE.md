# AI usage metering

Every AI call in these functions records one row in `public.ai_usage_events`:
feature, model, vendor, prompt and completion token counts, and an estimated
cost. Rows never contain prompt text, answers or health details.

- Helper: `meter.ts` (`meterAi(result, { feature, userId, personId })`).
- Table is server-only: RLS on, no policies, no anon/authenticated grants.
- Metering is fire-and-forget and never fails a request.

Functions in this PR were copied from the deployed versions (deployed source was
ahead of git), then metered. They import function-local copies of
`azureOpenAI.ts`, `cors.ts` and `meter.ts` so git matches what runs.

Not metered yet: `generate-weekly-digest` (cron disabled), `extract-onboarding`
(v1), `transcribe-audio` (calls OpenAI directly; needs a vendor review).

## Free-plan allowances (1.1, not deployed)

`_shared/allowance.ts` counts rows in `ai_usage_events` to apply the free plan:
5 Ask questions a month (`ask`), 3 document reads a month (`document_read`),
and each loved one's first summary (`home_summary`). Wellet AI
(`subscriptions.status` in active, trialing, granted) removes the limits.
Months reset on the 1st, Eastern time.

Limits apply only when the `FREE_LIMITS_ENFORCED` secret is `true`. Until then
every call is allowed. When a limit is reached the function returns 402 with
`{ code: "free_limit", feature, used, limit, resets_on }`. A document over the
limit is still saved, marked "Saved without reading."

`usage-allowance` is read-only and lets the app show counts before a caregiver
asks. Viewing, sharing, exporting and the emergency summary never call it.

Copies of `allowance.ts` live next to each function that uses it, like `meter.ts`.
