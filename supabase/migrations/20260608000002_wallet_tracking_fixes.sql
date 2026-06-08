-- =============================================================================
-- Migration 00002: wallet tracking fixes
-- Fixes: bundle dedup, relationship staging, wallet profile repair,
--        advisory lock helper, DB function health check, token_meta table.
-- Run in Supabase SQL Editor BEFORE deploying the new wallet-tracker function.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. token_meta: stores launch time and other token-level facts
-- ---------------------------------------------------------------------------
create table if not exists token_meta (
  mint            text primary key,
  launch_time     timestamptz,           -- first ever trade timestamp
  name            text,
  symbol          text,
  decimals        integer,
  created_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. relationship_staging: first-seen relationships held until co_occurrence >= 2
--    Uses a TTL column so it never grows unbounded.
-- ---------------------------------------------------------------------------
create table if not exists relationship_staging (
  id                bigserial primary key,
  seen_at           timestamptz not null default now(),
  wallet_a          text not null,
  wallet_b          text not null,
  relationship_type text not null,
  confidence        numeric not null,
  evidence          jsonb,
  unique (wallet_a, wallet_b, relationship_type)
);
create index if not exists idx_relationship_staging_seen_at on relationship_staging(seen_at);

-- ---------------------------------------------------------------------------
-- 3. bundles: add dedup_hash column for deterministic deduplication
-- ---------------------------------------------------------------------------
alter table bundles add column if not exists dedup_hash text;
create unique index if not exists idx_bundles_dedup_hash on bundles(dedup_hash) where dedup_hash is not null;

-- ---------------------------------------------------------------------------
-- 4. wallet_profiles: add data_quality flag so pre-fix rows are distinguishable
-- ---------------------------------------------------------------------------
alter table wallet_profiles add column if not exists data_quality text not null default 'pre_fix';

-- ---------------------------------------------------------------------------
-- 5. Repair existing wallet_profiles: truncate and rebuild from trades table.
--    This is safe because trades is the source of truth (upserted by signature).
--    All wallet stats are re-derived correctly from the full trades history.
-- ---------------------------------------------------------------------------
truncate table wallet_profiles restart identity;

-- Rebuild wallet_profiles from trades (correct lifetime aggregates)
insert into wallet_profiles (
  wallet,
  first_seen_at,
  last_seen_at,
  total_buys,
  total_sells,
  total_buy_sol,
  total_sell_sol,
  total_buy_tokens,
  total_sell_tokens,
  net_position,
  avg_buy_price,
  avg_sell_price,
  realized_pnl_sol,
  bundle_score,
  tags,
  data_quality
)
select
  wallet,
  min(block_time)                                                    as first_seen_at,
  max(block_time)                                                    as last_seen_at,
  count(*) filter (where side = 'buy')                               as total_buys,
  count(*) filter (where side = 'sell')                              as total_sells,
  coalesce(sum(sol_amount)   filter (where side = 'buy'),  0)        as total_buy_sol,
  coalesce(sum(sol_amount)   filter (where side = 'sell'), 0)        as total_sell_sol,
  coalesce(sum(token_amount) filter (where side = 'buy'),  0)        as total_buy_tokens,
  coalesce(sum(token_amount) filter (where side = 'sell'), 0)        as total_sell_tokens,
  coalesce(sum(token_amount) filter (where side = 'buy'),  0) -
  coalesce(sum(token_amount) filter (where side = 'sell'), 0)        as net_position,
  avg(price_per_token) filter (where side = 'buy')                   as avg_buy_price,
  avg(price_per_token) filter (where side = 'sell')                  as avg_sell_price,
  null                                                               as realized_pnl_sol,
  0                                                                  as bundle_score,
  '{}'::text[]                                                       as tags,
  'verified'                                                         as data_quality
from trades
group by wallet
on conflict (wallet) do nothing;

-- ---------------------------------------------------------------------------
-- 6. Postgres RPC functions called by the edge function
-- ---------------------------------------------------------------------------

-- Health check: called at boot to verify DB functions are deployed
create or replace function ping_increment_wallet_profile()
returns text language sql as $$ select 'ok'::text; $$;

-- Bulk relationship lookup: accepts JSONB array of {wallet_a, wallet_b, relationship_type}
-- Returns matching rows so the edge function can diff in memory
create or replace function bulk_lookup_relationships(pairs jsonb)
returns table (
  id               bigint,
  wallet_a         text,
  wallet_b         text,
  relationship_type text,
  co_occurrence    integer,
  confidence       numeric
) language sql as $$
  select wr.id, wr.wallet_a, wr.wallet_b, wr.relationship_type, wr.co_occurrence, wr.confidence
  from wallet_relationships wr
  join jsonb_array_elements(pairs) p on
    wr.wallet_a          = (p->>'wallet_a') and
    wr.wallet_b          = (p->>'wallet_b') and
    wr.relationship_type = (p->>'relationship_type');
$$;

-- Incremental wallet profile upsert: safely merges a single cycle's deltas
-- into lifetime totals using atomic SQL arithmetic
create or replace function upsert_wallet_profile_incremental(
  p_wallet            text,
  p_first_seen        timestamptz,
  p_last_seen         timestamptz,
  p_buy_count         integer,
  p_sell_count        integer,
  p_buy_sol           numeric,
  p_sell_sol          numeric,
  p_buy_tokens        numeric,
  p_sell_tokens       numeric,
  p_avg_buy_price     numeric,
  p_avg_sell_price    numeric,
  p_realized_pnl      numeric,
  p_bundle_score      numeric,
  p_tags              text[]
) returns void language plpgsql as $$
begin
  insert into wallet_profiles (
    wallet, first_seen_at, last_seen_at,
    total_buys, total_sells,
    total_buy_sol, total_sell_sol,
    total_buy_tokens, total_sell_tokens,
    net_position,
    avg_buy_price, avg_sell_price,
    realized_pnl_sol,
    bundle_score, tags, data_quality
  ) values (
    p_wallet, p_first_seen, p_last_seen,
    p_buy_count, p_sell_count,
    p_buy_sol, p_sell_sol,
    p_buy_tokens, p_sell_tokens,
    p_buy_tokens - p_sell_tokens,
    p_avg_buy_price, p_avg_sell_price,
    p_realized_pnl,
    p_bundle_score, p_tags, 'verified'
  )
  on conflict (wallet) do update set
    -- preserve earliest first_seen, advance last_seen
    first_seen_at     = least(wallet_profiles.first_seen_at,    excluded.first_seen_at),
    last_seen_at      = greatest(wallet_profiles.last_seen_at,  excluded.last_seen_at),
    -- atomically accumulate lifetime totals
    total_buys        = wallet_profiles.total_buys        + excluded.total_buys,
    total_sells       = wallet_profiles.total_sells       + excluded.total_sells,
    total_buy_sol     = wallet_profiles.total_buy_sol     + excluded.total_buy_sol,
    total_sell_sol    = wallet_profiles.total_sell_sol    + excluded.total_sell_sol,
    total_buy_tokens  = wallet_profiles.total_buy_tokens  + excluded.total_buy_tokens,
    total_sell_tokens = wallet_profiles.total_sell_tokens + excluded.total_sell_tokens,
    net_position      = wallet_profiles.net_position      + (excluded.total_buy_tokens - excluded.total_sell_tokens),
    -- overwrite derived/scored fields (these are re-computed each cycle)
    avg_buy_price     = excluded.avg_buy_price,
    avg_sell_price    = excluded.avg_sell_price,
    realized_pnl_sol  = excluded.realized_pnl_sol,
    bundle_score      = excluded.bundle_score,
    tags              = excluded.tags,
    data_quality      = 'verified';
end;
$$;

-- Grant execute to the service role used by edge functions
grant execute on function ping_increment_wallet_profile()          to service_role;
grant execute on function bulk_lookup_relationships(jsonb)         to service_role;
grant execute on function upsert_wallet_profile_incremental(
  text,timestamptz,timestamptz,integer,integer,
  numeric,numeric,numeric,numeric,
  numeric,numeric,numeric,numeric,text[]
) to service_role;
