-- Apple Health sample key, step 1 of 2 (2026-10-21).
-- Each wearable_observations row gets sample_key, unique per (person_id, source).
--   "hk|<HealthKit UUID>" when the app sends the sample UUID.
--   "v1|<hk_type>|<start ms>|<end ms>|<device>" otherwise.
-- The old unique key (person_id, hk_type, start_at, source) let an iPhone and
-- an Apple Watch sample with the same start overwrite each other.
-- The backfill below must stay in step with sampleKey() in
-- supabase/functions/wellet-health-ingest/index.ts (v12).
alter table public.wearable_observations add column if not exists sample_key text;

update public.wearable_observations
   set sample_key = 'v1|' || hk_type
     || '|' || floor(extract(epoch from start_at) * 1000)::bigint::text
     || '|' || coalesce(floor(extract(epoch from end_at) * 1000)::bigint::text, '')
     || '|' || coalesce(device_source, '')
 where sample_key is null;

create unique index if not exists wearable_observations_sample_key
  on public.wearable_observations (person_id, source, sample_key);
