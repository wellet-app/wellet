-- 20261123170000_condition_dedup.sql
--
-- One-time cleanup of duplicate EHR condition rows (2026-11-23, approved by
-- Betsy in thread). Pairs with the ehr-persist change that keys condition
-- fingerprints on name and day only.
--
-- Why copies exist:
--   1. Epic sends a condition from the problem list and again as a visit
--      diagnosis; the old fingerprint included the first code, which differs.
--   2. Reconnects before 2026-11-12 made a new connection row, so the old
--      (superseded) connection kept its own copy.
--   3. Rows from deleted connections lost connection_id (ON DELETE SET NULL)
--      and sit beside the live copy.
--
-- What this does:
--   a. Groups EHR condition rows by person, lowercased name, UTC day and
--      hospital. Rows with no connection join the group's only hospital, or
--      their own group when there is none or more than one.
--   b. Keeps one row per group: live connection first, then a row with a
--      visit link, then newest. The kept row takes a visit link from a copy
--      if it has none.
--   c. Copies every removed row, whole, to ops_backup.condition_dupes_20261123
--      (with kept_id), then deletes it from public.health_events.
--   d. Rewrites source_fingerprint on every remaining EHR condition row to the
--      new formula, so the next sync updates these rows instead of adding new
--      ones. Old values go to ops_backup.condition_fp_20261123.
--
-- Rollback:
--   update public.health_events h set source_fingerprint = b.old_fingerprint,
--     encounter_fhir_id = b.old_encounter_fhir_id
--     from ops_backup.condition_fp_20261123 b where b.id = h.id;
--   insert into public.health_events (<all health_events columns>)
--     select <same columns> from ops_backup.condition_dupes_20261123;
--   Then redeploy the previous fetch-ehr-data.
--
-- ops_backup is owned by postgres with no grants to anon or authenticated.

create or replace function ops_backup.fnv1a64(input text) returns text
language plpgsql immutable as $$
declare
  h numeric := 14695981039346656037;
  prime numeric := 1099511628211;
  m numeric := 18446744073709551616;
  c int; lo numeric; i int; hex text := ''; d int;
begin
  for i in 1..char_length(input) loop
    c := ascii(substr(input, i, 1));
    lo := mod(h, 65536);
    h := h - lo + ((lo::int) # c);
    h := mod(h * prime, m);
  end loop;
  for i in 1..16 loop
    d := mod(h, 16)::int;
    hex := substr('0123456789abcdef', d + 1, 1) || hex;
    h := div(h, 16);
  end loop;
  return hex;
end $$;

create table ops_backup.condition_dupes_20261123 as
with c as (
  select h.*, ec.hospital_name as hosp, ec.status as conn_status,
         lower(h.title) as tkey,
         to_char(h.event_date at time zone 'UTC', 'YYYY-MM-DD') as dkey
  from public.health_events h
  left join public.ehr_connections ec on ec.id = h.connection_id
  where h.event_type = 'condition' and h.source = 'ehr'
),
g as (
  select person_id, tkey, dkey,
         count(distinct hosp) filter (where connection_id is not null) as n_hosp,
         min(hosp) filter (where connection_id is not null) as only_hosp
  from c group by 1, 2, 3
),
k as (
  select c.*,
         case when c.connection_id is not null then c.hosp
              when g.n_hosp = 1 then g.only_hosp
              else '__no_connection__' end as cluster
  from c join g using (person_id, tkey, dkey)
),
r as (
  select k.*,
         row_number() over (
           partition by person_id, tkey, dkey, cluster
           order by (conn_status = 'connected') desc nulls last,
                    (connection_id is not null) desc,
                    (encounter_fhir_id is not null) desc,
                    created_at desc, id
         ) as rn,
         first_value(id) over (
           partition by person_id, tkey, dkey, cluster
           order by (conn_status = 'connected') desc nulls last,
                    (connection_id is not null) desc,
                    (encounter_fhir_id is not null) desc,
                    created_at desc, id
         ) as kept_id
  from k
)
select h.*, r.kept_id
from public.health_events h join r on r.id = h.id
where r.rn > 1;

-- Old fingerprints and visit links, before anything changes.
create table ops_backup.condition_fp_20261123 as
select id, source_fingerprint as old_fingerprint, encounter_fhir_id as old_encounter_fhir_id
from public.health_events
where event_type = 'condition' and source = 'ehr';

-- Kept rows with no visit link take one from a removed copy.
update public.health_events h
set encounter_fhir_id = d.enc
from (
  select kept_id, min(encounter_fhir_id) as enc
  from ops_backup.condition_dupes_20261123
  where encounter_fhir_id is not null
  group by kept_id
) d
where h.id = d.kept_id and h.encounter_fhir_id is null;

delete from public.health_events h
using ops_backup.condition_dupes_20261123 d
where h.id = d.id;

update public.health_events
set source_fingerprint = ops_backup.fnv1a64(
  'epic|Condition|' || lower(title) || '|' || to_char(event_date at time zone 'UTC', 'YYYY-MM-DD'))
where event_type = 'condition' and source = 'ehr';

revoke all on ops_backup.condition_dupes_20261123 from public, anon, authenticated;
revoke all on ops_backup.condition_fp_20261123 from public, anon, authenticated;
