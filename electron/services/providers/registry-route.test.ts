import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'

// Controllable keychain so we can flip between "all providers keyed" and "no keys".
vi.mock('../keychain', () => ({ getKey: vi.fn(() => 'test-key'), hasKey: vi.fn(() => true) }))
vi.mock('../event-log', () => ({ recordEvent: vi.fn() }))
// Controllable settings so the Background-model setting can be armed per test. Hermetic: the
// real reader would consult the electron stub's userData settings.json.
vi.mock('../settings-helper', () => ({ readSettings: vi.fn(() => ({})), patchSettings: vi.fn() }))

import {
  routeModel,
  resolveModel,
  isUsableModel,
  detectOllama,
  describeBackgroundModel,
  MODEL_CATALOG,
  PROVIDERS
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

  it('routes extraction to a cheap tier and chat to a strong tier (all keyed)', () => {
    const ext = routeModel('extraction')
    const chat = routeModel('chat')
    expect(ext).toBeTruthy()
    expect(chat).toBeTruthy()
    if (hasCheap) expect(CHEAP.has(resolveModel(ext as string).tier)).toBe(true)
    if (hasStrong) expect(STRONG.has(resolveModel(chat as string).tier)).toBe(true)
    if (hasCheap && hasStrong) expect(ext).not.toBe(chat) // different model per task
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

describe('routeModel — the Background-model setting (Settings → Models)', () => {
  // Live, pickable ids: not the connector, not a benchmark-only hidden entry.
  const pickable = MODEL_CATALOG.filter((m) => m.id !== 'duin-brain' && !m.hidden)
  const store = (value: unknown): void => {
    vi.mocked(readSettings).mockReturnValue({ backgroundModel: value } as Record<string, unknown>)
  }
  afterEach(() => {
    vi.mocked(readSettings).mockReturnValue({})
    delete process.env.DUIN_ROUTE_EXTRACTION
    delete process.env.DUIN_ROUTE_TITLE
    __resetProviderHealth()
  })

  it('a stored model wins over the tier policy for extraction AND titles', () => {
    const auto = routeModel('extraction')
    // Deliberately NOT what Auto picks — a strong-tier model — so this cannot pass by coincidence.
    const chosen = pickable.find((m) => m.id !== auto && STRONG.has(m.tier))!.id
    store(chosen)
    expect(routeModel('extraction')).toBe(chosen)
    expect(routeModel('title')).toBe(chosen)
  })

  it('leaves chat routing alone — the setting governs background work only', () => {
    const before = routeModel('chat')
    store(pickable.find((m) => m.id !== before)!.id)
    expect(routeModel('chat')).toBe(before)
  })

  it("'' / 'auto' / blank / absent / non-string all mean Auto", () => {
    const auto = routeModel('extraction')
    for (const value of ['', 'auto', '   ', undefined, null, 42]) {
      store(value)
      expect(routeModel('extraction'), `value ${JSON.stringify(value)}`).toBe(auto)
    }
  })

  it('an explicit usable preferred still wins over the setting', () => {
    const [a, b] = pickable
    store(a.id)
    expect(routeModel('extraction', b.id)).toBe(b.id)
  })

  it('beats an armed DUIN_ROUTE_EXTRACTION pin — a choice made in the product is not overridden by deploy config', () => {
    const [a, b] = pickable
    process.env.DUIN_ROUTE_EXTRACTION = a.id
    store(b.id)
    expect(routeModel('extraction')).toBe(b.id)
  })

  it('a retired id follows RETIRED_MODEL_MAP to its successor, as a saved conversation would', () => {
    store('qwen3.5-flash') // retired in the 2026-08-21 catalog redo → qwen3.7-flash
    expect(routeModel('extraction')).toBe('qwen3.7-flash')
  })

  it('an unknown id falls through to Auto rather than routing nowhere', () => {
    const auto = routeModel('extraction')
    store('no-such-model')
    expect(routeModel('extraction')).toBe(auto)
    expect(routeModel('extraction')).not.toBeNull()
  })

  it("falls through to Auto when the chosen model's provider has no key", () => {
    const auto = routeModel('extraction')!
    const autoProvider = MODEL_CATALOG.find((m) => m.id === auto)!.provider
    const chosen = pickable.find((m) => m.provider !== autoProvider)!
    vi.mocked(getKey).mockImplementation((provider: string) =>
      provider === PROVIDERS[chosen.provider].keyEnv ? null : 'test-key'
    )
    store(chosen.id)
    expect(routeModel('extraction')).toBe(auto)
  })

  it('steps over the chosen model while its account is refusing, and comes back after', () => {
    const auto = routeModel('extraction')!
    const autoProvider = MODEL_CATALOG.find((m) => m.id === auto)!.provider
    const chosen = pickable.find((m) => m.provider !== autoProvider)!
    store(chosen.id)
    expect(routeModel('extraction')).toBe(chosen.id)
    noteProviderRefusal(chosen.provider, 'insufficient balance')
    expect(routeModel('extraction')).toBe(auto)
    __resetProviderHealth()
    expect(routeModel('extraction')).toBe(chosen.id)
  })

  it('describeBackgroundModel reports what applies and why', () => {
    const auto = routeModel('extraction')
    expect(describeBackgroundModel()).toEqual({ chosen: null, effective: auto, automatic: auto, source: 'auto' })

    const chosen = pickable.find((m) => m.id !== auto)!.id
    store(chosen)
    expect(describeBackgroundModel()).toEqual({ chosen, effective: chosen, automatic: auto, source: 'setting' })

    // Pinned but unusable: the pane must see the fallback, not the wish.
    store('no-such-model')
    expect(describeBackgroundModel()).toEqual({
      chosen: 'no-such-model',
      effective: auto,
      automatic: auto,
      source: 'auto'
    })

    vi.mocked(readSettings).mockReturnValue({})
    const pinned = pickable.find((m) => m.id !== auto)!.id
    process.env.DUIN_ROUTE_EXTRACTION = pinned
    expect(describeBackgroundModel()).toEqual({ chosen: null, effective: pinned, automatic: pinned, source: 'env' })
  })
})
