import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-cu-safety-test', isReady: () => true },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const { DEFAULT_APP_SETTINGS } = await import('./default-app-settings')
const { classifyMcpTool, COMPUTER_USE_SERVER_IDS } = await import('./tool-registry')

// Pins the "computer-use ships gated and OFF by default" contract. If a future edit flips any
// of these, this guard fails loudly rather than silently arming desktop actuation.
// (The connectors-catalog `enabled:false` half lives in src/data/connectors-catalog.test.ts —
//  the catalog is in the web project and can't be imported from a node-side test.)
describe('computer-use safety contract', () => {
  it('background autonomy is OFF by default', () => {
    expect(DEFAULT_APP_SETTINGS.backgroundAutonomy).toBe(false)
  })

  it('the fail-closed server ids cover both catalog computer-use connectors', () => {
    expect(COMPUTER_USE_SERVER_IDS.has('terminator')).toBe(true)
    expect(COMPUTER_USE_SERVER_IDS.has('computer-use')).toBe(true)
  })

  it('a computer-use server actuation tool is destructive + approval-gated (fail-closed)', () => {
    const c = classifyMcpTool('terminator', 'click')
    expect(c.requiresApproval).toBe(true)
    expect(c.risks).toContain('destructive')
  })
})
