-- =============================================================================
-- Phase 7 — Migration 4: pg_cron schedule for fire-medication-reminders
-- =============================================================================
-- Runs the fire-medication-reminders edge function every 1 minute.
-- The function itself is idempotent (UNIQUE on reminder_fired_events), so a
-- double-run is harmless. Uses pg_net for the HTTP call, matching the pattern
-- already in use for generate-weekly-digest.
--
-- Configuration (must be set via Supabase Studio → Database → Custom Config,
-- or via project secrets; pg_cron jobs can't read function env):
--   app.supabase_url          — the project URL
--   app.service_role_key      — service-role key for the Authorization header
-- These mirror what generate-weekly-digest already uses.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Unschedule any prior version so re-running this migration is safe.
DO $$
BEGIN
  PERFORM cron.unschedule('fire-medication-reminders-every-minute')
  WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'fire-medication-reminders-every-minute'
  );
EXCEPTION WHEN OTHERS THEN
  -- cron.unschedule raises if the job doesn't exist; swallow.
  NULL;
END $$;

SELECT cron.schedule(
  'fire-medication-reminders-every-minute',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := current_setting('app.supabase_url', true) || '/functions/v1/fire-medication-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);

COMMENT ON EXTENSION pg_cron IS 'Phase 7: schedules fire-medication-reminders every minute.';

-- =============================================================================
-- End Migration 4
-- =============================================================================
