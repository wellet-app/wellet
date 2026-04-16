-- Add missing columns to health_export_jobs for the import pipeline
alter table public.health_export_jobs add column if not exists file_name text;
alter table public.health_export_jobs add column if not exists file_size_bytes bigint;
alter table public.health_export_jobs add column if not exists source_system text;

-- Relax the status check constraint to allow 'uploading' and 'completed'
alter table public.health_export_jobs drop constraint if exists health_export_jobs_status_check;
alter table public.health_export_jobs add constraint health_export_jobs_status_check
  check (status in ('uploading', 'pending', 'processing', 'complete', 'completed', 'partial', 'failed'));
