-- Step 2 of 2. Apply only after the web change that reads has_token
-- (instead of access_token) is live on mywellet.com.
--
-- Before: anon and authenticated held every table privilege, and RLS
-- let a signed-in user read and update every column of their own rows,
-- including access_token, refresh_token, code_verifier, token_url and
-- last_error_debug. Edge functions use the service role and are not
-- affected by any of this.
--
-- After:
--   anon           no access.
--   authenticated  SELECT on display columns only; UPDATE of status
--                  only, and only pending -> abandoned; DELETE of own
--                  rows (Disconnect). No INSERT; rows are created by
--                  epic-auth, cerner-auth-start, oneup-auth and va-auth
--                  with the service role.

revoke all on public.ehr_connections from anon;
revoke all on public.ehr_connections from authenticated;

grant select (
  id, user_id, person_id, hospital_name, provider, connected_provider,
  status, needs_reconnect, connected_at, last_synced_at, created_at,
  fhir_base_url, patient_id, client_id_used, token_expires_at,
  sort_order, disconnected_at, has_token
) on public.ehr_connections to authenticated;

grant update (status) on public.ehr_connections to authenticated;
grant delete on public.ehr_connections to authenticated;

drop policy if exists "Users can insert own EHR connections" on public.ehr_connections;

drop policy if exists "Users can update own EHR connections" on public.ehr_connections;
create policy "Users can abandon own pending EHR connections"
  on public.ehr_connections for update to authenticated
  using ((select auth.uid()) = user_id and status = 'pending')
  with check ((select auth.uid()) = user_id and status = 'abandoned');
