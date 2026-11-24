-- The person sharing Apple Health decides whether Ask Wellet may read what
-- they share. Null means not allowed (the default). Set and cleared only by
-- data-source-invite action set_ai_allowed, for the sharer's own link.
alter table public.person_data_links
  add column if not exists ai_allowed_at timestamptz;

comment on column public.person_data_links.ai_allowed_at is
  'When the sharer allowed Ask Wellet to read what they share. Null = not allowed.';
