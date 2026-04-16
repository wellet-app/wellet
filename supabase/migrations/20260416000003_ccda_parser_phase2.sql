-- Phase 2: C-CDA XML parser support
-- Add export_job_id to medications if missing (other tables already have it)
ALTER TABLE public.medications ADD COLUMN IF NOT EXISTS export_job_id uuid;

-- Add indexes for deduplication queries (fast lookups by person + key fields)
CREATE INDEX IF NOT EXISTS idx_allergies_person_substance
  ON public.allergies (person_id, lower(substance));

CREATE INDEX IF NOT EXISTS idx_lab_results_person_test_date
  ON public.lab_results (person_id, lower(test_name), effective_date);

CREATE INDEX IF NOT EXISTS idx_medications_person_name
  ON public.medications (person_id, lower(name));

CREATE INDEX IF NOT EXISTS idx_vitals_person_type
  ON public.vitals (person_id, vital_type);

CREATE INDEX IF NOT EXISTS idx_health_events_person_title_type
  ON public.health_events (person_id, lower(title), event_type);
