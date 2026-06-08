# where to get api keys

All data source keys are optional. DEXScreener needs no key at all.
More keys = more complete data, but the monitor works with just DEXScreener.

---

## DEXScreener

No key required. The monitor queries the public API automatically.
Provides: price, volume, buy/sell counts, liquidity, trending rank.

---

## Birdeye

Provides: token overview, holder count.

1. go to [birdeye.so](https://birdeye.so)
2. sign up and go to your dashboard
3. API → Create API Key
4. free tier is sufficient
5. add as `BIRDEYE_API_KEY` in Supabase secrets

---

## Solscan

Provides: top holder list, holder concentration metrics.

1. go to [pro.solscan.io](https://pro.solscan.io)
2. sign up
3. API → Get API Token
4. free tier works
5. add as `SOLSCAN_API_KEY` in Supabase secrets

---

## X / Twitter Bearer Token

Provides: mention count, sentiment, engagement data.

1. go to [developer.twitter.com](https://developer.twitter.com)
2. create a project and app (free basic tier works)
3. Keys and Tokens → Bearer Token
4. add as `X_BEARER_TOKEN` in Supabase secrets

---

## X OAuth keys (for posting tweets)

Only needed if you're running `scripts/x_poster.py`.

1. same developer portal as above
2. Keys and Tokens → API Key and Secret + Access Token and Secret
3. make sure your app has Read and Write permissions
4. add all four to your `.env` file:
   - `X_API_KEY`
   - `X_API_SECRET`
   - `X_ACCESS_TOKEN`
   - `X_ACCESS_TOKEN_SECRET`

See [ai-providers.md](ai-providers.md) for AI key setup.
