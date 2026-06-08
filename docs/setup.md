# setup guide

Before you start, you need:
- a Supabase account (free tier is fine: supabase.com)
- the Supabase CLI installed: `npm install -g supabase`
- your token's mint address

---

## 1. create the project

Go to supabase.com → New Project. Pick a name, region, and password.
Takes about 2 minutes to provision. When it's ready, grab your
**Project Reference ID** from the URL:
`https://supabase.com/dashboard/project/YOUR_REF_IS_HERE`

---

## 2. run the database migration

Open the Supabase dashboard → SQL Editor → New Query.
Paste the contents of `supabase/migrations/20260608000000_create_monitoring_schema.sql`
and click Run. You'll see "Success. No rows returned."

---

## 3. deploy the edge function

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy mim-monitor --no-verify-jwt
```

Or use the dashboard: Edge Functions → Deploy a new function.

---

## 4. set secrets

Dashboard → Project Settings → Edge Functions → Add a new secret.
Add each of these:

```
TOKEN_MINT          your token's SPL mint address
TOKEN_SYMBOL        e.g. TOKEN
TOKEN_NAME          e.g. My Token Name
```

Then add whichever optional keys you have (data sources, Telegram,
AI providers). See [api-keys.md](api-keys.md) and [ai-providers.md](ai-providers.md).

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are injected automatically
inside Edge Functions — you don't need to add those.

---

## 5. test it

```bash
bash scripts/test_monitor.sh YOUR_PROJECT_REF
```

Or just curl it:

```bash
curl https://YOUR_PROJECT_REF.supabase.co/functions/v1/mim-monitor
```

A healthy response looks like:

```json
{
  "ok": true,
  "ai_provider": "grok",
  "token": { "symbol": "TOKEN" },
  "health": { "score": 54.5, "status": "warning" },
  "decisions": ["daily_update"],
  "alerts": ["⚠️ Low liquidity: 12.4 SOL"],
  "recommendations": ["Add LP on Raydium CLMM or Meteora DLMM"]
}
```

---

## 6. schedule it

Open `scripts/setup_cron.sql`, replace `YOUR_PROJECT_REF`,
run it in the SQL Editor. This sets up pg_cron to fire the
function every 5 minutes automatically.

---

## 7. optional: X/Twitter posting

```bash
pip install tweepy supabase python-dotenv
cp .env.example .env
# fill in the X OAuth keys
python scripts/x_poster.py
```

Run this anywhere (VPS, Railway, Render, your laptop).
It polls `content_queue` every 60 seconds and posts pending tweets.

---

## done

The monitor is live. It will:
- check your token every 5 minutes
- post to Telegram when something worth saying happens
- queue tweets for x_poster.py if you're running it
- send ops alerts to your private group on health issues
- log everything to Supabase indefinitely

Check [customization.md](customization.md) if you want to change
triggers, tweak the health weights, or add Discord.
