-- Reimbursements (mywellet) PR 1 — freshness triggers
--
-- Flip reimbursement_assessments.needs_refresh = TRUE for a loved one when
-- their situation changes in a way that could change which programs apply:
--   - a new EHR connection is added (new hospital_system / chart)
--   - their chart conditions or insurance change (people.conditions /
--     people.insurance_info)
--
-- The on-render UI also treats stale_at < now() as needs_refresh, so the
-- 90-day case is handled client-side and does not need a trigger.
--
-- See: wellet_reimbursements_mywellet_spec.md (Freshness rules).

-- Mark every assessment for a loved one stale. SECURITY DEFINER so the
-- trigger can update the row regardless of the acting user's RLS context;
-- it only ever flips a boolean, never reads PHI.
CREATE OR REPLACE FUNCTION public.mark_reimbursements_stale(p_person_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE public.reimbursement_assessments
     SET needs_refresh = TRUE,
         updated_at    = NOW()
   WHERE person_id = p_person_id
     AND needs_refresh = FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

-- ── ehr_connections INSERT ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reimbursements_on_ehr_connection()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM public.mark_reimbursements_stale(NEW.person_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS reimbursements_ehr_connection_added ON public.ehr_connections;
CREATE TRIGGER reimbursements_ehr_connection_added
  AFTER INSERT ON public.ehr_connections
  FOR EACH ROW
  EXECUTE FUNCTION public.reimbursements_on_ehr_connection();

-- ── people UPDATE (conditions or insurance_info changed) ────────────
CREATE OR REPLACE FUNCTION public.reimbursements_on_person_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.conditions IS DISTINCT FROM OLD.conditions
     OR NEW.insurance_info IS DISTINCT FROM OLD.insurance_info THEN
    PERFORM public.mark_reimbursements_stale(NEW.id);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public;

DROP TRIGGER IF EXISTS reimbursements_person_situation_changed ON public.people;
CREATE TRIGGER reimbursements_person_situation_changed
  AFTER UPDATE OF conditions, insurance_info ON public.people
  FOR EACH ROW
  EXECUTE FUNCTION public.reimbursements_on_person_update();
