// =============================================================================
// wallet-tracker — Solana Wallet & Trade Tracker Edge Function
// Fetches recent transactions for the monitored token, extracts buy/sell
// trades, profiles wallets, detects address relationships and bundles.
// Run every 5 minutes via pg_cron (or on demand).
// =============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const MINT          = Deno.env.get("TOKEN_MINT") ?? "";
const RPC_URL       = Deno.env.get("SOLANA_RPC_URL") ?? "https://api.mainnet-beta.solana.com";
const SOL_PRICE_URL = "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";

// How many transactions to fetch per cycle (max 1000 per Solana RPC call)
const TX_LIMIT = 100;

// Bundle detection: wallets acting within this many slots are flagged
const BUNDLE_SLOT_WINDOW = 3;

// Wallets acting within this many seconds are flagged as coordinated
const COORDINATED_WINDOW_SECONDS = 10;

// Minimum co-occurrences before a relationship is flagged
const MIN_CO_OCCURRENCE = 2;

// Known DEX program IDs
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
  signature       : string;
  blockTime       : number;         // unix timestamp
  slot            : number;
  wallet          : string;
  side            : "buy" | "sell";
  tokenAmount     : number;
  solAmount       : number;
  pricePerToken   : number;
  usdValue        : number;
  program         : string;
  raw             : Record<string, unknown>;
}

interface WalletSummary {
  wallet          : string;
  buys            : ParsedTrade[];
  sells           : ParsedTrade[];
}

// ─────────────────────────────────────────────────────────────────────────────
// SOL PRICE
// ─────────────────────────────────────────────────────────────────────────────

