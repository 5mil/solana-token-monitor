-- =============================================================================
-- setup_cron.sql v2
-- Schedules both edge functions via pg_cron.
--
-- BEFORE RUNNING:
--   1. Replace YOUR_PROJECT_REF with your Supabase project reference ID
--      (found in Project Settings → General → Reference ID)
--   2. Do NOT put your service role key inline here.
--      Store it in Supabase Vault and reference it via vault.decrypted_secrets.
--      See: https://supabase.com/docs/guides/database/vault
--
-- The key validation below will prevent running with the placeholder value.
-- =============================================================================

-- Validate: reject if project ref is still the placeholder
do $$ begin
  if current_setting('app.project_ref', true) is null
     or current_setting('app.project_ref', true) = ''
     or current_setting('app.project_ref', true) = 'YOUR_PROJECT_REF' then
    raise exception
      'Replace YOUR_PROJECT_REF with your real Supabase project reference before running setup_cron.sql';
  end if;
end $$;

-- Validate: service role key must be a valid JWT (3 dot-separated segments)
-- Retrieve the key from vault at runtime — never hardcode it in SQL
do $$ declare
  v_key text;
begin
  select decrypted_secret into v_key
  from vault.decrypted_secrets
  where name = 'SUPABASE_SERVICE_ROLE_KEY'
  limit 1;

  if v_key is null or v_key = '' then
    raise exception
      'Service role key not found in Vault. Add it via: select vault.create_secret(''YOUR_KEY'', ''SUPABASE_SERVICE_ROLE_KEY'');';
  end if;

  -- Validate JWT structure: must have exactly 3 dot-separated base64 segments
  if array_length(string_to_array(v_key, '.'), 1) != 3 then
    raise exception
      'SUPABASE_SERVICE_ROLE_KEY in Vault does not look like a valid JWT. Check for typos or extra whitespace.';
  end if;
end $$;

-- Remove existing jobs if re-running
select cron.unschedule(jobname)
from cron.job
where jobname in ('mim-monitor', 'wallet-tracker');

-- mim-monitor: every 5 minutes
select cron.schedule(
  'mim-monitor',
  '*/5 * * * *',
  format(
    $sql$
    select net.http_post(
      url     := 'https://%s.supabase.co/functions/v1/mim-monitor',
      headers := jsonb_build_object(
        'Content-Type',  'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1)
      ),
      body    := '{}'::jsonb
    );
    $sql$,
    current_setting('app.project_ref')
  )
);

-- wallet-tracker: every 5 minutes, offset 2min to avoid overlap with mim-monitor
select cron.schedule(
  'wallet-tracker',
  '2-57/5 * * * *',
  format(
    $sql$
    select net.http_get(
      url     := 'https://%s.supabase.co/functions/v1/wallet-tracker?limit=100',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'SUPABASE_SERVICE_ROLE_KEY' limit 1)
      )
    );
    $sql$,
    current_setting('app.project_ref')
  )
);

-- Confirm scheduled jobs
select jobid, jobname, schedule, active from cron.job
where jobname in ('mim-monitor', 'wallet-tracker');

-- Usage reminder
do $$ begin
  raise notice 'Cron jobs scheduled. To set project_ref for this session: SET app.project_ref = ''your-ref-id'';';
end $$;
