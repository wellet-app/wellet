-- Captures reports from users who couldn't connect their health system.
-- Fuels manual triage + prioritization of new Epic/Cerner/Athena endpoints.

create table if not exists public.hospital_connect_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,

  -- What the user told us
  hospital_name text not null,
  city text,
  state text,
  issue_type text not null check (issue_type in (
    'not_found',              -- couldn't find hospital in picker
    'unsupported_version',    -- our DSTU2 guard tripped
    'oauth_error',            -- login flow failed
    'connected_no_data',      -- auth ok but fetch-ehr-data returned nothing
    'other'
  )),
  notes text,
  contact_email text,

  -- Technical breadcrumbs (optional — for debugging)
  fhir_base_url text,
  error_code text,
  error_message text,
  user_agent text,

  -- Workflow
  status text not null default 'new' check (status in ('new','triaged','in_progress','resolved','rejected')),
  triage_notes text,
  resolved_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_hcr_user_id on public.hospital_connect_requests(user_id);
create index if not exists idx_hcr_status on public.hospital_connect_requests(status);
create index if not exists idx_hcr_created on public.hospital_connect_requests(created_at desc);

-- Keep updated_at fresh
create or replace function public.hcr_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_hcr_touch on public.hospital_connect_requests;
create trigger trg_hcr_touch before update on public.hospital_connect_requests
  for each row execute function public.hcr_touch_updated_at();

-- RLS: users can insert + read their own; service role has full access (for admin triage)
alter table public.hospital_connect_requests enable row level security;

drop policy if exists hcr_insert_own on public.hospital_connect_requests;
create policy hcr_insert_own on public.hospital_connect_requests
  for insert to authenticated
  with check (user_id = auth.uid() or user_id is null);

drop policy if exists hcr_select_own on public.hospital_connect_requests;
create policy hcr_select_own on public.hospital_connect_requests
  for select to authenticated
  using (user_id = auth.uid());

-- No update/delete for authenticated users — triage happens via service role.
