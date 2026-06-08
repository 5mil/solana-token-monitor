# how it works

The whole system is a single Supabase Edge Function (`mim-monitor`) that
runs on a pg_cron schedule every 5 minutes. Here's what happens each cycle:

---

## data collection

The function fetches from up to four sources in parallel:

- **DEXScreener** — price, volume, buy/sell counts, liquidity depth, trending rank
- **Birdeye** — token overview, holder count (requires API key)
- **Solscan** — top holders list for concentration analysis (requires API key)
- **X API** — recent mentions, engagement metrics (requires bearer token)

DEXScreener is the primary source. The others enrich the picture.

---

## health scoring

Five dimensions, each scored 0-100, combined into an overall score:

| dimension | what it measures |
|-----------|------------------|
| liquidity | pool depth vs. daily volume |
| trading | buy/sell ratio, txn counts |
| holders | count, growth, concentration |
| social | X mentions, engagement |
| listings | trending presence, DEX coverage |

Overall score drives the health status: healthy (≥70), warning (≥40), critical (<40).

---

## trigger detection

After scoring, the function checks a set of conditions against current and
previous metrics to decide what, if anything, is worth posting:

- `trending_new` — entered DEXScreener trending for the first time
- `volume_spike` — volume up 50%+ vs. previous period
- `price_up_10` — price up 10%+ in 24h
- `holder_milestone` — crossed a round holder count threshold
- `health_warning` — overall score dropped below 40
- `daily_update` — no post in 23+ hours (always fires as a fallback)

---

## content generation

For each triggered event, the function generates two versions of content:
one for the public Telegram channel, one for X/Twitter.

If an AI key is configured, it builds a context string from the live metrics
and sends it to the AI provider. If no AI key is set, or if the AI call fails,
it falls back to data-driven templates.

Content is stored in `content_queue` with `status = pending`.

---

## posting

**Telegram** posts happen directly from the edge function — no external service needed.
Public channel posts and ops group alerts are sent via the Telegram Bot API.

**X/Twitter** posts go through `scripts/x_poster.py`, a lightweight Python process
that polls `content_queue` for pending tweets and posts them via the Twitter API.
This separation exists because the Twitter API requires OAuth 1.0a, which is
easier to handle in Python than in a Deno edge function.

---

## database tables

| table | purpose |
|-------|---------|
| `token_metrics` | raw metric snapshot every cycle |
| `health_scores` | scored health per cycle |
| `decisions_log` | which triggers fired and why |
| `content_queue` | generated content pending or posted |
| `post_history` | completed posts with timestamps |

All tables are append-only. Nothing is ever deleted. This gives you a full
history of how your token's metrics evolved and what was posted when.
