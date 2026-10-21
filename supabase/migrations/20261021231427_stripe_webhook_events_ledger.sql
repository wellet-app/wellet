-- 2026-10-21: Stripe webhook event ledger (idempotency, I14).
-- Rollback: drop table if exists public.stripe_webhook_events;
create table if not exists public.stripe_webhook_events (
  event_id          text primary key,
  type              text not null,
  stripe_created_at timestamptz,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  status            text not null default 'processing'
                    check (status in ('processing', 'processed', 'failed')),
  outcome           text,
  error             text,
  attempts          integer not null default 1
);
comment on table public.stripe_webhook_events is
  'One row per Stripe event id, written by stripe-webhook before any subscription write. Service role only. No card or health data.';
create index if not exists stripe_webhook_events_status_idx
  on public.stripe_webhook_events (status, received_at);
alter table public.stripe_webhook_events enable row level security;
revoke all on public.stripe_webhook_events from anon, authenticated;
