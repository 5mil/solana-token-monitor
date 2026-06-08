# solana-token-monitor

Watches a Solana token around the clock and posts to Telegram and X
when something worth saying happens.

It pulls data from DEXScreener, Birdeye, Solscan, and X every 5 minutes,
scores the token's health across 5 dimensions, and figures out whether
anything has changed enough to be worth posting. When it does post,
it either uses an AI you've configured (Grok, OpenAI, or Nemotron) or
falls back to data-driven templates.

Everything runs on Supabase — the database, the scheduled function,
the content queue. No server to maintain.

---

## what it does

- scores token health 0-100 across liquidity, trading, holders, social, listings
- detects: new trending entries, volume spikes, price moves, holder milestones, health warnings
- posts to a public Telegram channel and a private ops group, with different content per channel
- queues tweets for a lightweight Python poster service
- logs every metric, decision, and post to Postgres — full audit trail
- uses Grok, OpenAI, or Nemotron for post copy if you provide a key; templates otherwise

---

## quickstart

Full step-by-step is in [docs/setup.md](docs/setup.md).

Short version:

1. create a Supabase project
2. run the migration SQL in the Supabase SQL editor
3. deploy the edge function (`supabase functions deploy mim-monitor --no-verify-jwt`)
4. set your secrets in the Supabase dashboard
5. run `scripts/setup_cron.sql` to schedule it every 5 minutes
6. test it: `bash scripts/test_monitor.sh YOUR_PROJECT_REF`

That's it. From that point it runs itself.

---

## picking an AI provider

All three are optional. If you set none, it uses templates and still works fine.

| provider | key secret | model used | notes |
|----------|-----------|------------|-------|
| Grok (xAI) | `GROK_API_KEY` | grok-3-mini | fastest, cheapest, good crypto context |
| OpenAI | `OPENAI_API_KEY` | gpt-4o-mini | reliable, well-tested |
| NVIDIA Nemotron | `NEMOTRON_API_KEY` | nemotron-ultra-253b | highest quality, slower |

Priority order: Grok → OpenAI → Nemotron → template. Set whichever you have.
If multiple keys are set, the highest-priority one wins. The active provider
is logged in every post record so you can see what wrote what.

---

## data sources

| source | what it provides | key required? |
|--------|-----------------|---------------|
| DEXScreener | price, volume, txn counts, liquidity | no |
| Birdeye | token overview, holder count | yes — free tier works |
| Solscan | top holder list, concentration | yes — free tier works |
| X API | mentions, sentiment, engagement | yes — basic tier works |

DEXScreener is the primary source. Everything else fills in the gaps.

---

## channel routing

| trigger | public channel | ops group |
|---------|---------------|-----------|
| daily update | post | detailed summary |
| trending | post | — |
| volume spike | post | — |
| price up 10%+ | post | — |
| holder milestone | post | — |
| health warning | — | alert |
| critical health | — | alert |

---

## repo layout

```
├── supabase/
│   ├── migrations/        database schema (run once)
│   └── functions/
│       └── mim-monitor/   edge function (deploy via CLI or dashboard)
├── scripts/
│   ├── setup_cron.sql     schedules the monitor in pg_cron
│   ├── test_monitor.sh    fires a single cycle manually
│   └── x_poster.py        polls content_queue and posts tweets
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
- [where to get api keys](docs/api-keys.md)
- [ai provider setup](docs/ai-providers.md)
- [how it works](docs/architecture.md)
- [extending it](docs/customization.md)

---

MIT license. Use it, fork it, break it, fix it.
