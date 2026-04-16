-- ── CAREGIVER RESOURCES ──────────────────────────────────────────────────────
-- Curated directory of vetted caregiver support organizations
CREATE TABLE caregiver_resources (
  id                UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  name              TEXT        NOT NULL,
  url               TEXT        NOT NULL,
  description       TEXT,
  detail            TEXT,
  conditions        TEXT[],
  categories        TEXT[],
  scope             TEXT        DEFAULT 'national',
  state             TEXT,
  phone             TEXT,
  is_free           BOOLEAN     DEFAULT TRUE,
  has_support_groups BOOLEAN    DEFAULT FALSE,
  has_zip_search    BOOLEAN     DEFAULT FALSE,
  vetted            BOOLEAN     DEFAULT TRUE,
  source_url        TEXT,
  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
ALTER TABLE caregiver_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Anyone can read resources" ON caregiver_resources FOR SELECT USING (true);

-- ── USER SAVED RESOURCES ────────────────────────────────────────────────────
-- Bookmarks and dismissals per user / care recipient
CREATE TABLE user_saved_resources (
  id                  UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id             UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  resource_id         UUID        NOT NULL REFERENCES caregiver_resources(id) ON DELETE CASCADE,
  care_recipient_id   UUID,
  saved_at            TIMESTAMPTZ DEFAULT NOW(),
  dismissed           BOOLEAN     DEFAULT FALSE,
  source_trigger      TEXT
);
ALTER TABLE user_saved_resources ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users see own saved resources" ON user_saved_resources FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users insert own saved resources" ON user_saved_resources FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users update own saved resources" ON user_saved_resources FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users delete own saved resources" ON user_saved_resources FOR DELETE USING (auth.uid() = user_id);
CREATE UNIQUE INDEX idx_user_saved_resources_unique ON user_saved_resources(user_id, resource_id);

-- ── SEED DATA: TIER 1 — National Organizations (Always Available) ───────────
INSERT INTO caregiver_resources (name, url, description, detail, conditions, categories, scope, phone, is_free, has_support_groups, has_zip_search, vetted) VALUES
(
  'Caregiver Action Network',
  'https://caregiveraction.org',
  'Nation''s leading family caregiver organization with a disease-specific resource directory.',
  'Caregiver Action Network (CAN) is the nation''s leading family caregiver organization working to improve the quality of life for more than 90 million Americans who care for loved ones. CAN provides free education, peer support, and resources for family caregivers across the country.',
  ARRAY['general'],
  ARRAY['education', 'support-group', 'advocacy'],
  'national',
  '855-227-3640',
  TRUE, TRUE, FALSE, TRUE
),
(
  'Family Caregiver Alliance',
  'https://caregiver.org',
  'State-by-state Family Care Navigator with 40+ years of caregiver support.',
  'Family Caregiver Alliance (FCA) was the first community-based nonprofit in the country to address the needs of families and friends providing long-term care for loved ones at home. FCA''s Family Care Navigator connects caregivers to state-by-state services.',
  ARRAY['general'],
  ARRAY['education', 'respite', 'financial-aid'],
  'national',
  '800-445-8106',
  TRUE, TRUE, TRUE, TRUE
),
(
  'AARP Caregiving',
  'https://aarp.org/caregiving',
  'Comprehensive caregiving guides, tools, and a local resource finder.',
  'AARP provides free caregiving guides, planning tools, legal resources, and a local resource finder to help family caregivers navigate every stage of the caregiving journey.',
  ARRAY['general'],
  ARRAY['education', 'financial-aid'],
  'national',
  '888-687-2277',
  TRUE, FALSE, TRUE, TRUE
),
(
  'Eldercare Locator',
  'https://eldercare.acl.gov',
  'HHS-funded service connecting caregivers to local Area Agencies on Aging.',
  'The Eldercare Locator, a public service of the U.S. Administration on Aging, connects older adults and their caregivers with local services including transportation, meals, home care, and caregiver support programs.',
  ARRAY['general'],
  ARRAY['respite', 'financial-aid'],
  'national',
  '800-677-1116',
  TRUE, FALSE, TRUE, TRUE
);

-- ── SEED DATA: TIER 2 — Condition-Specific Organizations ───────────────────
INSERT INTO caregiver_resources (name, url, description, detail, conditions, categories, scope, phone, is_free, has_support_groups, has_zip_search, vetted) VALUES
(
  'Alzheimer''s Association',
  'https://alz.org',
  '24/7 helpline, local support group finder, and free caregiver education.',
  'The Alzheimer''s Association leads the way to end Alzheimer''s and all other dementia. They offer a 24/7 Helpline staffed by master''s-level clinicians, support groups searchable by ZIP code, and free online and in-person education programs for caregivers.',
  ARRAY['alzheimers', 'dementia'],
  ARRAY['support-group', 'education', 'helpline'],
  'national',
  '800-272-3900',
  TRUE, TRUE, TRUE, TRUE
),
(
  'Parkinson''s Foundation',
  'https://parkinson.org',
  'Free caregiver courses, local chapter finder, and a Helpline.',
  'The Parkinson''s Foundation makes life better for people with Parkinson''s disease by improving care and advancing research. They offer free online caregiver courses, local chapters, a Helpline, and a network of Centers of Excellence.',
  ARRAY['parkinsons'],
  ARRAY['education', 'support-group'],
  'national',
  '800-473-4636',
  TRUE, TRUE, TRUE, TRUE
),
(
  'American Cancer Society',
  'https://cancer.org',
  'Support group finder by cancer type and ZIP, plus free rides to treatment.',
  'The American Cancer Society provides cancer support programs including support groups by cancer type, free lodging near treatment centers, rides to treatment, and a 24/7 helpline with cancer information specialists.',
  ARRAY['cancer'],
  ARRAY['support-group', 'financial-aid', 'transportation'],
  'national',
  '800-227-2345',
  TRUE, TRUE, TRUE, TRUE
),
(
  'CancerCare',
  'https://cancercare.org',
  'Free professional counseling and financial assistance for cancer caregivers.',
  'CancerCare provides free professional support services to anyone affected by cancer, including counseling by oncology social workers, support groups, educational workshops, and financial assistance for treatment-related costs.',
  ARRAY['cancer'],
  ARRAY['support-group', 'financial-aid', 'counseling'],
  'national',
  '800-813-4673',
  TRUE, TRUE, FALSE, TRUE
),
(
  'American Stroke Association',
  'https://stroke.org',
  'Stroke support group finder and caregiver resources.',
  'The American Stroke Association, a division of the American Heart Association, provides resources for stroke survivors and their caregivers including support groups, recovery guides, and connections to local rehabilitation services.',
  ARRAY['stroke'],
  ARRAY['support-group', 'education'],
  'national',
  '888-478-7653',
  TRUE, TRUE, TRUE, TRUE
),
(
  'ALS Association',
  'https://als.org',
  'Care services, equipment loan programs, and support groups for ALS families.',
  'The ALS Association provides care services to assist people with ALS and their families through certified clinical care centers, equipment loan programs, support groups, and a nationwide network of chapters.',
  ARRAY['als'],
  ARRAY['support-group', 'equipment', 'respite'],
  'national',
  '800-782-4747',
  TRUE, TRUE, FALSE, TRUE
),
(
  'American Heart Association',
  'https://heart.org',
  'Caregiver resources and a nationwide support network for heart disease.',
  'The American Heart Association offers caregiver resources, an online support network, educational materials, and tools for managing heart disease and stroke recovery at home.',
  ARRAY['heart_disease'],
  ARRAY['education', 'support-group'],
  'national',
  '800-242-8721',
  TRUE, TRUE, FALSE, TRUE
),
(
  'NAMI',
  'https://nami.org',
  'Family support groups and the free Family-to-Family education program.',
  'The National Alliance on Mental Illness (NAMI) is the nation''s largest grassroots mental health organization. NAMI offers free Family Support Groups led by trained family members, and the Family-to-Family education program for caregivers of individuals living with mental illness.',
  ARRAY['mental_health'],
  ARRAY['support-group', 'education'],
  'national',
  '800-950-6264',
  TRUE, TRUE, TRUE, TRUE
),
(
  'National MS Society',
  'https://nationalmssociety.org',
  'MS Navigator program and support groups for people affected by MS.',
  'The National MS Society connects people affected by MS to information, resources, and support through their MS Navigator program, peer support groups, and a nationwide network of chapters.',
  ARRAY['ms'],
  ARRAY['support-group', 'education'],
  'national',
  '800-344-4867',
  TRUE, TRUE, TRUE, TRUE
),
(
  'National Kidney Foundation',
  'https://kidney.org',
  'Caregiver support, education, and resources for kidney disease management.',
  'The National Kidney Foundation provides education, support, and advocacy for people affected by kidney disease. Resources include caregiver guides, peer mentoring programs, and a helpline for kidney disease questions.',
  ARRAY['kidney'],
  ARRAY['education', 'support-group'],
  'national',
  '800-622-9010',
  TRUE, TRUE, FALSE, TRUE
),
(
  'American Lung Association',
  'https://lung.org',
  'Better Breathers Club support groups for lung disease caregivers.',
  'The American Lung Association offers Better Breathers Clubs — a support group for people with chronic lung conditions and their caregivers. They also provide free educational resources and a Lung HelpLine staffed by nurses and respiratory therapists.',
  ARRAY['lung'],
  ARRAY['support-group', 'education'],
  'national',
  '800-586-4872',
  TRUE, TRUE, TRUE, TRUE
);

-- ── SEED DATA: TIER 3 — Situation-Specific Organizations ───────────────────
INSERT INTO caregiver_resources (name, url, description, detail, conditions, categories, scope, phone, is_free, has_support_groups, has_zip_search, vetted) VALUES
(
  'Well Spouse Association',
  'https://wellspouse.org',
  'Support for spouse and partner caregivers — you don''t have to do this alone.',
  'Well Spouse Association is the only national organization dedicated to the needs of spousal caregivers. They offer peer support groups, a newsletter, and an annual conference connecting spouse caregivers with shared experiences.',
  ARRAY['general'],
  ARRAY['support-group'],
  'national',
  '732-577-8899',
  TRUE, TRUE, FALSE, TRUE
),
(
  'Daughterhood',
  'https://daughterhood.org',
  'Community for women caring for aging family members.',
  'Daughterhood provides community and support for women navigating the challenges of caring for aging family members through local Daughterhood Circles, online resources, and a supportive community of fellow caregivers.',
  ARRAY['general'],
  ARRAY['support-group', 'education'],
  'national',
  NULL,
  TRUE, TRUE, FALSE, TRUE
),
(
  'VA Caregiver Support',
  'https://caregiver.va.gov',
  'Resources and support for caregivers of veterans, including stipends.',
  'The VA Caregiver Support Program provides resources, education, and support for caregivers of veterans. Programs include the Program of Comprehensive Assistance for Family Caregivers, which may include a monthly stipend, health insurance, and respite care.',
  ARRAY['general'],
  ARRAY['financial-aid', 'respite', 'education'],
  'national',
  '855-260-3274',
  TRUE, FALSE, FALSE, TRUE
),
(
  'GriefShare',
  'https://griefshare.org',
  'Grief recovery support groups — a 13-week program near you.',
  'GriefShare is a friendly, caring group of people who will walk alongside you through one of life''s most difficult experiences. The 13-week program features video seminars, group discussion, and a personal workbook.',
  ARRAY['bereavement'],
  ARRAY['bereavement', 'support-group'],
  'national',
  NULL,
  TRUE, TRUE, TRUE, TRUE
),
(
  'Hospice Foundation of America',
  'https://hospicefoundation.org',
  'Bereavement resources and end-of-life caregiving support.',
  'Hospice Foundation of America provides programs, resources, and education for professionals, volunteers, and those coping with serious illness, death, and grief. They offer bereavement resources and teleconferences on end-of-life issues.',
  ARRAY['bereavement'],
  ARRAY['bereavement', 'education'],
  'national',
  '800-854-3402',
  TRUE, FALSE, FALSE, TRUE
);
