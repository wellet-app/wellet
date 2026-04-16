-- Add columns needed for Epic SMART on FHIR integration
alter table public.ehr_connections
  add column if not exists provider text,
  add column if not exists fhir_base_url text,
  add column if not exists patient_id text,
  add column if not exists code_verifier text,
  add column if not exists state text;
