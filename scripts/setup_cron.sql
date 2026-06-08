-- Schedule mim-monitor to run every 5 minutes via pg_cron
-- Replace YOUR_PROJECT_REF with your actual Supabase project reference ID
-- Run this in the Supabase SQL Editor

select cron.schedule(
  'mim-monitor-5min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/mim-monitor',
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body := '{}'::jsonb
  );
  $$
);
