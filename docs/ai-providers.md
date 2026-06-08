# AI providers

The monitor supports three AI providers for generating post content.
All are optional — if you configure none, it uses templates and works perfectly.

You control which provider is used and in what fallback order via two secrets:

```
AI_PRIMARY_PROVIDER     your preferred provider (grok | openai | nemotron)
AI_PROVIDER_PREFERENCE  full fallback order, comma-separated
                        e.g. openai,grok,nemotron,template
```

If neither is set, the default order is `grok → openai → nemotron → template`,
based on whichever keys are present. You can override this completely.

The active order is returned in every response as `ai_provider_order` so
you can verify your configuration during testing.

---

## Grok (xAI)

1. go to [console.x.ai](https://console.x.ai)
2. sign in with your X account
3. API Keys → Create Key
4. add as `GROK_API_KEY` in Supabase secrets

Model: `grok-3-mini` | Cost: ~$0.0003 per post

---

## OpenAI

1. go to [platform.openai.com](https://platform.openai.com)
2. API Keys → Create new secret key
3. add as `OPENAI_API_KEY` in Supabase secrets

Model: `gpt-4o-mini` | Cost: ~$0.0002 per post
To use gpt-4o instead, change the model string in `callOpenAI()` in `index.ts`.

---

## NVIDIA Nemotron

1. go to [build.nvidia.com](https://build.nvidia.com)
2. sign up and click Get API Key (top right)
3. add as `NEMOTRON_API_KEY` in Supabase secrets

Model: `nvidia/llama-3.1-nemotron-ultra-253b-v1`
Slower than Grok or OpenAI (3-8s per call), highest output quality.
API is OpenAI-compatible — swap the model string to use any other NVIDIA model.

---

## examples

Prefer Nemotron, fall back to OpenAI, then templates:
```
AI_PRIMARY_PROVIDER=nemotron
AI_PROVIDER_PREFERENCE=nemotron,openai,template
```

Use OpenAI only, no fallback to other AI providers:
```
AI_PRIMARY_PROVIDER=openai
AI_PROVIDER_PREFERENCE=openai,template
```

No AI at all — templates only:
```
AI_PROVIDER_PREFERENCE=template
```

---

## no AI key

Templates produce clean, data-accurate posts from live on-chain numbers.
The `ai_generated` field in the database will be `false` for all posts.
