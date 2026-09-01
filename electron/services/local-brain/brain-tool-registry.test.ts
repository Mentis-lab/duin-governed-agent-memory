import { describe, it, expect, vi } from 'vitest'

// The brain registry imports tool-registry.ts, whose applySnip chain pulls in
// electron's BrowserWindow via filter-loader. Mock electron so the import stays
// clean under vitest's node environment (mirrors tool-registry.test.ts).
vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-brain-tool-registry-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { brainToolRegistry } from './brain-tool-registry'
import {
  WRITE_NOTE_TOOL, READ_FILE_TOOL, LIST_DIR_TOOL, EDIT_FILE_TOOL, DELETE_FILE_TOOL,
  MOVE_FILE_TOOL, CREATE_DIR_TOOL, CREATE_SKILL_TOOL, SEARCH_FILES_TOOL, GLOB_FILES_TOOL, RUN_COMMAND_TOOL,
  START_COMMAND_TOOL, READ_COMMAND_TOOL, STOP_COMMAND_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
  WRITE_TODOS_TOOL, SPAWN_AGENT_TOOL, RENDER_ARTIFACT_TOOL
} from './agui-executors'

// C1 gate — the dedicated brain catalog must be BYTE-IDENTICAL to the authored
// *_TOOL consts (same names, descriptions, and parameter schemas), so the tool
// surface the model sees is unchanged when server.ts sources it from the
// registry instead of the hand-built aguiTools array. A drift here changes the
// model-facing tool contract silently.

const ALL = [
  WRITE_NOTE_TOOL, READ_FILE_TOOL, LIST_DIR_TOOL, EDIT_FILE_TOOL, DELETE_FILE_TOOL,
  MOVE_FILE_TOOL, CREATE_DIR_TOOL, CREATE_SKILL_TOOL, SEARCH_FILES_TOOL, GLOB_FILES_TOOL, RUN_COMMAND_TOOL,
  START_COMMAND_TOOL, READ_COMMAND_TOOL, STOP_COMMAND_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
  WRITE_TODOS_TOOL, SPAWN_AGENT_TOOL, RENDER_ARTIFACT_TOOL
] as { function: { name: string; description: string; parameters: unknown } }[]

const SIMPLE = new Set([
  'write_file', 'read_file', 'list_dir', 'edit_file', 'delete_file', 'move_file', 'create_dir',
  'create_skill', 'search_files', 'glob_files', 'run_command', 'start_command', 'read_command',
  'stop_command', 'web_fetch', 'web_search', 'write_todos'
])

describe('brain-tool-registry — dedicated catalog byte-parity with authored *_TOOL consts', () => {
  it('registers exactly the 19 brain tools', () => {
    const names = brainToolRegistry.getDescriptors().map((d) => d.name).sort()
    expect(names).toEqual(ALL.map((t) => t.function.name).sort())
    expect(names.length).toBe(19)
  })

  it('each descriptor carries the exact authored schema + description', () => {
    for (const t of ALL) {
      const d = brainToolRegistry.getById(t.function.name)
      expect(d, `missing descriptor for ${t.function.name}`).toBeTruthy()
      expect(d!.description).toBe(t.function.description)
      expect(d!.inputSchema).toEqual(t.function.parameters)
      expect(d!.providerKind).toBe('native')
    }
  })

  it('the 16 simple tools have executeNative handlers; render_artifact + spawn_agent are catalog-only', () => {
    for (const t of ALL) {
      const name = t.function.name
      expect(brainToolRegistry.hasHandler(name), `handler expectation for ${name}`).toBe(SIMPLE.has(name))
    }
  })

  it('does NOT leak into the shared coder singleton (isolation)', async () => {
    const { toolRegistry } = await import('../tool-registry')
    const coderNames = new Set(toolRegistry.getDescriptors().map((d) => d.name))
    // write_file / edit_file / spawn_agent are brain-only names; they must not
    // have appeared on the coder surface as a side effect of registration.
    expect(coderNames.has('write_file')).toBe(false)
    expect(coderNames.has('edit_file')).toBe(false)
    expect(coderNames.has('spawn_agent')).toBe(false)
  })
})
