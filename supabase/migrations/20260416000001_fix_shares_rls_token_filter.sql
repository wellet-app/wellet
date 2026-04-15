-- ============================================================================
-- SECURITY FIX: Shares table RLS — restrict anon SELECT to token-gated RPC
-- Run this BEFORE merging PR #29 to main (share.html calls this function)
-- ============================================================================
--
-- PROBLEM: The anon SELECT policy "Public can read shares by token" allows any
-- unauthenticated caller to read ALL non-expired share rows — patient names,
-- medications, appointments — without providing a token value.
--
-- FIX: Replace direct table access with a security-definer RPC function that
-- requires the caller to supply the exact token. Revoke direct anon SELECT.
-- ============================================================================

begin;

-- 1. Drop the overly permissive anon SELECT policy
drop policy if exists "Public can read shares by token" on public.shares;

-- 2. Create a secure lookup function
--    - security definer: runs as the function owner (postgres), bypasses RLS
--    - set search_path: prevents search_path injection
--    - returns at most 1 row matching the exact token and checks expiration
create or replace function public.get_share_by_token(share_token text)
returns setof public.shares
language sql
security definer
set search_path = public
stable  -- result depends only on DB state, safe to cache within a transaction
as $$
  select * from public.shares
  where token = share_token
    and expires_at > now()
  limit 1;
$$;

-- 3. Grant execute to both anon and authenticated roles
grant execute on function public.get_share_by_token(text) to anon;
grant execute on function public.get_share_by_token(text) to authenticated;

-- 4. Revoke direct anon SELECT on the shares table
--    Authenticated users keep their "Users can view own shares" policy.
--    The security-definer function bypasses RLS entirely, so anon callers
--    can still read shares — but ONLY through the RPC with a valid token.
revoke select on public.shares from anon;

commit;

-- ============================================================================
-- ROLLBACK (if needed):
--
--   begin;
--   drop function if exists public.get_share_by_token(text);
--   grant select on public.shares to anon;
--   create policy "Public can read shares by token"
--     on public.shares for select
--     to anon
--     using (expires_at > now());
--   commit;
-- ============================================================================
