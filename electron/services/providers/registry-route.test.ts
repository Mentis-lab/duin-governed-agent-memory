import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'

// Controllable keychain so we can flip between "all providers keyed" and "no keys".
vi.mock('../keychain', () => ({ getKey: vi.fn(() => 'test-key'), hasKey: vi.fn(() => true) }))
vi.mock('../event-log', () => ({ recordEvent: vi.fn() }))
// Controllable settings so the Background-model setting can be armed per test. Hermetic: the
// real reader would consult the electron stub's userData settings.json.
vi.mock('../settings-helper', () => ({
  readSettings: vi.fn(() => ({})),
  patchSettings: vi.fn(),
  registerLegacyModelSettingsDeps: vi.fn()
}))

import {
  routeModel,
  resolveRole,
  resolveModel,
  isUsableModel,
  detectOllama,
  describeBackgroundModel,
  MODEL_CATALOG,
  PROVIDERS,
  LEGACY_MODEL_SETTINGS_DEPS
} from './registry'
import { getKey } from '../keychain'
import { readSettings } from '../settings-helper'
import { noteProviderRefusal, __resetProviderHealth } from './provider-health'

// These tests assert DEFAULT task-aware routing. DUIN_ROUTE_<TASK> is an operator pin that
// force-routes a task's AUTOMATIC selection to a specific model — it overrides the tier policy but
// NOT an explicit `preferred` (see routeModel + the precedence describe block below). When such a pin
// is armed in the ambient shell (e.g. DUIN_ROUTE_EXTRACTION=glm-4.5-airx) it overrides the tier
// routing these default tests assert, so neutralise every routing pin here for hermeticity. The
// precedence between a pin and an explicit preferred is asserted explicitly, with a pin armed, below.
const SAVED_ROUTE_PINS: Record<string, string | undefined> = {}
beforeAll(() => {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('DUIN_ROUTE_')) {
      SAVED_ROUTE_PINS[k] = process.env[k]
      delete process.env[k]
    }
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(SAVED_ROUTE_PINS)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

const CHEAP = new Set(['flash', 'open', 'coder'])
const STRONG = new Set(['pro', 'reasoner'])
const hasCheap = MODEL_CATALOG.some((m) => CHEAP.has(m.tier))
const hasStrong = MODEL_CATALOG.some((m) => STRONG.has(m.tier))

afterEach(() => {
  vi.mocked(getKey).mockReturnValue('test-key')
  vi.restoreAllMocks?.()
})

describe('routeModel — native task-aware routing', () => {
  it('honors a usable preferred model regardless of task', () => {
    const real = MODEL_CATALOG.find((m) => m.id !== 'duin-brain')!
    expect(routeModel('chat', real.id)).toBe(real.id)
    expect(routeModel('extraction', real.id)).toBe(real.id)
  })

  it('never returns the duin-brain connector as a preferred', () => {
    const picked = routeModel('chat', 'duin-brain')
    expect(picked).not.toBe('duin-brain')
  })

  it('routes extraction to a cheap tier; chat follows the policy speed (fast by default → cheap)', () => {
    const ext = routeModel('extraction')
    const chat = routeModel('chat')
    expect(ext).toBeTruthy()
    expect(chat).toBeTruthy()
    if (hasCheap) expect(CHEAP.has(resolveModel(ext as string).tier)).toBe(true)
    // speed 'fast' (the default): chat takes the flash tier first — the 2026-09-02 evaluation's
    // pick (deepseek-v4-flash won on cost and speed with task success tied).
    if (hasCheap) expect(CHEAP.has(resolveModel(chat as string).tier)).toBe(true)
  })

  it('speed balanced / strong route chat to a strong tier; extraction stays cheap', () => {
    for (const speed of ['balanced', 'strong'] as const) {
      vi.mocked(readSettings).mockReturnValue({ providerPolicy: { speed } } as Record<string, unknown>)
      const chat = routeModel('chat')!
      const ext = routeModel('extraction')!
      if (hasStrong) expect(STRONG.has(resolveModel(chat).tier), speed).toBe(true)
      if (hasCheap) expect(CHEAP.has(resolveModel(ext).tier), speed).toBe(true)
      if (hasCheap && hasStrong) expect(ext).not.toBe(chat)
    }
    // strong prefers a reasoner over a pro model when the head provider ships both
    vi.mocked(readSettings).mockReturnValue({ providerPolicy: { speed: 'strong' } } as Record<string, unknown>)
    const strong = resolveModel(routeModel('chat')!)
    const headHasReasoner = MODEL_CATALOG.some((m) => m.provider === strong.provider && m.tier === 'reasoner' && !m.hidden)
    if (headHasReasoner) expect(strong.tier).toBe('reasoner')
    vi.mocked(readSettings).mockReturnValue({})
  })

  it('falls back to a local Ollama model when no provider key is set', async () => {
    vi.mocked(getKey).mockReturnValue(null as unknown as string)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ models: [{ name: 'llama3.2' }] }) })) as any
    await detectOllama()
    expect(routeModel('extraction')).toBe('ollama:llama3.2')
    expect(routeModel('chat')).toBe('ollama:llama3.2')
  })

  it('isUsableModel rejects the connector + unknown ids', () => {
    expect(isUsableModel('duin-brain')).toBe(false)
    expect(isUsableModel('')).toBe(false)
  })
})

