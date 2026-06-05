-- Wellet · data_source_invites
--
-- A caregiver (the person logged in to Wellet) can invite a loved one to grant
-- access to a specific data source — Apple Health, an EHR (e.g. Duke MyChart),
-- or future sources — by sending them an SMS with a one-time link. The loved
-- one opens the link on her own device, where she's the only one who can
-- complete the OAuth / HealthKit consent that her data source requires.
--
-- One invite = one data source for one person. Apple Health and EHR share this
-- same table and edge function. Upload + manual entry stay caregiver-doable
-- and DO NOT use this flow.
--
-- Tokens are single-use, 24h expiry. The same SMS can be re-sent (iPad
-- fallback) without minting a new token.

CREATE TABLE IF NOT EXISTS public.data_source_invites (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Who this invite is FOR (the loved one whose data we want to receive).
  person_id           uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,

  -- Who created it (the caregiver). auth.users so we can RLS by auth.uid().
  caregiver_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Which data source the loved one will be granting access to.
  -- Extensible: future sources can add 'fitbit', 'oura', 'invitae', etc.
  data_source         text NOT NULL CHECK (data_source IN ('apple_health','ehr')),

  -- For ehr only: pre-resolved by the caregiver before sending the link, so
  -- the loved one never has to pick her own hospital from a search box.
  hospital_name       text,
  fhir_base_url       text,

  -- Channel + destination. Phone or email of the LOVED ONE.
  channel             text NOT NULL CHECK (channel IN ('sms','email')),
  target_contact      text NOT NULL,

  -- Optional: if we want the loved one to authenticate as a specific email
  -- when consuming (binds the token to her identity). Null = no binding.
  intended_email      text,

  -- The link payload. UUID is what we put in the URL; this is the primary
  -- lookup key the edge function uses.
  token               uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,

  -- Lifecycle.
  expires_at          timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  consumed_at         timestamptz,
  consumed_by_user_id uuid REFERENCES auth.users(id),

  -- Bookkeeping.
  sms_log_id          uuid REFERENCES public.sms_log(id),
  resend_count        int NOT NULL DEFAULT 0,
  last_resent_at      timestamptz,

  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.data_source_invites IS
  'Caregiver-to-loved-one invitations to connect a data source (Apple Health, EHR). One-time use, 24h expiry, single token per data source per send.';

-- Hot path: token lookup on every landing page open.
CREATE INDEX IF NOT EXISTS idx_data_source_invites_token
  ON public.data_source_invites(token);

-- Caregiver dashboard "pending invites" query.
CREATE INDEX IF NOT EXISTS idx_data_source_invites_person
  ON public.data_source_invites(person_id, created_at DESC);

-- "What's still pending for this caregiver" query.
CREATE INDEX IF NOT EXISTS idx_data_source_invites_caregiver_pending
  ON public.data_source_invites(caregiver_user_id, created_at DESC)
  WHERE consumed_at IS NULL;

-- ----------------------------------------------------------------------------
-- RLS — locked down. The edge function uses service-role for token lookup
-- (so the loved one, who has no auth yet, can resolve her own link). The
-- caregiver gets read access only to invites they themselves created.

ALTER TABLE public.data_source_invites ENABLE ROW LEVEL SECURITY;

-- Caregiver can see their own outgoing invites.
DROP POLICY IF EXISTS "Caregivers view their own invites" ON public.data_source_invites;
CREATE POLICY "Caregivers view their own invites"
  ON public.data_source_invites
  FOR SELECT
  USING (auth.uid() = caregiver_user_id);

-- Caregiver can create an invite, but only for a person they own.
DROP POLICY IF EXISTS "Caregivers create invites for their own people" ON public.data_source_invites;
CREATE POLICY "Caregivers create invites for their own people"
  ON public.data_source_invites
  FOR INSERT
  WITH CHECK (
    auth.uid() = caregiver_user_id
    AND EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.id = person_id
        AND p.user_id = auth.uid()
    )
  );

-- No direct UPDATE/DELETE from anon or authenticated clients. The edge
-- function uses service-role to mark invites consumed; the caregiver-side
-- modal calls the edge function to create + (later) cancel/resend.

-- ----------------------------------------------------------------------------
-- Helper view: caregiver-facing "what's pending for this person" lookup. Used
-- by the Waiting-for-Mom status state in wellet.js. Excludes expired and
-- consumed invites so the UI never confuses "still waiting" with "done".

CREATE OR REPLACE VIEW public.data_source_invites_pending AS
  SELECT
    id, person_id, caregiver_user_id, data_source,
    hospital_name, channel, target_contact,
    token, expires_at, created_at,
    sms_log_id, resend_count, last_resent_at
  FROM public.data_source_invites
  WHERE consumed_at IS NULL
    AND expires_at > now();

GRANT SELECT ON public.data_source_invites_pending TO authenticated;
