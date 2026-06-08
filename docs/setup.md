# setup guide

This repo contains no pre-configured accounts, tokens, or API keys.
Everything you set up belongs entirely to you.

Before you start, you need:
- a Supabase account (free tier works: supabase.com)
- the Supabase CLI: `npm install -g supabase`
- your Solana token's mint address

---

## 1. create a Supabase project

Go to supabase.com → New Project. Pick a name, region, and password.
Wait about 2 minutes for it to provision. Grab your **Project Reference ID**
from the dashboard URL:

```
https://supabase.com/dashboard/project/YOUR_REF_HERE
```

---

## 2. run the database migration

Dashboard → SQL Editor → New Query.
Paste the contents of `supabase/migrations/20260608000000_create_monitoring_schema.sql`
and click Run.

---

## 3. deploy the edge function

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy mim-monitor --no-verify-jwt
```

---

## 4. set secrets

Dashboard → Project Settings → Edge Functions → Add a new secret.

Required:
```
TOKEN_MINT          your SPL token mint address
TOKEN_SYMBOL        your token ticker
TOKEN_NAME          your token full name
```

Optional (add whichever you have):
```
AI_PRIMARY_PROVIDER    your preferred AI: grok | openai | nemotron
AI_PROVIDER_PREFERENCE full fallback order, e.g. openai,grok,nemotron,template
GROK_API_KEY
OPENAI_API_KEY
NEMOTRON_API_KEY
BIRDEYE_API_KEY
SOLSCAN_API_KEY
X_BEARER_TOKEN
TELEGRAM_BOT_TOKEN
TELEGRAM_CHAT_ID
TELEGRAM_OPS_CHAT_ID
```

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
inside Edge Functions — do not add those manually.

See [ai-providers.md](ai-providers.md) and [api-keys.md](api-keys.md)
for instructions on getting each key.

---

## 5. test it

```bash
bash scripts/test_monitor.sh YOUR_PROJECT_REF
```

A healthy response:

```json
{
  "ok": true,
  "ai_provider": "grok",
  "ai_provider_order": ["grok", "openai", "template"],
  "token": { "symbol": "YOUR_SYMBOL" },
  "health": { "score": 54.5, "status": "warning" },
  "decisions": ["daily_update"],
  "alerts": [],
  "recommendations": []
}
```

---

## 6. schedule it

Open `scripts/setup_cron.sql`, replace `YOUR_PROJECT_REF`, run it
in the SQL Editor. This schedules the monitor every 5 minutes via pg_cron.

---

## 7. optional: X/Twitter posting

```bash
pip install tweepy supabase python-dotenv
cp .env.example .env
# fill in your X OAuth keys
python scripts/x_poster.py
```

Run this anywhere: a VPS, Railway, Render, or your local machine.
It polls `content_queue` every 60 seconds and posts pending tweets.

---

## done

The monitor runs itself from here. Every 5 minutes it will:
- fetch on-chain data and score your token’s health
- post to Telegram when something is worth saying
- queue tweets for x_poster.py if you’re running it
- send ops alerts to your private group on health drops
- log everything to Supabase indefinitely

See [customization.md](customization.md) to adjust thresholds, weights, or add Discord.
