-- Wellet · Phase 7 · Circle Actions · Part 1
-- ============================================================================
-- Goal: extend every caregiver-facing clinical table from "owner only" to
-- "owner OR accepted circle member." Mutate-your-own semantics for any row
-- a caregiver authors. EHR-pulled rows have no human author, which keeps
-- them client-immutable through normal paths (service-role EHR sync still
-- writes via service_role and bypasses RLS).
--
-- Decisions locked 2026-06-14:
--   - Anyone in the accepted circle can SELECT/INSERT.
--   - Only the row's author can UPDATE/DELETE (mutate-your-own).
--   - The `role` column on care_circle_members stays metadata only in v1.
--   - The owning user retains exclusive control over the `people` row itself
--     (profile fields, who is in the circle).
--
-- Tables touched (audited against prod 2026-06-14):
--   medications, medication_logs, medication_reminders,
--   health_events, lab_results, vitals, care_signals, documents,
--   allergies, update_me_summaries.
--
-- Part 1 is RLS + author columns. Audit + read-tracking tables ship in Part 2.
-- Realtime publication + reminder-firing infra ship in Part 3.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- A. Helper: a single source of truth for "is this user in the accepted
--    circle for this person, or owns the person row?" Used in every policy.
--    SECURITY DEFINER + STABLE so it can be inlined into RLS without
--    triggering RLS recursion on care_circle_members itself.
-- ---------------------------------------------------------------------------

create or replace function public.is_in_care_circle(p_person_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from public.people
      where people.id = p_person_id and people.user_id = auth.uid()
  ) or exists (
    select 1 from public.care_circle_members
      where care_circle_members.person_id = p_person_id
        and care_circle_members.user_id   = auth.uid()
        and care_circle_members.invite_status = 'accepted'
  );
$$;

grant execute on function public.is_in_care_circle(uuid) to authenticated;

comment on function public.is_in_care_circle(uuid) is
  'Phase 7: returns true if the calling user owns the person row or is an accepted care_circle_members entry for it. Used by every clinical-table RLS policy.';

-- ---------------------------------------------------------------------------
-- B. Add created_by_user_id to every caregiver-authorable clinical table.
--    EHR-pulled rows have NULL author; they remain client-immutable.
--    Backfill historical rows to the owning user so the primary keeps full
--    edit rights on their own legacy entries.
-- ---------------------------------------------------------------------------

alter table public.medications
  add column if not exists created_by_user_id uuid references auth.users(id);

update public.medications m
  set created_by_user_id = p.user_id
  from public.people p
  where m.person_id = p.id
    and m.created_by_user_id is null
    and m.source = 'manual';
-- EHR-sourced rows keep created_by_user_id = NULL → client cannot mutate.

alter table public.health_events
  add column if not exists created_by_user_id uuid references auth.users(id);

update public.health_events e
  set created_by_user_id = p.user_id
  from public.people p
  where e.person_id = p.id
    and e.created_by_user_id is null;

alter table public.documents
  add column if not exists created_by_user_id uuid references auth.users(id);

update public.documents d
  set created_by_user_id = p.user_id
  from public.people p
  where d.person_id = p.id
    and d.created_by_user_id is null;

alter table public.allergies
  add column if not exists created_by_user_id uuid references auth.users(id);

update public.allergies a
  set created_by_user_id = p.user_id
  from public.people p
  where a.person_id = p.id
    and a.created_by_user_id is null;

-- medication_logs and medication_reminders already have user_id (the author).
-- Add created_by_user_id as a defaulted alias so every clinical table uses
-- one canonical column name. user_id stays for backward compatibility.
alter table public.medication_logs
  add column if not exists created_by_user_id uuid references auth.users(id);
update public.medication_logs
  set created_by_user_id = user_id
  where created_by_user_id is null;

alter table public.medication_reminders
  add column if not exists created_by_user_id uuid references auth.users(id);
update public.medication_reminders
  set created_by_user_id = user_id
  where created_by_user_id is null;

-- lab_results, vitals, care_signals, update_me_summaries are EHR-pulled or
-- computed — no caregiver authoring path. No author column needed; their
-- SELECT just extends to the circle.

-- ---------------------------------------------------------------------------
-- C. Drop the old owner-only policies and install circle-aware ones.
-- ---------------------------------------------------------------------------

-- medications
drop policy if exists "Users see own medications" on public.medications;
create policy "circle_select" on public.medications
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.medications
  for insert with check (
    public.is_in_care_circle(person_id)
    and (created_by_user_id is null or created_by_user_id = auth.uid())
  );
create policy "circle_update_own" on public.medications
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.medications
  for delete using (auth.uid() = created_by_user_id);

-- medication_logs
drop policy if exists "Users manage own med logs" on public.medication_logs;
drop policy if exists "Caregivers read med logs" on public.medication_logs;
create policy "circle_select" on public.medication_logs
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.medication_logs
  for insert with check (
    public.is_in_care_circle(person_id)
    and created_by_user_id = auth.uid()
    and user_id = auth.uid()
  );
