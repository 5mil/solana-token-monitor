-- =============================================================================
-- wallet tracking schema
-- Adds buy/sell tracking, address relationships, bundle detection,
-- and historical trade scan support.
-- Run in Supabase SQL Editor after the initial migration.
-- =============================================================================

-- Every on-chain trade observed for the monitored token
create table if not exists trades (
  id                bigserial primary key,
  observed_at       timestamptz not null default now(),
  signature         text not null unique,        -- tx signature (dedup key)
  block_time        timestamptz,
  slot              bigint,
  wallet            text not null,               -- signer wallet address
  side              text not null,               -- 'buy' | 'sell'
  token_amount      numeric,                     -- token delta (absolute)
  sol_amount        numeric,                     -- SOL delta (absolute)
  price_per_token   numeric,                     -- derived: sol / token
  usd_value         numeric,                     -- sol_amount * sol_price at time
  program           text,                        -- dex program: raydium | jupiter | orca | other
  raw               jsonb                        -- full parsed tx for audit
);

-- Wallet-level aggregates (updated on each tracker run)
create table if not exists wallet_profiles (
  wallet            text primary key,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  total_buys        integer not null default 0,
  total_sells       integer not null default 0,
  total_buy_sol     numeric not null default 0,
  total_sell_sol    numeric not null default 0,
  total_buy_tokens  numeric not null default 0,
  total_sell_tokens numeric not null default 0,
  net_position      numeric not null default 0,  -- tokens held (buy - sell)
  avg_buy_price     numeric,
  avg_sell_price    numeric,
  realized_pnl_sol  numeric,
  bundle_score      numeric not null default 0,  -- 0-100, higher = more suspicious
  tags              text[] not null default '{}' -- 'bundler','sniper','whale','bot','flipper'
);

-- Wallets active within the same slot or within a configurable time window
-- These are candidate bundles or coordinated actors
create table if not exists wallet_relationships (
  id                bigserial primary key,
  detected_at       timestamptz not null default now(),
  wallet_a          text not null,
  wallet_b          text not null,
  relationship_type text not null,  -- 'same_slot_buy' | 'same_slot_sell' | 'coordinated_buy' | 'coordinated_sell' | 'mirror_trade' | 'bundle'
  co_occurrence     integer not null default 1,  -- how many times seen together
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  confidence        numeric not null default 0,  -- 0-100
  evidence          jsonb,                       -- slot numbers, signatures, etc.
  unique (wallet_a, wallet_b, relationship_type)
);

-- Detected bundles: groups of wallets acting together
create table if not exists bundles (
  id                bigserial primary key,
  detected_at       timestamptz not null default now(),
  bundle_type       text not null,   -- 'launch_bundle' | 'coordinated_buy' | 'coordinated_sell' | 'wash_trade'
  wallets           text[] not null, -- all wallet addresses in the bundle
  slot_range        int8range,       -- slot window they acted in
  time_range        tstzrange,       -- timestamp window
  total_sol         numeric,         -- total SOL involved
  total_tokens      numeric,         -- total tokens involved
  confidence        numeric not null default 0,
  notes             text,
  signatures        text[]           -- all tx signatures
);

-- Historical scan state: track how far back we have scanned
create table if not exists scan_state (
  id                bigserial primary key,
  started_at        timestamptz not null default now(),
  completed_at      timestamptz,
  oldest_signature  text,   -- oldest signature processed
  newest_signature  text,   -- newest signature processed
  total_tx_scanned  integer not null default 0,
  total_trades_found integer not null default 0,
  status            text not null default 'running',  -- 'running' | 'complete' | 'failed' | 'partial'
  error             text,
  cursor            text    -- Solana RPC pagination cursor (before param)
);

-- Indexes
create index if not exists idx_trades_wallet       on trades(wallet);
create index if not exists idx_trades_block_time   on trades(block_time desc);
create index if not exists idx_trades_side         on trades(side);
create index if not exists idx_trades_slot         on trades(slot);
create index if not exists idx_wallet_profiles_bundle_score on wallet_profiles(bundle_score desc);
create index if not exists idx_wallet_relationships_wallets on wallet_relationships(wallet_a, wallet_b);
create index if not exists idx_wallet_relationships_type    on wallet_relationships(relationship_type);
create index if not exists idx_bundles_detected_at on bundles(detected_at desc);