async function getSolPrice(): Promise<number> {
  try {
    const res = await fetch(SOL_PRICE_URL, { signal: AbortSignal.timeout(6_000) });
    if (!res.ok) return 150; // fallback
    const data = await res.json();
    return data?.solana?.usd ?? 150;
  } catch {
    return 150;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOLANA RPC HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method : "POST",
    headers: { "Content-Type": "application/json" },
    body   : JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal : AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json() as { result?: unknown; error?: { message: string } };
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
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
// Extracts buy/sell side, wallet, token and SOL amounts from a parsed tx.
// Handles Raydium, Jupiter, Orca, Meteora (all use SPL token transfers).
// ─────────────────────────────────────────────────────────────────────────────

function detectProgram(tx: Record<string, unknown>): string {
  const message = (tx?.transaction as Record<string, unknown>)?.message as Record<string, unknown>;
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

function parseTrade(
  sig: string,
  slot: number,
  blockTime: number,
  tx: Record<string, unknown>,
  mint: string,
  solPrice: number,
): ParsedTrade | null {
  try {
    const meta    = tx.meta as Record<string, unknown>;
    const message = (tx.transaction as Record<string, unknown>)?.message as Record<string, unknown>;
    if (!meta || !message) return null;

    // Error check
    if (meta.err !== null && meta.err !== undefined) return null;

    const accountKeys = (message.accountKeys as Array<Record<string, unknown>>) ?? [];
    const signer      = accountKeys.find((k) => k.signer === true);
    const wallet      = (signer?.pubkey as string) ?? accountKeys[0]?.pubkey as string;
    if (!wallet) return null;

    // Find token balance changes for our mint
    const preTokenBalances  = (meta.preTokenBalances  as Array<Record<string, unknown>>) ?? [];
    const postTokenBalances = (meta.postTokenBalances as Array<Record<string, unknown>>) ?? [];

    // Aggregate all token delta for this mint across all accounts
    let totalTokenDelta = 0;
    const mintAccounts = new Set<number>();

    for (const post of postTokenBalances) {
      if ((post.mint as string) !== mint) continue;
      const accountIndex = post.accountIndex as number;
      mintAccounts.add(accountIndex);
      const postAmt = parseFloat((post.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
      const preEntry = preTokenBalances.find((p) => p.accountIndex === accountIndex && (p.mint as string) === mint);
      const preAmt   = parseFloat((preEntry?.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
      totalTokenDelta += postAmt - preAmt;
    }

    // Check accounts in pre but not post (fully drained)
    for (const pre of preTokenBalances) {
      if ((pre.mint as string) !== mint) continue;
      const accountIndex = pre.accountIndex as number;
      if (!mintAccounts.has(accountIndex)) {
        const preAmt = parseFloat((pre.uiTokenAmount as Record<string, string>)?.uiAmountString ?? "0");
        totalTokenDelta -= preAmt;
      }
    }

    if (Math.abs(totalTokenDelta) < 0.0001) return null; // dust / irrelevant

    // SOL delta for the signer
    const signerIndex  = accountKeys.findIndex((k) => (k.pubkey as string) === wallet);
    const preBalances  = (meta.preBalances  as number[]) ?? [];
    const postBalances = (meta.postBalances as number[]) ?? [];
    const solDelta     = signerIndex >= 0
      ? (postBalances[signerIndex] - preBalances[signerIndex]) / 1e9
      : 0;

    const side: "buy" | "sell" = totalTokenDelta > 0 ? "buy" : "sell";
    const tokenAmount  = Math.abs(totalTokenDelta);
    const solAmount    = Math.abs(solDelta);
    const pricePerToken = tokenAmount > 0 ? solAmount / tokenAmount : 0;
    const usdValue     = solAmount * solPrice;
    const program      = detectProgram(tx);

    return {
      signature: sig,
      blockTime,
      slot,
      wallet,
      side,
      tokenAmount,
      solAmount,
      pricePerToken,
      usdValue,
      program,
      raw: tx,
    };
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RELATIONSHIP & BUNDLE DETECTION
// ─────────────────────────────────────────────────────────────────────────────

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
}

function detectRelationshipsAndBundles(trades: ParsedTrade[]): {
  relationships: RelationshipResult[];
  bundles: BundleResult[];
} {
  const relationships: RelationshipResult[] = [];
  const bundles: BundleResult[]             = [];

  if (trades.length < 2) return { relationships, bundles };

  // Group trades by slot
  const bySlot = new Map<number, ParsedTrade[]>();
  for (const t of trades) {
    const list = bySlot.get(t.slot) ?? [];
    list.push(t);
    bySlot.set(t.slot, list);
  }

  // Group trades by time window (COORDINATED_WINDOW_SECONDS)
  const sorted     = [...trades].sort((a, b) => a.blockTime - b.blockTime);
  const timeGroups : ParsedTrade[][] = [];
  let   currentGroup: ParsedTrade[]  = [];

  for (const t of sorted) {
    if (currentGroup.length === 0) {
      currentGroup.push(t);
    } else {
      const windowStart = currentGroup[0].blockTime;
      if (t.blockTime - windowStart <= COORDINATED_WINDOW_SECONDS) {
        currentGroup.push(t);
      } else {
        if (currentGroup.length > 1) timeGroups.push(currentGroup);
        currentGroup = [t];
      }
    }
  }
  if (currentGroup.length > 1) timeGroups.push(currentGroup);

  // Same-slot relationships
  for (const [slot, slotTrades] of bySlot) {
    if (slotTrades.length < 2) continue;

    const buyers  = slotTrades.filter((t) => t.side === "buy");
    const sellers = slotTrades.filter((t) => t.side === "sell");

    // Multiple buyers in same slot = potential bundle
    if (buyers.length >= 2) {
      const wallets = [...new Set(buyers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
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
        });

        // Pairwise relationships
        for (let i = 0; i < wallets.length; i++) {
          for (let j = i + 1; j < wallets.length; j++) {
            relationships.push({
              wallet_a         : wallets[i],
              wallet_b         : wallets[j],
              relationship_type: "same_slot_buy",
              confidence       : 80,
              evidence         : { slot, signatures: buyers.map((t) => t.signature) },
            });
          }
        }
      }
    }

    // Multiple sellers in same slot = coordinated dump
    if (sellers.length >= 2) {
      const wallets = [...new Set(sellers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
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
        });

        for (let i = 0; i < wallets.length; i++) {
          for (let j = i + 1; j < wallets.length; j++) {
            relationships.push({
              wallet_a         : wallets[i],
              wallet_b         : wallets[j],
              relationship_type: "same_slot_sell",
              confidence       : 85,
              evidence         : { slot, signatures: sellers.map((t) => t.signature) },
            });
          }
        }
      }
    }

    // Buyers and sellers in same slot = potential wash trade
    if (buyers.length >= 1 && sellers.length >= 1) {
      const buyWallets  = [...new Set(buyers.map((t) => t.wallet))];
      const sellWallets = [...new Set(sellers.map((t) => t.wallet))];
      const overlap     = buyWallets.filter((w) => sellWallets.includes(w));
      if (overlap.length > 0) {
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
        });
      }
    }
  }

  // Coordinated time-window relationships
  for (const group of timeGroups) {
    const buyers  = group.filter((t) => t.side === "buy");
    const sellers = group.filter((t) => t.side === "sell");

    if (buyers.length >= 2) {
      const wallets = [...new Set(buyers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
        for (let i = 0; i < wallets.length; i++) {
          for (let j = i + 1; j < wallets.length; j++) {
            // Only add if not already a same-slot relationship
            const alreadyLinked = relationships.some(
              (r) =>
                ((r.wallet_a === wallets[i] && r.wallet_b === wallets[j]) ||
                 (r.wallet_a === wallets[j] && r.wallet_b === wallets[i])) &&
                r.relationship_type === "same_slot_buy"
            );
            if (!alreadyLinked) {
              relationships.push({
                wallet_a         : wallets[i],
                wallet_b         : wallets[j],
                relationship_type: "coordinated_buy",
                confidence       : 60,
                evidence         : {
                  window_seconds: COORDINATED_WINDOW_SECONDS,
                  signatures    : buyers.map((t) => t.signature),
                },
              });
            }
          }
        }
      }
    }

    if (sellers.length >= 2) {
      const wallets = [...new Set(sellers.map((t) => t.wallet))];
      if (wallets.length >= 2) {
        for (let i = 0; i < wallets.length; i++) {
          for (let j = i + 1; j < wallets.length; j++) {
            const alreadyLinked = relationships.some(
              (r) =>
                ((r.wallet_a === wallets[i] && r.wallet_b === wallets[j]) ||
                 (r.wallet_a === wallets[j] && r.wallet_b === wallets[i])) &&
                r.relationship_type === "same_slot_sell"
            );
            if (!alreadyLinked) {
              relationships.push({
                wallet_a         : wallets[i],
                wallet_b         : wallets[j],
                relationship_type: "coordinated_sell",
                confidence       : 65,
                evidence         : {
                  window_seconds: COORDINATED_WINDOW_SECONDS,
                  signatures    : sellers.map((t) => t.signature),
                },
              });
            }
          }
        }
      }
    }

    // Mirror trades: wallet bought then sold (or sold then bought) within window
    const walletGroupTrades = new Map<string, ParsedTrade[]>();
    for (const t of group) {
      const list = walletGroupTrades.get(t.wallet) ?? [];
      list.push(t);
      walletGroupTrades.set(t.wallet, list);
    }
    for (const [wallet, wTrades] of walletGroupTrades) {
      const hasBuy  = wTrades.some((t) => t.side === "buy");
      const hasSell = wTrades.some((t) => t.side === "sell");
      if (hasBuy && hasSell) {
        relationships.push({
          wallet_a         : wallet,
          wallet_b         : wallet,
          relationship_type: "mirror_trade",
          confidence       : 70,
          evidence         : {
            window_seconds: COORDINATED_WINDOW_SECONDS,
            signatures    : wTrades.map((t) => t.signature),
          },
        });
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
    if (t.side === "buy") s.buys.push(t);
    else s.sells.push(t);
  }
  return [...map.values()];
}

function computeBundleScore(wallet: string, relationships: RelationshipResult[], bundles: BundleResult[]): number {
  let score = 0;
  const inBundle = bundles.some((b) => b.wallets.includes(wallet));
  if (inBundle) score += 40;
  const relCount = relationships.filter(
    (r) => r.wallet_a === wallet || r.wallet_b === wallet
  ).length;
  score += Math.min(40, relCount * 10);
  const highConfidence = relationships.filter(
    (r) => (r.wallet_a === wallet || r.wallet_b === wallet) && r.confidence >= 80
  ).length;
  score += Math.min(20, highConfidence * 10);
  return Math.min(100, score);
}

function assignTags(summary: WalletSummary, bundleScore: number, bundles: BundleResult[]): string[] {
  const tags: string[] = [];
  if (bundleScore >= 60) tags.push("bundler");
  if (summary.buys.length > 0 && summary.sells.length === 0) {
    const avgBuyTime = summary.buys[0].blockTime;
    const firstTrade = Math.min(...summary.buys.map((t) => t.blockTime));
    if (Date.now() / 1000 - firstTrade < 300) tags.push("sniper"); // bought within 5min of tracking
  }
  const totalSol = summary.buys.reduce((s, t) => s + t.solAmount, 0) +
                   summary.sells.reduce((s, t) => s + t.solAmount, 0);
  if (totalSol > 50) tags.push("whale");
  const totalTrades = summary.buys.length + summary.sells.length;
  if (totalTrades > 20) tags.push("bot");
  if (summary.buys.length > 0 && summary.sells.length > 0 &&
      Math.abs(summary.buys.length - summary.sells.length) <= 2) tags.push("flipper");
  return tags;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE UPSERTS
// ─────────────────────────────────────────────────────────────────────────────

async function upsertTrades(sb: SupabaseClient, trades: ParsedTrade[]): Promise<number> {
  if (!trades.length) return 0;
  const rows = trades.map((t) => ({
    signature    : t.signature,
    block_time   : new Date(t.blockTime * 1000).toISOString(),
    slot         : t.slot,
    wallet       : t.wallet,
    side         : t.side,
    token_amount : t.tokenAmount,
    sol_amount   : t.solAmount,
    price_per_token: t.pricePerToken,
    usd_value    : t.usdValue,
    program      : t.program,
    raw          : t.raw,
  }));
  const { error, count } = await sb.from("trades").upsert(rows, { onConflict: "signature", count: "exact" });
  if (error) console.error("upsertTrades error:", error.message);
  return count ?? trades.length;
}

async function upsertWalletProfiles(
  sb         : SupabaseClient,
  summaries  : WalletSummary[],
  relationships: RelationshipResult[],
  bundles    : BundleResult[],
): Promise<void> {
  for (const s of summaries) {
    const bundleScore = computeBundleScore(s.wallet, relationships, bundles);
    const tags        = assignTags(s, bundleScore, bundles);

    const totalBuySol     = s.buys.reduce((acc, t) => acc + t.solAmount, 0);
    const totalSellSol    = s.sells.reduce((acc, t) => acc + t.solAmount, 0);
    const totalBuyTokens  = s.buys.reduce((acc, t) => acc + t.tokenAmount, 0);
    const totalSellTokens = s.sells.reduce((acc, t) => acc + t.tokenAmount, 0);
    const avgBuyPrice     = s.buys.length > 0
      ? s.buys.reduce((acc, t) => acc + t.pricePerToken, 0) / s.buys.length
      : null;
    const avgSellPrice    = s.sells.length > 0
      ? s.sells.reduce((acc, t) => acc + t.pricePerToken, 0) / s.sells.length
      : null;
    const realizedPnl = avgSellPrice !== null && avgBuyPrice !== null
      ? (avgSellPrice - avgBuyPrice) * Math.min(totalBuyTokens, totalSellTokens)
      : null;

    const allTimes = [...s.buys, ...s.sells].map((t) => t.blockTime);
    const firstSeen = Math.min(...allTimes);
    const lastSeen  = Math.max(...allTimes);

    await sb.from("wallet_profiles").upsert({
      wallet           : s.wallet,
      first_seen_at    : new Date(firstSeen * 1000).toISOString(),
      last_seen_at     : new Date(lastSeen  * 1000).toISOString(),
      total_buys       : s.buys.length,
      total_sells      : s.sells.length,
      total_buy_sol    : totalBuySol,
      total_sell_sol   : totalSellSol,
      total_buy_tokens : totalBuyTokens,
      total_sell_tokens: totalSellTokens,
      net_position     : totalBuyTokens - totalSellTokens,
      avg_buy_price    : avgBuyPrice,
      avg_sell_price   : avgSellPrice,
      realized_pnl_sol : realizedPnl,
      bundle_score     : bundleScore,
      tags,
    }, { onConflict: "wallet" });
  }
}

async function upsertRelationships(sb: SupabaseClient, relationships: RelationshipResult[]): Promise<void> {
  for (const r of relationships) {
    // Normalise order so (A,B) and (B,A) map to the same row
    const [wa, wb] = r.wallet_a <= r.wallet_b
      ? [r.wallet_a, r.wallet_b]
      : [r.wallet_b, r.wallet_a];

    const { data: existing } = await sb
      .from("wallet_relationships")
      .select("id, co_occurrence")
      .eq("wallet_a", wa)
      .eq("wallet_b", wb)
      .eq("relationship_type", r.relationship_type)
      .maybeSingle();

    if (existing) {
      await sb.from("wallet_relationships").update({
        co_occurrence: existing.co_occurrence + 1,
        last_seen_at : new Date().toISOString(),
        confidence   : Math.min(100, r.confidence + existing.co_occurrence * 2),
        evidence     : r.evidence,
      }).eq("id", existing.id);
    } else {
      await sb.from("wallet_relationships").insert({
        wallet_a         : wa,
        wallet_b         : wb,
        relationship_type: r.relationship_type,
        co_occurrence    : 1,
        confidence       : r.confidence,
        evidence         : r.evidence,
      });
    }
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
  }));
  const { error } = await sb.from("bundles").insert(rows);
  if (error) console.error("insertBundles error:", error.message);
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
  // Pass ?before=SIGNATURE to paginate backwards (historical scan)
  const before = url.searchParams.get("before") ?? undefined;
  const limit  = Math.min(parseInt(url.searchParams.get("limit") ?? String(TX_LIMIT)), 1000);

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb          = createClient(supabaseUrl, supabaseKey);

  try {
    const solPrice = await getSolPrice();

    // 1. Fetch recent signatures for the token mint
    const sigs = await getSignaturesForAddress(MINT, limit, before);
    if (!sigs.length) {
      return new Response(JSON.stringify({ ok: true, message: "No transactions found", trades: 0 }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // 2. Fetch full transactions in parallel (batches of 10 to avoid rate limits)
    const trades: ParsedTrade[] = [];
    const BATCH = 10;
    for (let i = 0; i < sigs.length; i += BATCH) {
      const batch   = sigs.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map((s) => getTransaction(s.signature).then((tx) =>
          tx ? parseTrade(s.signature, s.slot, s.blockTime ?? 0, tx, MINT, solPrice) : null
        ))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) trades.push(r.value);
      }
    }

    if (!trades.length) {
      return new Response(JSON.stringify({ ok: true, message: "No trades parsed", txs_checked: sigs.length }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }

    // 3. Detect relationships and bundles
    const { relationships, bundles } = detectRelationshipsAndBundles(trades);

    // 4. Build wallet summaries
    const summaries = buildWalletSummaries(trades);

    // 5. Persist everything
    const savedTrades = await upsertTrades(sb, trades);
    await upsertWalletProfiles(sb, summaries, relationships, bundles);
    await upsertRelationships(sb, relationships);
    await insertBundles(sb, bundles);

    // 6. Pagination cursor for historical scan
    const oldestSig = sigs[sigs.length - 1]?.signature ?? null;

    return new Response(JSON.stringify({
      ok              : true,
      txs_checked     : sigs.length,
      trades_found    : trades.length,
      trades_saved    : savedTrades,
      wallets         : summaries.length,
      relationships   : relationships.length,
      bundles         : bundles.length,
      oldest_sig      : oldestSig,
      // Pass oldest_sig as ?before= to continue scanning backwards
      next_page       : oldestSig ? `?before=${oldestSig}&limit=${limit}` : null,
      summary: {
        buyers        : trades.filter((t) => t.side === "buy").length,
        sellers       : trades.filter((t) => t.side === "sell").length,
        bundlers      : summaries.filter((s) => computeBundleScore(s.wallet, relationships, bundles) >= 60).length,
        flagged_wallets: summaries.filter((s) => assignTags(s, computeBundleScore(s.wallet, relationships, bundles), bundles).length > 0).length,
      },
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("wallet-tracker fatal:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
