import { describe, it, expect, vi } from 'vitest'

// The brain registry (and server.ts transitively) pull electron's BrowserWindow
// in via tool-registry's applySnip chain. Mock electron so the import stays
// clean under vitest's node environment (mirrors brain-tool-registry.test.ts).
vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-brain-handled-tools-parity-test',
    getAppPath: () => '.tmp-brain-handled-tools-parity-test',
    isPackaged: false
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  session: { defaultSession: { webRequest: { onBeforeRequest: () => {} } } }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { HANDLED_TOOLS } from './server'
import { brainToolRegistry } from './brain-tool-registry'
import { isSimpleAguiTool } from './agui-tools'

// Gate finding F4 — the brain round loop's dispatch filter.
//
// handleAgui keeps only the tool calls whose name is in HANDLED_TOOLS (or is an
// MCP name); everything else is dropped on the floor — no tool_result row, no
// TOOL_CALL frame, and the turn then burns its completeness retry on a call the
// model made perfectly legitimately against a tool it was OFFERED.
//
// HANDLED_TOOLS used to be an 18-name literal inside the round loop, a hand
// mirror of a 19-tool registry. `create_skill` is registered, offered, and
// dispatchable — and was missing from the literal, so every create_skill call
// was silently discarded. These tests pin the parity in both directions so the
// next tool addition cannot drift the same way.

const CATALOG_ONLY = new Set(['render_artifact', 'spawn_agent'])

describe('brain HANDLED_TOOLS <-> brainToolRegistry parity', () => {
  const registered = brainToolRegistry.getDescriptors().map((d) => d.name)

  it('covers EVERY registered brain tool', () => {
    const missing = registered.filter((n) => !HANDLED_TOOLS.has(n))
    expect(
      missing,
      `registered brain tools the round loop would silently drop: ${missing.join(', ')}`
    ).toEqual([])
  })

  it('pins create_skill specifically — the tool this defect dropped', () => {
    expect(registered).toContain('create_skill')
    expect(HANDLED_TOOLS.has('create_skill')).toBe(true)
  })

  it('lists no phantom name that is not registered', () => {
    const phantom = [...HANDLED_TOOLS].filter((n) => !registered.includes(n))
    expect(phantom, `HANDLED_TOOLS names with no registry entry: ${phantom.join(', ')}`).toEqual(
      []
    )
  })

  it('every handled name is actually dispatchable by agui-dispatch', () => {
    // Being in HANDLED_TOOLS only gets a call past the filter; agui-dispatch
    // must then have a branch for it or the call still dead-ends in
    // notAvailable. Simple tools route through AGUI_TOOLS; render_artifact and
    // spawn_agent are dispatched at their call site in server.ts.
    const undispatchable = [...HANDLED_TOOLS].filter(
      (n) => !isSimpleAguiTool(n) && !CATALOG_ONLY.has(n)
    )
    expect(undispatchable).toEqual([])
  })
})