describe('routeModel — precedence: explicit preferred vs env pin', () => {
  // The suite-level guard cleared ambient pins; these arm one explicitly and clean up after.
  afterEach(() => {
    delete process.env.DUIN_ROUTE_EXTRACTION
  })

  it('an explicit usable preferred wins over an armed env pin', () => {
    const usable = MODEL_CATALOG.filter((m) => m.id !== 'duin-brain')
    const pinned = usable[0].id
    const preferred = usable[1].id // distinct from the pin
    process.env.DUIN_ROUTE_EXTRACTION = pinned
    // Regression guard: the pin used to be checked first and silently beat an explicit preferred.
    expect(routeModel('extraction', preferred)).toBe(preferred)
  })

  it('the env pin applies (over the tier policy) when no preferred is given', () => {
    const pinned = MODEL_CATALOG.find((m) => m.id !== 'duin-brain')!.id
    process.env.DUIN_ROUTE_EXTRACTION = pinned
    expect(routeModel('extraction')).toBe(pinned)
  })
})

describe('routeModel — the provider policy (Settings → Models), P0 model plane', () => {
  // The Background-model SETTING (a stored model id) is gone: a stored id was a claim the account
  // is funded and the id still exists (S2, 2026-09-02). Its replacement is the extraction ROLE
  // override in `providerPolicy.roles` — a provider preference, resolved against live health.
  // Every assertion the old suite made about the setting is kept here in policy terms.
  const pickable = MODEL_CATALOG.filter((m) => m.id !== 'duin-brain' && !m.hidden)
  const policy = (p: Record<string, unknown>): void => {
    vi.mocked(readSettings).mockReturnValue({ providerPolicy: p } as Record<string, unknown>)
  }
  afterEach(() => {
    vi.mocked(readSettings).mockReturnValue({})
    delete process.env.DUIN_ROUTE_EXTRACTION
    delete process.env.DUIN_ROUTE_TITLE
    __resetProviderHealth()
  })

  it('a role override wins over the general order for THAT role — extraction and title each carry their own', () => {
    const auto = routeModel('extraction')!
    const autoProvider = resolveModel(auto).provider
    // Deliberately NOT what Auto picks, so this cannot pass by coincidence.
    const other = pickable.find((m) => m.provider !== autoProvider)!.provider
    policy({ order: [], roles: { extraction: [other], title: [other] } })
    expect(resolveModel(routeModel('extraction')!).provider).toBe(other)
    expect(resolveModel(routeModel('title')!).provider).toBe(other)
    // Per-role by contract (roles.ts): an extraction override says nothing about titles. (The old
    // Background-model SETTING governed both; the migration seeds extraction only.)
    policy({ order: [], roles: { extraction: [other] } })
    expect(resolveModel(routeModel('title')!).provider).toBe(autoProvider)
  })

  it('leaves chat routing alone — the extraction override governs background work only', () => {
    const before = routeModel('chat')!
    const other = pickable.find((m) => m.provider !== resolveModel(before).provider)!.provider
    policy({ order: [], roles: { extraction: [other] } })
    expect(routeModel('chat')).toBe(before)
  })

  it('the general order is the primary key for every role (D2)', () => {
    const auto = routeModel('chat')!
    const other = pickable.find((m) => m.provider !== resolveModel(auto).provider)!.provider
    policy({ order: [other] })
    expect(resolveModel(routeModel('chat')!).provider).toBe(other)
    expect(resolveModel(routeModel('extraction')!).provider).toBe(other)
  })

  it('an empty / absent / malformed policy means Auto — every keyed provider in catalog order', () => {
    const auto = routeModel('extraction')
    for (const value of [{}, { order: [] }, { order: 'nope' }, { order: ['no-such-provider'] }, undefined, null, 42]) {
      vi.mocked(readSettings).mockReturnValue({ providerPolicy: value } as Record<string, unknown>)
      expect(routeModel('extraction'), `value ${JSON.stringify(value)}`).toBe(auto)
    }
  })

  it('an explicit usable preferred still wins over the policy', () => {
    const auto = routeModel('extraction')!
    const b = pickable.find((m) => m.provider !== resolveModel(auto).provider)!
    policy({ order: [resolveModel(auto).provider] })
    expect(routeModel('extraction', b.id)).toBe(b.id)
  })

  it('an armed DUIN_ROUTE_EXTRACTION pin still applies over the policy pick (deploy-time ops config)', () => {
    // The old model SETTING sat above the pin; a provider PREFERENCE is not a model pin, so the
    // env pin — a specific usable id — outranks the automatic pick and loses only to health.
    const auto = routeModel('extraction')!
    const pinned = pickable.find((m) => m.provider !== resolveModel(auto).provider)!
    process.env.DUIN_ROUTE_EXTRACTION = pinned.id
    policy({ order: [resolveModel(auto).provider] })
    expect(routeModel('extraction')).toBe(pinned.id)
  })

  it('a retired env pin follows RETIRED_MODEL_MAP to its successor (S20: duin-launch.bat names glm-4.5-airx)', () => {
    process.env.DUIN_ROUTE_EXTRACTION = 'qwen3.5-flash' // retired in the 2026-08-21 catalog redo → qwen3.7-flash
    expect(routeModel('extraction')).toBe('qwen3.7-flash')
  })

  it('an unknown provider in the order falls through to Auto rather than routing nowhere', () => {
    const auto = routeModel('extraction')
    policy({ order: ['no-such-provider'], roles: { extraction: ['also-unknown'] } })
    expect(routeModel('extraction')).toBe(auto)
    expect(routeModel('extraction')).not.toBeNull()
  })

  it('falls through to Auto when the preferred provider has no key', () => {
    const auto = routeModel('extraction')!
    const autoProvider = resolveModel(auto).provider
    const chosen = pickable.find((m) => m.provider !== autoProvider)!
    vi.mocked(getKey).mockImplementation((provider: string) =>
      provider === PROVIDERS[chosen.provider].keyEnv ? null : 'test-key'
    )
    policy({ order: [chosen.provider] })
    expect(routeModel('extraction')).toBe(auto)
  })

  it('steps over the preferred provider while its account is refusing, and comes back after', () => {
    const auto = routeModel('extraction')!
    const autoProvider = resolveModel(auto).provider
    const chosen = pickable.find((m) => m.provider !== autoProvider)!
    policy({ order: [chosen.provider] })
    expect(resolveModel(routeModel('extraction')!).provider).toBe(chosen.provider)
    noteProviderRefusal(chosen.provider, 'insufficient balance')
    expect(routeModel('extraction')).toBe(auto)
    __resetProviderHealth()
    expect(resolveModel(routeModel('extraction')!).provider).toBe(chosen.provider)
  })

  it('an unhealthy preferred provider is still in the CHAIN, at the end — never dropped', () => {
    const auto = resolveRole('extraction')!
    const chosen = pickable.find((m) => m.provider !== auto.provider)!
    policy({ order: [chosen.provider] })
    noteProviderRefusal(chosen.provider, 'insufficient balance')
    const r = resolveRole('extraction')!
    expect(r.provider).not.toBe(chosen.provider)
    expect(r.chain.map((id) => resolveModel(id).provider)).toContain(chosen.provider)
    expect(resolveModel(r.chain[r.chain.length - 1]).provider).toBe(chosen.provider)
  })

  it('describeBackgroundModel reports what applies and why', () => {
    const auto = routeModel('extraction')!
    expect(describeBackgroundModel()).toEqual({ chosen: null, effective: auto, automatic: auto, source: 'auto' })

    const other = pickable.find((m) => m.provider !== resolveModel(auto).provider)!.provider
    policy({ order: [], roles: { extraction: [other] } })
    const d = describeBackgroundModel()
    expect(d.source).toBe('setting')
    expect(d.chosen).toBe(d.effective)
    expect(resolveModel(d.effective!).provider).toBe(other)
    expect(d.automatic).toBe(auto)

    // Preferred but unusable (no key): the pane must see the fallback, not the wish.
    vi.mocked(getKey).mockImplementation((provider: string) => (provider === PROVIDERS[other].keyEnv ? null : 'test-key'))
    expect(describeBackgroundModel()).toEqual({ chosen: null, effective: auto, automatic: auto, source: 'auto' })

    vi.mocked(getKey).mockReturnValue('test-key')
    vi.mocked(readSettings).mockReturnValue({})
    const pinned = pickable.find((m) => m.id !== auto)!.id
    process.env.DUIN_ROUTE_EXTRACTION = pinned
    expect(describeBackgroundModel()).toEqual({ chosen: null, effective: pinned, automatic: pinned, source: 'env' })
  })
})

