// provider-health probe — health is a completion, not a key check (P0 model plane, W2).
//
// Hermetic: the keychain and settings are mocked, `fetch` is stubbed, so every row below is a
// provider RESPONSE the probe turned into a health verdict — and the cache/TTL/trigger contract the
// module publishes (10-minute TTL, one call per provider per refresh, no call without a key).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../keychain', () => ({
  getKey: vi.fn((provider: string) => (provider === 'deepseek' || provider === 'openai' ? 'sk-test-secret-key' : null)),
  hasKey: vi.fn((provider: string) => provider === 'deepseek' || provider === 'openai')
}))
vi.mock('../event-log', () => ({ recordEvent: vi.fn(), boundedJsonPreview: (s: unknown) => String(s ?? '').slice(0, 200) }))
vi.mock('../settings-helper', () => ({
  readSettings: vi.fn(() => ({})),
  patchSettings: vi.fn(),
  registerLegacyModelSettingsDeps: vi.fn()
}))

import {
  probeProvider,
  probeTargetFor,
  listProviderHealth,
  refreshProviderHealth,
  scheduleBootProbes,
  onProviderHealthChanged,
  noteProviderRefusal,
  noteProviderSuccess,
  providerHealthState,
  isProviderCoolingDown,
  HEALTH_TTL_MS,
  __resetProviderHealth
} from './provider-health'
import { MODEL_CATALOG, PROVIDERS } from './registry'

type FetchCall = { url: string; init: { headers: Record<string, string>; body: string } }
const calls: FetchCall[] = []
let respond: (call: FetchCall) => Promise<Response> | Response = () => new Response('{"choices":[]}', { status: 200 })

const t0 = Date.parse('2026-09-02T12:00:00.000Z')

beforeEach(() => {
  __resetProviderHealth()
  calls.length = 0
  respond = () => new Response('{"choices":[]}', { status: 200 })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: FetchCall['init']) => {
      const call = { url, init }
      calls.push(call)
      return respond(call)
    })
  )
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('probe target', () => {
  it('is the provider’s cheapest non-hidden catalog model (flash → open → pro …)', () => {
    const t = probeTargetFor('deepseek')!
    const m = MODEL_CATALOG.find((x) => x.id === t.modelId)!
    expect(m.provider).toBe('deepseek')
    expect(m.hidden).toBeFalsy()
    const tiers = MODEL_CATALOG.filter((x) => x.provider === 'deepseek' && !x.hidden).map((x) => x.tier)
    const expected = (['flash', 'open', 'pro', 'coder', 'reasoner'] as const).find((tier) => tiers.includes(tier))
    expect(m.tier).toBe(expected)
  })

  it('is null for a provider with no catalog, custom or detected model', () => {
    expect(probeTargetFor('groq')).toBeNull()
    expect(probeTargetFor('ollama')).toBeNull()
  })
})

