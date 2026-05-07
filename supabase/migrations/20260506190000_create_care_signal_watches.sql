-- Care Signal "Notify me" watches
-- ----------------------------------------------------------------------------
-- A user-defined notification rule attached to a person + a behavior or
-- wearable signal. The user picks the threshold; Wellet only watches and
-- reports the fact when the threshold is crossed.
--
-- Hard product limits (NOT enforced in SQL but documented here so future
-- migrations don't drift):
--   • Allowed watch_type values are restricted to behaviors + wearables only
--     at launch. No watches on raw lab values, medication doses, or
--     diagnoses. See CHECK constraint on watch_type below.
--   • The user defines parameters; the evaluator NEVER picks a default
--     "what's high" threshold.
--
-- Surfaces this powers:
--   • Care Signals card → "🔔 Notify me" pill → Ask Wellet watch mode
--   • Settings → Notifications → My Watches
--   • Onboarding default: new_record_arrived auto-enabled (opt-out)
-- ----------------------------------------------------------------------------

-- 1. The watch itself
CREATE TABLE IF NOT EXISTS public.care_signal_watches (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,

  -- Allowed watch_type values at launch. Behaviors + wearables only.
  -- Adding new types is a deliberate review (clinical-line policy).
  watch_type text NOT NULL CHECK (watch_type IN (
    'resting_hr_sustained_above',
    'resting_hr_above_baseline',
    'daily_steps_below',
    'sleep_duration_below',
    'wearable_silence',
    'refill_gap',
    'pcp_visit_gap',
    'new_care_team_member',
    'new_record_arrived',
    'appointment_changed'
  )),

  -- Shape varies by watch_type. Validated in the create-care-signal-watch
  -- edge function, not in SQL, so we can iterate without migrations.
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Plain-language description shown back to the user (e.g. "Mom's resting
  -- HR stays above 90 for 3 days"). This is what the user sees in Settings →
  -- My Watches and what we echo on save. Stored on insert so it survives
  -- even if the parameter shape evolves.
  description text NOT NULL,

  -- Lifecycle
  active boolean NOT NULL DEFAULT true,
  paused_at timestamptz,
  last_fired_at timestamptz,
  fire_count integer NOT NULL DEFAULT 0,

  -- Provenance — useful for analytics and onboarding tracking
  created_via text NOT NULL DEFAULT 'ask_wellet'
    CHECK (created_via IN ('ask_wellet','onboarding_default','suggestion','admin')),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_care_signal_watches_user_person_active
  ON public.care_signal_watches (user_id, person_id, active);

CREATE INDEX IF NOT EXISTS idx_care_signal_watches_type_active
  ON public.care_signal_watches (watch_type) WHERE active = true;

-- 2. Per-fire audit log. Every time a watch trips, we log the trigger value
--    and whether the notification was actually delivered. Drives the
--    "last fired" UI, deduplication, and debugging.
CREATE TABLE IF NOT EXISTS public.care_signal_watch_fires (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  watch_id uuid NOT NULL REFERENCES public.care_signal_watches(id) ON DELETE CASCADE,
  fired_at timestamptz NOT NULL DEFAULT now(),

  -- What data caused this fire? For event watches (new record, appt change),
  -- this carries the source row id so we can dedupe and never re-fire on the
  -- same event. For threshold watches, it carries the qualifying window so
  -- we can require a fresh crossing before re-firing.
  trigger_value jsonb,

  -- Was the notification queued / sent?
  notification_status text NOT NULL DEFAULT 'queued'
    CHECK (notification_status IN ('queued','sent','suppressed_quiet_hours','failed','skipped_rate_limit','skipped_dup')),
  notification_channel text,           -- 'email' (v1); 'push' / 'both' later
  notification_sent_at timestamptz,
  error text
);

CREATE INDEX IF NOT EXISTS idx_care_signal_watch_fires_watch_fired
  ON public.care_signal_watch_fires (watch_id, fired_at DESC);

-- 3. updated_at trigger for care_signal_watches
CREATE OR REPLACE FUNCTION public.tg_care_signal_watches_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS care_signal_watches_set_updated_at ON public.care_signal_watches;
CREATE TRIGGER care_signal_watches_set_updated_at
  BEFORE UPDATE ON public.care_signal_watches
  FOR EACH ROW
  EXECUTE FUNCTION public.tg_care_signal_watches_set_updated_at();

-- 4. RLS — owner-only access. Service role bypasses RLS for the evaluator.
ALTER TABLE public.care_signal_watches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.care_signal_watch_fires ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read own watches" ON public.care_signal_watches;
CREATE POLICY "Users can read own watches"
  ON public.care_signal_watches FOR SELECT
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can insert own watches" ON public.care_signal_watches;
CREATE POLICY "Users can insert own watches"
  ON public.care_signal_watches FOR INSERT
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can update own watches" ON public.care_signal_watches;
CREATE POLICY "Users can update own watches"
  ON public.care_signal_watches FOR UPDATE
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "Users can delete own watches" ON public.care_signal_watches;
CREATE POLICY "Users can delete own watches"
  ON public.care_signal_watches FOR DELETE
  USING (user_id = auth.uid());

-- Fires: read-only to the watch owner, inserts only via service role.
DROP POLICY IF EXISTS "Users can read own fires" ON public.care_signal_watch_fires;
CREATE POLICY "Users can read own fires"
  ON public.care_signal_watch_fires FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.care_signal_watches w
      WHERE w.id = watch_id AND w.user_id = auth.uid()
    )
  );

-- 5. Helpful comments
COMMENT ON TABLE public.care_signal_watches IS
  'User-defined notification rules on behavior + wearable signals. User defines every threshold; Wellet never picks "what is healthy."';
COMMENT ON COLUMN public.care_signal_watches.watch_type IS
  'Enum restricted to behaviors and wearables only. Adding new types (especially clinical labs/doses) requires deliberate review.';
COMMENT ON TABLE public.care_signal_watch_fires IS
  'Audit log of every watch fire. Used for the "last fired" UI, dedup, and rate limiting.';
