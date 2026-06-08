# AI providers

The monitor can use one of three AI services to write post copy.
If you don't set any of them, it uses templates — the system works
either way, AI just makes the posts sound more natural.

---

## Grok (xAI)

Recommended if you're already on X. Fast, cheap, and has solid
awareness of crypto / defi context from training on X posts.

1. go to [console.x.ai](https://console.x.ai)
2. sign in with your X account
3. API Keys → Create Key
4. add as `GROK_API_KEY` in Supabase secrets

Model used: `grok-3-mini`
Cost: roughly $0.0003 per post at typical lengths

---

## OpenAI

The most widely used option. gpt-4o-mini is fast and inexpensive.
Use gpt-4o if you want higher quality at ~10x the cost.

1. go to [platform.openai.com](https://platform.openai.com)
2. API Keys → Create new secret key
3. add as `OPENAI_API_KEY` in Supabase secrets

To switch to gpt-4o, change `model: "gpt-4o-mini"` in `callOpenAI()`
Model used: `gpt-4o-mini`
Cost: roughly $0.0002 per post

---

## NVIDIA Nemotron

Highest quality option — `nemotron-ultra-253b-v1` is a 253B parameter
model that consistently produces strong long-form output. Slower than
Grok or OpenAI (expect 3-8s per call), but worth it if post quality
is the priority over speed.

1. go to [build.nvidia.com](https://build.nvidia.com)
2. sign up / sign in
3. Get API Key (top right)
4. add as `NEMOTRON_API_KEY` in Supabase secrets

Model used: `nvidia/llama-3.1-nemotron-ultra-253b-v1`
API is OpenAI-compatible, so swapping models is just changing the model string.
Cost: check [build.nvidia.com/explore/discover](https://build.nvidia.com/explore/discover) for current pricing

---

## using multiple keys

You can set all three. The function tries them in order — Grok first,
then OpenAI, then Nemotron. First successful response wins.

This gives you automatic failover: if Grok is down or rate-limited,
it falls through to OpenAI, then Nemotron, then templates.

---

## no AI key

Everything still works. Templates produce clean, data-accurate posts
using the live on-chain numbers. The `ai_generated` field in the
database will be `false` for all posts.
