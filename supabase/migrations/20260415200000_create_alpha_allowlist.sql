-- Alpha Allowlist: gates access during private alpha.
-- Only emails present in this table can sign in via magic link.
-- anon can SELECT (to check membership); only service_role can mutate.

create table if not exists public.alpha_allowlist (
  id uuid default gen_random_uuid() primary key,
  email text not null unique,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  notes text
);

-- Ensure emails are always stored lowercase
create or replace function public.alpha_allowlist_lower_email()
returns trigger as $$
begin
  new.email := lower(new.email);
  return new;
end;
$$ language plpgsql;

create trigger trg_alpha_allowlist_lower_email
  before insert or update on public.alpha_allowlist
  for each row execute function public.alpha_allowlist_lower_email();

-- Index for fast email lookups
create index idx_alpha_allowlist_email on public.alpha_allowlist (email);

-- RLS
alter table public.alpha_allowlist enable row level security;

-- anon + authenticated can check if an email is on the list
create policy "Anyone can check allowlist"
  on public.alpha_allowlist for select
  to anon, authenticated
  using (true);

-- No insert/update/delete for anon or authenticated — only service_role bypasses RLS

-- Seed: first alpha user
insert into public.alpha_allowlist (email, notes)
values ('betsy.eble@gmail.com', 'Founder — first alpha user')
on conflict (email) do nothing;