// ── The migration lookups main.ts registers at boot (P0 audit A2, 2026-09-03) ──
describe('LEGACY_MODEL_SETTINGS_DEPS — catalog lookups for the providerPolicy migration', () => {
  it('maps a catalog id to its provider, the connector and unknown ids to null, prefixed ids by prefix', () => {
    vi.mocked(readSettings).mockReturnValue({})
    const catalogId = MODEL_CATALOG.find((m) => !m.hidden && !m.internal && m.id !== 'duin-brain' && m.provider === 'deepseek')!.id
    expect(LEGACY_MODEL_SETTINGS_DEPS.providerOf(catalogId)).toBe('deepseek')
    expect(LEGACY_MODEL_SETTINGS_DEPS.providerOf('duin-brain')).toBeNull()
    expect(LEGACY_MODEL_SETTINGS_DEPS.providerOf('no-such-model-id')).toBeNull()
    expect(LEGACY_MODEL_SETTINGS_DEPS.providerOf('ollama:llama3')).toBe('ollama')
    expect(LEGACY_MODEL_SETTINGS_DEPS.providerOf('openrouter:x/y')).toBe('openrouter')
  })

  it('keyedProviders lists only providers with a stored key, each a known provider id', () => {
    vi.mocked(getKey).mockReturnValue('test-key')
    const keyed = LEGACY_MODEL_SETTINGS_DEPS.keyedProviders()
    expect(keyed.length).toBeGreaterThan(0)
    for (const p of keyed) expect(p in PROVIDERS).toBe(true)
  })
})
