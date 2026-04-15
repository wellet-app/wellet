-- Waitlist Requests: captures emails from users who aren't on the alpha allowlist
-- but want to be notified when access opens up.

create table if not exists public.waitlist_requests (
  id uuid default gen_random_uuid() primary key,
  email text not null unique,
  requested_at timestamptz not null default now(),
  status text not null default 'pending',
  notes text
);

-- Lowercase email trigger
create or replace function public.waitlist_requests_lower_email()
returns trigger as $$
begin
  new.email := lower(new.email);
  return new;
end;
$$ language plpgsql;

create trigger trg_waitlist_requests_lower_email
  before insert or update on public.waitlist_requests
  for each row execute function public.waitlist_requests_lower_email();

-- Index
create index idx_waitlist_requests_email on public.waitlist_requests (email);

-- RLS
alter table public.waitlist_requests enable row level security;

-- anon can insert (submit a request) and select own row for duplicate checking
create policy "Anyone can submit a waitlist request"
  on public.waitlist_requests for insert
  to anon, authenticated
  with check (true);

create policy "Anyone can check waitlist requests"
  on public.waitlist_requests for select
  to anon, authenticated
  using (true);

-- Only service_role can update/delete
