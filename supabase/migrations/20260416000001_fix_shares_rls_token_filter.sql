-- SECURITY FIX: Shares table RLS — restrict anon SELECT to token-filtered lookups
--
-- BEFORE: Any anonymous caller could read ALL non-expired shares (person names,
-- medications, appointments) without providing a token.
--
-- AFTER: Anonymous callers can only read a share row if they filter by a specific
-- token value in the query. The share.html page already does .eq('token', token),
-- so this is a no-op for legitimate use but blocks enumeration.

-- Drop the overly permissive policy
drop policy if exists "Public can read shares by token" on public.shares;

-- Recreate with proper token filter using RLS + security definer function
-- Since RLS can't inspect query params directly, we use a server-side function
-- that takes a token and returns the share if valid and non-expired.

-- Step 1: Create a secure lookup function (runs as service role, bypasses RLS)
create or replace function public.get_share_by_token(share_token text)
returns setof public.shares
language sql
security definer
set search_path = public
as $$
  select * from public.shares
  where token = share_token
    and expires_at > now()
  limit 1;
$$;

-- Step 2: Grant execute to anon role
grant execute on function public.get_share_by_token(text) to anon;

-- Step 3: Revoke direct anon SELECT on shares table entirely
-- (authenticated users still have their own SELECT policy)
revoke select on public.shares from anon;

-- Note: share.html must be updated to call this function via .rpc() instead
-- of querying the table directly. See the corresponding share.html change.
