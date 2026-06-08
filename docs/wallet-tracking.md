# wallet tracking & bundle detection

The `wallet-tracker` edge function watches every on-chain transaction
for your token and builds a complete picture of who is buying, selling,
and acting in coordination.

---

## what it does

- fetches recent transactions for the token mint from the Solana RPC
- parses each transaction to extract wallet, side (buy/sell), token amount, SOL amount, and price
- detects relationships between wallets acting in the same slot or within a configurable time window
- identifies bundles: coordinated buys, coordinated sells, wash trades
- builds and updates a profile for every wallet seen
- stores everything in Postgres (trades, wallet_profiles, wallet_relationships, bundles)

---

## database tables

| table | contains |
|-------|----------|
| `trades` | every individual buy/sell tx with wallet, amount, price, program |
| `wallet_profiles` | aggregated stats per wallet: total buys/sells, PnL, bundle score, tags |
| `wallet_relationships` | pairs of wallets flagged as related, with type and confidence |
| `bundles` | groups of wallets acting together in a slot or time window |

---

## relationship types

| type | meaning |
|------|---------|
| `same_slot_buy` | 2+ wallets bought in the exact same slot |
| `same_slot_sell` | 2+ wallets sold in the exact same slot |
| `coordinated_buy` | 2+ wallets bought within 10 seconds of each other |
| `coordinated_sell` | 2+ wallets sold within 10 seconds of each other |
| `mirror_trade` | single wallet both bought and sold within 10 seconds |
| `wash_trade` | wallet bought and sold in the exact same slot |

---

## bundle types

| type | meaning |
|------|---------|
| `launch_bundle` | multiple wallets bought in the same slot (classic sniper bundle) |
| `coordinated_sell` | multiple wallets sold in the same slot |
| `wash_trade` | wallet is both buyer and seller in the same slot |

---

## wallet tags

| tag | assigned when |
|-----|---------------|
| `bundler` | bundle score ≥ 60 |
| `sniper` | bought within 5 minutes of first appearance in the tracker |
| `whale` | moved more than 50 SOL total |
| `bot` | more than 20 trades observed |
| `flipper` | roughly equal buys and sells |

---

## setup

Add one secret to Supabase:

```
SOLANA_RPC_URL    your RPC endpoint (default: mainnet-beta public)
```

For production use a paid RPC like Helius, QuickNode, or Triton:
```
https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
```
The free public RPC rate-limits aggressively on `getTransaction`.

Deploy the function:
```bash
supabase functions deploy wallet-tracker --no-verify-jwt
```

Then run the migration:
```bash
# paste supabase/migrations/20260608000001_create_wallet_tracking_schema.sql
# into the SQL Editor
```

---

## historical scan

To scan the entire trading history and build a complete picture of
coin movement from launch:

```bash
export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
bash scripts/historical_scan.sh YOUR_PROJECT_REF
```

This walks backwards through all transactions, page by page (100 per page),
untilit reaches the first ever trade. It writes every trade and relationship
it finds to the database as it goes, so it is safe to stop and resume.

To resume from where it stopped, pass the oldest signature from the last run:
```bash
bash scripts/historical_scan.sh YOUR_PROJECT_REF OLDEST_SIGNATURE
```

---

## querying the data

Top buyers by volume:
```sql
select wallet, total_buys, total_buy_sol, bundle_score, tags
from wallet_profiles
order by total_buy_sol desc
limit 20;
```

All flagged bundlers:
```sql
select wallet, bundle_score, tags, total_buy_sol
from wallet_profiles
where bundle_score >= 60
order by bundle_score desc;
```

Wallets buying and selling at the same time:
```sql
select wallet_a, wallet_b, relationship_type, co_occurrence, confidence
from wallet_relationships
where relationship_type in ('same_slot_buy','same_slot_sell','wash_trade')
order by confidence desc;
```

All detected bundles:
```sql
select bundle_type, wallets, total_sol, confidence, notes
from bundles
order by detected_at desc;
```

Full trade history for a wallet:
```sql
select signature, block_time, side, token_amount, sol_amount, price_per_token, program
from trades
where wallet = 'WALLET_ADDRESS'
order by block_time desc;
```
