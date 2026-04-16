create table if not exists public.medication_reminders (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  medication_id uuid not null references public.medications(id) on delete cascade,
  reminder_times jsonb not null default '[]'::jsonb,
  active boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_med_reminders_user on public.medication_reminders (user_id);
create index if not exists idx_med_reminders_med on public.medication_reminders (medication_id);

alter table public.medication_reminders enable row level security;

create policy "Users can create own reminders" on public.medication_reminders for insert to authenticated with check (auth.uid() = user_id);
create policy "Users can view own reminders" on public.medication_reminders for select to authenticated using (auth.uid() = user_id);
create policy "Users can update own reminders" on public.medication_reminders for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "Users can delete own reminders" on public.medication_reminders for delete to authenticated using (auth.uid() = user_id);
