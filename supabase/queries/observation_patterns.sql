-- =============================================================================
-- Recurring pattern queries for "Wellet noticed" surfacing.
-- Backed by public.observation_series (created in migration observation_series_view_v1).
--
-- The view unifies vitals + lab_results + wearable_observations into one
-- time-series stream with hour_of_day_et, dow_et, daypart_et already computed.
--
-- Caregiver voice: "Wellet has been noticing..." / "across the last 30 days..."
-- Never "track" or "monitor". Always "loved one" or "family member".
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Daypart pattern — does a metric run higher in the morning vs evening?
--    Example output: "Heart rate runs about 9 bpm higher in the afternoon
--                     than the evening across the last 30 days."
-- -----------------------------------------------------------------------------
-- :person_id, :metric_key (e.g. 'systolic blood pressure', 'hkquantitytypeidentifierheartrate')
SELECT
  daypart_et,
  count(*)                            AS n_readings,
  round(avg(value_numeric), 1)        AS avg_value,
  round(stddev(value_numeric), 1)     AS sd,
  min(unit)                           AS unit
FROM public.observation_series
WHERE person_id = :person_id
  AND metric_key = :metric_key
  AND effective_at > now() - interval '30 days'
  AND value_numeric IS NOT NULL
GROUP BY daypart_et
HAVING count(*) >= 5  -- need at least 5 readings per daypart for a signal
ORDER BY avg_value DESC NULLS LAST;

-- -----------------------------------------------------------------------------
-- 2. Day-of-week pattern — is something different on weekends, or one day?
--    Example surface: "Resting heart rate trends higher on Saturdays."
-- -----------------------------------------------------------------------------
SELECT
  CASE dow_et
    WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue' WHEN 3 THEN 'Wed'
    WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat'
  END                                 AS dow,
  count(*)                            AS n,
  round(avg(value_numeric), 1)        AS avg_value
FROM public.observation_series
WHERE person_id = :person_id
  AND metric_key = :metric_key
  AND effective_at > now() - interval '60 days'
  AND value_numeric IS NOT NULL
GROUP BY dow_et
ORDER BY dow_et;

-- -----------------------------------------------------------------------------
-- 3. Trending series — last 30 readings of a single metric for sparkline use.
-- -----------------------------------------------------------------------------
SELECT
  effective_at,
  value_numeric,
  unit,
  source_table,
  daypart_et
FROM public.observation_series
WHERE person_id = :person_id
  AND metric_key = :metric_key
  AND value_numeric IS NOT NULL
ORDER BY effective_at DESC
LIMIT 30;

-- -----------------------------------------------------------------------------
-- 4. Recent-vs-baseline drift — has the average shifted in last 14 days vs
--    the 30 days before that? Useful for "Wellet noticed: blood pressure
--    has been running 8 mmHg higher than your usual."
-- -----------------------------------------------------------------------------
WITH baseline AS (
  SELECT avg(value_numeric) AS baseline_avg, count(*) AS n
  FROM public.observation_series
  WHERE person_id = :person_id
    AND metric_key = :metric_key
    AND effective_at BETWEEN now() - interval '44 days' AND now() - interval '14 days'
    AND value_numeric IS NOT NULL
),
recent AS (
  SELECT avg(value_numeric) AS recent_avg, count(*) AS n
  FROM public.observation_series
  WHERE person_id = :person_id
    AND metric_key = :metric_key
    AND effective_at > now() - interval '14 days'
    AND value_numeric IS NOT NULL
)
SELECT
  round(baseline.baseline_avg, 1)                         AS baseline_avg,
  round(recent.recent_avg, 1)                             AS recent_avg,
  round(recent.recent_avg - baseline.baseline_avg, 1)     AS drift,
  baseline.n                                              AS baseline_n,
  recent.n                                                AS recent_n
FROM baseline, recent
WHERE baseline.n >= 7 AND recent.n >= 3;  -- enough data to be meaningful

-- -----------------------------------------------------------------------------
-- 5. Top metrics with usable signal — find which metrics this person has
--    enough data for to surface patterns at all.
-- -----------------------------------------------------------------------------
SELECT
  metric_key,
  metric_name,
  count(*)                                                AS n_readings,
  count(DISTINCT date_trunc('day', effective_at))         AS n_days,
  min(effective_at)::date                                 AS first_seen,
  max(effective_at)::date                                 AS last_seen
FROM public.observation_series
WHERE person_id = :person_id
  AND value_numeric IS NOT NULL
  AND effective_at > now() - interval '90 days'
GROUP BY metric_key, metric_name
HAVING count(*) >= 10
ORDER BY n_readings DESC;
