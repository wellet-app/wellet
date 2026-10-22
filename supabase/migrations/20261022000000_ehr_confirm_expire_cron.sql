-- Clears Epic connects paused for the caregiver's confirm (status
-- awaiting_confirm) once the hospital access token has expired, so encrypted
-- tokens never sit on an unconfirmed row. Runs every 15 minutes.
-- Companion to epic-auth v66 confirm_patient (2026-10-21).
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
