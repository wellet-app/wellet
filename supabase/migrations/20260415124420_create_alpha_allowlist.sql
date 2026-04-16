create table if not exists public.alpha_allowlist (
  id uuid default gen_random_uuid() primary key,
  email text not null unique,
  invited_at timestamptz not null default now(),
  accepted_at timestamptz,
  notes text
);

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

create index idx_alpha_allowlist_email on public.alpha_allowlist (email);

alter table public.alpha_allowlist enable row level security;

create policy "Anyone can check allowlist"
  on public.alpha_allowlist for select
  to anon, authenticated
  using (true);

insert into public.alpha_allowlist (email, notes)
values ('betsy.eble@gmail.com', 'Founder — first alpha user')
on conflict (email) do nothing;
