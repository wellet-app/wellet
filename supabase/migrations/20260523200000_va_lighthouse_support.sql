-- VA Lighthouse (Patient Health API) integration support.
-- Reuses the existing `ehr_connections.provider` column (already text) — VA
-- rows will be created with provider='va'. No new table needed because VA is
-- a single tenant (unlike Cerner which is per-hospital).
--
-- Adds a CHECK constraint so future provider values are explicit and any
-- migration regression is caught loudly.

-- Backfill any NULL provider rows to 'epic' (the only provider that
-- existed prior to today) so we can safely add the CHECK.
update public.ehr_connections
set provider = 'epic'
where provider is null;

-- Add the CHECK constraint. We allow the 5 vendors we currently know about
-- plus a generic 'other' escape hatch so a future small integration doesn't
-- need a migration just to test.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'ehr_connections_provider_check'
  ) then
    alter table public.ehr_connections
      add constraint ehr_connections_provider_check
      check (provider in ('epic','cerner','va','oneup','terra','other'));
  end if;
end $$;

-- Index for the common "find this user's VA connection" query path.
create index if not exists idx_ehr_connections_provider
  on public.ehr_connections (provider, person_id)
  where status = 'connected';

comment on column public.ehr_connections.provider is
  'EHR vendor for this connection. One of: epic, cerner, va, oneup, terra, other.';
