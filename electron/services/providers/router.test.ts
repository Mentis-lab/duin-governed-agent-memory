// router.test — the pure resolution algebra (roles.ts contract, decision D2), hermetic.
//
// No catalog, keychain, settings or health cache: every input is a table below, so each key of
// the resolution (pin > policy order > health > tier) is asserted in isolation and the failure
// names the key that moved.

import { describe, it, expect } from 'vitest'
import {
  resolveRoleCore,
  resolveJuryCore,
  normalizeProviderPolicy,
  providerOrderFor,
  canonicalTask,
  nextFailoverHop,
  exhaustionMessage,
  roleTierOrder,
  DEFAULT_POLICY_SPEED,
  type RoleResolverInput,
  type ProviderHealthState
} from './router'
import type { ProviderId } from './registry'
import type { ProviderPolicy } from './roles'

const CATALOG: ProviderId[] = ['deepseek', 'openai', 'anthropic', 'zhipu', 'ollama']

/** Models per provider, chat-best first; the structured roles get the same list reversed so a
 *  test can tell which tier order was applied. */
const MODELS: Record<string, string[]> = {
  deepseek: ['ds-pro', 'ds-flash'],
  openai: ['oa-pro', 'oa-mini'],
  anthropic: ['cl-opus', 'cl-haiku'],
  zhipu: ['glm-pro', 'glm-flash'],
  ollama: ['ollama:llama']
}

function input(over: {
  policy?: Partial<ProviderPolicy>
  keyed?: ProviderId[]
  health?: Partial<Record<ProviderId, ProviderHealthState>>
  catalog?: ProviderId[]
} = {}): RoleResolverInput {
  const keyed = new Set<ProviderId>(over.keyed ?? ['deepseek', 'openai', 'anthropic'])
  const health = over.health ?? {}
  return {
    policy: { order: [], roles: {}, localOnlyBackground: false, speed: 'fast', ...over.policy },
    catalogOrder: over.catalog ?? CATALOG,
    isKeyed: (p) => keyed.has(p),
    healthOf: (p) => health[p] ?? 'unknown',
    candidates: (p, task) => {
      const list = MODELS[p] ?? []
      return task === 'chat' || task === 'agentic' ? list : [...list].reverse()
    },
    pinInfo: (id) => {
      for (const [p, ids] of Object.entries(MODELS)) {
        if (ids.includes(id)) return { provider: p as ProviderId, callable: keyed.has(p as ProviderId) }
      }
      return null
    }
  }
}

describe('providerOrderFor — the policy is the primary key', () => {
  it('empty order = every keyed provider in catalog order (never stored, computed here)', () => {
    expect(providerOrderFor('chat', input())).toEqual(['deepseek', 'openai', 'anthropic'])
  })

  it('a ranked order comes first; unranked keyed providers are appended in catalog order', () => {
    const i = input({ policy: { order: ['anthropic'] } })
    expect(providerOrderFor('chat', i)).toEqual(['anthropic', 'deepseek', 'openai'])
  })

  it('a role override outranks the general order for that role only', () => {
    const i = input({ policy: { order: ['deepseek'], roles: { extraction: ['openai'] } } })
    expect(providerOrderFor('extraction', i)).toEqual(['openai', 'deepseek', 'anthropic'])
    expect(providerOrderFor('chat', i)).toEqual(['deepseek', 'openai', 'anthropic'])
  })

  it('unkeyed providers never appear, even when ranked', () => {
    const i = input({ policy: { order: ['zhipu', 'openai'] }, keyed: ['openai'] })
    expect(providerOrderFor('chat', i)).toEqual(['openai'])
  })

  it('localOnlyBackground confines the background roles to the local runtime, chat untouched', () => {
    const i = input({ policy: { localOnlyBackground: true }, keyed: ['deepseek', 'ollama'] })
    expect(providerOrderFor('extraction', i)).toEqual(['ollama'])
    expect(providerOrderFor('jury', i)).toEqual(['ollama'])
    expect(providerOrderFor('title', i)).toEqual(['ollama'])
    expect(providerOrderFor('embed', i)).toEqual(['ollama'])
    expect(providerOrderFor('chat', i)).toEqual(['deepseek', 'ollama'])
    expect(providerOrderFor('reviewer', i)).toEqual(['deepseek', 'ollama'])
  })

  it('localOnlyBackground with no local runtime resolves NOTHING for background roles — honestly', () => {
    const i = input({ policy: { localOnlyBackground: true }, keyed: ['deepseek'] })
    expect(providerOrderFor('extraction', i)).toEqual([])
    expect(resolveRoleCore('extraction', i)).toBeNull()
  })
})