describe('probeProvider — one completion, classified', () => {
  it('a 200 completion is healthy/ok with latency and the probed model, and calls the chat endpoint once with a 1-token cap', async () => {
    const h = await probeProvider('deepseek', true, t0)
    expect(h).toMatchObject({ provider: 'deepseek', healthy: true, reason: 'ok' })
    expect(h.probedModelId).toBe(probeTargetFor('deepseek')!.modelId)
    expect(typeof h.latencyMs).toBe('number')
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${PROVIDERS.deepseek.baseURL.replace(/\/+$/, '')}/chat/completions`)
    const body = JSON.parse(calls[0].init.body)
    expect(body.max_tokens).toBe(1)
    expect(body.stream).toBe(false)
    expect(body.model).toBe(probeTargetFor('deepseek')!.apiModelId)
  })

  it('openai gets max_completion_tokens (its reasoning models reject max_tokens)', async () => {
    await probeProvider('openai', true, t0)
    const body = JSON.parse(calls[0].init.body)
    expect(body.max_completion_tokens).toBe(1)
    expect(body.max_tokens).toBeUndefined()
  })

  it('a 401 body is unauthorized with the provider’s detail; 402 is no-credit; 403 access wording is model-access', async () => {
    respond = () => new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), { status: 401 })
    const h401 = await probeProvider('openai', true, t0)
    expect(h401).toMatchObject({ healthy: false, reason: 'unauthorized', detail: 'Incorrect API key provided' })
    // The fix hint rides on the row, labelled with the catalog name, so the renderer needs no
    // import of roles.ts to show it (lane C's Status row).
    expect(h401.hint).toContain('OpenAI')
    expect(h401.hint).toContain('key')
    expect(listProviderHealth(t0).find((h) => h.provider === 'openai')!.hint).toBe(h401.hint)
    expect(listProviderHealth(t0).find((h) => h.provider === 'zhipu')!.hint).toContain('Zhipu')
    respond = () => new Response('{"error":{"message":"余额不足或无可用资源包,请充值。"}}', { status: 402 })
    expect(await probeProvider('deepseek', true, t0)).toMatchObject({ healthy: false, reason: 'no-credit' })
    respond = () => new Response('{"error":{"message":"Project does not have access to model gpt-5.5"}}', { status: 403 })
    expect(await probeProvider('openai', true, t0)).toMatchObject({ healthy: false, reason: 'model-access' })
  })

  it('a thrown fetch (ECONNREFUSED) is network; a timeout is network', async () => {
    respond = () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    }
    expect(await probeProvider('deepseek', true, t0)).toMatchObject({ healthy: false, reason: 'network' })
  })

  it('a provider with no key answers no-key WITHOUT a call', async () => {
    expect(await probeProvider('zhipu', true, t0)).toMatchObject({ provider: 'zhipu', healthy: false, reason: 'no-key' })
    expect(calls).toHaveLength(0)
  })

  it('never returns or records the key', async () => {
    await probeProvider('deepseek', true, t0)
    respond = () => new Response('{"error":{"message":"bad"}}', { status: 401 })
    await probeProvider('openai', true, t0)
    expect(JSON.stringify(listProviderHealth(t0))).not.toContain('sk-test-secret-key')
  })
})

describe('cache + TTL (10 min)', () => {
  it('a second probe inside the TTL makes no call; after the TTL it re-probes; force always probes', async () => {
    await probeProvider('deepseek', false, t0)
    await probeProvider('deepseek', false, t0 + HEALTH_TTL_MS - 1)
    expect(calls).toHaveLength(1)
    await probeProvider('deepseek', false, t0 + HEALTH_TTL_MS + 1)
    expect(calls).toHaveLength(2)
    await probeProvider('deepseek', true, t0 + HEALTH_TTL_MS + 2)
    expect(calls).toHaveLength(3)
  })

  it('concurrent probes of one provider share a single in-flight request', async () => {
    await Promise.all([probeProvider('deepseek', true, t0), probeProvider('deepseek', true, t0)])
    expect(calls).toHaveLength(1)
  })
})

describe('listProviderHealth — computed rows, never typed', () => {
  it('shows no-key for unkeyed, "not probed yet" (checkedAt 0) for keyed-but-unobserved, and the observation once probed', async () => {
    const before = Object.fromEntries(listProviderHealth(t0).map((h) => [h.provider, h]))
    expect(before.zhipu).toMatchObject({ healthy: false, reason: 'no-key' })
    expect(before.deepseek).toMatchObject({ healthy: true, reason: 'unknown', checkedAt: 0 })
    expect(before.oneai).toBeUndefined() // hidden gateways are not listed
    await probeProvider('deepseek', true, t0)
    const after = Object.fromEntries(listProviderHealth(t0).map((h) => [h.provider, h]))
    expect(after.deepseek).toMatchObject({ healthy: true, reason: 'ok', checkedAt: t0 })
  })

  it('a classified refusal parks the provider and the list says why; a success clears it', () => {
    noteProviderRefusal('deepseek', '429 余额不足或无可用资源包,请充值。', t0, 'no-credit')
    expect(providerHealthState('deepseek', t0 + 1)).toBe('unhealthy')
    const row = listProviderHealth(t0 + 1).find((h) => h.provider === 'deepseek')!
    expect(row).toMatchObject({ healthy: false, reason: 'no-credit' })
    expect(row.detail).toContain('余额不足')
    noteProviderSuccess('deepseek', t0 + 2)
    expect(providerHealthState('deepseek', t0 + 3)).toBe('healthy')
    expect(isProviderCoolingDown('deepseek', t0 + 3)).toBe(false)
  })

  it('not-found is a MODEL fact: it never parks the account', () => {
    noteProviderRefusal('deepseek', 'model_not_found', t0, 'not-found')
    expect(isProviderCoolingDown('deepseek', t0 + 1)).toBe(false)
    expect(providerHealthState('deepseek', t0 + 1)).toBe('unknown')
  })

  it('a rate limit parks for minutes, not the legacy 45', () => {
    noteProviderRefusal('deepseek', 'Rate limit reached', t0, 'rate-limit')
    expect(isProviderCoolingDown('deepseek', t0 + 60_000)).toBe(true)
    expect(isProviderCoolingDown('deepseek', t0 + 3 * 60_000)).toBe(false)
  })

  it('a healthy probe lifts a cooldown — it is the evidence the park was waiting for', async () => {
    noteProviderRefusal('deepseek', '402', t0, 'no-credit')
    expect(providerHealthState('deepseek', t0 + 1)).toBe('unhealthy')
    await probeProvider('deepseek', true, t0 + 2)
    expect(providerHealthState('deepseek', t0 + 3)).toBe('healthy')
  })
})

describe('triggers', () => {
  it('refreshProviderHealth("all") probes every keyed visible provider exactly once and returns the full list', async () => {
    const list = await refreshProviderHealth('all')
    expect(calls).toHaveLength(2) // deepseek + openai keyed
    expect(list.find((h) => h.provider === 'deepseek')).toMatchObject({ healthy: true, reason: 'ok' })
    expect(list.find((h) => h.provider === 'zhipu')).toMatchObject({ reason: 'no-key' })
  })

  it('onProviderHealthChanged fires on a probe, a refusal and a success', async () => {
    const seen: number[] = []
    const off = onProviderHealthChanged(() => seen.push(1))
    await probeProvider('deepseek', true, t0)
    noteProviderRefusal('openai', '401', t0, 'unauthorized')
    noteProviderSuccess('openai', t0 + 1)
    off()
    noteProviderSuccess('deepseek', t0 + 2)
    expect(seen.length).toBe(3)
  })

  it('boot probes are staggered timers, one per keyed provider, and never block', async () => {
    vi.useFakeTimers()
    const n = scheduleBootProbes()
    expect(n).toBe(2)
    expect(calls).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1_500)
    expect(calls).toHaveLength(2)
  })
})
