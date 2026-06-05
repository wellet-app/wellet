-- 20260602120000_create_user_passkeys.sql
-- Face ID / WebAuthn passkey support for mywellet.com web app.
--
-- Two tables:
--   user_passkeys       — long-lived registered credentials per user
--   passkey_challenges  — short-lived (5 min) challenges for register & auth flows
--
-- All writes happen via the `verify-passkey` edge function using the service
-- role. Users can read & delete their own passkeys directly for the Settings
-- "Sign-in" UI; no other direct access is allowed.

-- =========================================================================
-- user_passkeys
-- =========================================================================
create table if not exists public.user_passkeys (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  credential_id   text not null unique,          -- base64url
  public_key      text not null,                 -- base64url COSE public key
  sign_count      bigint not null default 0,
  transports      text[] not null default '{}',  -- e.g. ['internal','hybrid']
  aaguid          text,                          -- authenticator model id
  device_label    text,                          -- user-editable e.g. "iPhone"
  user_agent      text,                          -- captured at registration
  created_at      timestamptz not null default now(),
  last_used_at    timestamptz
);

create index if not exists user_passkeys_user_id_idx
  on public.user_passkeys(user_id);

alter table public.user_passkeys enable row level security;

-- Users may list their own passkeys (Settings → Sign-in)
drop policy if exists "passkeys_own_select" on public.user_passkeys;
create policy "passkeys_own_select" on public.user_passkeys
  for select using (auth.uid() = user_id);

-- Users may remove their own passkeys (Settings → Remove)
drop policy if exists "passkeys_own_delete" on public.user_passkeys;
create policy "passkeys_own_delete" on public.user_passkeys
  for delete using (auth.uid() = user_id);

-- No insert/update policy on purpose: only the verify-passkey edge function
-- (service role) writes here.

-- =========================================================================
-- passkey_challenges
-- =========================================================================
-- Short-lived challenges for both register and auth flows. Single-use:
-- the verify-passkey edge function deletes the row immediately after a
-- successful verification.
--
-- For register-* the user_id is set (we know the caller from their JWT).
-- For auth-* the user_id is null until the assertion identifies the user
-- via the credential's user_handle.
create table if not exists public.passkey_challenges (
  challenge   text primary key,                 -- base64url
  user_id     uuid references auth.users(id) on delete cascade,
  purpose     text not null check (purpose in ('register','auth')),
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null default (now() + interval '5 minutes')
);

create index if not exists passkey_challenges_expires_idx
  on public.passkey_challenges(expires_at);

alter table public.passkey_challenges enable row level security;
-- No policies = no direct user access. Only service role from the edge
-- function can read / write.

-- =========================================================================
-- Janitor: purge expired challenges
-- =========================================================================
-- Called by the verify-passkey edge function at the top of every request,
-- but exposed here so pg_cron or a future cleanup job can also call it.
create or replace function public.purge_expired_passkey_challenges()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  n integer;
begin
  delete from public.passkey_challenges
  where expires_at < now();
  get diagnostics n = row_count;
  return n;
end;
$$;
