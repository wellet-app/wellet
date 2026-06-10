-- Reimbursements (mywellet) PR 1
--
-- One row per loved one (person_id). Holds the 9 ScorecardInput fields,
-- the generated programs/signals, per-field provenance, and freshness
-- metadata. We do NOT denormalize program details onto people — programs
-- and federal rules change, and we want to re-run generation against a
-- saved input set.
--
-- See: wellet_reimbursements_mywellet_spec.md (Data model).

CREATE TABLE IF NOT EXISTS public.reimbursement_assessments (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       UUID        NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  user_id         UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- The 9 ScorecardInput fields (same shape as scorecard2-submit v2).
  loved_one_age_band   TEXT,   -- derived from people.date_of_birth when possible
  conditions           TEXT[]  NOT NULL DEFAULT '{}',  -- from people.conditions / chart
  current_tools        TEXT[]  NOT NULL DEFAULT '{}',  -- always asked
  biggest_worry        TEXT,   -- always asked
  coverage             TEXT[]  NOT NULL DEFAULT '{}',  -- partially derivable from people.insurance_info
  adl_level            TEXT,   -- always asked (not in chart)
  hospital_system      TEXT,   -- derived from ehr_connections
  caregiver_role       TEXT,   -- derived from care_circle_members.role, else asked
  state                TEXT,   -- derived from hospital / profile, else asked

  -- Results from scorecard2-submit v2's generatePrograms() / generateSignals().
  result_programs      JSONB   NOT NULL DEFAULT '[]'::jsonb,
  result_signals       JSONB   NOT NULL DEFAULT '[]'::jsonb,

  -- Per-input-field provenance, e.g. { "conditions": "ehr", "coverage": "user" }.
  -- Lets the UI show "we filled this from the chart" vs "you told us".
  input_provenance     JSONB   NOT NULL DEFAULT '{}'::jsonb,

  -- Freshness.
  assessed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stale_at             TIMESTAMPTZ,  -- assessed_at + 90 days; set by trigger
  needs_refresh        BOOLEAN     NOT NULL DEFAULT FALSE,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One assessment per loved one. The edge function upserts on this.
CREATE UNIQUE INDEX IF NOT EXISTS reimbursement_assessments_person_unique
  ON public.reimbursement_assessments(person_id);

-- The freshness triggers (next migration) flip needs_refresh by user_id +
-- person_id; index both for the lookups they do.
CREATE INDEX IF NOT EXISTS reimbursement_assessments_user_idx
  ON public.reimbursement_assessments(user_id);

ALTER TABLE public.reimbursement_assessments ENABLE ROW LEVEL SECURITY;

-- Caregivers see and manage only their own assessments. The edge function
-- writes with the service role, so it is unaffected by this policy.
CREATE POLICY "Users see own reimbursements" ON public.reimbursement_assessments
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- ── Freshness trigger: set stale_at = assessed_at + 90 days ──────────
-- Runs on INSERT and whenever assessed_at changes on UPDATE, so a refresh
-- (which bumps assessed_at) re-arms the 90-day window. Also keeps
-- updated_at current.
CREATE OR REPLACE FUNCTION public.set_reimbursement_freshness()
RETURNS TRIGGER AS $$
BEGIN
  NEW.stale_at := NEW.assessed_at + INTERVAL '90 days';
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER reimbursement_assessments_set_freshness
  BEFORE INSERT OR UPDATE OF assessed_at
  ON public.reimbursement_assessments
  FOR EACH ROW
  EXECUTE FUNCTION public.set_reimbursement_freshness();

COMMENT ON TABLE public.reimbursement_assessments IS
  'One per loved one (person_id). Saved scorecard input + generated programs/signals + freshness for the in-app Reimbursements surface. See wellet_reimbursements_mywellet_spec.md.';
