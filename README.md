# solana-token-monitor

Watches a Solana token around the clock and posts to Telegram and X
when something worth saying happens.

This repo contains no pre-configured accounts, tokens, or secrets.
Everyone who uses it sets up their own Supabase project, their own
Telegram bot, and their own API keys. Nothing here is tied to anyone.

It pulls data from DEXScreener, Birdeye, Solscan, and X every 5 minutes,
scores the token’s health across 5 dimensions, and decides whether anything
has changed enough to be worth posting. When it posts, it uses whatever
AI provider you’ve configured — Grok, OpenAI, or Nemotron — or falls
back to data-driven templates if you’ve set none.

Everything runs on Supabase — the database, the scheduled function, the
content queue. No server to maintain.

---

## what it does

- scores token health 0-100 across liquidity, trading, holders, social, listings
- detects: trending entries, volume spikes, price moves, holder milestones, health warnings
- posts to a public Telegram channel and a private ops group with different content per channel
- queues tweets for a lightweight Python poster service
- logs every metric, decision, and post to Postgres — full audit trail
- uses your preferred AI for post copy, or templates if you prefer none

---

## quickstart

Full guide: [docs/setup.md](docs/setup.md)

Short version:
1. create a Supabase project
2. run the migration SQL in the SQL editor
3. deploy the edge function
4. set your secrets in the Supabase dashboard
5. schedule it with `scripts/setup_cron.sql`
6. test: `bash scripts/test_monitor.sh YOUR_PROJECT_REF`

---

## AI provider setup

All three providers are optional. Set none and it uses templates.
Set your preferred provider via `AI_PRIMARY_PROVIDER`.
Set your full fallback order via `AI_PROVIDER_PREFERENCE`.

| provider | key name | model | notes |
|----------|----------|-------|-------|
| Grok (xAI) | `GROK_API_KEY` | grok-3-mini | fast, good crypto context |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini | reliable, widely supported |
| NVIDIA Nemotron | `NEMOTRON_API_KEY` | nemotron-ultra-253b | highest quality, slower |

See [docs/ai-providers.md](docs/ai-providers.md) for full setup and examples.

---

## data sources

| source | provides | key required? |
|--------|----------|---------------|
| DEXScreener | price, volume, txns, liquidity, trending | no |
| Birdeye | token overview, holder count | yes — free tier |
| Solscan | top holder list, concentration | yes — free tier |
| X API | mentions, sentiment | yes — basic tier |

---

## channel routing

| trigger | public channel | ops group |
|---------|---------------|-----------|
| daily update | ✓ | ✓ (detailed) |
| trending | ✓ | — |
| volume spike | ✓ | — |
| price up 10%+ | ✓ | — |
| holder milestone | ✓ | — |
| health warning | — | ✓ |
| health critical | — | ✓ |

---

## repo layout

```
├── supabase/
│   ├── migrations/         database schema (run once)
│   └── functions/
│       └── mim-monitor/    edge function
├── scripts/
│   ├── setup_cron.sql      schedules the monitor
│   ├── test_monitor.sh     manual test run
│   └── x_poster.py         tweet queue runner
└── docs/
    ├── setup.md
    ├── telegram.md
    ├── api-keys.md
    ├── ai-providers.md
    ├── architecture.md
    └── customization.md
```

---

## docs

- [setup guide](docs/setup.md)
- [telegram setup](docs/telegram.md)
- [api key sources](docs/api-keys.md)
- [ai provider setup](docs/ai-providers.md)
- [how it works](docs/architecture.md)
- [customization](docs/customization.md)

---

MIT license. Use it, fork it, modify it.