create policy "circle_update_own" on public.medication_logs
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.medication_logs
  for delete using (auth.uid() = created_by_user_id);

-- medication_reminders
drop policy if exists "Users can view own reminders" on public.medication_reminders;
drop policy if exists "Users can create own reminders" on public.medication_reminders;
drop policy if exists "Users can update own reminders" on public.medication_reminders;
drop policy if exists "Users can delete own reminders" on public.medication_reminders;
create policy "circle_select" on public.medication_reminders
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.medication_reminders
  for insert with check (
    public.is_in_care_circle(person_id)
    and created_by_user_id = auth.uid()
    and user_id = auth.uid()
  );
create policy "circle_update_own" on public.medication_reminders
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.medication_reminders
  for delete using (auth.uid() = created_by_user_id);

-- health_events
drop policy if exists "Users see own health_events" on public.health_events;
drop policy if exists "Users see own events"        on public.health_events;
create policy "circle_select" on public.health_events
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.health_events
  for insert with check (
    public.is_in_care_circle(person_id)
    and (created_by_user_id is null or created_by_user_id = auth.uid())
  );
create policy "circle_update_own" on public.health_events
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.health_events
  for delete using (auth.uid() = created_by_user_id);

-- documents
drop policy if exists "Users see own documents" on public.documents;
create policy "circle_select" on public.documents
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.documents
  for insert with check (
    public.is_in_care_circle(person_id)
    and (created_by_user_id is null or created_by_user_id = auth.uid())
  );
create policy "circle_update_own" on public.documents
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.documents
  for delete using (auth.uid() = created_by_user_id);

-- allergies
drop policy if exists "Users see own allergies" on public.allergies;
create policy "circle_select" on public.allergies
  for select using (public.is_in_care_circle(person_id));
create policy "circle_insert" on public.allergies
  for insert with check (
    public.is_in_care_circle(person_id)
    and (created_by_user_id is null or created_by_user_id = auth.uid())
  );
create policy "circle_update_own" on public.allergies
  for update using (auth.uid() = created_by_user_id)
  with check (auth.uid() = created_by_user_id);
create policy "circle_delete_own" on public.allergies
  for delete using (auth.uid() = created_by_user_id);

-- lab_results — EHR-sourced, read-only to clients
drop policy if exists "Users see own lab_results" on public.lab_results;
drop policy if exists "Users see own labs"        on public.lab_results;
create policy "circle_select" on public.lab_results
  for select using (public.is_in_care_circle(person_id));
-- INSERT path goes through EHR sync (service role bypasses RLS). No client INSERT policy.

-- vitals — EHR + Apple Health sourced, read-only to clients in v1
drop policy if exists "Users see own vitals" on public.vitals;
create policy "circle_select" on public.vitals
  for select using (public.is_in_care_circle(person_id));

-- care_signals — computed
drop policy if exists "Users see own care_signals" on public.care_signals;
drop policy if exists "Users see own signals"      on public.care_signals;
create policy "circle_select" on public.care_signals
  for select using (public.is_in_care_circle(person_id));

-- update_me_summaries — computed
drop policy if exists "Users see own summaries" on public.update_me_summaries;
create policy "circle_select" on public.update_me_summaries
  for select using (public.is_in_care_circle(person_id));

-- ---------------------------------------------------------------------------
-- D. `people` table: keep owner-only for the row itself (profile + circle
--    membership), but add a circle SELECT so members can read the loved
--    one's name + DOB on their own dashboard.
-- ---------------------------------------------------------------------------

drop policy if exists "Users see own people" on public.people;
create policy "people_owner_all" on public.people
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "people_circle_select" on public.people
  for select using (
    exists (
      select 1 from public.care_circle_members
        where care_circle_members.person_id = people.id
          and care_circle_members.user_id   = auth.uid()
          and care_circle_members.invite_status = 'accepted'
    )
  );

-- ---------------------------------------------------------------------------
-- E. care_circle_members: secondary caregivers need to see their own
--    membership row (today the RLS only lets the owner see it).
-- ---------------------------------------------------------------------------

drop policy if exists "Users can read own care circle" on public.care_circle_members;
create policy "ccm_owner_select" on public.care_circle_members
  for select using (
    person_id in (select id from public.people where user_id = auth.uid())
  );
create policy "ccm_member_select_self" on public.care_circle_members
  for select using (user_id = auth.uid());

commit;

-- ============================================================================
-- ROLLBACK plan (for review only — do not run in this migration):
--
--   begin;
--   -- Restore owner-only policies on each table (drop circle_* policies,
--   -- recreate the original "Users see own ..." with person_id IN people).
--   -- Drop is_in_care_circle.
--   -- Restore the original care_circle_members SELECT policy.
--   -- Restore the original people SELECT policy.
--   commit;
--
-- Author columns can stay; they are forward-compatible.
-- ============================================================================
