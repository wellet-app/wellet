-- Manual-person onboarding foundations (issue #66)
-- Adds DOB + sex fallback columns so caregiver-entered values survive
-- EHR connect/disconnect cycles. See PR description for full context.

-- 1. Fallback columns: preserve caregiver-entered values even after an EHR
--    connection overwrites the live date_of_birth / sex fields.
ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS manual_date_of_birth date,
  ADD COLUMN IF NOT EXISTS manual_sex text;

-- 2. Constrain sex to the four UI-exposed values. Using a named constraint
--    so we can drop/replace it cleanly if the enum ever expands.
--    Existing rows with NULL or unexpected values are left untouched
--    (NOT VALID) so this migration never fails on legacy data; new writes
--    are enforced immediately on the manual_sex column and normalized on
--    the live sex column going forward.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'people_sex_check'
  ) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_sex_check
      CHECK (sex IS NULL OR sex IN ('female','male','intersex','prefer_not_to_say'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'people_manual_sex_check'
  ) THEN
    ALTER TABLE public.people
      ADD CONSTRAINT people_manual_sex_check
      CHECK (manual_sex IS NULL OR manual_sex IN ('female','male','intersex','prefer_not_to_say'));
  END IF;
END $$;

-- 3. Column comments for anyone reading the schema cold.
COMMENT ON COLUMN public.people.manual_date_of_birth IS
  'Caregiver-entered DOB snapshot. Preserved across EHR connect/disconnect. The live date_of_birth column may be overwritten by FHIR Patient.birthDate when connected.';
COMMENT ON COLUMN public.people.manual_sex IS
  'Caregiver-entered biological sex snapshot. Preserved across EHR connect/disconnect. The live sex column may be overwritten by FHIR Patient.gender when connected.';
