import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// Controllable keychain so we can simulate "only provider X is keyed" without a real
// keychain. Mirrors registry-route.test.ts's mocking pattern.
vi.mock('../keychain', () => ({ getKey: vi.fn(() => null as string | null) }))
vi.mock('../event-log', () => ({ recordEvent: vi.fn() }))

import { resolveWorkflowTierModel, detectOllama, MODEL_CATALOG } from './registry'
import { getKey } from '../keychain'
import { resolveModelId, setTierModelResolver, TIER_MODEL_MAP } from '../workflow-budget'

afterEach(() => {
  vi.mocked(getKey).mockReset()
  vi.mocked(getKey).mockReturnValue(null as unknown as string)
})

// B5 fix — before this fix, workflow-budget.ts's TIER_MODEL_MAP was a hardcoded literal
// {cheap: 'deepseek-v4-flash', pro: 'deepseek-v4-pro'} that setTierModelMap() (its
// documented production override) never actually replaced. resolveWorkflowTierModel is
// the new production wiring: it must resolve each symbolic tier to a model whose
// PROVIDER the operator actually keyed, not unconditionally to DeepSeek.
describe('resolveWorkflowTierModel', () => {
  it('resolves cheap -> a flash/open/coder-tier model when every provider is keyed', () => {
    vi.mocked(getKey).mockReturnValue('test-key')
    const id = resolveWorkflowTierModel('cheap')
    expect(id).toBe('claude-haiku-4-5') // first flash-tier catalog entry (anthropic leads the 2026-08-21 catalog order)
    const desc = MODEL_CATALOG.find((m) => m.id === id)
    expect(['flash', 'open', 'coder']).toContain(desc?.tier)
  })

  it('resolves pro -> a pro/reasoner-tier model when every provider is keyed', () => {
    vi.mocked(getKey).mockReturnValue('test-key')
    const id = resolveWorkflowTierModel('pro')
    expect(id).toBe('claude-opus-5') // first pro-tier catalog entry (anthropic leads the 2026-08-21 catalog order)
    const desc = MODEL_CATALOG.find((m) => m.id === id)
    expect(['pro', 'reasoner']).toContain(desc?.tier)
  })

  it('never returns the duin-brain connector for either tier', () => {
    vi.mocked(getKey).mockReturnValue('test-key')
    expect(resolveWorkflowTierModel('cheap')).not.toBe('duin-brain')
    expect(resolveWorkflowTierModel('pro')).not.toBe('duin-brain')
  })

  // The regression this fix is FOR: an operator with a Zhipu key and no DeepSeek key.
  // Before the fix nothing consulted key availability at all, so every workflow
  // `agent(prompt, {model:'cheap'|'pro'})` call resolved to the literal DeepSeek ids
  // regardless of this. Now it must route to the provider that is actually usable.
  it('routes to the keyed provider (zhipu), NOT the hardcoded DeepSeek default, when only that provider has a key', () => {
    vi.mocked(getKey).mockImplementation((provider: string) => (provider === 'zhipu' ? 'test-key' : null))
    const cheap = resolveWorkflowTierModel('cheap')
    const pro = resolveWorkflowTierModel('pro')
    expect(cheap).toBe('glm-5-turbo')
    expect(pro).toBe('glm-5.3')
    expect(cheap).not.toBe('deepseek-v4-flash')
    expect(pro).not.toBe('deepseek-v4-pro')
    expect(MODEL_CATALOG.find((m) => m.id === cheap)?.provider).toBe('zhipu')
    expect(MODEL_CATALOG.find((m) => m.id === pro)?.provider).toBe('zhipu')
  })

  it('never resolves to a picker-hidden operator-only model even if its provider is keyed', () => {
    // Only the 'oneai' benchmark gateway is keyed. Its two catalog entries
    // (gpt-5.5-oneai / gpt-5.6-sol-oneai) are both tier:'pro' and hidden:true.
    vi.mocked(getKey).mockImplementation((provider: string) => (provider === 'oneai' ? 'test-key' : null))
    expect(resolveWorkflowTierModel('pro')).toBeNull()
  })

  it('returns null when nothing is keyed and no local Ollama model is detected', () => {
    vi.mocked(getKey).mockReturnValue(null as unknown as string)
    expect(resolveWorkflowTierModel('cheap')).toBeNull()
    expect(resolveWorkflowTierModel('pro')).toBeNull()
  })

  it('falls back to a detected local Ollama model when no provider is keyed', async () => {
    vi.mocked(getKey).mockReturnValue(null as unknown as string)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2' }] }) })) as any
    await detectOllama()
    expect(resolveWorkflowTierModel('cheap')).toBe('ollama:llama3.2')
    expect(resolveWorkflowTierModel('pro')).toBe('ollama:llama3.2')
  })
})

/**
 * The staleness half of the same defect, at the seam main.ts actually wires.
 *
 * main.ts used to call resolveWorkflowTierModel() TWICE, synchronously, inside
 * app.whenReady and freeze the two answers into TIER_MODEL_MAP. Both of this
 * resolver's inputs arrive later than that instant: `ollamaModels` is only ever
 * filled by the async detectOllama() probe that startLocalBrain fires further
 * down the same function, and a provider key can be pasted during onboarding.
 * So a keyless local-Ollama install snapshotted null/null on EVERY launch and
 * every workflow `agent(prompt, {model:'cheap'})` demanded a DeepSeek key for
 * the whole session. It was invisible because every other consumer of the same
 * registry (routeModel, chatOnce) calls getKey() live and behaves correctly.
 */
describe('workflow tier wiring: registry resolver -> workflow-budget', () => {
  beforeEach(async () => {
    // Boot-shaped state: no keys, and the Ollama probe has not succeeded.
    vi.mocked(getKey).mockReturnValue(null as unknown as string)
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await detectOllama()
    setTierModelResolver(resolveWorkflowTierModel) // exactly what main.ts registers
  })
  afterEach(() => setTierModelResolver(null))

  it('routes a workflow tier to Ollama once the async probe lands, mid-session', async () => {
    // At "boot" nothing is usable, so the shipped last-resort default stands.
    expect(resolveModelId('cheap', 'default-model')).toBe(TIER_MODEL_MAP.cheap)

    // startLocalBrain's `void detectOllama()` resolves a second after whenReady.
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ models: [{ name: 'llama3.2' }] })
    })) as unknown as typeof fetch
    await detectOllama()

    // Same call, no restart. Under the boot snapshot both stayed on DeepSeek forever.
    expect(resolveModelId('cheap', 'default-model')).toBe('ollama:llama3.2')
    expect(resolveModelId('pro', 'default-model')).toBe('ollama:llama3.2')
  })

  it('routes a workflow tier to a provider key pasted after launch, without a restart', () => {
    expect(resolveModelId('pro', 'default-model')).toBe(TIER_MODEL_MAP.pro)

    // settings:saveProviderKey lands a Zhipu key post-onboarding.
    vi.mocked(getKey).mockImplementation((provider: string) => (provider === 'zhipu' ? 'test-key' : null))

    expect(resolveModelId('pro', 'default-model')).toBe('glm-5.3')
    expect(resolveModelId('cheap', 'default-model')).toBe('glm-5-turbo')
  })
})
