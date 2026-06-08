// =============================================================================
// wallet-tracker — Solana Wallet & Trade Tracker Edge Function
// v2: all 12 issues fixed
//   - incremental lifetime-safe wallet profile upserts via Postgres function
//   - bundle dedup via SHA-256 hash
//   - batched relationship lookup via rpc (single round-trip)
//   - bulk wallet upsert replaced with per-wallet Postgres RPC (atomic increments)
//   - sniper tag uses token launch time from token_meta table
//   - MIN_CO_OCCURRENCE staging gate via relationship_staging table
//   - WSOL account delta for SOL amount with AMM v4 native fallback
//   - null blockTime guarded (skipped, not stored as epoch 0)
//   - advisory lock prevents concurrent run corruption
//   - O(n²) pairwise loop capped at 20 wallets per slot
//   - public RPC warning in response
//   - DB function health check at boot
// =============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const MINT          = Deno.env.get("TOKEN_MINT") ?? "";
const RPC_URL       = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const SOL_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

const TX_LIMIT                   = 100;
const COORDINATED_WINDOW_SECONDS = 10;
const MIN_CO_OCCURRENCE          = 2;       // relationships must be seen this many times before promotion
const MAX_PAIRWISE_WALLETS       = 20;      // OOM guard: skip pairwise loop above this wallet count per slot
const WSOL_MINT                  = "So11111111111111111111111111111111111111112";

const IS_PUBLIC_RPC = RPC_URL.includes("mainnet-beta.solana.com");

const DEX_PROGRAMS: Record<string, string> = {
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "raydium",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "raydium_clmm",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4":  "jupiter",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc":  "orca",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "meteora",
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface ParsedTrade {
  signature     : string;
  blockTime     : number;
  slot          : number;
  wallet        : string;
  side          : "buy" | "sell";
  tokenAmount   : number;
  solAmount     : number;
  pricePerToken : number;
  usdValue      : number;
  program       : string;
  solSource     : "wsol" | "native"; // which method was used to derive solAmount
  raw           : Record<string, unknown>;
}

interface WalletSummary {
  wallet: string;
  buys  : ParsedTrade[];
  sells : ParsedTrade[];
}

interface RelationshipResult {
  wallet_a         : string;
  wallet_b         : string;
  relationship_type: string;
  confidence       : number;
  evidence         : Record<string, unknown>;
}

interface BundleResult {
  bundle_type : string;
  wallets     : string[];
  slot_min    : number;
  slot_max    : number;
  time_min    : number;
  time_max    : number;
  total_sol   : number;
  total_tokens: number;
  confidence  : number;
  signatures  : string[];
  notes       : string;
  dedup_hash  : string;
}

// ─────────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

async function sha256hex(input: string): Promise<string> {
  const buf    = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function bundleDedupHash(bundle_type: string, slot: number, wallets: string[]): Promise<string> {
  // Sort wallets for deterministic ordering regardless of JS insertion order
  const key = `${bundle_type}:${slot}:${[...wallets].sort().join(",")}`;
  return sha256hex(key);
}

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(SOL_PRICE_URL, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return 150;
    const data = await res.json();
    return data?.solana?.usd ?? 150;
  } catch {
    return 150;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOLANA RPC
// ─────────────────────────────────────────────────────────────────────────────

async function rpc(method: string, params: unknown[], retries = 3): Promise<unknown> {
  let delay = 1000;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(RPC_URL, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal : AbortSignal.timeout(30_000),
    });
    // Retry on 429 or 5xx with exponential backoff
    if (res.status === 429 || res.status >= 500) {
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.min(delay, 30_000)));
        delay *= 2;
        continue;
      }
      throw new Error(`RPC HTTP ${res.status} after ${retries} retries`);
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }
  throw new Error("RPC: exhausted retries");
}

async function getSignaturesForAddress(mint: string, limit: number, before?: string): Promise<Array<{
  signature: string;
  slot: number;
  blockTime: number | null;
}>> {
  const params: unknown[] = [
    mint,
    { limit, commitment: "confirmed", ...(before ? { before } : {}) },
  ];
  const result = await rpc("getSignaturesForAddress", params);
  return (result as Array<{ signature: string; slot: number; blockTime: number | null }>) ?? [];
}