describe('resolveRoleCore — pin > policy order > health > tier', () => {
  it('resolves the head of the policy order and returns the full chain, one model per provider', () => {
    const r = resolveRoleCore('chat', input())!
    expect(r).toMatchObject({ task: 'chat', modelId: 'ds-pro', provider: 'deepseek', source: 'policy' })
    expect(r.chain).toEqual(['ds-pro', 'oa-pro', 'cl-opus'])
    expect(r.chain[0]).toBe(r.modelId)
  })

  it('the role tier order picks the model inside a provider (extraction gets the cheap one)', () => {
    expect(resolveRoleCore('extraction', input())!.modelId).toBe('ds-flash')
    expect(resolveRoleCore('title', input())!.modelId).toBe('ds-flash')
    expect(resolveRoleCore('chat', input())!.modelId).toBe('ds-pro')
  })

  it('an unhealthy provider moves to the END of the chain — never out of it', () => {
    const r = resolveRoleCore('chat', input({ health: { deepseek: 'unhealthy' } }))!
    expect(r.provider).toBe('openai')
    expect(r.chain).toEqual(['oa-pro', 'cl-opus', 'ds-pro'])
  })

  it("'unknown' health ranks with healthy — an unobserved provider is not doomed", () => {
    const r = resolveRoleCore('chat', input({ health: { deepseek: 'unknown', openai: 'healthy' } }))!
    expect(r.provider).toBe('deepseek')
  })

  it('every keyed provider unhealthy → the order is unchanged and the turn still resolves', () => {
    const r = resolveRoleCore('chat', input({ health: { deepseek: 'unhealthy', openai: 'unhealthy', anthropic: 'unhealthy' } }))!
    expect(r.chain).toEqual(['ds-pro', 'oa-pro', 'cl-opus'])
  })

  it('a callable, not-unhealthy pin wins (source: pin) and heads the chain', () => {
    const r = resolveRoleCore('chat', input(), { pin: 'cl-haiku' })!
    expect(r).toMatchObject({ modelId: 'cl-haiku', provider: 'anthropic', source: 'pin' })
    expect(r.chain).toEqual(['cl-haiku', 'ds-pro', 'oa-pro', 'cl-opus'])
  })

  it('a pin whose provider is unhealthy loses to policy and rides at the END of the chain', () => {
    const r = resolveRoleCore('chat', input({ health: { anthropic: 'unhealthy' } }), { pin: 'cl-haiku' })!
    expect(r).toMatchObject({ modelId: 'ds-pro', source: 'policy' })
    expect(r.chain[r.chain.length - 1]).toBe('cl-haiku')
  })

  it('a pin that is not callable (unknown id / no key) is ignored', () => {
    expect(resolveRoleCore('chat', input(), { pin: 'no-such-model' })!.source).toBe('policy')
    expect(resolveRoleCore('chat', input(), { pin: 'glm-pro' })!.modelId).toBe('ds-pro') // zhipu unkeyed
  })

  it('reviewer skips the avoided provider while another candidate exists, else falls back to it', () => {
    const avoid = new Set<ProviderId>(['deepseek'])
    expect(resolveRoleCore('reviewer', input(), { avoidProviders: avoid })!.provider).toBe('openai')
    expect(resolveRoleCore('reviewer', input({ keyed: ['deepseek'] }), { avoidProviders: avoid })!.provider).toBe('deepseek')
  })

  it("'reason' resolves as chat and 'code' as agentic (legacy aliases)", () => {
    expect(canonicalTask('reason')).toBe('chat')
    expect(canonicalTask('code')).toBe('agentic')
    expect(resolveRoleCore('reason', input())!.task).toBe('reason')
    expect(resolveRoleCore('code', input())!.task).toBe('agentic')
  })

  it('returns null when nothing is callable', () => {
    expect(resolveRoleCore('chat', input({ keyed: [] }))).toBeNull()
    expect(resolveRoleCore('chat', input({ keyed: [] }), { pin: 'ds-pro' })).toBeNull()
  })
})

