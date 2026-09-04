import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  makeBudgetTracker,
  resolveModelId,
  setTierModelMap,
  setTierModelResolver,
  tierOfModel,
  TIER_MODEL_MAP
} from './workflow-budget'

describe('tierOfModel', () => {
  it('classifies cheap-tier model IDs via substring', () => {
    expect(tierOfModel('deepseek-v4-flash')).toBe('cheap')
    expect(tierOfModel('claude-haiku-4-5')).toBe('cheap')
    expect(tierOfModel('gemma-3n')).toBe('cheap')
    expect(tierOfModel('qwen-mini')).toBe('cheap')
    expect(tierOfModel('cheap')).toBe('cheap')
  })

  it('classifies pro-tier model IDs via substring', () => {
    expect(tierOfModel('deepseek-v4-pro')).toBe('pro')
    expect(tierOfModel('claude-opus-4-7')).toBe('pro')
    expect(tierOfModel('claude-sonnet-4-6')).toBe('pro')
    expect(tierOfModel('pro')).toBe('pro')
  })

  it('returns unknown for unrecognised IDs', () => {
    expect(tierOfModel('mystery-model')).toBe('unknown')
    expect(tierOfModel(undefined)).toBe('unknown')
    expect(tierOfModel('')).toBe('unknown')
  })
})

describe('resolveModelId', () => {
  it('passes through concrete model IDs', () => {
    expect(resolveModelId('deepseek-v4-pro', 'd')).toBe('deepseek-v4-pro')
  })
  it('ships NO model id for the symbolic tiers (P0 model plane: no default model)', () => {
    expect(TIER_MODEL_MAP).toEqual({})
  })
  it("a symbolic tier nothing resolved hands back the caller's engine, never the tier word", () => {
    expect(resolveModelId('cheap', 'd')).toBe('d')
    expect(resolveModelId('pro', 'd')).toBe('d')
    // ...and nothing at all when the caller has no engine either: the fork resolves the agentic role.
    expect(resolveModelId('cheap')).toBeUndefined()
  })
  it("falls back to the caller's engine when undefined", () => {
    expect(resolveModelId(undefined, 'fallback-id')).toBe('fallback-id')
    expect(resolveModelId(undefined)).toBeUndefined()
  })
})

describe('setTierModelMap', () => {
  it('updates the symbolic mapping', () => {
    setTierModelMap({ cheap: 'custom-cheap-id' })
    expect(resolveModelId('cheap', 'd')).toBe('custom-cheap-id')
    // Restore the shipped (empty) map.
    delete TIER_MODEL_MAP.cheap
    expect(resolveModelId('cheap', 'd')).toBe('d')
  })
})

// The bug this seam exists for: production used to SNAPSHOT both tiers into
// setTierModelMap() once, inside the synchronous app.whenReady block, from a
// resolver whose inputs (stored provider keys, the async Ollama probe) are not
// populated at that instant. The map then never changed again for the whole
// session. A resolver is re-consulted per agent() call, so late-arriving state
// lands without a restart.
describe('setTierModelResolver', () => {
  afterEach(() => setTierModelResolver(null))

  it('re-resolves each tier on EVERY call, so a late answer is not frozen out', () => {
    let live: string | null = null
    setTierModelResolver(() => live)

    // Boot-shaped state: nothing usable yet -> the caller's own engine stands.
    expect(resolveModelId('cheap', 'd')).toBe('d')

    // ...the Ollama probe lands / the operator pastes a key.
    live = 'ollama:llama3.2'
    expect(resolveModelId('cheap', 'd')).toBe('ollama:llama3.2')
    expect(resolveModelId('pro', 'd')).toBe('ollama:llama3.2')
  })

  it('is consulted only for symbolic tiers, never for concrete ids or the default', () => {
    const resolver = vi.fn(() => 'ollama:llama3.2')
    setTierModelResolver(resolver)
    expect(resolveModelId('deepseek-v4-pro', 'd')).toBe('deepseek-v4-pro')
    expect(resolveModelId(undefined, 'fallback-id')).toBe('fallback-id')
    expect(resolver).not.toHaveBeenCalled()
  })

  it("falls back to the caller's engine when the resolver throws, instead of failing the agent call", () => {
    setTierModelResolver(() => {
      throw new Error('keychain unavailable')
    })
    expect(resolveModelId('pro', 'd')).toBe('d')
  })
})

describe('makeBudgetTracker', () => {
  it('starts at 0 spent across all tiers when no model is recorded', () => {
    const t = makeBudgetTracker(100)
    expect(t.spent()).toBe(0)
    expect(t.remaining()).toBe(100)
    expect(t.byTier()).toEqual({ cheap: 0, pro: 0, unknown: 0 })
  })

  it('returns Infinity remaining when total is null', () => {
    const t = makeBudgetTracker(null)
    expect(t.remaining()).toBe(Infinity)
    expect(t.total).toBeNull()
  })

  it('accumulates per-tier spend', () => {
    const t = makeBudgetTracker(100)
    t.record('deepseek-v4-flash', 5) // cheap
    t.record('deepseek-v4-pro', 10) // pro
    t.record('deepseek-v4-flash', 7) // cheap again
    t.record('weird-model', 3) // unknown
    expect(t.spent()).toBe(25)
    expect(t.remaining()).toBe(75)
    expect(t.byTier()).toEqual({ cheap: 12, pro: 10, unknown: 3 })
  })

  it('ignores zero / negative token deltas', () => {
    const t = makeBudgetTracker(10)
    t.record('cheap', 0)
    t.record('cheap', -5)
    expect(t.spent()).toBe(0)
  })

  it('byTier() returns a copy (mutation does not affect tracker)', () => {
    const t = makeBudgetTracker(null)
    t.record('cheap', 5)
    const snap = t.byTier()
    snap.cheap = 999
    expect(t.byTier().cheap).toBe(5)
  })
})
