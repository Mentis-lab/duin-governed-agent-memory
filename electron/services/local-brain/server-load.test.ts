import { describe, it, expect, vi } from 'vitest'

// Boot-safety regression net for the Stage-B monolith split. The split created
// several body-deferred import cycles (server.ts ↔ brain-native-routes ↔
// agui-grounding, etc.). tsc and the unit tests do NOT exercise module INIT
// order — a cycle that touches an imported binding at load time would throw a
// TDZ / undefined error only when the module graph is first evaluated. This
// test evaluates the whole /agui server module graph and asserts the public
// entry points resolved, catching that class of regression cheaply.

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-server-load-test',
    getName: () => 'duin',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

describe('local-brain server module graph — loads without circular-init failure', () => {
  it('evaluates server.ts and its relocated modules, exposing the entry points', async () => {
    const mod = await import('./server')
    expect(typeof mod.startLocalBrain).toBe('function')
    expect(typeof mod.stopLocalBrain).toBe('function')
    expect(typeof mod.handleAgui).toBe('function')
  })

  it('the relocated route + dispatch modules evaluate standalone', async () => {
    const grounding = await import('./agui-grounding')
    const subagent = await import('./agui-subagent')
    const gate = await import('./agui-gate')
    const stateRoutes = await import('./brain-state-routes')
    const nativeRoutes = await import('./brain-native-routes')
    expect(grounding).toBeTruthy()
    expect(subagent).toBeTruthy()
    expect(gate).toBeTruthy()
    expect(stateRoutes).toBeTruthy()
    expect(nativeRoutes).toBeTruthy()
  })

  it('the executive-api mount evaluates in the graph (server.ts imports it at load)', async () => {
    // server.ts statically imports handleExecutiveRequest; the endpoint keeps
    // its organ imports DYNAMIC so this edge stays cycle-safe. If someone
    // hoists an organ import to module level and closes a cycle, this is the
    // test that catches it at init time.
    const exec = await import('../executive-api/exec-endpoint')
    expect(typeof exec.handleExecutiveRequest).toBe('function')
  })
})
