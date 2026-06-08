# extending it

The monitor is designed to be modified. Here are the most common changes.

---

## changing trigger thresholds

In `supabase/functions/mim-monitor/index.ts`, find the trigger detection block.
All thresholds are plain constants at the top of the function:

```typescript
const VOLUME_SPIKE_THRESHOLD = 1.5;   // 50% increase
const PRICE_UP_THRESHOLD     = 0.10;  // 10% increase
const HEALTH_WARNING_SCORE   = 40;
const DAILY_POST_HOURS       = 23;
```

Change any of these and redeploy.

---

## adjusting health weights

The five health dimensions each contribute to the overall score.
Default weights are equal (20% each). To change them:

```typescript
const HEALTH_WEIGHTS = {
  liquidity: 0.25,
  trading:   0.25,
  holders:   0.20,
  social:    0.15,
  listings:  0.15
};
```

---

## adding Discord

The Telegram posting logic is isolated in a `sendTelegram()` helper.
Add a `sendDiscord()` function alongside it using Discord's webhook API:

```typescript
async function sendDiscord(message: string): Promise<void> {
  const url = Deno.env.get("DISCORD_WEBHOOK_URL");
  if (!url) return;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: message })
  });
}
```

Then call it wherever `sendTelegram()` is called.

---

## adding new triggers

1. add a condition check in the trigger detection block
2. give it a name string (e.g. `"whale_exit"`)
3. add a prompt branch in the content generation block
4. add a row to the channel routing logic

The `decisions_log` table will automatically record the new trigger type.

---

## switching AI models

Each provider function has a hardcoded model string. Change it directly:

- Grok: `model: "grok-3-mini"` → `"grok-3"` for more capable output
- OpenAI: `model: "gpt-4o-mini"` → `"gpt-4o"` for higher quality
- Nemotron: model string is already the largest available

---

## running on a different schedule

The default is every 5 minutes. To change it, edit `scripts/setup_cron.sql`
and rerun it in the SQL Editor. Standard cron syntax applies.

Note: DEXScreener's free API refreshes roughly every 30-60 seconds,
so running faster than every 2 minutes won't improve data freshness.