describe('resolveJuryCore — distinct, healthy, honest', () => {
  it('three keyed healthy providers → three distinct jurors, cheap tier each', () => {
    const panel = resolveJuryCore(3, input())
    expect(panel.map((r) => r.provider)).toEqual(['deepseek', 'openai', 'anthropic'])
    expect(panel.map((r) => r.modelId)).toEqual(['ds-flash', 'oa-mini', 'cl-haiku'])
    for (const r of panel) expect(r.chain).toEqual([r.modelId])
  })

  it('never seats an unhealthy provider — fewer than asked is the honest answer', () => {
    const panel = resolveJuryCore(3, input({ health: { openai: 'unhealthy', anthropic: 'unhealthy' } }))
    expect(panel.map((r) => r.provider)).toEqual(['deepseek'])
  })

  it('never seats an avoided provider (the extractor’s family)', () => {
    const panel = resolveJuryCore(3, input(), { avoidProviders: new Set<ProviderId>(['deepseek']) })
    expect(panel.map((r) => r.provider)).toEqual(['openai', 'anthropic'])
  })

  it('an estate with nothing healthy seats nobody', () => {
    expect(resolveJuryCore(3, input({ health: { deepseek: 'unhealthy', openai: 'unhealthy', anthropic: 'unhealthy' } }))).toEqual([])
    expect(resolveJuryCore(0, input())).toEqual([])
  })

  it('localOnlyBackground seats only the local runtime', () => {
    const panel = resolveJuryCore(3, input({ policy: { localOnlyBackground: true }, keyed: ['deepseek', 'ollama'] }))
    expect(panel.map((r) => r.provider)).toEqual(['ollama'])
  })
})

describe('normalizeProviderPolicy — settings.json is untrusted input', () => {
  it('drops unknown providers, de-duplicates, keeps only known roles, and coerces the switch', () => {
    const p = normalizeProviderPolicy(
      {
        order: ['deepseek', 'bogus', 'deepseek', 42, 'openai'],
        roles: { extraction: ['openai', 'nope'], bogusRole: ['deepseek'], title: [] },
        localOnlyBackground: 'yes'
      },
      CATALOG
    )
    expect(p).toEqual({ order: ['deepseek', 'openai'], roles: { extraction: ['openai'] }, localOnlyBackground: false, speed: 'fast' })
  })

  it('anything that is not an object is the empty policy', () => {
    for (const raw of [undefined, null, 'x', 7, []]) {
      expect(normalizeProviderPolicy(raw, CATALOG)).toEqual({ order: [], roles: {}, localOnlyBackground: false, speed: 'fast' })
    }
  })

  it('speed: the three values pass through; anything else (or absent) reads as the default, fast', () => {
    for (const s of ['fast', 'balanced', 'strong'] as const) {
      expect(normalizeProviderPolicy({ speed: s }, CATALOG).speed).toBe(s)
    }
    for (const s of [undefined, 'turbo', 1, null]) {
      expect(normalizeProviderPolicy({ speed: s }, CATALOG).speed).toBe(DEFAULT_POLICY_SPEED)
    }
  })
})

describe('roleTierOrder — the speed preference moves chat/agentic only', () => {
  it('fast = flash → open → pro → reasoner; balanced = pro → reasoner → flash → open; strong = reasoner → pro → flash → open', () => {
    expect(roleTierOrder('chat', 'fast').slice(0, 4)).toEqual(['flash', 'open', 'pro', 'reasoner'])
    expect(roleTierOrder('chat', 'balanced').slice(0, 4)).toEqual(['pro', 'reasoner', 'flash', 'open'])
    expect(roleTierOrder('chat', 'strong').slice(0, 4)).toEqual(['reasoner', 'pro', 'flash', 'open'])
    for (const s of ['fast', 'balanced', 'strong'] as const) {
      expect(roleTierOrder('agentic', s)).toEqual(roleTierOrder('chat', s))
    }
  })

  it('the default (absent speed) is fast — the evaluation’s chat pick', () => {
    expect(DEFAULT_POLICY_SPEED).toBe('fast')
    expect(roleTierOrder('chat')).toEqual(roleTierOrder('chat', 'fast'))
  })

  it('extraction / title / jury / embed / reviewer keep the cheap-first order under every speed', () => {
    for (const task of ['extraction', 'title', 'jury', 'embed', 'reviewer'] as const) {
      for (const s of ['fast', 'balanced', 'strong'] as const) {
        expect(roleTierOrder(task, s).slice(0, 3), `${task}/${s}`).toEqual(['flash', 'open', 'pro'])
      }
    }
  })

  it('resolution hands the policy speed to the candidate lookup for every provider', () => {
    const seen: string[] = []
    const i = input({ policy: { speed: 'strong' } })
    const spy: RoleResolverInput = { ...i, candidates: (p, task, speed) => { seen.push(`${p}:${task}:${speed}`); return i.candidates(p, task, speed) } }
    resolveRoleCore('chat', spy)
    expect(seen).toEqual(['deepseek:chat:strong', 'openai:chat:strong', 'anthropic:chat:strong'])
    seen.length = 0
    resolveJuryCore(2, spy)
    expect(seen).toEqual(['deepseek:jury:strong', 'openai:jury:strong'])
  })
})

