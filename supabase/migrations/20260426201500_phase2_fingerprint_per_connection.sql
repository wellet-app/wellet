-- Phase 2 supplemental: scope fingerprint uniqueness to (person_id, connection_id, source_fingerprint)
--
-- Rationale: with N connections per person, two hospitals can return a resource
-- with the same fingerprint (e.g. "Aspirin 81mg" prescribed at both Duke and
-- Epic Sandbox). The current (person_id, source_fingerprint) UNIQUE would
-- collide on upsert and the 2nd connection's row would overwrite the 1st,
-- including the connection_id source-tag — meaning a row tagged to Duke could
-- silently flip to Sandbox if Sandbox synced second. That's a data-integrity
-- bug for the upcoming hospital-pill UI.
--
-- Fix: extend the UNIQUE to include connection_id so each connection owns its
-- own fingerprint slot per person. NULL connection_id rows (manual / CCDA /
-- Apple Health) coexist as a separate slot via NULLS NOT DISTINCT.
--
-- Postgres 15+ supports `NULLS NOT DISTINCT` on UNIQUE indexes, which treats
-- two NULLs as equal — required so manual rows continue to dedup against
-- themselves on re-upload. Supabase runs PG 15.

-- medications
DROP INDEX IF EXISTS public.medications_fingerprint_unique;
CREATE UNIQUE INDEX medications_fingerprint_unique
  ON public.medications (person_id, connection_id, source_fingerprint)
  NULLS NOT DISTINCT;

-- allergies
DROP INDEX IF EXISTS public.allergies_fingerprint_unique;
CREATE UNIQUE INDEX allergies_fingerprint_unique
  ON public.allergies (person_id, connection_id, source_fingerprint)
  NULLS NOT DISTINCT;

-- health_events
DROP INDEX IF EXISTS public.health_events_fingerprint_unique;
CREATE UNIQUE INDEX health_events_fingerprint_unique
  ON public.health_events (person_id, connection_id, source_fingerprint)
  NULLS NOT DISTINCT;

-- lab_results
DROP INDEX IF EXISTS public.lab_results_fingerprint_unique;
CREATE UNIQUE INDEX lab_results_fingerprint_unique
  ON public.lab_results (person_id, connection_id, source_fingerprint)
  NULLS NOT DISTINCT;

-- vitals
DROP INDEX IF EXISTS public.vitals_fingerprint_unique;
CREATE UNIQUE INDEX vitals_fingerprint_unique
  ON public.vitals (person_id, connection_id, source_fingerprint)
  NULLS NOT DISTINCT;
