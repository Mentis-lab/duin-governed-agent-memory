import { describe, expect, it } from 'vitest'
import { describeEngine, groupModelsForPicker, healthReasonLabel, providerFixHint } from './model-label'
import { AUTO_ENGINE, type ModelInfo, type ProviderHealth, type RoleResolution } from './types'

// P0 model plane — the renderer's ONE engine label and the picker's usability rule.
// "usable" means healthy (a real completion succeeded), never "a key exists".

const models: ModelInfo[] = [
  { id: 'a-pro', name: 'A Pro', provider: 'anthropic', contextWindow: 1, supportsTools: true, supportsVision: true },
  { id: 'd-flash', name: 'D Flash', provider: 'deepseek', contextWindow: 1, supportsTools: true, supportsVision: false },
  { id: 'd-pro', name: 'D Pro', provider: 'deepseek', contextWindow: 1, supportsTools: true, supportsVision: false },
  { id: 'z-1', name: 'Z One', provider: 'zhipu', contextWindow: 1, supportsTools: true, supportsVision: false },
  { id: 'duin-brain', name: 'Brain', contextWindow: 1, supportsTools: false, supportsVision: false, internal: true }
]

const row = (provider: ProviderHealth['provider'], healthy: boolean, reason: ProviderHealth['reason']): ProviderHealth => ({
  provider,
  healthy,
  reason,
  checkedAt: 1
})

describe('describeEngine — one label for chip + status line', () => {
  const resolved = (source: RoleResolution['source']): RoleResolution => ({
    task: 'chat',
    modelId: 'd-flash',
    provider: 'deepseek',
    chain: ['d-flash', 'd-pro'],
    source
  })

  it('AUTO_ENGINE with a policy resolution reads "<name> · auto"', () => {
    expect(describeEngine(AUTO_ENGINE, resolved('policy'), models)).toEqual({
      label: 'D Flash · auto',
      modelId: 'd-flash',
      mode: 'auto'
    })
  })

  it('a pin that resolved reads "<name> · pinned"', () => {
    expect(describeEngine('d-flash', resolved('pin'), models)).toEqual({
      label: 'D Flash · pinned',
      modelId: 'd-flash',
      mode: 'pinned'
    })
  })

  it('a pin with no resolution yet still names the pin (never the sentinel)', () => {
    expect(describeEngine('a-pro', null, models)).toEqual({ label: 'A Pro · pinned', modelId: 'a-pro', mode: 'pinned' })
  })

  it('AUTO_ENGINE with nothing routable is an honest "No usable engine"', () => {
    expect(describeEngine(AUTO_ENGINE, null, models)).toEqual({ label: 'No usable engine', modelId: null, mode: 'none' })
  })

  it('falls back to a compacted id when the catalog does not know the model', () => {
    expect(describeEngine('gone-v1-pro', null, models).label).toBe('Gone V1 Pro · pinned')
  })
})

describe('groupModelsForPicker — policy order first, usable = healthy', () => {
  const label = (id: string): string => id.toUpperCase()

  it('orders groups by the policy, then the curated order, then alphabetically; drops internal rows', () => {
    const groups = groupModelsForPicker({
      models,
      policyOrder: ['deepseek'],
      curatedOrder: ['anthropic', 'zhipu'],
      health: [],
      label
    })
    expect(groups.map((g) => g.id)).toEqual(['deepseek', 'anthropic', 'zhipu'])
    expect(groups.find((g) => g.id === 'deepseek')?.models.map((m) => m.id)).toEqual(['d-flash', 'd-pro'])
    expect(groups.some((g) => g.models.some((m) => m.internal))).toBe(false)
    expect(groups.every((g) => g.probed === false && g.healthy === false)).toBe(true)
  })

  it('a keyed provider whose probe failed is NOT usable and carries its reason', () => {
    const groups = groupModelsForPicker({
      models,
      policyOrder: ['anthropic', 'deepseek', 'zhipu'],
      curatedOrder: [],
      health: [row('anthropic', false, 'no-credit'), row('deepseek', true, 'ok'), row('zhipu', false, 'no-key')],
      label
    })
    // Anthropic stays FIRST (the operator's order), greyed — it is not moved or hidden.
    expect(groups.map((g) => [g.id, g.healthy, g.reason])).toEqual([
      ['anthropic', false, 'no-credit'],
      ['deepseek', true, 'ok'],
      ['zhipu', false, 'no-key']
    ])
  })

  it('an unlisted provider (imported/custom) lands after the policy and curated groups', () => {
    const withCustom: ModelInfo[] = [...models, { id: 'c-1', name: 'C', provider: 'groq', contextWindow: 1, supportsTools: false, supportsVision: false }]
    const groups = groupModelsForPicker({ models: withCustom, policyOrder: ['zhipu'], curatedOrder: ['deepseek'], health: [], label })
    expect(groups.map((g) => g.id)).toEqual(['zhipu', 'deepseek', 'anthropic', 'groq'])
  })
})

describe('health reason → label + fix hint (mirror of roles.ts providerFixHint)', () => {
  it('names every classified reason', () => {
    expect(healthReasonLabel('ok')).toBe('healthy')
    expect(healthReasonLabel('no-credit')).toBe('no credit')
    expect(healthReasonLabel('unauthorized')).toBe('key rejected')
    expect(healthReasonLabel('rate-limit')).toBe('rate-limited')
    expect(healthReasonLabel(undefined)).toBe('unchecked')
  })

  it('hints say what to do, with the provider named, and nothing for a healthy provider', () => {
    expect(providerFixHint('ok', 'DeepSeek')).toBe('')
    expect(providerFixHint('no-credit', 'Anthropic')).toContain('Anthropic has no credit')
    expect(providerFixHint('no-key', 'Zhipu')).toContain('Add a Zhipu key')
    expect(providerFixHint(undefined, 'Groq')).toContain('has not been probed')
  })
})
