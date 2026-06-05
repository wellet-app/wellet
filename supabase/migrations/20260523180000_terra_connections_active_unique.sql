-- 2026-05-23: prevent duplicate active Terra connections per (user, person, provider).
--
-- Bug: terra-auth/store upserts with onConflict='terra_user_id', but Terra mints a
-- brand-new terra_user_id for every widget session. So a user who taps "Connect
-- Google Health" twice ends up with two active rows instead of one updated row.
-- Real-world impact discovered today: one user had 4 active GOOGLE rows for
-- themselves; only the first was actually receiving data.
--
-- Fix: partial unique index scoped to status='active'. Disconnected rows are
-- preserved as audit history (we don't want to lose the trail), but at most one
-- active row can exist per (user_id, person_id, provider) tuple.
--
-- Pre-check before applying: existing duplicate active rows have been cleaned up.
-- This migration will fail loudly if duplicates remain — that's intentional.

create unique index if not exists terra_connections_active_unique
  on public.terra_connections (user_id, person_id, provider)
  where status = 'active';
