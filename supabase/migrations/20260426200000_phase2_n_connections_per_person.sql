-- Phase 2: N-connections-per-person
-- Adds connection_id source-tag to clinical tables so a single person can
-- hold rows from multiple EHR connections. Adds sort_order + disconnected_at
-- to ehr_connections for the UI ordering / soft-delete model.
--
-- Backfill: every existing EHR-sourced row on Mom's account is stamped with
-- her current Duke connection_id (e2760973-0a33-4ea8-a549-7d9295423cf1).
-- Today there is exactly one connected ehr_connections row (Mom's Duke), so
-- the backfill is unambiguous. Manual rows (source != 'ehr') stay
-- connection_id = NULL and continue to render through the manual path.
--
-- All ALTERs are additive and nullable, so this is safe to apply before any
-- application code reads the new columns.

-- ============================================================
-- 1. ehr_connections: sort_order + disconnected_at
-- ============================================================
ALTER TABLE public.ehr_connections
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS disconnected_at timestamptz NULL;

COMMENT ON COLUMN public.ehr_connections.sort_order IS
  'Manual UI ordering override for the hospital pill row. 0 = use default (most-recently-synced first). Higher values pin earlier.';
COMMENT ON COLUMN public.ehr_connections.disconnected_at IS
  'Soft-delete timestamp. When set, the connection is hidden from default Records but its clinical rows remain queryable for a future "Past sources" view.';

-- ============================================================
-- 2. Add connection_id to clinical tables (nullable, FK ON DELETE SET NULL)
-- ============================================================
ALTER TABLE public.health_events
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL
    REFERENCES public.ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE public.medications
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL
    REFERENCES public.ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE public.lab_results
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL
    REFERENCES public.ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE public.allergies
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL
    REFERENCES public.ehr_connections(id) ON DELETE SET NULL;

ALTER TABLE public.vitals
  ADD COLUMN IF NOT EXISTS connection_id uuid NULL
    REFERENCES public.ehr_connections(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.health_events.connection_id IS
  'Source-tag: which ehr_connections row this row came from. NULL for manual/CCDA/Apple Health. Set by fetch-ehr-data fan-out (Phase 2).';
COMMENT ON COLUMN public.medications.connection_id IS 'See health_events.connection_id.';
COMMENT ON COLUMN public.lab_results.connection_id IS 'See health_events.connection_id.';
COMMENT ON COLUMN public.allergies.connection_id IS 'See health_events.connection_id.';
COMMENT ON COLUMN public.vitals.connection_id IS 'See health_events.connection_id.';

-- ============================================================
-- 3. Indexes for per-connection fan-out queries
-- ============================================================
CREATE INDEX IF NOT EXISTS health_events_person_conn_idx
  ON public.health_events (person_id, connection_id)
  WHERE connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS medications_person_conn_idx
  ON public.medications (person_id, connection_id)
  WHERE connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lab_results_person_conn_idx
  ON public.lab_results (person_id, connection_id)
  WHERE connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS allergies_person_conn_idx
  ON public.allergies (person_id, connection_id)
  WHERE connection_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS vitals_person_conn_idx
  ON public.vitals (person_id, connection_id)
  WHERE connection_id IS NOT NULL;

-- ============================================================
-- 4. Backfill existing EHR rows on Mom's account to her current Duke connection
-- ============================================================
-- Today: exactly one connected ehr_connections row exists in prod (Mom's Duke).
-- All EHR-sourced clinical rows on her person_id came from that one connection,
-- so we can stamp them safely.
--
-- We resolve the connection_id by lookup (not hardcoded UUID) so this migration
-- is replayable on any environment where exactly one connected EHR row exists
-- for a given person.

WITH mom_duke AS (
  SELECT id
  FROM public.ehr_connections
  WHERE person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
    AND status = 'connected'
    AND fhir_base_url ILIKE '%duke%'
  LIMIT 1
)
UPDATE public.health_events he
SET connection_id = (SELECT id FROM mom_duke)
WHERE he.person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
  AND he.source = 'ehr'
  AND he.connection_id IS NULL
  AND EXISTS (SELECT 1 FROM mom_duke);

WITH mom_duke AS (
  SELECT id
  FROM public.ehr_connections
  WHERE person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
    AND status = 'connected'
    AND fhir_base_url ILIKE '%duke%'
  LIMIT 1
)
UPDATE public.medications m
SET connection_id = (SELECT id FROM mom_duke)
WHERE m.person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
  AND m.source = 'ehr'
  AND m.connection_id IS NULL
  AND EXISTS (SELECT 1 FROM mom_duke);

WITH mom_duke AS (
  SELECT id
  FROM public.ehr_connections
  WHERE person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
    AND status = 'connected'
    AND fhir_base_url ILIKE '%duke%'
  LIMIT 1
)
UPDATE public.lab_results l
SET connection_id = (SELECT id FROM mom_duke)
WHERE l.person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
  AND l.source = 'ehr'
  AND l.connection_id IS NULL
  AND EXISTS (SELECT 1 FROM mom_duke);

WITH mom_duke AS (
  SELECT id
  FROM public.ehr_connections
  WHERE person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
    AND status = 'connected'
    AND fhir_base_url ILIKE '%duke%'
  LIMIT 1
)
UPDATE public.allergies a
SET connection_id = (SELECT id FROM mom_duke)
WHERE a.person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
  AND a.source = 'ehr'
  AND a.connection_id IS NULL
  AND EXISTS (SELECT 1 FROM mom_duke);

-- vitals has 0 rows so the WHERE will be a no-op, but we run it for completeness
-- in case any are written between migration write-time and apply-time.
WITH mom_duke AS (
  SELECT id
  FROM public.ehr_connections
  WHERE person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
    AND status = 'connected'
    AND fhir_base_url ILIKE '%duke%'
  LIMIT 1
)
UPDATE public.vitals v
SET connection_id = (SELECT id FROM mom_duke)
WHERE v.person_id = '2a1e1a92-f091-40d2-9f25-567d9b37fefb'
  AND v.source = 'ehr'
  AND v.connection_id IS NULL
  AND EXISTS (SELECT 1 FROM mom_duke);
