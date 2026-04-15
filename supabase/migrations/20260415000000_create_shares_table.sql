-- Care Circle Sharing: shareable health summary snapshots
-- Tokens expire after 7 days. Public read via token, insert requires auth.

create table if not exists public.shares (
  id uuid default gen_random_uuid() primary key,
  token text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  person_id uuid not null references public.people(id) on delete cascade,
  person_name text not null,
  summary_text text,
  recent_events jsonb default '[]'::jsonb,
  medications jsonb default '[]'::jsonb,
  appointments jsonb default '[]'::jsonb,
  include_notes boolean default false,
  include_meds boolean default true,
  expires_at timestamptz not null default (now() + interval '7 days'),
  created_at timestamptz default now()
);

-- Index for fast token lookups on the public share page
create index idx_shares_token on public.shares (token);

-- Index for listing a user's shares
create index idx_shares_user_id on public.shares (user_id);

-- RLS policies
alter table public.shares enable row level security;

-- Authenticated users can insert shares for their own data
create policy "Users can create shares"
  on public.shares for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Authenticated users can view their own shares
create policy "Users can view own shares"
  on public.shares for select
  to authenticated
  using (auth.uid() = user_id);

-- Anyone (including anon) can read a share by token if not expired
create policy "Public can read shares by token"
  on public.shares for select
  to anon
  using (expires_at > now());

-- Track share view events for traction metrics
create table if not exists public.share_events (
  id uuid default gen_random_uuid() primary key,
  share_id uuid not null references public.shares(id) on delete cascade,
  event_type text not null default 'view',
  viewer_ip text,
  created_at timestamptz default now()
);

alter table public.share_events enable row level security;

-- Anyone can insert view events (anon visitors on the share page)
create policy "Anyone can log share views"
  on public.share_events for insert
  to anon
  with check (true);

-- Authenticated users can insert share events too
create policy "Auth users can log share events"
  on public.share_events for insert
  to authenticated
  with check (true);

-- Share creators can view events on their shares
create policy "Users can view own share events"
  on public.share_events for select
  to authenticated
  using (
    share_id in (select id from public.shares where user_id = auth.uid())
  );
