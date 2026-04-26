-- Hotfix: allow N EHR connections per person.
--
-- WHY: Today public.ehr_connections has UNIQUE INDEX idx_ehr_connections_person
-- on (person_id). The epic-auth.start handler issues an upsert with
-- onConflict: 'person_id'. The first time anyone tries to connect a SECOND
-- hospital to a person who already has one (e.g. attempting to add UNC to a
-- loved one who already has Duke), the upsert silently overwrites the
-- existing row's tokens, fhir_base_url, and patient_id with the new
-- pending-OAuth scratch data, then returns an authorize URL. If the user
-- abandons the new OAuth flow at any point, the original connection is gone.
--
-- This migration drops the (person_id) unique constraint and replaces it
-- with a partial unique index on (person_id, fhir_base_url) WHERE
-- status = 'connected'. Pending/half-finished connections (status != 'connected'
-- or fhir_base_url IS NULL) are not deduped, which is the right behavior for
-- in-flight OAuth attempts that may retry.
--
-- SAFETY: The single existing connected row in production
-- (person_id = 2a1e1a92-..., fhir_base_url = health-apis.duke.edu)
-- satisfies the new partial unique constraint. No data movement; no
-- cascading deletes; no token rotation. The migration is reversible by
-- recreating the old index (which would only succeed while there is still
-- ≤1 row per person).
--
-- COMPANION CODE CHANGES (in the same branch):
--   * supabase/functions/epic-auth/index.ts — start handler: upsert → insert
--   * supabase/functions/oneup-auth/index.ts — start handler: upsert → insert
-- Frontend changes for full N-per-person rendering are tracked in the
-- N-connections design doc and land in a follow-up branch.

BEGIN;

-- 1. Drop the old single-connection-per-person constraint.
DROP INDEX IF EXISTS public.idx_ehr_connections_person;

-- 2. Add the new constraint: at most one CONNECTED row per (person, hospital).
--    Pending OAuth attempts (status != 'connected' or fhir_base_url is null)
--    are not deduped, so retries don't fight existing pending rows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ehr_connections_person_fhir_connected
  ON public.ehr_connections (person_id, fhir_base_url)
  WHERE fhir_base_url IS NOT NULL AND status = 'connected';

-- 3. Performance index for the per-person fan-out lookup that
--    fetch-ehr-data will issue once it learns to fan out.
CREATE INDEX IF NOT EXISTS idx_ehr_connections_person_status
  ON public.ehr_connections (person_id, status);

-- 4. Defense-in-depth: prevent two pending starts from racing on the same
--    state token. (state should already be globally unique per OAuth attempt;
--    making that explicit prevents a future bug from compounding.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_ehr_connections_state_unique
  ON public.ehr_connections (state)
  WHERE state IS NOT NULL;

COMMIT;
