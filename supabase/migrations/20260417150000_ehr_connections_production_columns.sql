-- Add columns for Epic FHIR production wiring:
-- hospital_name: stores the selected hospital's display name
-- token_url: stores the discovered token endpoint (per-hospital, not hardcoded)
alter table public.ehr_connections
  add column if not exists hospital_name text,
  add column if not exists token_url text;
