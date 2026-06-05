-- UNC Health Care provider directory cache.
--
-- Why this table exists:
--   UNC's public provider directory at unchealth.org is backed by a
--   publicly embedded Yext "Answers" API that returns the full set of
--   ~5,172 providers, INCLUDING fields Epic FHIR never exposes:
--     - npi (stable national identifier)
--     - c_epicID (the same Practitioner.id our FHIR pulls return)
--     - mainPhone, fax, structured address, headshot, specialty
--
--   Because c_epicID is the same id Wellet already stores when it
--   syncs UNC FHIR Practitioner rows, a single bulk seed of this
--   table converts every UNC Care Team card from "name only" to
--   "name + phone + photo + specialty" with zero NPPES round-trips
--   and zero name-match ambiguity.
--
-- Lifecycle:
--   - Bulk-seeded by the seed-unc-providers edge function (~104 pages
--     × 50 providers/page). Run on-demand; idempotent via upsert on
--     npi. Re-runs are cheap and pick up new providers + contact
--     changes.
--   - Read by enrich-practitioner's UNC adapter at lookup time. The
--     adapter prefers c_epic_id matches (because FHIR Practitioner.id
--     is unambiguous) then falls back to npi, then to name.
--   - last_seen_at column lets us age out providers no longer in the
--     directory.

CREATE TABLE IF NOT EXISTS public.unc_providers (
  npi              text PRIMARY KEY,
  -- c_epicID from Yext = Epic Practitioner.id from FHIR. This is the
  -- gold matching field: identical token on both sides. Indexed for
  -- O(1) lookup by the adapter.
  c_epic_id        text,
  yext_entity_id   text,

  -- Name parts. Yext gives all three; we keep them split for
  -- adapter-side name matching when c_epic_id isn't passed in.
  name             text,
  first_name       text,
  last_name        text,
  middle_name      text,
  credentials      text[],           -- ["MD"], ["PA-C"], ["RN", "BSN"]

  -- Contact
  main_phone       text,             -- E.164 from Yext, e.g. "+19849745000"
  fax              text,
  custom_email     text,

  -- Address (kept structured; the adapter flattens to our Address shape)
  address_line1    text,
  address_line2    text,
  address_city     text,
  address_state    text,             -- "NC"
  address_postal   text,
  address_country  text,

  -- Photo
  headshot_url     text,
  headshot_alt     text,

  -- Specialty / org
  primary_specialty       text,
  specialties             text[],
  org_unit_folder         text,
  languages               text[],
  accepting_new_patients  boolean,
  gender                  text,
  insurance_accepted      text[],
  website                 text,

  -- Geocode (handy for future "nearby" UX; pulled from Yext when present)
  geocoded_lat     double precision,
  geocoded_lng     double precision,

  -- Provenance + lifecycle
  raw_yext         jsonb NOT NULL,
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Lookup paths the adapter uses
CREATE INDEX IF NOT EXISTS unc_providers_c_epic_id_idx
  ON public.unc_providers (c_epic_id)
  WHERE c_epic_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS unc_providers_last_name_lower_idx
  ON public.unc_providers (lower(last_name));

CREATE INDEX IF NOT EXISTS unc_providers_last_seen_at_idx
  ON public.unc_providers (last_seen_at);

-- Keep updated_at fresh on UPSERT
CREATE OR REPLACE FUNCTION public.unc_providers_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS unc_providers_touch_updated_at ON public.unc_providers;
CREATE TRIGGER unc_providers_touch_updated_at
  BEFORE UPDATE ON public.unc_providers
  FOR EACH ROW EXECUTE FUNCTION public.unc_providers_touch_updated_at();

-- RLS: this table is non-PHI public directory info. Service role reads
-- and writes; authenticated users get SELECT so the edge function can
-- be invoked with the user's JWT in the future if we ever want
-- adapter-time lookups to use the user's session. No anon access.
ALTER TABLE public.unc_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "unc_providers select for authenticated"
  ON public.unc_providers;
CREATE POLICY "unc_providers select for authenticated"
  ON public.unc_providers
  FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS "unc_providers service role all"
  ON public.unc_providers;
CREATE POLICY "unc_providers service role all"
  ON public.unc_providers
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

COMMENT ON TABLE public.unc_providers IS
  'Bulk-seeded cache of UNC Health Care''s public Yext provider directory. Non-PHI. Seeded by seed-unc-providers edge function; read by enrich-practitioner UNC adapter. c_epic_id matches Epic Practitioner.id from FHIR pulls.';
