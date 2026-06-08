// =============================================================================
// mim-monitor — Solana Token Monitor Edge Function
// Runs every 5 minutes via pg_cron. Fetches token metrics from multiple
// sources, scores health, detects triggers, generates AI or template content,
// posts to Telegram, and queues tweets.
// =============================================================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — all values from environment secrets
// ─────────────────────────────────────────────────────────────────────────────

const MINT         = Deno.env.get("TOKEN_MINT") ?? "";
const SYMBOL       = Deno.env.get("TOKEN_SYMBOL") ?? "TOKEN";
const NAME         = Deno.env.get("TOKEN_NAME") ?? "Token";

const BIRDEYE_KEY  = Deno.env.get("BIRDEYE_API_KEY");
const SOLSCAN_KEY  = Deno.env.get("SOLSCAN_API_KEY");
const X_BEARER     = Deno.env.get("X_BEARER_TOKEN");

const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN");
const TG_CHAT      = Deno.env.get("TELEGRAM_CHAT_ID");
const TG_OPS       = Deno.env.get("TELEGRAM_OPS_CHAT_ID") ?? TG_CHAT;

// Trigger thresholds
const VOLUME_SPIKE_THRESHOLD  = 1.5;   // 50% increase vs previous period
const PRICE_UP_THRESHOLD      = 0.10;  // 10% price increase in 24h
const HEALTH_WARNING_SCORE    = 40;
const HEALTH_CRITICAL_SCORE   = 25;
const DAILY_POST_HOURS        = 23;

// Health weights (must sum to 1.0)
const HEALTH_WEIGHTS = {
  liquidity : 0.25,
  trading   : 0.25,
  holders   : 0.20,
  social    : 0.15,
  listings  : 0.15,
};

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

interface TokenMetrics {
  price            : number;
  price_change_24h : number;
  volume_24h       : number;
  volume_prev      : number;
  liquidity_usd    : number;
  liquidity_sol    : number;
  buys_24h         : number;
  sells_24h        : number;
  holder_count     : number;
  top10_pct        : number;
  trending_rank    : number | null;
  mentions_24h     : number;
  sentiment_score  : number;
  source_data      : Record<string, unknown>;
}

interface HealthScores {
  liquidity : number;
  trading   : number;
  holders   : number;
  social    : number;
  listings  : number;
  overall   : number;
  status    : "healthy" | "warning" | "critical";
}

interface Decision {
  trigger  : string;
  fired    : boolean;
  reason   : string;
}

interface AIRequest {
  prompt     : string;
  max_tokens?: number;
  system?    : string;
}

// ─────────────────────────────────────────────────────────────────────────────
// AI CONTENT GENERATION
// Priority: Grok → OpenAI → Nemotron → template fallback
// ─────────────────────────────────────────────────────────────────────────────

const AI_SYSTEM = `You are a sharp crypto community manager. Be concise,
energetic, and authentic. No "LFG", no "to the moon", no emoji
overload. Sound like a real person who actually tracks on-chain data.`;

