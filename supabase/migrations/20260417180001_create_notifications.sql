-- Persistent notifications table for bell panel state
CREATE TABLE IF NOT EXISTS public.notifications (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  person_id uuid REFERENCES public.people(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('med_reminder', 'appointment', 'pattern_alert', 'care_circle', 'system')),
  title text NOT NULL,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_notifications_user ON public.notifications (user_id, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own notifications"
  ON public.notifications FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own notifications"
  ON public.notifications FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can update own notifications"
  ON public.notifications FOR UPDATE
  USING (user_id = auth.uid());

CREATE POLICY "Users can delete own notifications"
  ON public.notifications FOR DELETE
  USING (user_id = auth.uid());
