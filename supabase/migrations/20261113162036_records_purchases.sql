-- One Apple consumable purchase (com.getwellet.ios.records.person) per loved one.
-- Written only by verify-records-purchase with the service role. No health information.
create table public.records_purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  product_id text not null,
  original_transaction_id text not null unique,
  environment text not null check (environment in ('Production','Sandbox')),
  price_cents integer,
  currency text,
  purchased_at timestamptz not null,
  refunded_at timestamptz,
  created_at timestamptz not null default now()
);
comment on table public.records_purchases is 'One Apple consumable purchase (com.getwellet.ios.records.person) per loved one. Written only by verify-records-purchase with the service role. Holds no health information.';
create unique index records_purchases_one_per_person on public.records_purchases(person_id) where refunded_at is null;
create index records_purchases_user_id_idx on public.records_purchases(user_id);
alter table public.records_purchases enable row level security;
create policy "Users see own purchases" on public.records_purchases for select using (user_id = (select auth.uid()));
revoke insert, update, delete on public.records_purchases from anon, authenticated;
