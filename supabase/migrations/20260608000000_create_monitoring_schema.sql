-- solana-token-monitor database schema
-- Run once in the Supabase SQL Editor

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- Raw metric snapshots
create table if not exists token_metrics (
  id              bigserial primary key,
  captured_at     timestamptz not null default now(),
  price           numeric,
  price_change_24h numeric,
  volume_24h      numeric,
  volume_prev     numeric,
  liquidity_usd   numeric,
  liquidity_sol   numeric,
  buys_24h        integer,
  sells_24h       integer,
  holder_count    integer,
  top10_pct       numeric,
  trending_rank   integer,
  mentions_24h    integer,
  sentiment_score numeric,
  source_data     jsonb
);

-- Health scores per cycle
create table if not exists health_scores (
  id              bigserial primary key,
  scored_at       timestamptz not null default now(),
  metric_id       bigint references token_metrics(id),
  liquidity_score numeric,
  trading_score   numeric,
  holder_score    numeric,
  social_score    numeric,
  listing_score   numeric,
  overall_score   numeric,
  status          text  -- 'healthy' | 'warning' | 'critical'
);

-- Trigger decisions per cycle
create table if not exists decisions_log (
  id              bigserial primary key,
  decided_at      timestamptz not null default now(),
  metric_id       bigint references token_metrics(id),
  trigger_name    text not null,
  fired           boolean not null,
  reason          text,
  ai_provider     text
);

-- Generated content queue
create table if not exists content_queue (
  id              bigserial primary key,
  created_at      timestamptz not null default now(),
  trigger_name    text not null,
  platform        text not null,  -- 'twitter' | 'telegram' | 'telegram_ops'
  content         text not null,
  status          text not null default 'pending',  -- 'pending' | 'posted' | 'failed'
  posted_at       timestamptz,
  platform_post_id text,
  error           text,
  ai_generated    boolean not null default false,
  ai_provider     text,
  metric_id       bigint references token_metrics(id)
);

-- Post history (completed posts)
create table if not exists post_history (
  id              bigserial primary key,
  posted_at       timestamptz not null default now(),
  platform        text not null,
  trigger_name    text not null,
  content         text not null,
  platform_post_id text,
  ai_generated    boolean not null default false,
  ai_provider     text
);

-- Indexes for common query patterns
create index if not exists idx_token_metrics_captured_at on token_metrics(captured_at desc);
create index if not exists idx_content_queue_status on content_queue(status, platform);
create index if not exists idx_post_history_posted_at on post_history(posted_at desc);
