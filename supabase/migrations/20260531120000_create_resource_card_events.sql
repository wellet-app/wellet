-- Caregiver-pay resource cards: per-tap telemetry so we can measure which
-- programs surface most often, which CTAs get tapped, and which clinics
-- families ask about. Insert-only from authenticated clients.

create table if not exists public.resource_card_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  care_recipient_id uuid references public.people(id) on delete set null,
  card_id text not null,
  event_type text not null check (event_type in ('view', 'cta_tap')),
  cta text,
  created_at timestamptz not null default now()
);

create index if not exists resource_card_events_card_id_idx
  on public.resource_card_events (card_id, created_at desc);
create index if not exists resource_card_events_user_idx
  on public.resource_card_events (user_id, created_at desc);

alter table public.resource_card_events enable row level security;

drop policy if exists "resource_card_events insert own" on public.resource_card_events;
create policy "resource_card_events insert own" on public.resource_card_events
  for insert to authenticated
  with check (auth.uid() = user_id or user_id is null);

drop policy if exists "resource_card_events read own" on public.resource_card_events;
create policy "resource_card_events read own" on public.resource_card_events
  for select to authenticated
  using (auth.uid() = user_id);

comment on table public.resource_card_events is
  'Tap telemetry for the caregiver-pay Resources cards. Best-effort writes from the client; failures are swallowed by design so a flaky table never blocks a Resources tab render.';