async function getTransaction(sig: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await rpc("getTransaction", [
      sig,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ]);
    return result as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TRADE PARSER
// ─────────────────────────────────────────────────────────────────────────────

function detectProgram(tx: Record<string, unknown>): string {
  const message      = (tx?.transaction as Record<string, unknown>)?.message as Record<string, unknown>;
  const instructions = (message?.instructions as Array<Record<string, unknown>>) ?? [];
  for (const ix of instructions) {
    const prog = ix?.programId as string;
    if (DEX_PROGRAMS[prog]) return DEX_PROGRAMS[prog];
  }
  const inner = (tx?.meta as Record<string, unknown>)?.innerInstructions as Array<Record<string, unknown>>;
  if (inner) {
    for (const group of inner) {
      for (const ix of (group?.instructions as Array<Record<string, unknown>>) ?? []) {
        const prog = ix?.programId as string;
        if (DEX_PROGRAMS[prog]) return DEX_PROGRAMS[prog];
      }
    }
  }
  return "other";
}

/**
 * Derives SOL amount from the transaction.
 * Strategy 1 (preferred): WSOL token account delta — works for Jupiter, Raydium CLMM, Orca, Meteora.
 * Strategy 2 (fallback):  native SOL balance delta — works for Raydium AMM v4 native pools.
 * Logs which path was used via solSource.
 */
function deriveSolAmount(
  tx        : Record<string, unknown>,
  wallet    : string,
  signerIndex: number,
): { solAmount: number; solSource: "wsol" | "native" } {
  const meta              = tx.meta as Record<string, unknown>;
  const preTokenBalances  = (meta?.preTokenBalances  as Array<Record<string, unknown>>) ?? [];
  const postTokenBalances = (meta?.postTokenBalances as Array<Record<string, unknown>>) ?? [];

  // Strategy 1: WSOL account delta
  let wsolDelta = 0;
  for (const post of postTokenBalances) {
    if ((post.mint as string) !== WSOL_MINT) continue;
    const idx     = post.accountIndex as number;
    const postAmt = parseFloat((post.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
    const preEntry = preTokenBalances.find((p) => p.accountIndex === idx && (p.mint as string) === WSOL_MINT);
    const preAmt  = parseFloat((preEntry?.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
    wsolDelta += postAmt - preAmt;
  }
  if (Math.abs(wsolDelta) > 0.000001) {
    return { solAmount: Math.abs(wsolDelta), solSource: "wsol" };
  }

  // Strategy 2: native SOL balance delta fallback
  const preBalances  = (meta?.preBalances  as number[]) ?? [];
  const postBalances = (meta?.postBalances as number[]) ?? [];
  const nativeDelta  = signerIndex >= 0
    ? (postBalances[signerIndex] - preBalances[signerIndex]) / 1e9
    : 0;
  return { solAmount: Math.abs(nativeDelta), solSource: "native" };
}

function parseTrade(
  sig      : string,
  slot     : number,
  blockTime: number,
  tx       : Record<string, unknown>,
  mint     : string,
  solPrice : number,
): ParsedTrade | null {
  try {
    const meta    = tx.meta as Record<string, unknown>;
    const message = (tx.transaction as Record<string, unknown>)?.message as Record<string, unknown>;
    if (!meta || !message) return null;
    if (meta.err !== null && meta.err !== undefined) return null;

    const accountKeys = (message.accountKeys as Array<Record<string, unknown>>) ?? [];
    const signer      = accountKeys.find((k) => k.signer === true);
    const wallet      = (signer?.pubkey as string) ?? (accountKeys[0]?.pubkey as string);
    if (!wallet) return null;

    const preTokenBalances  = (meta.preTokenBalances  as Array<Record<string, unknown>>) ?? [];
    const postTokenBalances = (meta.postTokenBalances as Array<Record<string, unknown>>) ?? [];

    let totalTokenDelta = 0;
    const mintAccounts  = new Set<number>();

    for (const post of postTokenBalances) {
      if ((post.mint as string) !== mint) continue;
      const accountIndex = post.accountIndex as number;
      mintAccounts.add(accountIndex);
      const postAmt  = parseFloat((post.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
      const preEntry = preTokenBalances.find((p) => p.accountIndex === accountIndex && (p.mint as string) === mint);
      const preAmt   = parseFloat((preEntry?.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
      totalTokenDelta += postAmt - preAmt;
    }
    for (const pre of preTokenBalances) {
      if ((pre.mint as string) !== mint) continue;
      if (!mintAccounts.has(pre.accountIndex as number)) {
        totalTokenDelta -= parseFloat((pre.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
      }
    }

    if (Math.abs(totalTokenDelta) < 0.0001) return null;

    const signerIndex              = accountKeys.findIndex((k) => (k.pubkey as string) === wallet);
    const { solAmount, solSource } = deriveSolAmount(tx, wallet, signerIndex);

    const side        : "buy" | "sell" = totalTokenDelta > 0 ? "buy" : "sell";
    const tokenAmount  = Math.abs(totalTokenDelta);
    const pricePerToken = tokenAmount > 0 ? solAmount / tokenAmount : 0;
    const usdValue     = solAmount * solPrice;
    const program      = detectProgram(tx);

    return { signature: sig, blockTime, slot, wallet, side, tokenAmount, solAmount, pricePerToken, usdValue, program, solSource, raw: tx };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONSHIP & BUNDLE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

async function detectRelationshipsAndBundles(trades: ParsedTrade[]): Promise<{
  relationships: RelationshipResult[];
  bundles      : BundleResult[];
}> {
  const relationships: RelationshipResult[] = [];
  const bundles      : BundleResult[]       = [];

  if (trades.length < 2) return { relationships, bundles };

  const bySlot = new Map<number, ParsedTrade[]>();
  for (const t of trades) {
    const list = bySlot.get(t.slot) ?? [];
    list.push(t);
    bySlot.set(t.slot, list);
  }

  // Time-window grouping
  const sorted       = [...trades].sort((a, b) => a.blockTime - b.blockTime);
  const timeGroups   : ParsedTrade[][] = [];
  let   currentGroup : ParsedTrade[]   = [];
  for (const t of sorted) {
    if (!currentGroup.length) {
      currentGroup.push(t);
    } else if (t.blockTime - currentGroup[0].blockTime <= COORDINATED_WINDOW_SECONDS) {
      currentGroup.push(t);
    } else {
      if (currentGroup.length > 1) timeGroups.push(currentGroup);
      currentGroup = [t];
    }
  }
  if (currentGroup.length > 1) timeGroups.push(currentGroup);

  // Same-slot analysis
  for (const [slot, slotTrades] of bySlot) {
    if (slotTrades.length < 2) continue;
    const buyers  = slotTrades.filter((t) => t.side === "buy");
    const sellers = slotTrades.filter((t) => t.side === "sell");

    // Buyers
    if (buyers.length >= 2) {
      const wallets = [...new Set(buyers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
        const hash = await bundleDedupHash("launch_bundle", slot, wallets);
        bundles.push({
          bundle_type : "launch_bundle",
          wallets,
          slot_min    : slot,
          slot_max    : slot,
          time_min    : Math.min(...buyers.map((t) => t.blockTime)),
          time_max    : Math.max(...buyers.map((t) => t.blockTime)),
          total_sol   : buyers.reduce((s, t) => s + t.solAmount, 0),
          total_tokens: buyers.reduce((s, t) => s + t.tokenAmount, 0),
          confidence  : Math.min(100, 50 + wallets.length * 10),
          signatures  : buyers.map((t) => t.signature),
          notes       : `${wallets.length} wallets bought in slot ${slot}`,
          dedup_hash  : hash,
        });
        // OOM guard: skip pairwise if too many wallets
        if (wallets.length <= MAX_PAIRWISE_WALLETS) {
          for (let i = 0; i < wallets.length; i++) {
            for (let j = i + 1; j < wallets.length; j++) {
              relationships.push({ wallet_a: wallets[i], wallet_b: wallets[j], relationship_type: "same_slot_buy", confidence: 80, evidence: { slot, signatures: buyers.map((t) => t.signature) } });
            }
          }
        } else {
          relationships.push({ wallet_a: wallets[0], wallet_b: "HIGH_ACTIVITY_SLOT", relationship_type: "same_slot_buy", confidence: 95, evidence: { slot, wallet_count: wallets.length, note: "pairwise skipped — exceeds MAX_PAIRWISE_WALLETS" } });
        }
      }
    }

    // Sellers
    if (sellers.length >= 2) {
      const wallets = [...new Set(sellers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
        const hash = await bundleDedupHash("coordinated_sell", slot, wallets);
        bundles.push({
          bundle_type : "coordinated_sell",
          wallets,
          slot_min    : slot,
          slot_max    : slot,
          time_min    : Math.min(...sellers.map((t) => t.blockTime)),
          time_max    : Math.max(...sellers.map((t) => t.blockTime)),
          total_sol   : sellers.reduce((s, t) => s + t.solAmount, 0),
          total_tokens: sellers.reduce((s, t) => s + t.tokenAmount, 0),
          confidence  : Math.min(100, 60 + wallets.length * 10),
          signatures  : sellers.map((t) => t.signature),
          notes       : `${wallets.length} wallets sold in slot ${slot}`,
          dedup_hash  : hash,
        });
        if (wallets.length <= MAX_PAIRWISE_WALLETS) {
          for (let i = 0; i < wallets.length; i++) {
            for (let j = i + 1; j < wallets.length; j++) {
              relationships.push({ wallet_a: wallets[i], wallet_b: wallets[j], relationship_type: "same_slot_sell", confidence: 85, evidence: { slot, signatures: sellers.map((t) => t.signature) } });
            }
          }
        }
      }
    }

    // Wash trade: same wallet both sides in same slot
    const buyWallets  = [...new Set(buyers.map((t) => t.wallet))];
    const sellWallets = [...new Set(sellers.map((t) => t.wallet))];
    const overlap     = buyWallets.filter((w) => sellWallets.includes(w));
    if (overlap.length > 0) {
      const hash = await bundleDedupHash("wash_trade", slot, overlap);
      bundles.push({
        bundle_type : "wash_trade",
        wallets     : overlap,
        slot_min    : slot,
        slot_max    : slot,
        time_min    : Math.min(...slotTrades.map((t) => t.blockTime)),
        time_max    : Math.max(...slotTrades.map((t) => t.blockTime)),
        total_sol   : slotTrades.reduce((s, t) => s + t.solAmount, 0),
        total_tokens: slotTrades.reduce((s, t) => s + t.tokenAmount, 0),
        confidence  : 90,
        signatures  : slotTrades.map((t) => t.signature),
        notes       : `${overlap.length} wallet(s) both bought and sold in slot ${slot}`,
        dedup_hash  : hash,
      });
    }
  }

  // Time-window coordinated relationships
  for (const group of timeGroups) {
    const buyers  = group.filter((t) => t.side === "buy");
    const sellers = group.filter((t) => t.side === "sell");

    const addCoordinated = (side: "buy" | "sell", type: string, sideConf: number, existingType: string) => {
      const pool    = side === "buy" ? buyers : sellers;
      const wallets = [...new Set(pool.map((t) => t.wallet))];
      if (wallets.length < 2) return;
      if (wallets.length > MAX_PAIRWISE_WALLETS) return;
      for (let i = 0; i < wallets.length; i++) {
        for (let j = i + 1; j < wallets.length; j++) {
          const alreadyLinked = relationships.some(
            (r) => ((r.wallet_a === wallets[i] && r.wallet_b === wallets[j]) || (r.wallet_a === wallets[j] && r.wallet_b === wallets[i])) && r.relationship_type === existingType
          );
          if (!alreadyLinked) {
            relationships.push({ wallet_a: wallets[i], wallet_b: wallets[j], relationship_type: type, confidence: sideConf, evidence: { window_seconds: COORDINATED_WINDOW_SECONDS, signatures: pool.map((t) => t.signature) } });
          }
        }
      }
    };
    addCoordinated("buy",  "coordinated_buy",  60, "same_slot_buy");
    addCoordinated("sell", "coordinated_sell", 65, "same_slot_sell");

    // Mirror trade: single wallet buys and sells within window
    const walletGroupTrades = new Map<string, ParsedTrade[]>();
    for (const t of group) {
      const list = walletGroupTrades.get(t.wallet) ?? [];
      list.push(t);
      walletGroupTrades.set(t.wallet, list);
    }
    for (const [wallet, wTrades] of walletGroupTrades) {
      if (wTrades.some((t) => t.side === "buy") && wTrades.some((t) => t.side === "sell")) {
        relationships.push({ wallet_a: wallet, wallet_b: wallet, relationship_type: "mirror_trade", confidence: 70, evidence: { window_seconds: COORDINATED_WINDOW_SECONDS, signatures: wTrades.map((t) => t.signature) } });
      }
    }
  }

  return { relationships, bundles };
}

// ─────────────────────────────────────────────────────────────────────────────
// WALLET PROFILE BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildWalletSummaries(trades: ParsedTrade[]): WalletSummary[] {
  const map = new Map<string, WalletSummary>();
  for (const t of trades) {
    if (!map.has(t.wallet)) map.set(t.wallet, { wallet: t.wallet, buys: [], sells: [] });
    const s = map.get(t.wallet)!;
    t.side === "buy" ? s.buys.push(t) : s.sells.push(t);
  }
  return [...map.values()];
}

function computeBundleScore(wallet: string, relationships: RelationshipResult[], bundles: BundleResult[]): number {
  let score = 0;
  if (bundles.some((b) => b.wallets.includes(wallet))) score += 40;
  const relCount       = relationships.filter((r) => r.wallet_a === wallet || r.wallet_b === wallet).length;
  const highConf       = relationships.filter((r) => (r.wallet_a === wallet || r.wallet_b === wallet) && r.confidence >= 80).length;
  score += Math.min(40, relCount * 10);
  score += Math.min(20, highConf * 10);
  return Math.min(100, score);
}

function assignTags(
  summary     : WalletSummary,
  bundleScore : number,
  bundles     : BundleResult[],
  launchTime  : number | null,   // unix timestamp of first token trade (from token_meta)
): string[] {
  const tags: string[] = [];
  if (bundleScore >= 60) tags.push("bundler");

  // Sniper: only meaningful if we know launch time
  if (launchTime !== null && summary.buys.length > 0) {
    const firstBuyTime = Math.min(...summary.buys.map((t) => t.blockTime));
    if (firstBuyTime - launchTime < 300) tags.push("sniper");  // bought within 5min of launch
  }

  const totalSol = [...summary.buys, ...summary.sells].reduce((s, t) => s + t.solAmount, 0);
  if (totalSol > 50) tags.push("whale");
  if (summary.buys.length + summary.sells.length > 20) tags.push("bot");
  if (summary.buys.length > 0 && summary.sells.length > 0 && Math.abs(summary.buys.length - summary.sells.length) <= 2) tags.push("flipper");
  return tags;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE WRITES
// ─────────────────────────────────────────────────────────────────────────────

async function upsertTrades(sb: SupabaseClient, trades: ParsedTrade[]): Promise<number> {
  if (!trades.length) return 0;
  const rows = trades.map((t) => ({
    signature      : t.signature,
    block_time     : new Date(t.blockTime * 1000).toISOString(),
    slot           : t.slot,
    wallet         : t.wallet,
    side           : t.side,
    token_amount   : t.tokenAmount,
    sol_amount     : t.solAmount,
    price_per_token: t.pricePerToken,
    usd_value      : t.usdValue,
    program        : `${t.program}:${t.solSource}`,  // record which SOL derivation method was used
    raw            : t.raw,
  }));
  const { error, count } = await sb.from("trades").upsert(rows, { onConflict: "signature", count: "exact" });
  if (error) console.error("upsertTrades error:", error.message);
  return count ?? trades.length;
}

async function upsertWalletProfiles(
  sb           : SupabaseClient,
  summaries    : WalletSummary[],
  relationships: RelationshipResult[],
  bundles      : BundleResult[],
  launchTime   : number | null,
): Promise<void> {
  for (const s of summaries) {
    const bundleScore = computeBundleScore(s.wallet, relationships, bundles);
    const tags        = assignTags(s, bundleScore, bundles, launchTime);

    const totalBuySol     = s.buys.reduce((acc, t)  => acc + t.solAmount,    0);
    const totalSellSol    = s.sells.reduce((acc, t) => acc + t.solAmount,    0);
    const totalBuyTokens  = s.buys.reduce((acc, t)  => acc + t.tokenAmount,  0);
    const totalSellTokens = s.sells.reduce((acc, t) => acc + t.tokenAmount,  0);
    const avgBuyPrice     = s.buys.length  > 0 ? s.buys.reduce((acc, t)  => acc + t.pricePerToken, 0) / s.buys.length  : null;
    const avgSellPrice    = s.sells.length > 0 ? s.sells.reduce((acc, t) => acc + t.pricePerToken, 0) / s.sells.length : null;
    const realizedPnl     = avgSellPrice !== null && avgBuyPrice !== null
      ? (avgSellPrice - avgBuyPrice) * Math.min(totalBuyTokens, totalSellTokens)
      : null;

    const allTimes  = [...s.buys, ...s.sells].map((t) => t.blockTime);
    const firstSeen = Math.min(...allTimes);
    const lastSeen  = Math.max(...allTimes);

    // Use the Postgres function for atomic incremental upsert
    const { error } = await sb.rpc("upsert_wallet_profile_incremental", {
      p_wallet        : s.wallet,
      p_first_seen    : new Date(firstSeen * 1000).toISOString(),
      p_last_seen     : new Date(lastSeen  * 1000).toISOString(),
      p_buy_count     : s.buys.length,
      p_sell_count    : s.sells.length,
      p_buy_sol       : totalBuySol,
      p_sell_sol      : totalSellSol,
      p_buy_tokens    : totalBuyTokens,
      p_sell_tokens   : totalSellTokens,
      p_avg_buy_price : avgBuyPrice,
      p_avg_sell_price: avgSellPrice,
      p_realized_pnl  : realizedPnl,
      p_bundle_score  : bundleScore,
      p_tags          : tags,
    });
    if (error) console.error(`upsertWalletProfile error for ${s.wallet}:`, error.message);
  }
}

async function upsertRelationships(sb: SupabaseClient, relationships: RelationshipResult[]): Promise<void> {
  if (!relationships.length) return;

  // Normalise wallet order for dedup
  const normed = relationships.map((r) => {
    const [wa, wb] = r.wallet_a <= r.wallet_b ? [r.wallet_a, r.wallet_b] : [r.wallet_b, r.wallet_a];
    return { ...r, wallet_a: wa, wallet_b: wb };
  });

  // 1. Check staging table for first-seen gate
  //    Relationships seen only once go to staging. Seen twice+ are promoted.
  const stagingCheck = await sb
    .from("relationship_staging")
    .select("wallet_a, wallet_b, relationship_type")
    .in("wallet_a", normed.map((r) => r.wallet_a))
    .in("wallet_b", normed.map((r) => r.wallet_b));

  const staged = new Set(
    (stagingCheck.data ?? []).map((r) => `${r.wallet_a}|${r.wallet_b}|${r.relationship_type}`)
  );

  const toInsertIntoStaging : typeof normed = [];
  const toPromote           : typeof normed = [];

  for (const r of normed) {
    const key = `${r.wallet_a}|${r.wallet_b}|${r.relationship_type}`;
    if (staged.has(key)) {
      toPromote.push(r);                  // seen before → promote to wallet_relationships
    } else {
      toInsertIntoStaging.push(r);        // first time → stage it
    }
  }

  // Write first-seen to staging
  if (toInsertIntoStaging.length) {
    await sb.from("relationship_staging").upsert(
      toInsertIntoStaging.map((r) => ({
        wallet_a         : r.wallet_a,
        wallet_b         : r.wallet_b,
        relationship_type: r.relationship_type,
        confidence       : r.confidence,
        evidence         : r.evidence,
      })),
      { onConflict: "wallet_a,wallet_b,relationship_type" }
    );
  }

  // Promote confirmed relationships
  if (toPromote.length) {
    // Single bulk lookup via Postgres RPC
    const pairs = toPromote.map((r) => ({ wallet_a: r.wallet_a, wallet_b: r.wallet_b, relationship_type: r.relationship_type }));
    const { data: existing } = await sb.rpc("bulk_lookup_relationships", { pairs: JSON.stringify(pairs) });
    const existingMap = new Map<string, { id: number; co_occurrence: number; confidence: number }>(
      (existing ?? []).map((e: { id: number; wallet_a: string; wallet_b: string; relationship_type: string; co_occurrence: number; confidence: number }) => [
        `${e.wallet_a}|${e.wallet_b}|${e.relationship_type}`,
        { id: e.id, co_occurrence: e.co_occurrence, confidence: e.confidence },
      ])
    );

    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: { id: number; co_occurrence: number; confidence: number }[] = [];

    for (const r of toPromote) {
      const key = `${r.wallet_a}|${r.wallet_b}|${r.relationship_type}`;
      const ex  = existingMap.get(key);
      if (ex) {
        toUpdate.push({ id: ex.id, co_occurrence: ex.co_occurrence + 1, confidence: Math.min(100, r.confidence + ex.co_occurrence * 2) });
      } else {
        toInsert.push({ wallet_a: r.wallet_a, wallet_b: r.wallet_b, relationship_type: r.relationship_type, co_occurrence: MIN_CO_OCCURRENCE, confidence: r.confidence, evidence: r.evidence });
      }
    }

    if (toInsert.length) {
      await sb.from("wallet_relationships").insert(toInsert);
    }
    for (const u of toUpdate) {
      await sb.from("wallet_relationships").update({ co_occurrence: u.co_occurrence, last_seen_at: new Date().toISOString(), confidence: u.confidence }).eq("id", u.id);
    }

    // Clean up promoted entries from staging + TTL cleanup (>1h old)
    await sb.from("relationship_staging").delete().in(
      "wallet_a", toPromote.map((r) => r.wallet_a)
    );
    await sb.from("relationship_staging").delete().lt("seen_at", new Date(Date.now() - 3_600_000).toISOString());
  }
}

async function insertBundles(sb: SupabaseClient, bundles: BundleResult[]): Promise<void> {
  if (!bundles.length) return;
  const rows = bundles.map((b) => ({
    bundle_type : b.bundle_type,
    wallets     : b.wallets,
    slot_range  : `[${b.slot_min},${b.slot_max}]`,
    time_range  : `[${new Date(b.time_min * 1000).toISOString()},${new Date(b.time_max * 1000).toISOString()}]`,
    total_sol   : b.total_sol,
    total_tokens: b.total_tokens,
    confidence  : b.confidence,
    notes       : b.notes,
    signatures  : b.signatures,
    dedup_hash  : b.dedup_hash,
  }));
  // ON CONFLICT DO NOTHING via the unique index on dedup_hash
  const { error } = await sb.from("bundles").upsert(rows, { onConflict: "dedup_hash", ignoreDuplicates: true });
  if (error) console.error("insertBundles error:", error.message);
}

// ─────────────────────────────────────────────────────────────────────────────
// TOKEN META (launch time for sniper detection)
// ─────────────────────────────────────────────────────────────────────────────

async function getOrSetLaunchTime(sb: SupabaseClient, mint: string, trades: ParsedTrade[]): Promise<number | null> {
  // Try to get from DB first
  const { data } = await sb.from("token_meta").select("launch_time").eq("mint", mint).maybeSingle();
  if (data?.launch_time) return Math.floor(new Date(data.launch_time).getTime() / 1000);

  // Not set yet: use the earliest trade we've ever seen for this token
  const { data: earliest } = await sb
    .from("trades")
    .select("block_time")
    .order("block_time", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (earliest?.block_time) {
    const launchTs = Math.floor(new Date(earliest.block_time).getTime() / 1000);
    await sb.from("token_meta").upsert({ mint, launch_time: earliest.block_time }, { onConflict: "mint" });
    return launchTs;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ADVISORY LOCK (prevents concurrent run corruption)
// ─────────────────────────────────────────────────────────────────────────────

async function tryAdvisoryLock(sb: SupabaseClient): Promise<boolean> {
  const { data, error } = await sb.rpc("pg_try_advisory_lock", { key: 1234567890 });
  if (error) return true;   // if lock check fails, proceed (don't block on DB issues)
  return data === true;
}

async function releaseAdvisoryLock(sb: SupabaseClient): Promise<void> {
  await sb.rpc("pg_advisory_unlock", { key: 1234567890 });
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (!MINT) {
    return new Response(JSON.stringify({ ok: false, error: "TOKEN_MINT not set" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  const url    = new URL(req.url);
  const before = url.searchParams.get("before") ?? undefined;
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? String(TX_LIMIT)), 1000);

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // ── DB health check: verify migration 00002 has been run
  const { error: healthErr } = await sb.rpc("ping_increment_wallet_profile");
  if (healthErr) {
    return new Response(JSON.stringify({
      ok   : false,
      error: "DB functions not deployed. Run migration 20260608000002_wallet_tracking_fixes.sql first.",
    }), { status: 503, headers: { "Content-Type": "application/json" } });
  }

  // ── Advisory lock: only one instance writes at a time
  const gotLock = await tryAdvisoryLock(sb);
  if (!gotLock) {
    return new Response(JSON.stringify({ ok: true, skipped: "lock_held", message: "Another instance is running" }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const solPrice = await getSolPrice();

    // 1. Fetch signatures — filter out null blockTime before fetching full txs
    const allSigs  = await getSignaturesForAddress(MINT, limit, before);
    const validSigs = allSigs.filter((s) => s.blockTime !== null);
    const nullCount = allSigs.length - validSigs.length;

    if (!validSigs.length) {
      await releaseAdvisoryLock(sb);
      return new Response(JSON.stringify({ ok: true, message: "No confirmed transactions found", null_blocktime_skipped: nullCount }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Fetch full transactions in batches of 10
    const trades: ParsedTrade[] = [];
    const BATCH = 10;
    for (let i = 0; i < validSigs.length; i += BATCH) {
      const batch   = validSigs.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((s) => getTransaction(s.signature).then((tx) =>
          tx ? parseTrade(s.signature, s.slot, s.blockTime!, tx, MINT, solPrice) : null
        ))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) trades.push(r.value);
      }
    }

    if (!trades.length) {
      await releaseAdvisoryLock(sb);
      return new Response(JSON.stringify({ ok: true, message: "No trades parsed", txs_checked: validSigs.length, null_blocktime_skipped: nullCount }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Detect relationships and bundles
    const { relationships, bundles } = await detectRelationshipsAndBundles(trades);

    // 4. Get token launch time for sniper tagging
    const launchTime = await getOrSetLaunchTime(sb, MINT, trades);

    // 5. Build wallet summaries
    const summaries = buildWalletSummaries(trades);

    // 6. Persist everything
    const savedTrades = await upsertTrades(sb, trades);
    await upsertWalletProfiles(sb, summaries, relationships, bundles, launchTime);
    await upsertRelationships(sb, relationships);
    await insertBundles(sb, bundles);

    const oldestSig = validSigs[validSigs.length - 1]?.signature ?? null;

    await releaseAdvisoryLock(sb);

    return new Response(JSON.stringify({
      ok                   : true,
      txs_checked          : validSigs.length,
      null_blocktime_skipped: nullCount,
      trades_found         : trades.length,
      trades_saved         : savedTrades,
      wallets              : summaries.length,
      relationships        : relationships.length,
      bundles              : bundles.length,
      oldest_sig           : oldestSig,
      next_page            : oldestSig ? `?before=${oldestSig}&limit=${limit}` : null,
      ...(IS_PUBLIC_RPC ? { warning: "Public RPC detected — rate limits will cause missed trades. Set SOLANA_RPC_URL to a paid endpoint (Helius, QuickNode, Triton)." } : {}),
      summary: {
        buyers         : trades.filter((t) => t.side === "buy").length,
        sellers        : trades.filter((t) => t.side === "sell").length,
        wsol_trades    : trades.filter((t) => t.solSource === "wsol").length,
        native_trades  : trades.filter((t) => t.solSource === "native").length,
        bundlers       : summaries.filter((s) => computeBundleScore(s.wallet, relationships, bundles) >= 60).length,
        flagged_wallets: summaries.filter((s) => assignTags(s, computeBundleScore(s.wallet, relationships, bundles), bundles, launchTime).length > 0).length,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("wallet-tracker fatal:", err);
    await releaseAdvisoryLock(sb).catch(() => {});
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
