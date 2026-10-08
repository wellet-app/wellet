
  WITH claimed AS (
    SELECT s.id, s.person_id, s.ehr_connection_id
    FROM public.ehr_sync_schedule s
    JOIN public.people p ON p.id = s.person_id
    JOIN public.ehr_connections c ON c.id = s.ehr_connection_id
    WHERE s.next_run_at <= now()
      AND s.paused_until_app_open = false
      AND c.status <> 'superseded'
      AND (
        p.last_app_open_at IS NULL
        OR p.last_app_open_at > now() - interval '30 days'
        -- Quiet mode (2026-10-08): people not opened in 30+ days still sync, weekly.
        OR s.last_run_at IS NULL
        OR s.last_run_at <= now() - interval '7 days'
      )
      AND COALESCE(p.is_reviewer, false) = false
    ORDER BY s.next_run_at
    LIMIT 5
    FOR UPDATE OF s SKIP LOCKED
  )
  SELECT net.http_post(
    url := 'https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/background-ehr-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := jsonb_build_object(
      'schedule_id', id,
      'person_id', person_id,
      'ehr_connection_id', ehr_connection_id
    ),
    timeout_milliseconds := 60000
  )
  FROM claimed;
  