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
