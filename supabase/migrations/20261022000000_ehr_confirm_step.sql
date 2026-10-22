-- epic-auth v66 confirm step (2026-10-21).
--
-- 1. Provenance for birth dates saved from a hospital record after the
--    caregiver confirms it (Iris I3). Value: 'ehr_confirm:<ehr_connections.id>'.
--    Null means entered in Wellet or unknown.
alter table public.people add column if not exists date_of_birth_source text;

-- 2. Clears Epic connects paused for the caregiver's confirm (status
--    awaiting_confirm) once the hospital access token has expired, so encrypted
--    tokens never sit on an unconfirmed row. Runs every 15 minutes.
select cron.schedule(
  'ehr-confirm-expire',
  '*/15 * * * *',
  $$
  update public.ehr_connections
     set access_token = null,
         refresh_token = null,
         token_expires_at = null,
         status = 'abandoned',
         last_error = 'confirm_expired',
         last_error_step = 'patient_confirm',
         last_error_at = now()
   where status = 'awaiting_confirm'
     and (token_expires_at is null or token_expires_at < now());
  $$
);
