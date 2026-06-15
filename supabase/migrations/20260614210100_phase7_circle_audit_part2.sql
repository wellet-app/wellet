-- =============================================================================
-- Phase 7 — Migration 2: Circle audit tables
-- =============================================================================
-- Adds:
--   1. circle_action_audit  — append-only log of every mutation by any circle member
--   2. circle_read_audit    — append-only log of who opened / read which surface
--
-- Retention: forever (per Betsy 2026-06-14 decision).
-- Both tables are append-only by design — no UPDATE/DELETE policies.
-- Visibility: anyone in the relevant care circle can SELECT their loved one's audit rows.
-- Writes: any authenticated user in the care circle may INSERT for that person.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. circle_action_audit
-- -----------------------------------------------------------------------------
-- One row per mutation on a clinical table inside a care circle.
-- Captures: who did it, what they did, which row, which table, when.
-- Used by:
--   - Activity tab "Actions" sub-tab
--   - Attribution UI ("Logged by Sarah · 7:32 AM")
--   - Forensic review if something looks wrong
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.circle_action_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  actor_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  action          text NOT NULL CHECK (action IN ('insert','update','delete')),
  table_name      text NOT NULL,
  row_id          uuid,
  -- Optional human-readable summary for the Activity feed
  -- e.g. "Logged Metformin 500mg at 7:32 AM"
  summary         text,
  -- Optional structured payload — old/new diff or extra context.
  -- Kept as jsonb so we can evolve without schema churn.
  payload         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_circle_action_audit_person_created
  ON public.circle_action_audit (person_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_circle_action_audit_actor_created
  ON public.circle_action_audit (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_circle_action_audit_table_row
  ON public.circle_action_audit (table_name, row_id);

ALTER TABLE public.circle_action_audit ENABLE ROW LEVEL SECURITY;

-- Anyone in the circle can read the loved one's action history.
DROP POLICY IF EXISTS circle_action_audit_select ON public.circle_action_audit;
CREATE POLICY circle_action_audit_select
  ON public.circle_action_audit
  FOR SELECT
  TO authenticated
  USING (public.is_in_care_circle(person_id));

-- Anyone in the circle can INSERT, but only as themselves.
-- The client writes its own audit rows immediately after the mutation succeeds.
-- (We could trigger this server-side from each table, but explicit client writes
--  keep the summary string generation in product code where it belongs.)
DROP POLICY IF EXISTS circle_action_audit_insert ON public.circle_action_audit;
CREATE POLICY circle_action_audit_insert
  ON public.circle_action_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_in_care_circle(person_id)
    AND actor_user_id = auth.uid()
  );

-- No UPDATE policy. No DELETE policy. Append-only.

COMMENT ON TABLE public.circle_action_audit IS
  'Phase 7: append-only log of every mutation by any circle member. Retention: forever. No update/delete.';

-- -----------------------------------------------------------------------------
-- 2. circle_read_audit
-- -----------------------------------------------------------------------------
-- One row per "read event" — when someone in the circle opens a surface.
-- Surfaces tracked (initial set, more added as product grows):
--   - 'timeline'            — main timeline view
--   - 'medications'         — meds list
--   - 'medication_detail'   — drill-in to a specific med (target_id = medication.id)
--   - 'health_events'       — health events list
--   - 'documents'           — documents list
--   - 'document_detail'     — viewing a specific document (target_id = document.id)
--   - 'ask_wellet'          — Ask Wellet conversation pane
--   - 'trends'              — Trends scan results
--   - 'care_signals'        — CareSignals list
--   - 'activity_actions'    — Activity tab > Actions sub-tab
--   - 'activity_reads'      — Activity tab > Reads sub-tab
--   - 'reimbursements'      — Reimbursements list
--   - 'profile'             — loved one's profile/people row
--
-- Client throttles to one row per (actor, person, surface, target) per 5 minutes
-- to avoid noise from scroll/re-renders. Throttle is client-side; the table accepts
-- whatever the client sends.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.circle_read_audit (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES public.people(id) ON DELETE CASCADE,
  actor_user_id   uuid NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  surface         text NOT NULL,
  -- For surfaces that drill into a specific row (medication_detail, document_detail),
  -- target_id holds that row's id. NULL for list-style surfaces.
  target_id       uuid,
  -- Optional table_name for the target (e.g. 'medications', 'documents').
  target_table    text,
  -- Optional client-supplied context (device, platform version, etc.).
  context         jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_circle_read_audit_person_created
  ON public.circle_read_audit (person_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_circle_read_audit_actor_created
  ON public.circle_read_audit (actor_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_circle_read_audit_surface
  ON public.circle_read_audit (person_id, surface, created_at DESC);

ALTER TABLE public.circle_read_audit ENABLE ROW LEVEL SECURITY;

-- Anyone in the circle can read the loved one's read-audit.
DROP POLICY IF EXISTS circle_read_audit_select ON public.circle_read_audit;
CREATE POLICY circle_read_audit_select
  ON public.circle_read_audit
  FOR SELECT
  TO authenticated
  USING (public.is_in_care_circle(person_id));

-- Anyone in the circle can INSERT their own read events.
DROP POLICY IF EXISTS circle_read_audit_insert ON public.circle_read_audit;
CREATE POLICY circle_read_audit_insert
  ON public.circle_read_audit
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.is_in_care_circle(person_id)
    AND actor_user_id = auth.uid()
  );

-- No UPDATE policy. No DELETE policy. Append-only.

COMMENT ON TABLE public.circle_read_audit IS
  'Phase 7: append-only log of who opened which surface in the care circle. Retention: forever. Client throttles to one row per (actor, person, surface, target) per 5 minutes.';

-- =============================================================================
-- End Migration 2
-- =============================================================================
