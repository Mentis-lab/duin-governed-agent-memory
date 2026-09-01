import { describe, it, expect } from 'vitest'
import {
  CacheSignalTracker,
  normalizeUsage,
  providerStreamsUsage,
  sortToolsStable
} from './usage-accounting'

describe('normalizeUsage — disjoint buckets across provider shapes', () => {
  it('DeepSeek shape: prompt_cache_hit_tokens carves the cached share out of prompt_tokens', () => {
    const u = normalizeUsage({
      prompt_tokens: 10_000,
      completion_tokens: 500,
      prompt_cache_hit_tokens: 8_960,
      prompt_cache_miss_tokens: 1_040
    })
    expect(u).toEqual({
      inputTokens: 1_040,
      outputTokens: 500,
      cacheReadTokens: 8_960,
      cacheWriteTokens: 0,
      promptTokens: 10_000
    })
  })

  it('OpenAI shape: prompt_tokens_details.cached_tokens', () => {
    const u = normalizeUsage({
      prompt_tokens: 4_000,
      completion_tokens: 100,
      prompt_tokens_details: { cached_tokens: 3_072 }
    })
    expect(u).toMatchObject({ inputTokens: 928, cacheReadTokens: 3_072 })
  })

  it('OpenRouter/Anthropic shape: cache_creation_input_tokens counts as write, not read', () => {
    const u = normalizeUsage({
      prompt_tokens: 2_000,
      completion_tokens: 50,
      cache_creation_input_tokens: 1_500
    })
    expect(u).toMatchObject({
      inputTokens: 2_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 1_500,
      promptTokens: 3_500
    })
  })

  it('no usage → null; junk fields → clamped to zero, never negative', () => {
    expect(normalizeUsage(undefined)).toBeNull()
    expect(normalizeUsage({})).toBeNull()
    expect(normalizeUsage({ prompt_tokens: -5, completion_tokens: 'x' })).toBeNull()
    const clamped = normalizeUsage({ prompt_tokens: 100, prompt_cache_hit_tokens: 400 })
    expect(clamped).toMatchObject({ inputTokens: 0, cacheReadTokens: 100 })
  })
})

describe('providerStreamsUsage allowlist', () => {
  it('sends stream_options only to verified providers', () => {
    expect(providerStreamsUsage('deepseek')).toBe(true)
    expect(providerStreamsUsage('openai')).toBe(true)
    expect(providerStreamsUsage('openrouter')).toBe(true)
    expect(providerStreamsUsage('ollama')).toBe(false)
    expect(providerStreamsUsage('zhipu')).toBe(false)
  })
})

describe('sortToolsStable — byte-stable tool ordering (prefix content)', () => {
  const tool = (name: string) => ({ type: 'function', function: { name } })

  it('sorts by code units regardless of input order, without mutating', () => {
    const input = [tool('zeta'), tool('Alpha'), tool('beta')]
    const sorted = sortToolsStable(input)
    expect(sorted!.map((t) => t.function.name)).toEqual(['Alpha', 'beta', 'zeta'])
    expect(input[0].function.name).toBe('zeta') // original untouched
    // Determinism: any permutation yields the same bytes.
    const other = sortToolsStable([tool('beta'), tool('zeta'), tool('Alpha')])
    expect(JSON.stringify(other)).toBe(JSON.stringify(sorted))
  })

  it('passes through undefined and single-element lists untouched', () => {
    expect(sortToolsStable(undefined)).toBeUndefined()
    const one = [tool('only')]
    expect(sortToolsStable(one)).toBe(one)
  })
})

describe('CacheSignalTracker — the prefix-regression alarm', () => {
  const usage = (promptTokens: number, cacheReadTokens: number) => ({
    inputTokens: promptTokens - cacheReadTokens,
    outputTokens: 10,
    cacheReadTokens,
    cacheWriteTokens: 0,
    promptTokens
  })

  it('healthy growth (hits keep pace) never trips', () => {
    const t = new CacheSignalTracker()
    expect(t.observe('c1', usage(1_000, 0)).regressed).toBe(false)
    expect(t.observe('c1', usage(2_000, 950)).regressed).toBe(false)
    expect(t.observe('c1', usage(3_000, 1_900)).regressed).toBe(false)
  })

  it('trips when reads collapse while the prompt grew — and names the cause class', () => {
    const t = new CacheSignalTracker()
    t.observe('c1', usage(2_000, 1_800))
    const sig = t.observe('c1', usage(2_400, 0))
    expect(sig.regressed).toBe(true)
    expect(sig.reason).toContain('rewrote the stable prefix')
  })

  it('a SHRUNK prompt (compaction) is not a regression even with zero reads', () => {
    const t = new CacheSignalTracker()
    t.observe('c1', usage(10_000, 9_000))
    expect(t.observe('c1', usage(2_000, 0)).regressed).toBe(false)
  })

  it('conversations are independent and the key set is bounded', () => {
    const t = new CacheSignalTracker(2)
    t.observe('a', usage(1_000, 900))
    t.observe('b', usage(1_000, 900))
    t.observe('c', usage(1_000, 900)) // at cap: evicts oldest ('a')
    // 'b' survived the eviction: its collapse trips.
    expect(t.observe('b', usage(1_200, 0)).regressed).toBe(true)
    // 'a' was evicted: re-observing has no prior → no trip (fresh start).
    expect(t.observe('a', usage(1_200, 0)).regressed).toBe(false)
  })
})
