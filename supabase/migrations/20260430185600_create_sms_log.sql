-- sms_log: every Twilio SMS we attempt to send goes here.
-- Inserted by the twilio-send-sms edge function. Updated by the (future)
-- twilio-status-webhook edge function with delivery status callbacks.
--
-- Voice: this is for Wellet Connect invitations to family members and
-- loved ones. Not clinical, not PHI. The body column is plain text and
-- intentionally not encrypted at rest beyond Postgres-level encryption.

CREATE TABLE IF NOT EXISTS public.sms_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- who/what triggered the send
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  member_id       uuid REFERENCES public.care_circle_members(id) ON DELETE SET NULL,
  source          text NOT NULL DEFAULT 'wellet-connect-invite',

  -- the message
  to_number       text NOT NULL,                -- E.164, e.g. +14155551212
  from_number     text,                          -- recorded for audit (matches messaging service)
  body            text NOT NULL,
  body_length     integer NOT NULL,
  segments        integer,                       -- filled when Twilio reports

  -- twilio response
  message_sid     text,                          -- SM... assigned by Twilio
  twilio_status   text,                          -- queued | sending | sent | delivered | failed | undelivered
  twilio_error_code   integer,
  twilio_error_message text,

  -- our internal status (separate from Twilio's so we can mark our own failures)
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sent','delivered','failed','rejected_by_us')),

  -- delivery webhook callback
  delivered_at    timestamptz,
  failed_at       timestamptz,
  last_status_at  timestamptz,

  -- diagnostics
  request_id      text,                          -- Twilio request id from response headers
  context         jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sms_log_user_id_created_idx
  ON public.sms_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_log_to_number_created_idx
  ON public.sms_log (to_number, created_at DESC);
CREATE INDEX IF NOT EXISTS sms_log_message_sid_idx
  ON public.sms_log (message_sid) WHERE message_sid IS NOT NULL;
CREATE INDEX IF NOT EXISTS sms_log_status_idx
  ON public.sms_log (status, created_at DESC);

-- RLS: users can read their own sms_log rows. Service role (edge functions) bypasses RLS.
ALTER TABLE public.sms_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users read own sms_log"
  ON public.sms_log FOR SELECT
  USING (auth.uid() = user_id);

-- No INSERT/UPDATE/DELETE policies — only the service role writes here,
-- exactly the same shape as signup_error_log.

COMMENT ON TABLE public.sms_log IS
  'Audit log of every SMS attempted via Twilio. Written by twilio-send-sms edge function. Updated by twilio-status-webhook on delivery callbacks.';
