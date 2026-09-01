import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-brain-tool-surface-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { brainToolRegistry, VAULT_TOOL_NAMES } from './brain-tool-registry'
import { normalizeToolsForProvider } from '../providers/schema-normalizer'
import {
  WRITE_NOTE_TOOL, READ_FILE_TOOL, LIST_DIR_TOOL, EDIT_FILE_TOOL, DELETE_FILE_TOOL,
  MOVE_FILE_TOOL, CREATE_DIR_TOOL, SEARCH_FILES_TOOL, GLOB_FILES_TOOL, RUN_COMMAND_TOOL,
  START_COMMAND_TOOL, READ_COMMAND_TOOL, STOP_COMMAND_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL,
  WRITE_TODOS_TOOL, CREATE_SKILL_TOOL, SPAWN_AGENT_TOOL, RENDER_ARTIFACT_TOOL
} from './agui-executors'

// C2 gate — the surface server.ts builds from the registry
// (normalizeToolsForProvider(brainToolRegistry.getDescriptors())) must be
// byte-identical, IN ORDER, to the hand-built `aguiTools` array it replaces.
// This is the real regression net for Stage 2: the model must see the exact
// same tools, same order, same schemas — the golden test only covers card
// strings, not the offered surface.

// The pre-registry hand-built array, verbatim (vault present).
const OLD_FULL = [
  WRITE_NOTE_TOOL, READ_FILE_TOOL, LIST_DIR_TOOL, EDIT_FILE_TOOL, DELETE_FILE_TOOL,
  MOVE_FILE_TOOL, CREATE_DIR_TOOL, SEARCH_FILES_TOOL, GLOB_FILES_TOOL,
  RUN_COMMAND_TOOL, START_COMMAND_TOOL, READ_COMMAND_TOOL, STOP_COMMAND_TOOL,
  WEB_FETCH_TOOL, WEB_SEARCH_TOOL, WRITE_TODOS_TOOL, CREATE_SKILL_TOOL, SPAWN_AGENT_TOOL, RENDER_ARTIFACT_TOOL
]

function buildSurface(hasVault: boolean) {
  const descs = brainToolRegistry
    .getDescriptors()
    .filter((d) => (hasVault ? true : !VAULT_TOOL_NAMES.has(d.name)))
  return normalizeToolsForProvider(
    descs.map((d) => ({
      name: d.name,
      description: d.description,
      inputSchema: d.inputSchema,
      providerKind: d.providerKind
    })),
    'deepseek'
  ).tools
}

describe('brain tool surface — registry-sourced == hand-built aguiTools (byte-parity, in order)', () => {
  it('with a vault: identical to the full 19-tool array', () => {
    expect(buildSurface(true)).toEqual(OLD_FULL)
  })

  it('without a vault: the 9 vault tools are dropped, rest identical in order', () => {
    const expected = OLD_FULL.filter((t) => !VAULT_TOOL_NAMES.has(t.function.name))
    expect(expected.length).toBe(10) // run/start/read/stop cmd + web_fetch/web_search + write_todos + create_skill + spawn + render
    expect(buildSurface(false)).toEqual(expected)
  })

  it('produces no normalizer warnings for any brain tool', () => {
    const descs = brainToolRegistry.getDescriptors()
    const { warnings } = normalizeToolsForProvider(
      descs.map((d) => ({ name: d.name, description: d.description, inputSchema: d.inputSchema, providerKind: d.providerKind })),
      'deepseek'
    )
    expect(warnings).toEqual([])
  })
})
