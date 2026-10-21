select cron.schedule('monthly-away-note', '0 14 1 * *', $cmd$
  SELECT net.http_post(
    url := 'https://nrpdhxygzyfmyljzfexv.supabase.co/functions/v1/send-away-note',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'service_role_key' LIMIT 1)
    ),
    body := jsonb_build_object('mode', 'cron'),
    timeout_milliseconds := 120000
  ) AS request_id;
  $cmd$);
