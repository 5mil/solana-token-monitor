-- =============================================================================
-- setup_cron.sql
-- Schedules both edge functions via pg_cron.
-- Replace YOUR_PROJECT_REF with your Supabase project reference.
-- Run once in the Supabase SQL Editor.
-- =============================================================================

-- Monitor: runs every 5 minutes
select cron.schedule(
  'mim-monitor',
  '*/5 * * * *',
  $$
  select net.http_post(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/mim-monitor',
    headers := '{"Content-Type": "application/json", "Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb,
    body    := '{}'::jsonb
  );
  $$
);

-- Wallet tracker: runs every 5 minutes (offset by 2 minutes to avoid overlap)
select cron.schedule(
  'wallet-tracker',
  '2-57/5 * * * *',
  $$
  select net.http_get(
    url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/wallet-tracker?limit=100',
    headers := '{"Authorization": "Bearer YOUR_SERVICE_ROLE_KEY"}'::jsonb
  );
  $$
);

-- To view scheduled jobs:
-- select * from cron.job;

-- To remove a job:
-- select cron.unschedule('wallet-tracker');
