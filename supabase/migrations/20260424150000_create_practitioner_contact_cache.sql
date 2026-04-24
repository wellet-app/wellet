-- Create practitioner_contact_cache table
--
-- Purpose: cache enriched practitioner contact info (phone, fax, address, bio,
-- photo) fetched from dukehealth.org and NPPES, since Duke's FHIR Practitioner
-- and PractitionerRole resources consistently return without telecom data.
--
-- Lookup key strategy:
--   "npi:<npi>"         when we have an NPI
--   "duke:<slug>"       when we matched a dukehealth.org provider page
--   "name:<first>-<last>-<state>" fallback when no NPI/Duke match
--
-- Rows are safe to delete; enrich-practitioner edge function will repopulate.

CREATE TABLE IF NOT EXISTS public.practitioner_contact_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_key text UNIQUE NOT NULL,
  practitioner_ref text,              -- Epic "Practitioner/abc123"
  name text,
  npi text,
  phones jsonb DEFAULT '[]'::jsonb,   -- array of strings
  fax text,
  addresses jsonb DEFAULT '[]'::jsonb, -- [{street,city,state,zip,label}]
  specialty text,
  bio text,
  photo_url text,
  source_name text,                   -- "dukehealth.org" | "NPPES"
  source_url text,
  confidence text,                    -- "high" | "medium" | "low"
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_practitioner_contact_cache_npi
  ON public.practitioner_contact_cache(npi)
  WHERE npi IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_practitioner_contact_cache_updated_at
  ON public.practitioner_contact_cache(updated_at DESC);

-- RLS: cache is read-only for authenticated users, write-only via service role
-- (edge function uses service role key, so no policy needed for writes).
ALTER TABLE public.practitioner_contact_cache ENABLE ROW LEVEL SECURITY;

CREATE POLICY "practitioner_contact_cache_read_authenticated"
  ON public.practitioner_contact_cache
  FOR SELECT
  TO authenticated
  USING (true);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION public.touch_practitioner_contact_cache_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_practitioner_contact_cache_updated_at
  ON public.practitioner_contact_cache;

CREATE TRIGGER trg_practitioner_contact_cache_updated_at
  BEFORE UPDATE ON public.practitioner_contact_cache
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_practitioner_contact_cache_updated_at();

COMMENT ON TABLE public.practitioner_contact_cache IS
  'Enriched contact info for Practitioner resources, populated by the enrich-practitioner edge function from dukehealth.org (primary) and NPPES (fallback). Epic Duke FHIR does not return telecom/address on Practitioner or PractitionerRole.';
