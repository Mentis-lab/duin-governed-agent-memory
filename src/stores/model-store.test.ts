import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderHealth, RoleResolution } from '@/lib/types'

// P0 model plane — model-store is the renderer's ONE source for policy, health and the
// chat-role resolution. These pin the rules the composer chip, status line and picker rely on:
// a pin resolves as a pin, AUTO resolves from policy, health rows come from main (a real
// completion) and a stale answer never overwrites a newer pin's.

vi.mock('@/stores/toast-store', () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} }
}))

const AUTO = 'duin-brain'

const healthRows: ProviderHealth[] = [
  { provider: 'deepseek', healthy: true, reason: 'ok', checkedAt: 10 },
  { provider: 'anthropic', healthy: false, reason: 'no-credit', checkedAt: 10 }
]

const resolution = (modelId: string, source: RoleResolution['source']): RoleResolution => ({
  task: 'chat',
  modelId,
  provider: 'deepseek',
  chain: [modelId],
  source
})

function stubApi(overrides: Record<string, unknown> = {}) {
  const resolve = vi.fn(async (_task: string, pin?: string) => ({
    success: true,
    data: pin ? resolution(pin, 'pin') : resolution('d-flash', 'policy')
  }))
  const api = {
    model: {
      list: async () => ({ success: true, data: [] }),
      policyGet: async () => ({ success: true, data: { order: ['deepseek', 'anthropic'] } }),
      healthList: async () => ({ success: true, data: healthRows }),
      healthProbe: vi.fn(async (target: string) => ({
        success: true,
        data:
          target === 'all'
            ? healthRows.map((h) => ({ ...h, checkedAt: 20 }))
            : [{ provider: target, healthy: true, reason: 'ok', checkedAt: 30 }]
      })),
      resolve,
      onHealthChanged: vi.fn(),
      ...overrides
    }
  }
  vi.stubGlobal('window', { api })
  return { api, resolve }
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('model-store — single source of truth', () => {
  it('loadModels reads policy + cached health from main and resolves the chat role for AUTO', async () => {
    const { resolve } = stubApi()
    const { useModelStore } = await import('./model-store')
    await useModelStore.getState().loadModels()
    const s = useModelStore.getState()
    expect(s.policy).toEqual({ order: ['deepseek', 'anthropic'] })
    expect(s.health).toEqual(healthRows)
    expect(s.loaded).toBe(true)
    // AUTO_ENGINE is never sent as a pin.
    expect(resolve).toHaveBeenCalledWith('chat', undefined)
    expect(s.resolution).toEqual(resolution('d-flash', 'policy'))
    expect(s.resolvedFor).toBe(AUTO)
  })

  it('a pin resolves AS a pin; usable means healthy, not keyed', async () => {
    const { resolve } = stubApi()
    const { useModelStore } = await import('./model-store')
    await useModelStore.getState().loadModels()
    await useModelStore.getState().refreshResolution('a-pro')
    expect(resolve).toHaveBeenLastCalledWith('chat', 'a-pro')
    expect(useModelStore.getState().resolution).toEqual(resolution('a-pro', 'pin'))
    expect(useModelStore.getState().isProviderHealthy('deepseek')).toBe(true)
    expect(useModelStore.getState().isProviderHealthy('anthropic')).toBe(false) // keyed, no credit
    expect(useModelStore.getState().isProviderHealthy('zhipu')).toBe(false) // never probed
  })

  it('a slower answer for an OLDER pin never overwrites the newer pin’s resolution', async () => {
    const gate: { release: (() => void) | null } = { release: null }
    const resolve = vi.fn((_task: string, pin?: string) => {
      if (pin === 'old') {
        return new Promise((r) => {
          gate.release = () => r({ success: true, data: resolution('old', 'pin') })
        })
      }
      return Promise.resolve({ success: true, data: resolution(pin ?? 'd-flash', pin ? 'pin' : 'policy') })
    })
    stubApi({ resolve })
    const { useModelStore } = await import('./model-store')
    const older = useModelStore.getState().refreshResolution('old')
    await useModelStore.getState().refreshResolution('new')
    expect(useModelStore.getState().resolution?.modelId).toBe('new')
    gate.release?.()
    await older
    expect(useModelStore.getState().resolution?.modelId).toBe('new')
    expect(useModelStore.getState().resolvedFor).toBe('new')
  })

  it('probe(provider) merges the fresh row over the cache and re-resolves; probe("all") replaces', async () => {
    const { api } = stubApi()
    const { useModelStore } = await import('./model-store')
    await useModelStore.getState().loadModels()
    const merged = await useModelStore.getState().probe('anthropic')
    expect(api.model.healthProbe).toHaveBeenCalledWith('anthropic')
    expect(merged.find((h) => h.provider === 'anthropic')?.healthy).toBe(true)
    expect(merged.find((h) => h.provider === 'deepseek')?.checkedAt).toBe(10) // cache kept
    const all = await useModelStore.getState().probe('all')
    expect(all.every((h) => h.checkedAt === 20)).toBe(true)
  })

  it('a health push from main replaces the rows and re-resolves', async () => {
    let push: ((rows: ProviderHealth[]) => void) | null = null
    const { resolve } = stubApi({
      onHealthChanged: (cb: (rows: ProviderHealth[]) => void) => {
        push = cb
        return () => {}
      }
    })
    const { useModelStore } = await import('./model-store')
    expect(push).not.toBeNull()
    const fresh: ProviderHealth[] = [{ provider: 'zhipu', healthy: true, reason: 'ok', checkedAt: 99 }]
    push!(fresh)
    await Promise.resolve()
    expect(useModelStore.getState().health).toEqual(fresh)
    expect(resolve).toHaveBeenCalled()
  })

  it('degrades honestly when the IPC surface is absent: no health, no resolution, no throw', async () => {
    vi.stubGlobal('window', { api: { model: { list: async () => ({ success: true, data: [] }) } } })
    const { useModelStore } = await import('./model-store')
    await expect(useModelStore.getState().loadModels()).resolves.toBe(true)
    expect(useModelStore.getState().health).toEqual([])
    expect(useModelStore.getState().resolution).toBeNull()
    expect(await useModelStore.getState().setPolicy({ order: ['deepseek'] })).toBe(false)
  })
})
