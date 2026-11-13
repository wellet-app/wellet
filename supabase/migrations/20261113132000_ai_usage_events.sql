-- Token counts per AI call, for cost and fair-use limits. Counts only.
create table if not exists public.ai_usage_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  user_id uuid references auth.users(id) on delete set null,
  person_id uuid references public.people(id) on delete set null,
  feature text not null,
  vendor text,
  model text,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  est_cost_usd numeric(10,6) not null default 0
);
comment on table public.ai_usage_events is 'Token counts per AI call, for cost and fair-use limits. Counts only, never prompt or answer text.';
create index if not exists ai_usage_events_user_created on public.ai_usage_events (user_id, created_at desc);
create index if not exists ai_usage_events_created on public.ai_usage_events (created_at desc);
alter table public.ai_usage_events enable row level security;
revoke all on public.ai_usage_events from anon, authenticated;
