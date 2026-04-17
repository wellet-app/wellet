-- Notification preferences: persists per-user toggles from Settings
CREATE TABLE IF NOT EXISTS public.notification_preferences (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  weekly_digest boolean NOT NULL DEFAULT true,
  pattern_alerts boolean NOT NULL DEFAULT true,
  care_circle_emails boolean NOT NULL DEFAULT true,
  email_reminders boolean NOT NULL DEFAULT false,
  quiet_hours_enabled boolean NOT NULL DEFAULT false,
  quiet_hours_start time DEFAULT '22:00',
  quiet_hours_end time DEFAULT '07:00',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notification prefs"
  ON public.notification_preferences FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own notification prefs"
  ON public.notification_preferences FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own notification prefs"
  ON public.notification_preferences FOR UPDATE
  USING (user_id = auth.uid());
