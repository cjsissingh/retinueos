// backend/src/models/model-catalog.ts
//
// Live model lists from each provider's own API — backs GET /models so the
// frontend's model picker is a dropdown of what's actually callable right
// now, not free text a typo can silently break (see model-routes.ts). Each
// provider's own model-list endpoint is the only real source of truth here:
// baking a static list into this codebase would just go stale the next time
// a provider ships a model, same problem the AI SDK itself deliberately
// doesn't solve (it's a calling layer, not a catalog).
//
// Cached in-memory per provider, briefly — this is called every time a
// model picker mounts, and a provider's lineup doesn't change minute to
// minute. A failed fetch (rate limit, network blip, revoked key) resolves
// to `[]` rather than throwing, so one flaky provider can't break the
// dropdown for the other.

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; models: string[] }>();

// OpenAI's /v1/models lists every model behind the account, including
// non-chat modalities (tts, transcription, embeddings, image generation,
// moderation, legacy completion) that would never be a sane pick for a
// persona's chat model. Allowlist the chat-model families, then strip out
// the non-chat ones that happen to share a prefix.
const OPENAI_INCLUDE = /^(gpt-|o[0-9]|chatgpt)/i;
const OPENAI_EXCLUDE = /audio|tts|transcribe|embedding|moderation|whisper|dall-e|image|realtime|instruct/i;

async function fetchOpenAiModels(): Promise<string[]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenAI models list failed: ${res.status}`);
  // SAFETY: OpenAI's /v1/models is a stable, documented endpoint returning
  // this shape; a shape change would surface as a runtime error below
  // rather than silently, since nothing here defends against `data` being
  // absent or non-array.
  const body = (await res.json()) as { data: Array<{ id: string }> };
  return body.data
    .map((m) => m.id)
    .filter((id) => OPENAI_INCLUDE.test(id) && !OPENAI_EXCLUDE.test(id))
    .sort();
}

async function fetchAnthropicModels(): Promise<string[]> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (!res.ok) throw new Error(`Anthropic models list failed: ${res.status}`);
  // SAFETY: Anthropic's /v1/models is a stable, documented endpoint
  // returning this shape; a shape change would surface as a runtime error
  // below rather than silently, since nothing here defends against `data`
  // being absent or non-array.
  const body = (await res.json()) as { data: Array<{ id: string }> };
  // Anthropic already returns newest-first — keep that order rather than
  // alphabetizing a "which one is current" signal away.
  return body.data.map((m) => m.id);
}

const FETCHERS = {
  anthropic: fetchAnthropicModels,
  openai: fetchOpenAiModels,
} satisfies Record<string, () => Promise<string[]>>;

async function getModelsFor(provider: string): Promise<string[]> {
  const hit = cache.get(provider);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.models;
  if (!Object.hasOwn(FETCHERS, provider)) return [];
  // SAFETY: Object.hasOwn just confirmed `provider` is one of FETCHERS's
  // own keys.
  const fetcher = FETCHERS[provider as keyof typeof FETCHERS];
  const models = await fetcher();
  cache.set(provider, { at: Date.now(), models });
  return models;
}

/** One entry per requested provider, always present (possibly `[]`) even if
 *  that provider's fetch failed — a picker for one provider should never go
 *  blank because another provider's API had a bad moment. */
export async function fetchAvailableModels(providers: string[]): Promise<Record<string, string[]>> {
  const out: Record<string, string[]> = {};
  await Promise.all(
    providers.map(async (provider) => {
      out[provider] = await getModelsFor(provider).catch(() => []);
    }),
  );
  return out;
}

/** Test-only: clears the in-memory cache so tests don't see each other's fetch mocks. */
export function resetModelCatalogCache(): void {
  cache.clear();
}
