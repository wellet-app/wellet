-- Drop the overly permissive anon SELECT policy
drop policy if exists "Public can read shares by token" on public.shares;

-- Create a secure lookup function
create or replace function public.get_share_by_token(share_token text)
returns setof public.shares
language sql
security definer
set search_path = public
stable
as $$
  select * from public.shares
  where token = share_token
    and expires_at > now()
  limit 1;
$$;

-- Grant execute to both roles
grant execute on function public.get_share_by_token(text) to anon;
grant execute on function public.get_share_by_token(text) to authenticated;

-- Revoke direct anon SELECT on shares table
revoke select on public.shares from anon;
