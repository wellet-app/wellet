-- Step 1 of 2. Safe to apply before the web change ships.
-- Adds a read-only yes/no flag so browsers can tell whether a
-- connection holds a token without ever reading the token itself.
alter table public.ehr_connections
  add column if not exists has_token boolean
  generated always as (access_token is not null) stored;
