-- Weekly digest infrastructure (getwellet claims audit item 1)
-- 1. Enable pg_cron + pg_net so we can schedule + invoke the edge function
-- 2. Add last_weekly_digest_sent_at to notification_preferences for idempotency
-- 3. Create weekly_digest_log for audit/debugging + deduplication

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS last_weekly_digest_sent_at timestamptz;

CREATE TABLE IF NOT EXISTS public.weekly_digest_log (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sent_at timestamptz NOT NULL DEFAULT now(),
  trigger_source text NOT NULL CHECK (trigger_source IN ('cron','manual_preview','manual_send')),
  period_start date NOT NULL,
  period_end date NOT NULL,
  status text NOT NULL CHECK (status IN ('sent','skipped_empty','failed','skipped_dup')),
  people_count int,
  events_count int,
  summary_preview text,
  error_message text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_weekly_digest_log_user_sent
  ON public.weekly_digest_log (user_id, sent_at DESC);

ALTER TABLE public.weekly_digest_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own digest log" ON public.weekly_digest_log;
CREATE POLICY "Users can read own digest log"
  ON public.weekly_digest_log FOR SELECT
  USING (user_id = auth.uid());

-- No insert policy for users: inserts happen via service role only
