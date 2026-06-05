-- observation_series view: unified time-series across vitals + lab_results + wearable_observations.
-- Powers recurring pattern detection (e.g. 'BP runs higher in the morning', 'Sunday medication misses').
-- Read-only, RLS comes from base tables.
-- Applied to project nrpdhxygzyfmyljzfexv on 2026-05-14 via apply_migration.

CREATE OR REPLACE FUNCTION public._safe_to_numeric(t text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN t IS NULL THEN NULL
    WHEN t ~ '^-?\d+(\.\d+)?$' THEN t::numeric
    WHEN substring(t FROM '^-?\d+(\.\d+)?') IS NOT NULL
      THEN substring(t FROM '^-?\d+(\.\d+)?')::numeric
    ELSE NULL
  END;
$$;

CREATE OR REPLACE VIEW public.observation_series AS
SELECT
  v.id                                          AS source_id,
  'vitals'::text                                AS source_table,
  v.person_id,
  lower(coalesce(v.vital_type, ''))             AS metric_key,
  v.vital_type                                  AS metric_name,
  v.loinc_code,
  v.effective_date                              AS effective_at,
  public._safe_to_numeric(v.value)              AS value_numeric,
  v.value                                       AS value_text,
  v.unit,
  v.source,
  EXTRACT(HOUR FROM v.effective_date AT TIME ZONE 'America/New_York')::int  AS hour_of_day_et,
  EXTRACT(DOW FROM v.effective_date AT TIME ZONE 'America/New_York')::int   AS dow_et,
  CASE
    WHEN EXTRACT(HOUR FROM v.effective_date AT TIME ZONE 'America/New_York') BETWEEN 4 AND 11 THEN 'morning'
    WHEN EXTRACT(HOUR FROM v.effective_date AT TIME ZONE 'America/New_York') BETWEEN 12 AND 17 THEN 'afternoon'
    WHEN EXTRACT(HOUR FROM v.effective_date AT TIME ZONE 'America/New_York') BETWEEN 18 AND 22 THEN 'evening'
    ELSE 'overnight'
  END                                            AS daypart_et
FROM public.vitals v
WHERE v.effective_date IS NOT NULL

UNION ALL

SELECT
  l.id                                          AS source_id,
  'lab_results'::text                           AS source_table,
  l.person_id,
  lower(coalesce(l.test_name, ''))              AS metric_key,
  l.test_name                                   AS metric_name,
  l.loinc_code,
  l.effective_date                              AS effective_at,
  public._safe_to_numeric(l.value)              AS value_numeric,
  l.value                                       AS value_text,
  l.unit,
  l.source,
  EXTRACT(HOUR FROM l.effective_date AT TIME ZONE 'America/New_York')::int  AS hour_of_day_et,
  EXTRACT(DOW FROM l.effective_date AT TIME ZONE 'America/New_York')::int   AS dow_et,
  CASE
    WHEN EXTRACT(HOUR FROM l.effective_date AT TIME ZONE 'America/New_York') BETWEEN 4 AND 11 THEN 'morning'
    WHEN EXTRACT(HOUR FROM l.effective_date AT TIME ZONE 'America/New_York') BETWEEN 12 AND 17 THEN 'afternoon'
    WHEN EXTRACT(HOUR FROM l.effective_date AT TIME ZONE 'America/New_York') BETWEEN 18 AND 22 THEN 'evening'
    ELSE 'overnight'
  END                                            AS daypart_et
FROM public.lab_results l
WHERE l.effective_date IS NOT NULL

UNION ALL

SELECT
  w.id                                          AS source_id,
  'wearable_observations'::text                 AS source_table,
  w.person_id,
  lower(coalesce(w.hk_type, ''))                AS metric_key,
  w.hk_type                                     AS metric_name,
  NULL::text                                    AS loinc_code,
  COALESCE(w.start_at, w.end_at)                AS effective_at,
  w.value::numeric                              AS value_numeric,
  w.value::text                                 AS value_text,
  w.unit,
  w.source,
  EXTRACT(HOUR FROM COALESCE(w.start_at, w.end_at) AT TIME ZONE 'America/New_York')::int  AS hour_of_day_et,
  EXTRACT(DOW FROM COALESCE(w.start_at, w.end_at) AT TIME ZONE 'America/New_York')::int   AS dow_et,
  CASE
    WHEN EXTRACT(HOUR FROM COALESCE(w.start_at, w.end_at) AT TIME ZONE 'America/New_York') BETWEEN 4 AND 11 THEN 'morning'
    WHEN EXTRACT(HOUR FROM COALESCE(w.start_at, w.end_at) AT TIME ZONE 'America/New_York') BETWEEN 12 AND 17 THEN 'afternoon'
    WHEN EXTRACT(HOUR FROM COALESCE(w.start_at, w.end_at) AT TIME ZONE 'America/New_York') BETWEEN 18 AND 22 THEN 'evening'
    ELSE 'overnight'
  END                                            AS daypart_et
FROM public.wearable_observations w
WHERE COALESCE(w.start_at, w.end_at) IS NOT NULL;

COMMENT ON VIEW public.observation_series IS
  'Unified time-series across vitals, lab_results, wearable_observations. Powers recurring pattern detection. Read-only. RLS inherited from base tables.';

GRANT SELECT ON public.observation_series TO authenticated;