describe('nextFailoverHop — the walk the round loop takes on a classified failure', () => {
  const providerOf = (id: string): ProviderId => {
    for (const [p, ids] of Object.entries(MODELS)) if (ids.includes(id)) return p as ProviderId
    throw new Error(`unknown ${id}`)
  }
  const chain = ['ds-pro', 'oa-pro', 'cl-opus']
  const hop = (over: Partial<Parameters<typeof nextFailoverHop>[0]>): string | null =>
    nextFailoverHop({
      chain,
      triedModels: new Set(['ds-pro']),
      providerOf,
      reason: 'no-credit',
      failedModelId: 'ds-pro',
      withinProvider: () => 'ds-flash',
      ...over
    })

  it('an account-level failure moves to the next provider in the chain — never the same account with another id', () => {
    expect(hop({ reason: 'no-credit' })).toBe('oa-pro')
    expect(hop({ reason: 'unauthorized' })).toBe('oa-pro')
    expect(hop({ reason: 'model-access' })).toBe('oa-pro')
    expect(hop({ reason: 'rate-limit' })).toBe('oa-pro')
    expect(hop({ reason: 'network' })).toBe('oa-pro')
  })

  it('a stale id (not-found) first tries the SAME provider’s next catalog id', () => {
    expect(hop({ reason: 'not-found' })).toBe('ds-flash')
    // …and falls through to the chain when the provider has nothing else.
    expect(hop({ reason: 'not-found', withinProvider: () => null })).toBe('oa-pro')
    // …and never returns an id already tried.
    expect(hop({ reason: 'not-found', triedModels: new Set(['ds-pro', 'ds-flash']) })).toBe('oa-pro')
  })

  it('skips every provider already tried this round, not just the last one (the third provider is reached)', () => {
    expect(hop({ triedModels: new Set(['ds-pro', 'oa-pro']), failedModelId: 'oa-pro' })).toBe('cl-opus')
    expect(hop({ triedModels: new Set(['ds-pro', 'oa-mini']), failedModelId: 'oa-mini' })).toBe('cl-opus')
  })

  it('returns null — exhausted — when nothing untried remains', () => {
    expect(hop({ triedModels: new Set(['ds-pro', 'oa-pro', 'cl-opus']), failedModelId: 'cl-opus' })).toBeNull()
    expect(hop({ chain: [] })).toBeNull()
  })
})

describe('exhaustionMessage — every engine with its own reason, one hint, the raw text last', () => {
  it('names each attempt with the reason IT failed for and hints at the first preference', () => {
    const msg = exhaustionMessage(
      [
        { modelId: 'claude-opus-5', reason: 'no-credit' },
        { modelId: 'gpt-5.5', reason: 'model-access' },
        { modelId: 'deepseek-v4-flash', reason: 'network' }
      ],
      'Anthropic (Claude)',
      'deepseek: network — fetch failed'
    )
    expect(msg).toContain('3 tried')
    expect(msg).toContain('claude-opus-5 (no-credit) → gpt-5.5 (model-access) → deepseek-v4-flash (network)')
    expect(msg).toContain('Anthropic (Claude) has no credit')
    expect(msg.endsWith('Last error: deepseek: network — fetch failed')).toBe(true)
    // Front-loaded: the walk comes before the hint, the hint before the raw text.
    expect(msg.indexOf('tried')).toBeLessThan(msg.indexOf('has no credit'))
    expect(msg.indexOf('has no credit')).toBeLessThan(msg.indexOf('Last error'))
  })

  it('is honest about an empty walk', () => {
    expect(exhaustionMessage([], 'DeepSeek', 'x')).toContain('0 tried')
  })
})
