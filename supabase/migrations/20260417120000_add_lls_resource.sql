-- Add Leukemia & Lymphoma Society (required by task spec)
INSERT INTO caregiver_resources (name, url, description, detail, conditions, categories, scope, phone, is_free, has_support_groups, has_zip_search, vetted) VALUES
(
  'Leukemia & Lymphoma Society',
  'https://lls.org',
  'Blood cancer support including financial assistance, peer-to-peer support, and clinical trial navigation.',
  'The Leukemia & Lymphoma Society (LLS) is the world''s largest voluntary health agency dedicated to blood cancer. LLS offers financial assistance for treatment, peer-to-peer support through First Connection, support groups, and the Information Resource Center.',
  ARRAY['cancer', 'leukemia', 'lymphoma'],
  ARRAY['support-group', 'financial-aid', 'education'],
  'national',
  '800-955-4572',
  TRUE, TRUE, FALSE, TRUE
);
