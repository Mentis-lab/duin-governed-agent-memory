import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// U2 — the four stores converted off raw IPC writes. Each of these used to report
// (or silently imply) a success it never got. The bar: a refused write must be
// VISIBLE, and optimistic UI must be rolled back.

const shown: Array<{ type: string; message: string }> = []

vi.mock('@/stores/toast-store', () => ({
  toast: {
    success: (message: string) => shown.push({ type: 'success', message }),
    error: (message: string) => shown.push({ type: 'error', message }),
    warning: (message: string) => shown.push({ type: 'warning', message }),
    info: (message: string) => shown.push({ type: 'info', message })
  },
  useToastStore: { getState: () => ({ show: () => 0 }) }
}))

beforeEach(() => {
  shown.length = 0
  vi.resetModules()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('activity-store.stopAgent — Stop on a runaway agent', () => {
  it('surfaces an error toast when the stop is refused', async () => {
    vi.stubGlobal('window', {
      api: { tasks: { stop: async () => ({ success: false, error: 'agent already detached' }) } }
    })
    const { useActivityStore } = await import('./activity-store')
    const ok = await useActivityStore.getState().stopAgent('run-1')
    expect(ok).toBe(false)
    expect(shown).toEqual([{ type: 'error', message: 'stop agent: agent already detached' }])
  })

  it('reports the missing handler instead of returning a bare false', async () => {
    vi.stubGlobal('window', { api: {} })
    const { useActivityStore } = await import('./activity-store')
    expect(await useActivityStore.getState().stopAgent('run-1')).toBe(false)
    expect(shown[0].type).toBe('error')
  })
})

describe('model-store.setPolicy — the Providers pane showing an order main did not accept', () => {
  it('ROLLS BACK the optimistic policy when the write fails', async () => {
    vi.stubGlobal('window', {
      api: {
        model: {
          policySet: async () => ({ success: false, error: 'unknown provider' }),
          resolve: async () => ({ success: true, data: null })
        }
      }
    })
    const { useModelStore } = await import('./model-store')
    useModelStore.setState({ policy: { order: ['deepseek'] } })
    const ok = await useModelStore.getState().setPolicy({ order: ['zhipu', 'deepseek'] })
    expect(ok).toBe(false)
    expect(useModelStore.getState().policy).toEqual({ order: ['deepseek'] })
    expect(shown[0]).toEqual({ type: 'error', message: "Couldn't save the provider policy: unknown provider" })
  })

  it('keeps the policy main returns when the write lands', async () => {
    vi.stubGlobal('window', {
      api: {
        model: {
          policySet: async (p: { order: string[] }) => ({ success: true, data: { order: p.order, roles: {} } }),
          resolve: async () => ({ success: true, data: null })
        }
      }
    })
    const { useModelStore } = await import('./model-store')
    useModelStore.setState({ policy: { order: ['deepseek'] } })
    const ok = await useModelStore.getState().setPolicy({ order: ['zhipu', 'deepseek'] })
    expect(ok).toBe(true)
    expect(useModelStore.getState().policy).toEqual({ order: ['zhipu', 'deepseek'], roles: {} })
    expect(shown).toEqual([])
  })
})

describe('mcp-store.reconnect — the row pinned on "connecting" forever', () => {
  it('lands the failure on the row instead of leaving it spinning', async () => {
    vi.stubGlobal('window', {
      api: { mcp: { reconnect: async () => ({ success: false, error: 'spawn ENOENT' }) } }
    })
    const { useMcpStore } = await import('./mcp-store')
    useMcpStore.setState({
      servers: [{ id: 's1', name: 's1', status: 'error' } as never]
    })
    await useMcpStore.getState().reconnect('s1')
    const row = useMcpStore.getState().servers[0] as { status: string; error?: string }
    expect(row.status).toBe('error')
    expect(row.error).toBe('reconnect server: spawn ENOENT')
    expect(shown[0].type).toBe('error')
  })
})

describe('hooks-store — bare false discarded the reason', () => {
  it('toasts the handler error on a failed update', async () => {
    vi.stubGlobal('window', {
      api: { hooks: { update: async () => ({ success: false, error: 'hook file is read-only' }) } }
    })
    const { useHooksStore } = await import('./hooks-store')
    expect(await useHooksStore.getState().update('h1', { enabled: false })).toBe(false)
    expect(shown[0]).toEqual({ type: 'error', message: 'update hook: hook file is read-only' })
  })
})
