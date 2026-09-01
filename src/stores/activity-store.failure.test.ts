import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// U1 — activity-store's `unwrapList` turned EVERY failed IPC read into `[]`, so on
// an autonomy product a dead main process rendered as "nothing is running": no
// agents, no cron automations, no pending wakeups, and no indication anything was
// wrong. These tests pin that a failed read is reported AS a failure and that the
// last-known rows survive it.

type Api = Record<string, unknown>

function stubApi(api: Api): void {
  vi.stubGlobal('window', { api, localStorage: undefined })
}

async function loadStore(): Promise<typeof import('./activity-store').useActivityStore> {
  const mod = await import('./activity-store')
  return mod.useActivityStore
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('activity-store: a failed read is not an empty machine', () => {
  it('records an error when the agent-run read fails', async () => {
    stubApi({ tasks: { list: async () => ({ success: false, error: 'brain unreachable' }) } })
    const useActivityStore = await loadStore()
    await useActivityStore.getState().refreshAgents()
    const s = useActivityStore.getState()
    expect(s.errors.agents).toContain('brain unreachable')
    expect(s.error).toContain('brain unreachable')
  })

  it('records an error when the preload surface is MISSING, instead of returning silently', async () => {
    // Was `if (!window.api?.tasks?.list) return` — a no-op that left the panel
    // showing the previous (or initial, empty) list with no explanation.
    stubApi({})
    const useActivityStore = await loadStore()
    await useActivityStore.getState().refreshAgents()
    expect(useActivityStore.getState().errors.agents).toBeTruthy()
  })

  it('does NOT blank previously-loaded rows when a refresh fails', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: true, data: [{ id: 'run-1' }] })
      .mockResolvedValueOnce({ success: false, error: 'ipc timeout' })
    stubApi({ tasks: { list } })
    const useActivityStore = await loadStore()
    await useActivityStore.getState().refreshAgents()
    expect(useActivityStore.getState().agentRuns).toHaveLength(1)

    await useActivityStore.getState().refreshAgents()
    const s = useActivityStore.getState()
    expect(s.agentRuns).toHaveLength(1) // still visible
    expect(s.errors.agents).toContain('ipc timeout') // but flagged as stale/failed
  })

  it('clears the section error once the read succeeds again', async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({ success: false, error: 'ipc timeout' })
      .mockResolvedValueOnce({ success: true, data: [] })
    stubApi({ tasks: { list } })
    const useActivityStore = await loadStore()
    await useActivityStore.getState().refreshAgents()
    expect(useActivityStore.getState().error).toBeTruthy()

    await useActivityStore.getState().refreshAgents()
    const s = useActivityStore.getState()
    expect(s.errors.agents).toBeUndefined()
    expect(s.error).toBeNull()
    expect(s.agentRuns).toEqual([]) // a genuine empty list is still a success
  })

  it('every section reports independently', async () => {
    stubApi({
      tasks: { list: async () => ({ success: true, data: [] }) },
      automations: { list: async () => ({ success: false, error: 'cron store locked' }) },
      loops: { list: async () => ({ success: true, data: [] }) },
      hooks: { list: async () => ({ success: false, error: 'hooks file unreadable' }) }
    })
    const useActivityStore = await loadStore()
    await useActivityStore.getState().refresh()
    const s = useActivityStore.getState()
    expect(s.errors.agents).toBeUndefined()
    expect(s.errors.automations).toContain('cron store locked')
    expect(s.errors.wakeups).toBeUndefined()
    expect(s.errors.hooks).toContain('hooks file unreadable')
  })
})
