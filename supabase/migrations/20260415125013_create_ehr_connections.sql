create table if not exists public.ehr_connections (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  oneup_user_id text,
  access_token text,
  refresh_token text,
  token_expires_at timestamptz,
  connected_provider text,
  connected_at timestamptz default now(),
  last_synced_at timestamptz,
  created_at timestamptz default now()
);

create unique index idx_ehr_connections_person on public.ehr_connections (person_id);
create index idx_ehr_connections_user on public.ehr_connections (user_id);

alter table public.ehr_connections enable row level security;

create policy "Users can view own EHR connections" on public.ehr_connections for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own EHR connections" on public.ehr_connections for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own EHR connections" on public.ehr_connections for update to authenticated using (auth.uid() = user_id);
create policy "Users can delete own EHR connections" on public.ehr_connections for delete to authenticated using (auth.uid() = user_id);
