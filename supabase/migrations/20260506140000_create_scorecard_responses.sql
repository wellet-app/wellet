-- Wellet Scorecard: "What Wellet Would Notice For You"
--
-- Captures responses to the 6-question caregiver scorecard on
-- getwellet.com/scorecard. Each row = one completed scorecard.
--
-- Email is captured (with consent) so we can email the personalized
-- result and follow up with a magic-link signup invitation. UTM and
-- referrer fields preserve attribution.

CREATE TABLE IF NOT EXISTS scorecard_responses (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  -- The 6 caregiver questions
  loved_one_age_band TEXT CHECK (loved_one_age_band IN (
    'under_60', '60_69', '70_79', '80_89', '90_plus', 'prefer_not_say'
  )),
  conditions TEXT[] DEFAULT '{}',          -- multi-select from a fixed list
  current_tools TEXT[] DEFAULT '{}',       -- e.g. {'mychart','sticky_notes','spreadsheet','memory'}
  biggest_worry TEXT CHECK (biggest_worry IN (
    'missing_something', 'medication_changes', 'appointment_chaos',
    'multiple_doctors', 'declining_changes', 'other'
  )),
  hospital_system TEXT,                    -- free-text or dropdown value
  caregiver_role TEXT CHECK (caregiver_role IN (
    'primary', 'shared', 'distance', 'professional', 'other'
  )),

  -- Email capture (after they see the result, with explicit consent)
  email TEXT,
  email_consent BOOLEAN DEFAULT false,

  -- Generated result (denormalized so we can re-send the same one)
  result_signals JSONB,                    -- array of { id, title, why } objects

  -- Attribution
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  user_agent TEXT,

  -- Lifecycle
  created_at TIMESTAMPTZ DEFAULT NOW(),
  email_captured_at TIMESTAMPTZ,
  brevo_synced_at TIMESTAMPTZ,
  magic_link_sent_at TIMESTAMPTZ
);

-- Index for follow-up queries
CREATE INDEX IF NOT EXISTS scorecard_responses_email_idx
  ON scorecard_responses(email)
  WHERE email IS NOT NULL;

CREATE INDEX IF NOT EXISTS scorecard_responses_created_at_idx
  ON scorecard_responses(created_at DESC);

-- Row-Level Security: anonymous inserts allowed, no anonymous reads.
-- Edge function uses service role to update result_signals after generating.
ALTER TABLE scorecard_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow anonymous scorecard inserts"
  ON scorecard_responses
  FOR INSERT
  TO anon
  WITH CHECK (true);

CREATE POLICY "Deny anonymous scorecard reads"
  ON scorecard_responses
  FOR SELECT
  TO anon
  USING (false);

-- Updates (e.g. attaching email + result_signals) are performed by the
-- scorecard-generate edge function using the service role. No anonymous
-- UPDATE policy — we don't want random clients mutating other rows.

COMMENT ON TABLE scorecard_responses IS
  'Responses to the public "What Wellet Would Notice For You" scorecard at getwellet.com/scorecard. Email capture is opt-in only.';
