-- ============================================================================
-- Wellet · Me-branch setup migration
-- File: supabase/migrations/20260505_me_branch_setup.sql
-- Author: Betsy (drafted Mon 2026-05-04 PM, applied Tue 2026-05-05 AM)
--
-- WHAT THIS DOES
-- 1. Adds `is_self` to public.people (boolean, default false).
--    Enforces "at most one self-row per user" via a partial unique index.
-- 2. Creates public.profiles, keyed to auth.users(id) via 1:1 FK.
--    Adds `app_mode` text column with CHECK ('me' | 'caregiver') and a row
--    per existing auth user.
-- 3. Backfills app_mode='caregiver' for any user who already has at least
--    one active person row, so existing accounts skip the first-run gate.
-- 4. Adds RLS policies on profiles so each user only sees their own row.
--
-- VERIFIED BASELINE (queried 2026-05-04 6:11 PM EDT):
--   auth.users           = 1 (Betsy)
--   people               = 1 (Mom / Cheryl Roberts Harris)
--   relationship='self'  = 0
--   profiles             = does not exist
-- This means the migration is effectively a fresh install.
--
-- HOW TO APPLY
-- Option A (recommended): Supabase dashboard → SQL Editor → paste this whole
--   file → Run. Wrapped in a single transaction; it either all applies or
--   none of it does.
-- Option B: psql against the project connection string.
--
-- ROLLBACK
-- See the inverse statements at the bottom of this file (commented out).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. people.is_self
-- ----------------------------------------------------------------------------

ALTER TABLE public.people
  ADD COLUMN IF NOT EXISTS is_self BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.people.is_self IS
  'True when this person row represents the authenticated user themselves '
  '(Me-mode self-person). False for loved ones / family members. '
  'Enforced one-per-user via the people_one_self_per_user partial index.';

-- Partial unique index: at most one self-row per user_id.
-- Excludes rows where user_id IS NULL because people.user_id is nullable
-- (legacy demo / orphan rows). Including those would let a single null-row
-- block all real users.
CREATE UNIQUE INDEX IF NOT EXISTS people_one_self_per_user
  ON public.people (user_id)
  WHERE is_self = true AND user_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. profiles table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  app_mode    TEXT CHECK (app_mode IN ('me', 'caregiver')) DEFAULT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.profiles            IS 'Per-auth-user app-level settings. 1:1 with auth.users.';
COMMENT ON COLUMN public.profiles.app_mode   IS 'Wellet app mode: ''me'' (self-use) | ''caregiver'' (someone I care for) | NULL (first-run gate not yet answered).';

-- Auto-update updated_at on row change.
CREATE OR REPLACE FUNCTION public.profiles_set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
CREATE TRIGGER profiles_set_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.profiles_set_updated_at();

-- Auto-create a profiles row whenever a new auth.users row appears, so the
-- client never has to upsert. The mode stays NULL until first-run answers.
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO public.profiles (id) VALUES (NEW.id)
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- ----------------------------------------------------------------------------
-- 3. Backfill: existing users get a profiles row
--    Users who already have an active person row → 'caregiver'.
--    Users with no people rows yet (or only archived) → leave NULL so they
--    hit the first-run gate the next time they sign in.
-- ----------------------------------------------------------------------------

INSERT INTO public.profiles (id, app_mode)
SELECT
  u.id,
  CASE
    WHEN EXISTS (
      SELECT 1 FROM public.people p
      WHERE p.user_id = u.id
        AND p.care_status = 'active'
    ) THEN 'caregiver'
    ELSE NULL
  END
FROM auth.users u
ON CONFLICT (id) DO UPDATE
  SET app_mode = COALESCE(public.profiles.app_mode, EXCLUDED.app_mode);

-- ----------------------------------------------------------------------------
-- 4. RLS on profiles — each user sees and edits only their own row
-- ----------------------------------------------------------------------------

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "profiles: read own" ON public.profiles;
CREATE POLICY "profiles: read own"
  ON public.profiles
  FOR SELECT
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "profiles: update own" ON public.profiles;
CREATE POLICY "profiles: update own"
  ON public.profiles
  FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- Inserts happen exclusively via the auth-user trigger (SECURITY DEFINER),
-- so we deliberately do NOT add a client-facing INSERT policy. If a future
-- client codepath needs to upsert a profile directly, add a policy here:
--   CREATE POLICY "profiles: insert own" ON public.profiles
--     FOR INSERT WITH CHECK (auth.uid() = id);

COMMIT;

-- ============================================================================
-- POST-APPLY SANITY CHECKS (run these manually after the migration)
-- ============================================================================
--
-- -- Should return 1 row: Betsy with app_mode='caregiver'
-- SELECT u.email, p.app_mode
-- FROM auth.users u
-- LEFT JOIN public.profiles p ON p.id = u.id;
--
-- -- Should return 1 row: Mom, is_self=false
-- SELECT name, is_self FROM public.people;
--
-- -- Index should exist
-- SELECT indexname FROM pg_indexes
-- WHERE schemaname = 'public' AND indexname = 'people_one_self_per_user';
--
-- -- Constraint should reject a second self-row for the same user
-- -- (this is a *test*, run against a throwaway user_id — do NOT run on prod):
-- -- INSERT INTO public.people (user_id, name, is_self) VALUES ('<uid>', 'A', true);
-- -- INSERT INTO public.people (user_id, name, is_self) VALUES ('<uid>', 'B', true);
-- -- The second insert should fail with: "duplicate key value violates unique
-- -- constraint people_one_self_per_user".

-- ============================================================================
-- ROLLBACK (uncomment and run as a single block if you need to undo)
-- ============================================================================
--
-- BEGIN;
-- DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
-- DROP FUNCTION IF EXISTS public.handle_new_auth_user();
-- DROP TRIGGER IF EXISTS profiles_set_updated_at ON public.profiles;
-- DROP FUNCTION IF EXISTS public.profiles_set_updated_at();
-- DROP TABLE IF EXISTS public.profiles;
-- DROP INDEX IF EXISTS public.people_one_self_per_user;
-- ALTER TABLE public.people DROP COLUMN IF EXISTS is_self;
-- COMMIT;
