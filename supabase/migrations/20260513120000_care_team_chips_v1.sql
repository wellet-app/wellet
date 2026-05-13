-- ============================================================================
-- Migration: care_team_chips_v1
-- Date:      2026-05-13
-- Purpose:   Storage for the "What your care team might not tell you"
--            chip section on Condition detail pages.
--
--   Tables created:
--     - public_data_cache              · 24h shared cache for public-registry
--                                        responses (ClinicalTrials.gov,
--                                        openFDA, PubMed). No PHI.
--     - condition_centers_of_excellence · curated reference list, manually
--                                        seeded per condition family.
--     - condition_advocacy_groups       · curated reference list, manually
--                                        seeded per condition family.
--
--   No PHI in any of these tables. They are pure public-data caches and
--   curated reference data, shared across all Wellet users.
--
--   Reversible: drop the three tables to roll back. No data dependencies.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. public_data_cache
--    One row per (source, query_key). Keyed by hash so we can cache trial
--    queries + FDA queries + PubMed queries in the same table without
--    column proliferation.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.public_data_cache (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source       text NOT NULL,         -- 'clinical_trials' | 'openfda' | 'pubmed'
  cache_key    text NOT NULL,         -- hash of normalized query params
  query_meta   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- for debugging only
  response     jsonb NOT NULL,
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  CONSTRAINT public_data_cache_source_chk
    CHECK (source IN ('clinical_trials', 'openfda', 'pubmed'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_pdc_source_key
  ON public.public_data_cache (source, cache_key);

CREATE INDEX IF NOT EXISTS idx_pdc_expires
  ON public.public_data_cache (expires_at);

COMMENT ON TABLE public.public_data_cache IS
  'Shared 24h cache for public-registry responses (ClinicalTrials.gov, openFDA, PubMed). No PHI. Keyed by (source, cache_key) where cache_key is a hash of the normalized query.';

-- RLS: this table is service-role only. Edge functions read/write with the
-- service key. Clients never touch it directly.
ALTER TABLE public.public_data_cache ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 2. condition_centers_of_excellence
--    Curated table. Each row: a center that specializes in a condition family,
--    keyed by a coarse condition label (e.g., "type 2 diabetes", "asthma",
--    "rheumatoid arthritis"). Edge function matches by ILIKE against the
--    condition_text from the chip request.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.condition_centers_of_excellence (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_key   text NOT NULL,       -- normalized lowercase, e.g. 'type 2 diabetes'
  condition_aliases text[] NOT NULL DEFAULT '{}', -- alt spellings, ICD prefixes
  center_name     text NOT NULL,
  hospital_system text,
  specialty       text,                -- 'Endocrinology', 'Pulmonology', etc.
  city            text,
  state           text,                -- two-letter
  lat             numeric(8,4),
  lng             numeric(9,4),
  website         text,
  designation     text,                -- 'NIH-designated', 'Society-designated', etc.
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coe_condition_key
  ON public.condition_centers_of_excellence (condition_key);

ALTER TABLE public.condition_centers_of_excellence ENABLE ROW LEVEL SECURITY;

-- Allow any authenticated user to read curated reference data. It's not PHI.
CREATE POLICY "coe_read_authenticated"
  ON public.condition_centers_of_excellence
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.condition_centers_of_excellence IS
  'Curated reference list of centers of excellence by condition. No PHI, readable by all authenticated users.';

-- ----------------------------------------------------------------------------
-- 3. condition_advocacy_groups
--    Curated table. Each row: a patient advocacy / education group for a
--    condition. Same matching pattern as centers_of_excellence.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.condition_advocacy_groups (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condition_key     text NOT NULL,
  condition_aliases text[] NOT NULL DEFAULT '{}',
  group_name        text NOT NULL,
  mission_short     text,               -- one-line mission, displayed in app
  website           text,
  type              text,               -- 'national', 'rare-disease', 'condition-specific'
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advocacy_condition_key
  ON public.condition_advocacy_groups (condition_key);

ALTER TABLE public.condition_advocacy_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "advocacy_read_authenticated"
  ON public.condition_advocacy_groups
  FOR SELECT
  TO authenticated
  USING (true);

COMMENT ON TABLE public.condition_advocacy_groups IS
  'Curated reference list of patient advocacy organizations by condition. No PHI, readable by all authenticated users.';

-- ----------------------------------------------------------------------------
-- Seed data: top 20 conditions
-- ----------------------------------------------------------------------------

-- Centers of excellence: seeded with NC-area centers since that's where our
-- testers live. Expand as testers from other regions onboard.

INSERT INTO public.condition_centers_of_excellence
  (condition_key, condition_aliases, center_name, hospital_system, specialty, city, state, lat, lng, website, designation)
VALUES
  ('type 2 diabetes', ARRAY['diabetes mellitus','e11','diabetes type 2'],
   'Duke Diabetes Center', 'Duke Health', 'Endocrinology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/diabetes-center', 'Academic medical center'),
  ('type 2 diabetes', ARRAY['diabetes mellitus','e11'],
   'UNC Diabetes Care Center', 'UNC Health', 'Endocrinology', 'Chapel Hill', 'NC', 35.9101, -79.0489,
   'https://www.uncmedicalcenter.org/uncmc/care-treatment/diabetes-and-endocrinology-center/', 'Academic medical center'),
  ('asthma', ARRAY['j45','allergic asthma'],
   'Duke Asthma, Allergy and Airway Center', 'Duke Health', 'Pulmonology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/locations/duke-asthma-allergy-and-airway-center', 'Academic medical center'),
  ('asthma', ARRAY['j45'],
   'UNC Pulmonary and Critical Care', 'UNC Health', 'Pulmonology', 'Chapel Hill', 'NC', 35.9101, -79.0489,
   'https://www.uncmedicalcenter.org/uncmc/care-treatment/pulmonary-and-critical-care/', 'Academic medical center'),
  ('hypothyroidism', ARRAY['e03','underactive thyroid'],
   'Duke Endocrinology Clinic', 'Duke Health', 'Endocrinology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/locations/duke-endocrinology-clinic', 'Academic medical center'),
  ('rheumatoid arthritis', ARRAY['m06','ra','m05'],
   'Duke Rheumatology', 'Duke Health', 'Rheumatology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/locations/duke-rheumatology-clinic', 'Academic medical center'),
  ('rheumatoid arthritis', ARRAY['m06','ra'],
   'UNC Thurston Arthritis Research Center', 'UNC Health', 'Rheumatology', 'Chapel Hill', 'NC', 35.9101, -79.0489,
   'https://www.med.unc.edu/tarc/', 'NIH-funded research center'),
  ('hypertension', ARRAY['i10','high blood pressure'],
   'Duke Hypertension Clinic', 'Duke Health', 'Cardiology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/heart-and-vascular/hypertension', 'Academic medical center'),
  ('atrial fibrillation', ARRAY['i48','afib','a-fib'],
   'Duke Center for Atrial Fibrillation', 'Duke Health', 'Cardiology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/heart-and-vascular/heart-rhythm-disorders/atrial-fibrillation', 'Academic medical center'),
  ('chronic kidney disease', ARRAY['n18','ckd'],
   'Duke Kidney Care', 'Duke Health', 'Nephrology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/kidney-care', 'Academic medical center'),
  ('copd', ARRAY['j44','chronic obstructive pulmonary disease'],
   'Duke COPD Clinic', 'Duke Health', 'Pulmonology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/pulmonary/copd', 'Academic medical center'),
  ('breast cancer', ARRAY['c50','breast carcinoma'],
   'Duke Cancer Institute · Breast Program', 'Duke Health', 'Oncology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/cancer/breast', 'NCI-designated comprehensive cancer center'),
  ('breast cancer', ARRAY['c50'],
   'UNC Lineberger Comprehensive Cancer Center', 'UNC Health', 'Oncology', 'Chapel Hill', 'NC', 35.9101, -79.0489,
   'https://unclineberger.org/', 'NCI-designated comprehensive cancer center'),
  ('alzheimer disease', ARRAY['g30','alzheimer''s','dementia'],
   'Duke/UNC Alzheimer''s Disease Research Center', 'Duke Health & UNC Health', 'Neurology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://sites.duke.edu/adrc/', 'NIH-designated ADRC'),
  ('parkinson disease', ARRAY['g20','parkinson''s'],
   'Duke Movement Disorders Clinic', 'Duke Health', 'Neurology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/neurology/movement-disorders', 'Parkinson Foundation Center of Excellence'),
  ('heart failure', ARRAY['i50','chf','congestive heart failure'],
   'Duke Heart Failure Program', 'Duke Health', 'Cardiology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/heart-and-vascular/heart-failure', 'Academic medical center'),
  ('multiple sclerosis', ARRAY['g35','ms'],
   'Duke Multiple Sclerosis Center', 'Duke Health', 'Neurology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/neurology/multiple-sclerosis-center', 'MS Society Center of Excellence'),
  ('lupus', ARRAY['m32','systemic lupus erythematosus','sle'],
   'Duke Lupus Clinic', 'Duke Health', 'Rheumatology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/rheumatology/lupus', 'Academic medical center'),
  ('inflammatory bowel disease', ARRAY['k50','k51','crohn''s','ulcerative colitis','ibd'],
   'UNC Multidisciplinary IBD Center', 'UNC Health', 'Gastroenterology', 'Chapel Hill', 'NC', 35.9101, -79.0489,
   'https://www.med.unc.edu/medicine/gi/ibd/', 'Academic medical center'),
  ('migraine', ARRAY['g43','migraines'],
   'Duke Headache Clinic', 'Duke Health', 'Neurology', 'Durham', 'NC', 35.9994, -78.9382,
   'https://www.dukehealth.org/treatments/neurology/headache-clinic', 'Academic medical center')
ON CONFLICT DO NOTHING;

-- Advocacy groups: seeded with national orgs for each top condition.

INSERT INTO public.condition_advocacy_groups
  (condition_key, condition_aliases, group_name, mission_short, website, type)
VALUES
  ('type 2 diabetes', ARRAY['diabetes mellitus','e11','diabetes type 2'],
   'American Diabetes Association', 'Funds research, education, and advocacy for people living with diabetes.',
   'https://diabetes.org', 'national'),
  ('type 2 diabetes', ARRAY['e11'],
   'Beyond Type 2', 'Community and resources for adults living with type 2 diabetes.',
   'https://beyondtype2.org', 'condition-specific'),
  ('asthma', ARRAY['j45'],
   'Asthma and Allergy Foundation of America', 'Education, advocacy, and research for people with asthma and allergies.',
   'https://aafa.org', 'national'),
  ('hypothyroidism', ARRAY['e03'],
   'American Thyroid Association · Patient Resources', 'Evidence-based education for people living with thyroid conditions.',
   'https://thyroid.org/thyroid-information/', 'national'),
  ('rheumatoid arthritis', ARRAY['m06','ra'],
   'Arthritis Foundation', 'Support, research, and advocacy for the 60M+ Americans living with arthritis.',
   'https://arthritis.org', 'national'),
  ('hypertension', ARRAY['i10','high blood pressure'],
   'American Heart Association · High Blood Pressure', 'Education and tools for managing blood pressure with a care team.',
   'https://www.heart.org/en/health-topics/high-blood-pressure', 'national'),
  ('atrial fibrillation', ARRAY['i48','afib'],
   'StopAfib.org', 'Patient-run community focused on living well with atrial fibrillation.',
   'https://www.stopafib.org', 'condition-specific'),
  ('chronic kidney disease', ARRAY['n18','ckd'],
   'American Kidney Fund', 'Direct financial assistance, advocacy, and education for kidney patients.',
   'https://www.kidneyfund.org', 'national'),
  ('chronic kidney disease', ARRAY['n18'],
   'National Kidney Foundation', 'Education, screening, and advocacy for kidney health.',
   'https://www.kidney.org', 'national'),
  ('copd', ARRAY['j44'],
   'COPD Foundation', 'Research, support groups, and education for people living with COPD.',
   'https://www.copdfoundation.org', 'condition-specific'),
  ('breast cancer', ARRAY['c50'],
   'Susan G. Komen', 'Research funding, financial assistance, and patient navigation for breast cancer.',
   'https://www.komen.org', 'national'),
  ('breast cancer', ARRAY['c50'],
   'Living Beyond Breast Cancer', 'Information and connection for people facing breast cancer at every stage.',
   'https://www.lbbc.org', 'condition-specific'),
  ('alzheimer disease', ARRAY['g30','alzheimer''s','dementia'],
   'Alzheimer''s Association', '24/7 helpline, support groups, and research funding for families facing dementia.',
   'https://www.alz.org', 'national'),
  ('parkinson disease', ARRAY['g20','parkinson''s'],
   'Parkinson''s Foundation', 'Research, education, and a helpline for people living with Parkinson''s and their families.',
   'https://www.parkinson.org', 'national'),
  ('parkinson disease', ARRAY['g20'],
   'Michael J. Fox Foundation', 'Research funding aimed at a cure for Parkinson''s disease.',
   'https://www.michaeljfox.org', 'national'),
  ('heart failure', ARRAY['i50','chf'],
   'American Heart Association · Heart Failure', 'Patient education and support resources for heart failure.',
   'https://www.heart.org/en/health-topics/heart-failure', 'national'),
  ('multiple sclerosis', ARRAY['g35','ms'],
   'National Multiple Sclerosis Society', 'Support, advocacy, and research for people living with MS.',
   'https://www.nationalmssociety.org', 'national'),
  ('lupus', ARRAY['m32','sle'],
   'Lupus Foundation of America', 'Research, advocacy, and patient resources for people with lupus.',
   'https://www.lupus.org', 'national'),
  ('inflammatory bowel disease', ARRAY['k50','k51','crohn''s','ibd'],
   'Crohn''s & Colitis Foundation', 'Patient support, research, and education for people with Crohn''s and ulcerative colitis.',
   'https://www.crohnscolitisfoundation.org', 'national'),
  ('migraine', ARRAY['g43'],
   'American Migraine Foundation', 'Patient education, research, and a doctor-finder for people living with migraine.',
   'https://americanmigrainefoundation.org', 'national')
ON CONFLICT DO NOTHING;
