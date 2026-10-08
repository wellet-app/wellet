alter table public.notification_preferences add column if not exists away_note boolean not null default false, add column if not exists last_away_note_sent_at timestamptz;