async function callGrok(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("GROK_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        model      : "grok-3-mini",
        messages   : [{ role: "system", content: req.system ?? AI_SYSTEM }, { role: "user", content: req.prompt }],
        max_tokens : req.max_tokens ?? 120,
        temperature: 0.85,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { console.warn("Grok error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("Grok failed:", e); return null; }
}

async function callOpenAI(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        model      : "gpt-4o-mini",
        messages   : [{ role: "system", content: req.system ?? AI_SYSTEM }, { role: "user", content: req.prompt }],
        max_tokens : req.max_tokens ?? 120,
        temperature: 0.85,
      }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) { console.warn("OpenAI error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("OpenAI failed:", e); return null; }
}

async function callNemotron(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("NEMOTRON_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method : "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body   : JSON.stringify({
        model      : "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        messages   : [{ role: "system", content: req.system ?? AI_SYSTEM }, { role: "user", content: req.prompt }],
        max_tokens : req.max_tokens ?? 120,
        temperature: 0.85,
        stream     : false,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) { console.warn("Nemotron error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("Nemotron failed:", e); return null; }
}

async function callAI(req: AIRequest): Promise<string | null> {
  return await callGrok(req) ?? await callOpenAI(req) ?? await callNemotron(req);
}

function activeAIProvider(): string {
  if (Deno.env.get("GROK_API_KEY"))     return "grok";
  if (Deno.env.get("OPENAI_API_KEY"))   return "openai";
  if (Deno.env.get("NEMOTRON_API_KEY")) return "nemotron";
  return "template";
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHERS
// ─────────────────────────────────────────────────────────────────────────────

async function fetchDexScreener(mint: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // Pick the highest-liquidity pair
    const pairs = (data.pairs ?? []) as Record<string, unknown>[];
    if (!pairs.length) return null;
    pairs.sort((a: Record<string, unknown>, b: Record<string, unknown>) =>
      ((b.liquidity as Record<string, number>)?.usd ?? 0) - ((a.liquidity as Record<string, number>)?.usd ?? 0)
    );
    return pairs[0];
  } catch (e) { console.warn("DexScreener fetch failed:", e); return null; }
}

async function fetchDexScreenerTrending(mint: string): Promise<number | null> {
  try {
    const res = await fetch("https://api.dexscreener.com/token-boosts/top/v1", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const data = await res.json() as Array<Record<string, unknown>>;
    const idx = data.findIndex((t) => (t.tokenAddress as string)?.toLowerCase() === mint.toLowerCase());
    return idx >= 0 ? idx + 1 : null;
  } catch (e) { console.warn("DexScreener trending fetch failed:", e); return null; }
}

async function fetchBirdeye(mint: string): Promise<Record<string, unknown> | null> {
  if (!BIRDEYE_KEY) return null;
  try {
    const res = await fetch(`https://public-api.birdeye.so/defi/token_overview?address=${mint}`, {
      headers: { "X-API-KEY": BIRDEYE_KEY, "x-chain": "solana" },
      signal : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()).data ?? null;
  } catch (e) { console.warn("Birdeye fetch failed:", e); return null; }
}

async function fetchSolscanHolders(mint: string): Promise<Record<string, unknown>[] | null> {
  if (!SOLSCAN_KEY) return null;
  try {
    const res = await fetch(`https://pro-api.solscan.io/v2.0/token/holders?address=${mint}&page=1&page_size=20`, {
      headers: { token: SOLSCAN_KEY },
      signal : AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()).data?.items ?? null;
  } catch (e) { console.warn("Solscan fetch failed:", e); return null; }
}

async function fetchXMentions(symbol: string): Promise<{ count: number; sentiment: number } | null> {
  if (!X_BEARER) return null;
  try {
    const query = encodeURIComponent(`$${symbol} lang:en -is:retweet`);
    const res = await fetch(
      `https://api.twitter.com/2/tweets/search/recent?query=${query}&max_results=100&tweet.fields=public_metrics`,
      { headers: { Authorization: `Bearer ${X_BEARER}` }, signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const tweets = data.data ?? [];
    const count  = data.meta?.result_count ?? tweets.length;
    // Naive sentiment: ratio of tweets containing positive words
    const positive = tweets.filter((t: Record<string, unknown>) =>
      /bullish|up|great|good|strong|buy|bought/i.test(t.text as string)
    ).length;
    const sentiment = tweets.length > 0 ? positive / tweets.length : 0.5;
    return { count, sentiment };
  } catch (e) { console.warn("X fetch failed:", e); return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// METRIC AGGREGATION
// ─────────────────────────────────────────────────────────────────────────────

async function collectMetrics(prevVolume: number): Promise<TokenMetrics> {
  const [dex, trending, birdeye, holders, social] = await Promise.allSettled([
    fetchDexScreener(MINT),
    fetchDexScreenerTrending(MINT),
    fetchBirdeye(MINT),
    fetchSolscanHolders(MINT),
    fetchXMentions(SYMBOL),
  ]);

  const dexData     = dex.status     === "fulfilled" ? dex.value     : null;
  const trendRank   = trending.status === "fulfilled" ? trending.value : null;
  const birdData    = birdeye.status  === "fulfilled" ? birdeye.value  : null;
  const holderList  = holders.status  === "fulfilled" ? holders.value  : null;
  const xData       = social.status   === "fulfilled" ? social.value   : null;

  // Price & volume from DexScreener
  const price            = parseFloat(String((dexData?.priceUsd ?? birdData?.price ?? 0))) || 0;
  const price_change_24h = parseFloat(String((dexData as Record<string, Record<string, number>>)?.priceChange?.h24 ?? 0)) || 0;
  const volume_24h       = parseFloat(String((dexData as Record<string, Record<string, number>>)?.volume?.h24 ?? birdData?.v24hUSD ?? 0)) || 0;
  const liquidity_usd    = parseFloat(String((dexData as Record<string, Record<string, number>>)?.liquidity?.usd ?? 0)) || 0;
  const liquidity_sol    = liquidity_usd / Math.max(price, 0.000001);

  // Buys/sells
  const txns  = (dexData as Record<string, Record<string, Record<string, number>>>)?.txns?.h24;
  const buys_24h  = txns?.buys  ?? 0;
  const sells_24h = txns?.sells ?? 0;

  // Holders from Birdeye or Solscan count
  const holder_count = (birdData?.holder as number) ?? (holderList?.length ?? 0);

  // Top-10 holder concentration
  let top10_pct = 0;
  if (holderList && holderList.length > 0) {
    const total = holderList.reduce((s: number, h: Record<string, unknown>) => s + (Number(h.amount) || 0), 0);
    const top10 = holderList.slice(0, 10).reduce((s: number, h: Record<string, unknown>) => s + (Number(h.amount) || 0), 0);
    top10_pct = total > 0 ? (top10 / total) * 100 : 0;
  }

  return {
    price,
    price_change_24h,
    volume_24h,
    volume_prev      : prevVolume,
    liquidity_usd,
    liquidity_sol,
    buys_24h,
    sells_24h,
    holder_count,
    top10_pct,
    trending_rank    : trendRank,
    mentions_24h     : xData?.count ?? 0,
    sentiment_score  : xData?.sentiment ?? 0.5,
    source_data      : { dex: dexData, birdeye: birdData, trending: trendRank, x: xData },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH SCORING
// ─────────────────────────────────────────────────────────────────────────────

function clamp(v: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, v));
}

function scoreHealth(m: TokenMetrics): HealthScores {
  // Liquidity score: healthy = >$50k, warning = >$10k, critical = <$10k
  const liquidity = clamp(
    m.liquidity_usd >= 50_000 ? 100 :
    m.liquidity_usd >= 10_000 ? 40 + (m.liquidity_usd - 10_000) / 40_000 * 60 :
    (m.liquidity_usd / 10_000) * 40
  );

  // Trading score: based on buy/sell ratio and txn volume
  const totalTxns  = m.buys_24h + m.sells_24h;
  const buySellRatio = totalTxns > 0 ? m.buys_24h / totalTxns : 0.5;
  const txnScore   = clamp(totalTxns / 200 * 50); // 200 txns/day = 50 pts
  const ratioScore = clamp(buySellRatio * 100);    // pure buy = 100 pts
  const trading    = clamp((txnScore + ratioScore) / 2);

  // Holder score: count + concentration
  const holderScore  = clamp(m.holder_count / 1000 * 60); // 1000 holders = 60 pts
  const concScore    = clamp(100 - m.top10_pct);           // lower concentration = better
  const holders      = clamp((holderScore + concScore) / 2);

  // Social score: mentions + sentiment
  const mentionScore = clamp(m.mentions_24h / 50 * 60);   // 50 mentions/day = 60 pts
  const sentScore    = clamp(m.sentiment_score * 100);
  const social       = clamp((mentionScore + sentScore) / 2);

  // Listings score: trending rank bonus
  const listings = m.trending_rank !== null
    ? clamp(100 - (m.trending_rank - 1) * 5)  // rank 1 = 100, rank 20 = 5
    : 20; // not trending but exists = baseline

  const overall =
    liquidity * HEALTH_WEIGHTS.liquidity +
    trading   * HEALTH_WEIGHTS.trading   +
    holders   * HEALTH_WEIGHTS.holders   +
    social    * HEALTH_WEIGHTS.social    +
    listings  * HEALTH_WEIGHTS.listings;

  const status: "healthy" | "warning" | "critical" =
    overall >= 70 ? "healthy" :
    overall >= HEALTH_WARNING_SCORE ? "warning" : "critical";

  return { liquidity, trading, holders, social, listings, overall, status };
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIGGER DETECTION
// ─────────────────────────────────────────────────────────────────────────────

interface PrevState {
  volume       : number;
  trendingRank : number | null;
  holderCount  : number;
  lastPostAt   : Date | null;
  lastHealth   : string | null;
}

function detectTriggers(m: TokenMetrics, h: HealthScores, prev: PrevState): Decision[] {
  const decisions: Decision[] = [];

  // New trending entry
  decisions.push({
    trigger: "trending_new",
    fired  : m.trending_rank !== null && prev.trendingRank === null,
    reason : m.trending_rank !== null && prev.trendingRank === null
      ? `Entered trending at rank #${m.trending_rank}`
      : "Not newly trending",
  });

  // Trending rank improvement (moved up 5+ spots)
  const rankImprovement = (prev.trendingRank ?? 999) - (m.trending_rank ?? 999);
  decisions.push({
    trigger: "trending_up",
    fired  : m.trending_rank !== null && rankImprovement >= 5,
    reason : rankImprovement >= 5
      ? `Trending rank improved by ${rankImprovement} spots to #${m.trending_rank}`
      : "No significant rank improvement",
  });

  // Volume spike
  const volRatio = prev.volume > 0 ? m.volume_24h / prev.volume : 0;
  decisions.push({
    trigger: "volume_spike",
    fired  : volRatio >= VOLUME_SPIKE_THRESHOLD,
    reason : volRatio >= VOLUME_SPIKE_THRESHOLD
      ? `Volume up ${((volRatio - 1) * 100).toFixed(0)}% vs previous period`
      : `Volume ratio ${volRatio.toFixed(2)} below threshold`,
  });

  // Price up 10%+
  decisions.push({
    trigger: "price_up_10",
    fired  : m.price_change_24h >= PRICE_UP_THRESHOLD * 100,
    reason : m.price_change_24h >= PRICE_UP_THRESHOLD * 100
      ? `Price up ${m.price_change_24h.toFixed(1)}% in 24h`
      : `Price change ${m.price_change_24h.toFixed(1)}% below threshold`,
  });

  // Holder milestones: 100, 250, 500, 1k, 2.5k, 5k, 10k, 25k, 50k, 100k
  const milestones = [100, 250, 500, 1_000, 2_500, 5_000, 10_000, 25_000, 50_000, 100_000];
  const crossedMilestone = milestones.find(
    (ms) => m.holder_count >= ms && prev.holderCount < ms
  );
  decisions.push({
    trigger: "holder_milestone",
    fired  : crossedMilestone !== undefined,
    reason : crossedMilestone
      ? `Crossed ${crossedMilestone.toLocaleString()} holders`
      : "No milestone crossed",
  });

  // Health dropped to warning
  decisions.push({
    trigger: "health_warning",
    fired  : h.status === "warning" && prev.lastHealth !== "warning" && prev.lastHealth !== "critical",
    reason : h.status === "warning"
      ? `Health score dropped to ${h.overall.toFixed(0)} (warning)`
      : `Health status: ${h.status}`,
  });

  // Health dropped to critical
  decisions.push({
    trigger: "health_critical",
    fired  : h.status === "critical" && prev.lastHealth !== "critical",
    reason : h.status === "critical"
      ? `Health score critical: ${h.overall.toFixed(0)}/100`
      : `Health status: ${h.status}`,
  });

  // Daily update — always fires if no post in DAILY_POST_HOURS
  const hoursSincePost = prev.lastPostAt
    ? (Date.now() - prev.lastPostAt.getTime()) / 3_600_000
    : 999;
  decisions.push({
    trigger: "daily_update",
    fired  : hoursSincePost >= DAILY_POST_HOURS && !decisions.some((d) => d.fired),
    reason : hoursSincePost >= DAILY_POST_HOURS
      ? `${hoursSincePost.toFixed(1)}h since last post`
      : `Last post was ${hoursSincePost.toFixed(1)}h ago`,
  });

  return decisions;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATE CONTENT (fallback when no AI key)
// ─────────────────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000)     return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtPrice(p: number): string {
  if (p < 0.000001) return p.toExponential(4);
  if (p < 0.01)     return p.toFixed(8);
  if (p < 1)        return p.toFixed(6);
  return p.toFixed(4);
}

function templateTweet(trigger: string, m: TokenMetrics, h: HealthScores): string {
  const p = `$${fmtPrice(m.price)}`;
  const v = fmt(m.volume_24h);
  const hld = m.holder_count.toLocaleString();
  const chg = m.price_change_24h >= 0 ? `+${m.price_change_24h.toFixed(1)}%` : `${m.price_change_24h.toFixed(1)}%`;

  switch (trigger) {
    case "trending_new":
      return `$${SYMBOL} just entered trending on DexScreener at #${m.trending_rank}. Price: ${p} | Vol: ${v} | Holders: ${hld} #Solana #${SYMBOL}`;
    case "trending_up":
      return `$${SYMBOL} climbing the DexScreener trending list — now at #${m.trending_rank}. Vol: ${v} | Holders: ${hld} #Solana`;
    case "volume_spike":
      return `$${SYMBOL} volume spiking. ${v} in 24h. Price: ${p} (${chg}) | ${m.buys_24h} buys vs ${m.sells_24h} sells #Solana`;
    case "price_up_10":
      return `$${SYMBOL} up ${chg} in 24h. Price: ${p} | Vol: ${v} | Holders: ${hld} #Solana`;
    case "holder_milestone":
      return `$${SYMBOL} just crossed ${hld} holders. Price: ${p} | Vol: ${v} #Solana`;
    case "daily_update":
      return `$${SYMBOL} daily: ${p} (${chg}) | Vol: ${v} | Holders: ${hld} | Health: ${h.overall.toFixed(0)}/100 #Solana #${SYMBOL}`;
    default:
      return `$${SYMBOL} update: ${p} | Vol: ${v} | Holders: ${hld} #Solana`;
  }
}

function templateTelegram(trigger: string, m: TokenMetrics, h: HealthScores, tradeUrl: string, chartUrl: string): string {
  const p    = fmtPrice(m.price);
  const v    = fmt(m.volume_24h);
  const hld  = m.holder_count.toLocaleString();
  const chg  = m.price_change_24h >= 0 ? `+${m.price_change_24h.toFixed(1)}%` : `${m.price_change_24h.toFixed(1)}%`;
  const links = `[Trade](${tradeUrl}) | [Chart](${chartUrl})`;

  switch (trigger) {
    case "trending_new":
      return `🔥 *$${SYMBOL} hit trending #${m.trending_rank} on DexScreener*\n\nPrice: $${p} | 24h: ${chg}\nVol: ${v} | Holders: ${hld}\n\n${links}`;
    case "trending_up":
      return `📈 *$${SYMBOL} climbing — trending #${m.trending_rank}*\n\nPrice: $${p} | Vol: ${v}\nHolders: ${hld}\n\n${links}`;
    case "volume_spike":
      return `⚡ *$${SYMBOL} volume spike*\n\n${v} in 24h | Buys: ${m.buys_24h} | Sells: ${m.sells_24h}\nPrice: $${p} (${chg})\n\n${links}`;
    case "price_up_10":
      return `🚀 *$${SYMBOL} up ${chg}*\n\nPrice: $${p} | Vol: ${v}\nHolders: ${hld}\n\n${links}`;
    case "holder_milestone":
      return `🎯 *$${SYMBOL} crossed ${hld} holders*\n\nPrice: $${p} | Vol: ${v}\n\n${links}`;
    case "daily_update":
      return `📊 *$${SYMBOL} daily summary*\n\nPrice: $${p} (${chg})\nVol: ${v} | Holders: ${hld}\nHealth: ${h.overall.toFixed(0)}/100 (${h.status})\n\n${links}`;
    case "health_warning":
      return `⚠️ *$${SYMBOL} health warning*\n\nScore dropped to ${h.overall.toFixed(0)}/100\nLiquidity: ${h.liquidity.toFixed(0)} | Trading: ${h.trading.toFixed(0)}\n\n${links}`;
    case "health_critical":
      return `🚨 *$${SYMBOL} health critical*\n\nScore: ${h.overall.toFixed(0)}/100\nLiquidity: ${fmt(m.liquidity_usd)} | Holders: ${hld}\n\n${links}`;
    default:
      return `$${SYMBOL}: $${p} | Vol: ${v} | Holders: ${hld}\n\n${links}`;
  }
}

function opsAlert(m: TokenMetrics, h: HealthScores, alerts: string[]): string {
  const p   = fmtPrice(m.price);
  const v   = fmt(m.volume_24h);
  const liq = fmt(m.liquidity_usd);
  const alertLines = alerts.map((a) => `• ${a}`).join("\n");

  return `🔔 *${NAME} ops alert — ${new Date().toUTCString()}*\n\n` +
    `Health: ${h.overall.toFixed(0)}/100 (${h.status})\n` +
    `Price: $${p} | Vol: ${v} | Liq: ${liq}\n` +
    `Holders: ${m.holder_count.toLocaleString()} | Top10: ${m.top10_pct.toFixed(1)}%\n` +
    `Buys: ${m.buys_24h} | Sells: ${m.sells_24h}\n\n` +
    `*Issues:*\n${alertLines || "None"}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTENT GENERATION (AI + template fallback)
// ─────────────────────────────────────────────────────────────────────────────

function buildContext(trigger: string, m: TokenMetrics, h: HealthScores): string {
  let ctx = `Token: $${SYMBOL} (${NAME}) on Solana
` +
    `Price: $${fmtPrice(m.price)} | 24h change: ${m.price_change_24h.toFixed(1)}%
` +
    `24h Volume: ${fmt(m.volume_24h)} | Liquidity: ${fmt(m.liquidity_usd)}
` +
    `Holders: ${m.holder_count.toLocaleString()} | Top-10 concentration: ${m.top10_pct.toFixed(1)}%
` +
    `Buys: ${m.buys_24h} | Sells: ${m.sells_24h} | Health: ${h.overall.toFixed(0)}/100`;

  if (trigger === "trending_new")     ctx += `\nEvent: Just entered DexScreener trending at rank #${m.trending_rank}`;
  if (trigger === "trending_up")      ctx += `\nEvent: Trending rank improved to #${m.trending_rank}`;
  if (trigger === "volume_spike")     ctx += `\nEvent: Volume spiked — ${fmt(m.volume_24h)} in 24h`;
  if (trigger === "price_up_10")      ctx += `\nEvent: Price up ${m.price_change_24h.toFixed(1)}% in 24h`;
  if (trigger === "holder_milestone") ctx += `\nEvent: Crossed ${m.holder_count.toLocaleString()} holders`;
  if (trigger === "daily_update")     ctx += `\nEvent: Scheduled daily community post`;
  if (trigger === "health_warning")   ctx += `\nEvent: Health score dropped to warning level`;
  if (trigger === "health_critical")  ctx += `\nEvent: Health score is critical`;

  return ctx;
}

async function generateContent(
  trigger : string,
  m       : TokenMetrics,
  h       : HealthScores,
  tradeUrl: string,
  chartUrl: string,
): Promise<{ tweet: string; telegram: string; aiGenerated: boolean; aiProvider: string }> {
  const aiProvider = activeAIProvider();

  if (aiProvider === "template") {
    return {
      tweet      : templateTweet(trigger, m, h),
      telegram   : templateTelegram(trigger, m, h, tradeUrl, chartUrl),
      aiGenerated: false,
      aiProvider : "template",
    };
  }

  const context = buildContext(trigger, m, h);
  const links   = `[Trade](${tradeUrl}) | [Chart](${chartUrl})`;

  const [tweetAI, tgAI] = await Promise.all([
    callAI({
      prompt    : `Write a tweet (max 260 chars) for this Solana token event. No hype clichés. Max 2 hashtags. Use only the numbers provided — do not invent data. Return only the tweet text.\n\n${context}`,
      max_tokens: 100,
    }),
    callAI({
      prompt    : `Write a Telegram message (max 420 chars) for this Solana token event. Use Markdown bold for key numbers. End with: ${links}. Return only the message.\n\n${context}`,
      max_tokens: 200,
    }),
  ]);

  return {
    tweet      : tweetAI    ?? templateTweet(trigger, m, h),
    telegram   : tgAI       ?? templateTelegram(trigger, m, h, tradeUrl, chartUrl),
    aiGenerated: !!(tweetAI || tgAI),
    aiProvider : tweetAI || tgAI ? aiProvider : "template",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEGRAM POSTING
// ─────────────────────────────────────────────────────────────────────────────

async function sendTelegram(chatId: string, text: string): Promise<boolean> {
  if (!TG_TOKEN || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method : "POST",
      headers: { "Content-Type": "application/json" },
      body   : JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown", disable_web_page_preview: true }),
      signal : AbortSignal.timeout(10_000),
    });
    if (!res.ok) { console.warn("Telegram send failed:", await res.text()); return false; }
    return true;
  } catch (e) { console.warn("Telegram error:", e); return false; }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATABASE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function getPrevState(sb: SupabaseClient): Promise<PrevState> {
  const [metricsRes, postRes] = await Promise.all([
    sb.from("token_metrics").select("volume_24h, trending_rank, holder_count").order("captured_at", { ascending: false }).limit(1),
    sb.from("post_history").select("posted_at").order("posted_at", { ascending: false }).limit(1),
  ]);
  const lastHealth = await sb.from("health_scores").select("status").order("scored_at", { ascending: false }).limit(1);

  const prev = metricsRes.data?.[0];
  const lastPost = postRes.data?.[0];

  return {
    volume      : prev?.volume_24h    ?? 0,
    trendingRank: prev?.trending_rank ?? null,
    holderCount : prev?.holder_count  ?? 0,
    lastPostAt  : lastPost?.posted_at ? new Date(lastPost.posted_at) : null,
    lastHealth  : lastHealth.data?.[0]?.status ?? null,
  };
}

async function saveMetrics(sb: SupabaseClient, m: TokenMetrics): Promise<number | null> {
  const { data, error } = await sb.from("token_metrics").insert({
    price            : m.price,
    price_change_24h : m.price_change_24h,
    volume_24h       : m.volume_24h,
    volume_prev      : m.volume_prev,
    liquidity_usd    : m.liquidity_usd,
    liquidity_sol    : m.liquidity_sol,
    buys_24h         : m.buys_24h,
    sells_24h        : m.sells_24h,
    holder_count     : m.holder_count,
    top10_pct        : m.top10_pct,
    trending_rank    : m.trending_rank,
    mentions_24h     : m.mentions_24h,
    sentiment_score  : m.sentiment_score,
    source_data      : m.source_data,
  }).select("id").single();
  if (error) { console.error("saveMetrics error:", error); return null; }
  return data?.id ?? null;
}

async function saveHealth(sb: SupabaseClient, h: HealthScores, metricId: number | null): Promise<void> {
  const { error } = await sb.from("health_scores").insert({
    metric_id      : metricId,
    liquidity_score: h.liquidity,
    trading_score  : h.trading,
    holder_score   : h.holders,
    social_score   : h.social,
    listing_score  : h.listings,
    overall_score  : h.overall,
    status         : h.status,
  });
  if (error) console.error("saveHealth error:", error);
}

async function saveDecisions(sb: SupabaseClient, decisions: Decision[], metricId: number | null, aiProvider: string): Promise<void> {
  const rows = decisions.map((d) => ({
    metric_id   : metricId,
    trigger_name: d.trigger,
    fired       : d.fired,
    reason      : d.reason,
    ai_provider : d.fired ? aiProvider : null,
  }));
  const { error } = await sb.from("decisions_log").insert(rows);
  if (error) console.error("saveDecisions error:", error);
}

async function queueTweet(
  sb         : SupabaseClient,
  trigger    : string,
  content    : string,
  metricId   : number | null,
  aiGenerated: boolean,
  aiProvider : string,
): Promise<void> {
  const { error } = await sb.from("content_queue").insert({
    trigger_name: trigger,
    platform    : "twitter",
    content,
    status      : "pending",
    ai_generated: aiGenerated,
    ai_provider : aiProvider,
    metric_id   : metricId,
  });
  if (error) console.error("queueTweet error:", error);
}

async function recordPost(
  sb         : SupabaseClient,
  platform   : string,
  trigger    : string,
  content    : string,
  aiGenerated: boolean,
  aiProvider : string,
): Promise<void> {
  const { error } = await sb.from("post_history").insert({
    platform,
    trigger_name: trigger,
    content,
    ai_generated: aiGenerated,
    ai_provider : aiProvider,
  });
  if (error) console.error("recordPost error:", error);
}

// ─────────────────────────────────────────────────────────────────────────────
// RECOMMENDATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

function buildRecommendations(m: TokenMetrics, h: HealthScores): string[] {
  const recs: string[] = [];
  if (h.liquidity < 40)  recs.push("Add LP on Raydium CLMM or Meteora DLMM to improve liquidity score");
  if (h.trading < 40)    recs.push("Low trading activity — consider a community campaign or incentivized trading event");
  if (h.holders < 40)    recs.push("Holder count is low — focus on distribution through airdrops or community rewards");
  if (m.top10_pct > 60)  recs.push(`Top-10 holders control ${m.top10_pct.toFixed(0)}% of supply — high concentration risk`);
  if (h.social < 30)     recs.push("Low social activity — increase X posting frequency and engagement");
  if (h.listings < 30)   recs.push("Not trending — boost submissions via DexScreener or community trending pushes");
  if (m.sells_24h > m.buys_24h * 1.5) recs.push("More sells than buys in 24h — check for whale exits in holder data");
  return recs;
}

function buildAlerts(m: TokenMetrics, h: HealthScores): string[] {
  const alerts: string[] = [];
  if (m.liquidity_usd < 5_000)   alerts.push(`Critical liquidity: ${fmt(m.liquidity_usd)}`);
  if (m.liquidity_usd < 20_000)  alerts.push(`Low liquidity: ${fmt(m.liquidity_usd)}`);
  if (m.top10_pct > 70)          alerts.push(`Top-10 concentration at ${m.top10_pct.toFixed(1)}%`);
  if (m.buys_24h + m.sells_24h < 10) alerts.push("Near-zero trading activity in 24h");
  if (h.overall < HEALTH_CRITICAL_SCORE) alerts.push(`Health score critical: ${h.overall.toFixed(0)}/100`);
  return alerts;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────────────────────────────────────

Deno.serve(async () => {
  const startTime = Date.now();

  if (!MINT) {
    return new Response(JSON.stringify({ ok: false, error: "TOKEN_MINT secret not set" }), {
      status: 400, headers: { "Content-Type": "application/json" },
    });
  }

  // Supabase client (service role — injected automatically in Edge Functions)
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const sb = createClient(supabaseUrl, supabaseKey);

  try {
    // 1. Load previous state
    const prev = await getPrevState(sb);

    // 2. Collect metrics from all data sources
    const metrics = await collectMetrics(prev.volume);

    // 3. Score health
    const health = scoreHealth(metrics);

    // 4. Detect triggers
    const decisions = detectTriggers(metrics, health, prev);
    const firedTriggers = decisions.filter((d) => d.fired);

    // 5. Save metrics and health to DB
    const metricId = await saveMetrics(sb, metrics);
    await saveHealth(sb, health, metricId);

    // 6. Build URLs
    const dexPair   = (metrics.source_data.dex as Record<string, string>)?.pairAddress ?? "";
    const tradeUrl  = dexPair
      ? `https://raydium.io/swap/?inputMint=sol&outputMint=${MINT}`
      : `https://jup.ag/swap/SOL-${MINT}`;
    const chartUrl  = dexPair
      ? `https://dexscreener.com/solana/${dexPair}`
      : `https://dexscreener.com/solana/${MINT}`;

    const aiProvider  = activeAIProvider();
    const postedToTg  : string[] = [];
    const queuedTweets: string[] = [];

    // 7. Generate and send content for each fired trigger
    for (const decision of firedTriggers) {
      const isOpsOnly = ["health_warning", "health_critical"].includes(decision.trigger);

      const content = await generateContent(decision.trigger, metrics, health, tradeUrl, chartUrl);

      if (isOpsOnly) {
        // Ops-only: send to private group, do not post publicly or queue tweet
        const alerts = buildAlerts(metrics, health);
        const opsMsg = opsAlert(metrics, health, alerts);
        const sent   = await sendTelegram(TG_OPS ?? "", opsMsg);
        if (sent) {
          await recordPost(sb, "telegram_ops", decision.trigger, opsMsg, false, "template");
          postedToTg.push(`ops:${decision.trigger}`);
        }
      } else {
        // Public: post to Telegram channel + queue tweet
        const tgSent = await sendTelegram(TG_CHAT ?? "", content.telegram);
        if (tgSent) {
          await recordPost(sb, "telegram", decision.trigger, content.telegram, content.aiGenerated, content.aiProvider);
          postedToTg.push(decision.trigger);
        }
        await queueTweet(sb, decision.trigger, content.tweet, metricId, content.aiGenerated, content.aiProvider);
        queuedTweets.push(decision.trigger);
      }
    }

    // 8. Send ops summary if health is warning/critical and no ops alert was already sent
    const needsOpsSummary = health.status !== "healthy" && !firedTriggers.some((d) => ["health_warning", "health_critical"].includes(d.trigger));
    if (needsOpsSummary) {
      const alerts = buildAlerts(metrics, health);
      if (alerts.length > 0) {
        const opsMsg = opsAlert(metrics, health, alerts);
        await sendTelegram(TG_OPS ?? "", opsMsg);
      }
    }

    // 9. Save all decisions
    await saveDecisions(sb, decisions, metricId, aiProvider);

    const elapsed = Date.now() - startTime;

    return new Response(JSON.stringify({
      ok           : true,
      elapsed_ms   : elapsed,
      ai_provider  : aiProvider,
      token        : { symbol: SYMBOL, name: NAME, mint: MINT },
      metrics      : {
        price            : metrics.price,
        price_change_24h : metrics.price_change_24h,
        volume_24h       : metrics.volume_24h,
        liquidity_usd    : metrics.liquidity_usd,
        holder_count     : metrics.holder_count,
        trending_rank    : metrics.trending_rank,
      },
      health       : { score: health.overall, status: health.status },
      decisions    : firedTriggers.map((d) => d.trigger),
      posted_tg    : postedToTg,
      queued_tweets: queuedTweets,
      alerts       : buildAlerts(metrics, health),
      recommendations: buildRecommendations(metrics, health),
    }), { status: 200, headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.error("mim-monitor fatal error:", err);
    return new Response(JSON.stringify({ ok: false, error: String(err) }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
});
