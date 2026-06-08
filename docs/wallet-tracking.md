# wallet tracking & bundle detection

The `wallet-tracker` edge function watches every on-chain transaction
for your token and builds a complete picture of who is buying, selling,
and acting in coordination.

---

## what it does

- fetches recent transactions for the token mint from the Solana RPC
- parses each transaction to extract wallet, side (buy/sell), token amount, SOL amount, and price
- derives SOL amount via WSOL account delta (works for Jupiter, Raydium CLMM, Orca, Meteora) with native SOL fallback for Raydium AMM v4
- detects relationships between wallets acting in the same slot or within a configurable time window
- gates relationships behind a co-occurrence staging table (MIN_CO_OCCURRENCE = 2) to suppress false positives
- identifies bundles: coordinated buys, coordinated sells, wash trades — deduplicated by SHA-256 hash
- builds and updates a profile for every wallet seen using atomic Postgres increments (lifetime-safe)
- uses advisory locks to prevent concurrent run corruption
- stores everything in Postgres (trades, wallet_profiles, wallet_relationships, bundles)

---

## setup order (important)

1. Run migration `20260608000000_create_monitoring_schema.sql`
2. Run migration `20260608000001_create_wallet_tracking_schema.sql`
3. Run migration `20260608000002_wallet_tracking_fixes.sql` ← **required before deploying v2 function**
4. Deploy edge function: `supabase functions deploy wallet-tracker --no-verify-jwt`
5. Add secrets:
   ```
   TOKEN_MINT         your token's mint address
   SOLANA_RPC_URL     your paid RPC endpoint (Helius/QuickNode/Triton — see note below)
   ```
6. Set up cron (see scripts/setup_cron.sql)

> **RPC note:** The function will work with the public RPC but will drop trades under load due to rate limiting. For any real-volume token, use a paid RPC. Helius free tier (100k req/day) is sufficient for most tokens.

---

## database tables

| table | contains |
|-------|----------|
| `trades` | every individual buy/sell tx: wallet, amount, price, program, sol derivation method |
| `wallet_profiles` | lifetime aggregated stats: buys/sells, SOL volume, PnL, bundle score, tags (`data_quality` flag indicates pre/post fix) |
| `wallet_relationships` | confirmed relationship pairs (co_occurrence ≥ 2), with type and confidence |
| `relationship_staging` | first-seen relationships awaiting second confirmation (TTL: 1 hour) |
| `bundles` | deduplicated groups of wallets acting together (unique by SHA-256 hash) |
| `token_meta` | token launch time and metadata (used for sniper detection) |

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
| `sniper` | first buy within 5 minutes of token launch time (from `token_meta`) |
| `whale` | moved more than 50 SOL total |
| `bot` | more than 20 trades observed |
| `flipper` | roughly equal buys and sells |

---

## historical scan

To scan the entire trading history from launch:

```bash
export SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
bash scripts/historical_scan.sh YOUR_PROJECT_REF
```

The scan saves its cursor to `.scan_state` after every page.
If it crashes or is interrupted, just re-run the same command — it resumes automatically.
To force a fresh scan from the beginning: `rm .scan_state`

**RPC rate limits:** On the public RPC, the scan will slow dramatically due to 429s and backoff.
For a token with >50k transactions, use a paid RPC.

---

## querying the data

**Top buyers by lifetime volume:**
```sql
select wallet, total_buys, total_buy_sol, bundle_score, tags, data_quality
from wallet_profiles
where data_quality = 'verified'   -- exclude pre-fix rows if any remain
order by total_buy_sol desc
limit 20;
```

**All confirmed bundlers:**
```sql
select wallet, bundle_score, tags, total_buy_sol
from wallet_profiles
where bundle_score >= 60
order by bundle_score desc;
```

**Wallets buying and selling at the same time:**
```sql
select wallet_a, wallet_b, relationship_type, co_occurrence, confidence
from wallet_relationships
where relationship_type in ('same_slot_buy','same_slot_sell','wash_trade')
order by confidence desc;
```

**All detected bundles:**
```sql
select bundle_type, wallets, total_sol, confidence, notes, detected_at
from bundles
order by detected_at desc;
```

**Full trade history for a wallet:**
```sql
select signature, block_time, side, token_amount, sol_amount, price_per_token, program
from trades
where wallet = 'WALLET_ADDRESS'
order by block_time desc;
```

**Wallets with suspicious data (pre-fix baseline — rebuild recommended):**
```sql
select wallet, total_buy_sol, data_quality
from wallet_profiles
where data_quality = 'pre_fix';
```
