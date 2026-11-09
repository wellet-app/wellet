-- person_data_links: a loved one shares their own Apple Health with a
-- caregiver's record for them.
--
-- Flow (plan: loved-one invite link, 2026-11-09):
--   1. Caregiver creates a data_source_invites row (channel 'messages').
--   2. Loved one opens the link, signs in, and data-source-invite
--      consume_self inserts a person_data_links row.
--   3. wellet-health-ingest v13 accepts person_id only when an active link
--      exists for (person_id, caller, 'apple_health'); rows carry link_id.
--   4. Either side ends the share with revoke_person_data_link(link_id).
--      Rows from that link are archived (archived_at set), not deleted.
--      Archived rows are hidden from the app, the observation_series view
--      and CareSignals.
--
-- Writes happen only through service-role edge functions and the revoke
-- function below. Clients can read links they are part of.

-- 1. Link table --------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.person_data_links (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  sharer_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('apple_health')),
  invite_id       uuid REFERENCES public.data_source_invites(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

-- One active link per person, sharer and source. Revoked links stay as
-- history; a new invite can create a fresh link after a revoke.
CREATE UNIQUE INDEX IF NOT EXISTS person_data_links_one_active
  ON public.person_data_links (person_id, sharer_user_id, source)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS person_data_links_sharer
  ON public.person_data_links (sharer_user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.person_data_links ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.person_data_links FROM anon;
REVOKE ALL ON public.person_data_links FROM authenticated;
GRANT SELECT ON public.person_data_links TO authenticated;

DROP POLICY IF EXISTS person_data_links_select_party ON public.person_data_links;
CREATE POLICY person_data_links_select_party
  ON public.person_data_links
  FOR SELECT
  TO authenticated
  USING (
    sharer_user_id = auth.uid()
    OR person_id IN (SELECT p.id FROM public.people p WHERE p.user_id = auth.uid())
  );

-- 2. wearable_observations: link and archive columns -------------------------

ALTER TABLE public.wearable_observations
  ADD COLUMN IF NOT EXISTS link_id uuid
    REFERENCES public.person_data_links(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS archived_at timestamptz;

CREATE INDEX IF NOT EXISTS wearable_observations_link_id
  ON public.wearable_observations (link_id)
  WHERE link_id IS NOT NULL;

-- Read policy: same owner rule as before, minus archived rows.
DROP POLICY IF EXISTS wearable_observations_select_own ON public.wearable_observations;
CREATE POLICY wearable_observations_select_own
  ON public.wearable_observations
  FOR SELECT
  USING (
    person_id IN (SELECT people.id FROM public.people WHERE people.user_id = auth.uid())
    AND archived_at IS NULL
  );

-- 3. observation_series view: hide archived wearable rows --------------------
-- The view is security_invoker, so client reads already follow the policy
-- above. Service-role readers bypass RLS, so the view filters too.
-- Rewrites only the wearable branch WHERE clause of the live definition and
-- fails loudly if that clause is not found exactly once.

DO $$
DECLARE
  def text := pg_get_viewdef('public.observation_series'::regclass, true);
  old_clause text := 'FROM wearable_observations w' || chr(10) || '  WHERE COALESCE(w.start_at, w.end_at) IS NOT NULL';
  new_clause text := 'FROM wearable_observations w' || chr(10) || '  WHERE COALESCE(w.start_at, w.end_at) IS NOT NULL AND w.archived_at IS NULL';
BEGIN
  IF def LIKE '%w.archived_at IS NULL%' THEN
    RETURN;
  END IF;
  IF (length(def) - length(replace(def, old_clause, ''))) / length(old_clause) <> 1 THEN
    RAISE EXCEPTION 'observation_series: wearable WHERE clause not found exactly once';
  END IF;
  EXECUTE 'CREATE OR REPLACE VIEW public.observation_series WITH (security_invoker = true) AS '
    || replace(def, old_clause, new_clause);
END
$$;

-- 4. Revoke: either side ends the share --------------------------------------

CREATE OR REPLACE FUNCTION public.revoke_person_data_link(p_link_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_link public.person_data_links%ROWTYPE;
  v_archived integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'auth required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_link FROM public.person_data_links WHERE id = p_link_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'link not found' USING ERRCODE = 'P0002';
  END IF;

  IF v_link.sharer_user_id <> v_uid
     AND NOT EXISTS (SELECT 1 FROM public.people p WHERE p.id = v_link.person_id AND p.user_id = v_uid) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF v_link.revoked_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'already_revoked', true, 'archived', 0);
  END IF;

  UPDATE public.person_data_links
     SET revoked_at = now(), revoked_by = v_uid
   WHERE id = p_link_id;

  UPDATE public.wearable_observations
     SET archived_at = now()
   WHERE link_id = p_link_id AND archived_at IS NULL;
  GET DIAGNOSTICS v_archived = ROW_COUNT;

  RETURN jsonb_build_object('ok', true, 'already_revoked', false, 'archived', v_archived);
END
$$;

REVOKE ALL ON FUNCTION public.revoke_person_data_link(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.revoke_person_data_link(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.revoke_person_data_link(uuid) TO authenticated;

-- 5. data_source_invites: allow the 'messages' channel ----------------------
-- The caregiver's iPhone sends the link from their own Messages app.
-- Rows store target_contact = 'via-messages' (placeholder, like 'approval').

ALTER TABLE public.data_source_invites
  DROP CONSTRAINT IF EXISTS data_source_invites_channel_check;
ALTER TABLE public.data_source_invites
  ADD CONSTRAINT data_source_invites_channel_check
  CHECK (channel = ANY (ARRAY['sms'::text, 'email'::text, 'approval'::text, 'messages'::text]));

-- 6. Lifecycle: if a link row is deleted (for example the sharer deletes
-- their Wellet account, which cascades here), archive its rows first so
-- shared data never becomes visible again without a link.

CREATE OR REPLACE FUNCTION public.person_data_links_archive_on_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE public.wearable_observations
     SET archived_at = COALESCE(archived_at, now())
   WHERE link_id = OLD.id;
  RETURN OLD;
END
$$;

REVOKE ALL ON FUNCTION public.person_data_links_archive_on_delete() FROM PUBLIC;

DROP TRIGGER IF EXISTS person_data_links_archive_on_delete ON public.person_data_links;
CREATE TRIGGER person_data_links_archive_on_delete
  BEFORE DELETE ON public.person_data_links
  FOR EACH ROW EXECUTE FUNCTION public.person_data_links_archive_on_delete();

-- Rollback (manual, in this order):
--   DROP TRIGGER person_data_links_archive_on_delete ON public.person_data_links;
--   DROP FUNCTION public.person_data_links_archive_on_delete();
--   DROP FUNCTION public.revoke_person_data_link(uuid);
--   Re-run the observation_series definition from 20260514_observation_series_view_v1.sql
--     (or replace ' AND w.archived_at IS NULL' out of pg_get_viewdef).
--   Recreate wearable_observations_select_own without the archived_at clause.
--   ALTER TABLE public.wearable_observations DROP COLUMN link_id, DROP COLUMN archived_at;
--   DROP TABLE public.person_data_links;
--   Restore data_source_invites_channel_check to ('sms','email','approval')
--     after confirming no 'messages' rows exist.
