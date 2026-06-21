-- =============================================================================
-- Phase 7 — Migration 3: reminder_fired_events + realtime publication
-- =============================================================================
-- Adds:
--   1. reminder_fired_events  — idempotency + audit log for the medication
--                               reminder edge function (* * * * * cron).
--   2. supabase_realtime publication — add clinical tables + audit so the
--      iOS client can subscribe and update in real time across circle members.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. reminder_fired_events
-- -----------------------------------------------------------------------------
-- The fire-medication-reminders edge function runs every minute. For each
-- (reminder, scheduled_time) pair that falls inside the current minute window,
-- it writes a row here BEFORE attempting Twilio / APNs fan-out. The UNIQUE
-- constraint on (reminder_id, scheduled_for) makes the whole pipeline idempotent:
-- if the cron double-fires, the second INSERT fails and we skip the send.
--
-- Fields:
--   reminder_id        — FK to medication_reminders.id (the recurring rule)
--   medication_id      — denormalized for cheap joins to the med name
--   person_id          — denormalized for cheap joins to the care circle
--   scheduled_for      — the minute-precision UTC timestamp this firing represents
--   fired_at           — wall clock when the edge function actually ran the send
--   recipients_count   — how many circle members got the fan-out
--   channels           — jsonb summary: {"push": 3, "sms": 1}
--   escalated          — true if this was the 30-min missed-dose escalation pass
--   error              — null on success; string error from Twilio/APNs if any
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.reminder_fired_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id       uuid NOT NULL REFERENCES public.medication_reminders(id) ON DELETE CASCADE,
  medication_id     uuid REFERENCES public.medications(id) ON DELETE SET NULL,
  person_id         uuid REFERENCES public.people(id) ON DELETE SET NULL,
  scheduled_for     timestamptz NOT NULL,
  fired_at          timestamptz NOT NULL DEFAULT now(),
  recipients_count  integer NOT NULL DEFAULT 0,
  channels          jsonb,
  escalated         boolean NOT NULL DEFAULT false,
  error             text,
  CONSTRAINT reminder_fired_events_unique_firing UNIQUE (reminder_id, scheduled_for, escalated)
);

CREATE INDEX IF NOT EXISTS idx_reminder_fired_events_person_fired
  ON public.reminder_fired_events (person_id, fired_at DESC);

CREATE INDEX IF NOT EXISTS idx_reminder_fired_events_scheduled
  ON public.reminder_fired_events (scheduled_for);

ALTER TABLE public.reminder_fired_events ENABLE ROW LEVEL SECURITY;

-- The edge function uses the service role, which bypasses RLS, so it can always
-- write. Authenticated users (any circle member) can READ to confirm a reminder
-- actually fired ("did Mom's 8am dose ping?").
DROP POLICY IF EXISTS reminder_fired_events_select ON public.reminder_fired_events;
CREATE POLICY reminder_fired_events_select
  ON public.reminder_fired_events
  FOR SELECT
  TO authenticated
  USING (
    person_id IS NOT NULL
    AND public.is_in_care_circle(person_id)
  );

-- No client INSERT/UPDATE/DELETE. Only the edge function (service role) writes here.

COMMENT ON TABLE public.reminder_fired_events IS
  'Phase 7: idempotency + audit log for fire-medication-reminders edge function. UNIQUE(reminder_id, scheduled_for, escalated) prevents double-fires. Written by service role only.';

-- -----------------------------------------------------------------------------
-- 2. Realtime publication
-- -----------------------------------------------------------------------------
-- The iOS client subscribes via Supabase Realtime so that when one caregiver
-- logs a dose, every other circle member sees the row appear immediately.
-- We add every clinical table that participates in circle workflows, plus the
-- two audit tables (so the Activity tab updates live), plus the reminder fired
-- events table (so the UI can show "8am dose pinged everyone").
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'medications',
    'medication_logs',
    'medication_reminders',
    'health_events',
    'documents',
    'allergies',
    'lab_results',
    'vitals',
    'care_signals',
    'update_me_summaries',
    'people',
    'care_circle_members',
    'circle_action_audit',
    'circle_read_audit',
    'reminder_fired_events'
  ];
BEGIN
  -- Ensure the publication exists. On hosted Supabase it does, but guard for
  -- self-hosted / local dev.
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY tables LOOP
    -- Only add if the table exists AND is not already in the publication.
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) AND NOT EXISTS (
      SELECT 1
      FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Realtime needs REPLICA IDENTITY FULL on tables where we care about UPDATE/DELETE
-- payloads carrying the old row (for diffing). For the audit + fired-events tables
-- which are append-only, default REPLICA IDENTITY is fine.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'medications',
    'medication_logs',
    'medication_reminders',
    'health_events',
    'documents',
    'allergies',
    'lab_results',
    'vitals',
    'care_signals',
    'update_me_summaries',
    'people',
    'care_circle_members'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format('ALTER TABLE public.%I REPLICA IDENTITY FULL', t);
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- End Migration 3
-- =============================================================================
