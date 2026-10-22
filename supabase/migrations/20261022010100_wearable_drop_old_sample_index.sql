-- Apple Health sample key, step 2 of 2 (2026-10-21). Run after
-- wellet-health-ingest v12 is live. Catches any row written by v11 between
-- step 1 and the deploy, then drops the old key that caused the overwrites.
update public.wearable_observations
   set sample_key = 'v1|' || hk_type
     || '|' || floor(extract(epoch from start_at) * 1000)::bigint::text
     || '|' || coalesce(floor(extract(epoch from end_at) * 1000)::bigint::text, '')
     || '|' || coalesce(device_source, '')
 where sample_key is null;

drop index if exists public.wearable_observations_unique_sample;
