-- ALLERGIES
create table if not exists public.allergies (
  id            uuid default gen_random_uuid() primary key,
  person_id     uuid not null references public.people(id) on delete cascade,
  substance     text not null,
  reaction      text,
  severity      text check (severity in ('mild', 'moderate', 'severe')),
  clinical_status text default 'active',
  onset_date    timestamptz,
  source        text not null default 'manual',
  source_code   text,
  source_system text,
  export_job_id uuid,
  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);
create index if not exists idx_allergies_person on public.allergies (person_id);
alter table public.allergies enable row level security;
create policy "Users can view own allergies" on public.allergies for select to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can insert own allergies" on public.allergies for insert to authenticated with check (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can update own allergies" on public.allergies for update to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can delete own allergies" on public.allergies for delete to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));

-- LAB RESULTS
create table if not exists public.lab_results (
  id              uuid default gen_random_uuid() primary key,
  person_id       uuid not null references public.people(id) on delete cascade,
  test_name       text not null,
  value           text,
  unit            text,
  reference_range text,
  status          text check (status in ('normal', 'abnormal', 'critical', 'unknown')),
  effective_date  timestamptz,
  loinc_code      text,
  category        text default 'laboratory',
  source          text not null default 'manual',
  source_file     text,
  export_job_id   uuid,
  created_at      timestamptz default now()
);
create index if not exists idx_lab_results_person on public.lab_results (person_id);
create index if not exists idx_lab_results_date on public.lab_results (effective_date desc);
alter table public.lab_results enable row level security;
create policy "Users can view own lab results" on public.lab_results for select to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can insert own lab results" on public.lab_results for insert to authenticated with check (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can update own lab results" on public.lab_results for update to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can delete own lab results" on public.lab_results for delete to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));

-- VITALS
create table if not exists public.vitals (
  id              uuid default gen_random_uuid() primary key,
  person_id       uuid not null references public.people(id) on delete cascade,
  vital_type      text not null,
  value           text not null,
  unit            text,
  effective_date  timestamptz,
  loinc_code      text,
  source          text not null default 'manual',
  source_file     text,
  export_job_id   uuid,
  created_at      timestamptz default now()
);
create index if not exists idx_vitals_person on public.vitals (person_id);
create index if not exists idx_vitals_date on public.vitals (effective_date desc);
alter table public.vitals enable row level security;
create policy "Users can view own vitals" on public.vitals for select to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can insert own vitals" on public.vitals for insert to authenticated with check (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can update own vitals" on public.vitals for update to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));
create policy "Users can delete own vitals" on public.vitals for delete to authenticated using (person_id in (select id from public.people where user_id = auth.uid()));

-- HEALTH EXPORT JOBS
create table if not exists public.health_export_jobs (
  id                uuid default gen_random_uuid() primary key,
  user_id           uuid not null references auth.users(id) on delete cascade,
  person_id         uuid not null references public.people(id) on delete cascade,
  file_path         text not null,
  file_size_bytes   bigint,
  source_system     text,
  status            text not null default 'pending' check (status in ('pending', 'processing', 'complete', 'partial', 'failed')),
  summary           jsonb default '{}'::jsonb,
  errors            jsonb default '[]'::jsonb,
  phase             int default 1,
  created_at        timestamptz default now(),
  completed_at      timestamptz
);
create index if not exists idx_export_jobs_person on public.health_export_jobs (person_id);
alter table public.health_export_jobs enable row level security;
create policy "Users can view own export jobs" on public.health_export_jobs for select to authenticated using (auth.uid() = user_id);
create policy "Users can insert own export jobs" on public.health_export_jobs for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can update own export jobs" on public.health_export_jobs for update to authenticated using (auth.uid() = user_id);

-- STORAGE BUCKET
insert into storage.buckets (id, name, public, file_size_limit) values ('documents', 'documents', false, 52428800) on conflict (id) do nothing;
