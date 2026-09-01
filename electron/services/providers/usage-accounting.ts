// Provider cache-usage accounting (efficiency campaign §5.1's missing half —
// the MEASUREMENT side; 2026-08-15, deepseek-harness graft A1).
//
// DUIN engineered prefix stability (prompt-layout.mjs + prefill-cache.ts,
// DUIN_STABLE_PREFIX) but reads NONE of the cache telemetry providers return,
// so nothing can prove the discipline pays or catch a regression that quietly
// re-busts the prefix. This module is the instrument: normalize every
// provider's usage block into DISJOINT buckets and keep a per-conversation
// signal that flags the classic failure — cache reads collapsing while the
// prompt keeps growing (a header/layout change upstream broke the prefix).
//
// Bucket convention (dsh-verified): OpenAI-shaped `prompt_tokens` INCLUDES
// cached tokens, so `inputTokens` here is the UNCACHED remainder —
// prompt_tokens − cacheRead — and the four buckets never overlap:
//   billedInput ≈ inputTokens (full price) + cacheReadTokens (~10x cheaper on
//   DeepSeek) + cacheWriteTokens (Anthropic-only surcharge, via OpenRouter).
// DeepSeek reports hits as prompt_cache_hit_tokens (and mirrors OpenAI's
// prompt_tokens_details.cached_tokens); it has no cache-write metric.
//
// Pure: no electron, no I/O — unit-testable and importable anywhere.

export interface NormalizedUsage {
  /** Uncached prompt tokens (full price). */
  inputTokens: number
  outputTokens: number
  /** Prompt tokens served from the provider's prefix cache. */
  cacheReadTokens: number
  /** Cache-write tokens (Anthropic via OpenRouter); 0 for DeepSeek/OpenAI. */
  cacheWriteTokens: number
  /** inputTokens + cacheReadTokens + cacheWriteTokens — the prompt's real size,
   *  which is the number the regression signal tracks growth on. */
  promptTokens: number
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Normalize a wire `usage` object (OpenAI / DeepSeek / OpenRouter shapes) into
 *  disjoint buckets. Returns null when there is no usable usage at all. */
export function normalizeUsage(raw: unknown): NormalizedUsage | null {
  if (!raw || typeof raw !== 'object') return null
  const u = raw as Record<string, unknown>
  const details = (u.prompt_tokens_details ?? null) as Record<string, unknown> | null
  const prompt = num(u.prompt_tokens)
  const output = num(u.completion_tokens)
  const cacheRead = Math.max(
    num(details?.cached_tokens),
    num(u.prompt_cache_hit_tokens)
  )
  const cacheWrite = num(u.cache_creation_input_tokens)
  if (prompt === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return null
  // Clamp reads to the reported prompt FIRST so the buckets always sum:
  // inputTokens + cacheReadTokens = prompt, promptTokens = prompt + write.
  const read = Math.min(cacheRead, prompt)
  return {
    inputTokens: prompt - read,
    outputTokens: output,
    cacheReadTokens: read,
    cacheWriteTokens: cacheWrite,
    promptTokens: prompt + cacheWrite
  }
}

/** Providers verified to accept OpenAI's `stream_options: {include_usage}` on
 *  streaming requests. Everyone else still gets opportunistic capture when a
 *  final chunk carries usage anyway (DeepSeek does even unasked); the option is
 *  simply not SENT to providers that might 400 on an unknown parameter. */
const STREAM_USAGE_PROVIDERS = new Set(['deepseek', 'openai', 'openrouter'])

export function providerStreamsUsage(provider: string): boolean {
  return STREAM_USAGE_PROVIDERS.has(provider)
}

/** Providers with a server-side prefix cache, where re-sending a shared
 *  prefix is discounted (DeepSeek ~10x, OpenAI 50%, Anthropic-via-OpenRouter
 *  cache_control). Model compaction's prefix-extension request only makes
 *  economic sense on these — anywhere else the "extension" is a full-price
 *  re-bill (or minutes of local re-prefill on ollama). */
const PREFIX_CACHE_PROVIDERS = new Set(['deepseek', 'openai', 'openrouter'])

export function providerHasPrefixCache(provider: string): boolean {
  return PREFIX_CACHE_PROVIDERS.has(provider)
}

/**
 * Deterministic tool ordering (A2b): the serialized tool list is part of the
 * request prefix, so its ORDER must be byte-stable across boots and MCP
 * reconnects or cross-session cache hits die on a reshuffle. Code-unit sort
 * (locale-independent — identical on every machine), non-mutating.
 */
export function sortToolsStable<T>(tools: T[] | undefined): T[] | undefined {
  if (!tools || tools.length < 2) return tools
  const nameOf = (t: T): string =>
    ((t as { function?: { name?: string } }).function?.name ?? '') as string
  return [...tools].sort((a, b) => {
    const na = nameOf(a)
    const nb = nameOf(b)
    return na < nb ? -1 : na > nb ? 1 : 0
  })
}

export interface CacheSignal {
  regressed: boolean
  reason?: string
}

/**
 * Per-conversation prefix-cache regression detector (dsh's "the production
 * signal": a header change or layout bug appears as a cache-read DROP on the
 * next step while the prompt kept growing). Advisory — it warns, never gates.
 */
export class CacheSignalTracker {
  private last = new Map<string, { promptTokens: number; cacheReadTokens: number }>()
  private readonly cap: number

  constructor(cap = 200) {
    this.cap = cap
  }

  observe(key: string, usage: NormalizedUsage): CacheSignal {
    const prev = this.last.get(key)
    // LRU bound so a long-lived process doesn't accumulate dead
    // conversations — re-observing refreshes recency (delete+set), so a
    // busy old conversation is not evicted before idle newer ones.
    if (!prev && this.last.size >= this.cap) {
      const oldest = this.last.keys().next().value
      if (oldest !== undefined) this.last.delete(oldest)
    }
    if (prev) this.last.delete(key)
    this.last.set(key, {
      promptTokens: usage.promptTokens,
      cacheReadTokens: usage.cacheReadTokens
    })
    if (!prev) return { regressed: false }

    const grew = usage.promptTokens >= prev.promptTokens
    const hadHits = prev.cacheReadTokens > 0
    const collapsed = usage.cacheReadTokens < prev.cacheReadTokens * 0.25
    if (grew && hadHits && collapsed) {
      return {
        regressed: true,
        reason:
          `cache-read collapsed ${prev.cacheReadTokens} → ${usage.cacheReadTokens} tokens while the prompt grew ` +
          `${prev.promptTokens} → ${usage.promptTokens} — something upstream rewrote the stable prefix ` +
          `(system-prompt block, tool order, or layout change).`
      }
    }
    return { regressed: false }
  }

  /** Test seam. */
  reset(): void {
    this.last.clear()
  }
}

/** Process-wide tracker keyed by conversation id (falls back to model id for
 *  conversationless calls). One instance so every chatStream call feeds the
 *  same memory. */
export const cacheSignalTracker = new CacheSignalTracker()
