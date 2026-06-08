// ─────────────────────────────────────────────────────────────────────────────
// AI CONTENT GENERATION
// Priority: Grok → OpenAI → Nemotron → template fallback
// Set whichever key(s) you have. First one found wins.
// ─────────────────────────────────────────────────────────────────────────────

interface AIRequest {
  prompt: string;
  max_tokens?: number;
  system?: string;
}

const AI_SYSTEM = `You are a sharp crypto community manager. Be concise,
energetic, and authentic. No "LFG", no "to the moon", no emojis
overload. Sound like a real person, not a bot.`;

export async function callGrok(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("GROK_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-3-mini",
        messages: [
          { role: "system", content: req.system ?? AI_SYSTEM },
          { role: "user",   content: req.prompt }
        ],
        max_tokens: req.max_tokens ?? 120,
        temperature: 0.85
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) { console.warn("Grok error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("Grok failed:", e); return null; }
}

export async function callOpenAI(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: req.system ?? AI_SYSTEM },
          { role: "user",   content: req.prompt }
        ],
        max_tokens: req.max_tokens ?? 120,
        temperature: 0.85
      }),
      signal: AbortSignal.timeout(12000)
    });
    if (!res.ok) { console.warn("OpenAI error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("OpenAI failed:", e); return null; }
}

export async function callNemotron(req: AIRequest): Promise<string | null> {
  const key = Deno.env.get("NEMOTRON_API_KEY");
  if (!key) return null;
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
        messages: [
          { role: "system", content: req.system ?? AI_SYSTEM },
          { role: "user",   content: req.prompt }
        ],
        max_tokens: req.max_tokens ?? 120,
        temperature: 0.85,
        stream: false
      }),
      signal: AbortSignal.timeout(20000)
    });
    if (!res.ok) { console.warn("Nemotron error:", await res.text()); return null; }
    return (await res.json()).choices?.[0]?.message?.content?.trim() ?? null;
  } catch (e) { console.warn("Nemotron failed:", e); return null; }
}

export async function callAI(req: AIRequest): Promise<string | null> {
  return (
    await callGrok(req) ??
    await callOpenAI(req) ??
    await callNemotron(req)
  );
}

export function activeAIProvider(): string {
  if (Deno.env.get("GROK_API_KEY"))     return "grok";
  if (Deno.env.get("OPENAI_API_KEY"))   return "openai";
  if (Deno.env.get("NEMOTRON_API_KEY")) return "nemotron";
  return "template";
}
