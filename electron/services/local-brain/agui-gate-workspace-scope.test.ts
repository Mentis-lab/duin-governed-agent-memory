// Backlog finding 1 (critical). A workspace-scoped permission policy is WRITTEN by
// permissions-store.ts keyed to getActiveWorkspace(), but both production callers of
// resolveAguiGate passed the VAULT notes dir as `workspacePath`. Those coincide until
// the user picks a workspace with the ChatInput chip (getActiveWorkspace falls back to
// the vault) and diverge the moment they do — so an explicit "deny for this workspace"
// was looked up under the wrong key, missed silently, and fell through to the
// trusted-afk blanket allow. The gate now resolves the scope itself.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-gate-ws-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const ACTIVE_WORKSPACE = '/picked/workspace'
const VAULT_DIR = '/the/vault'

vi.mock('../workspace-state', () => ({
  getActiveWorkspace: () => ACTIVE_WORKSPACE
}))

const seen: Array<{ workspacePath?: string; toolId?: string }> = []
vi.mock('../permission-policies-store', () => ({
  resolveDecision: (input: { workspacePath?: string; toolId?: string }) => {
    seen.push(input)
    return null
  }
}))

import { resolveAguiGate } from './agui-gate'

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'x',
  function: { name, arguments: JSON.stringify(args) }
})

beforeEach(() => {
  seen.length = 0
})

describe('agui-gate — workspace-scoped policy lookup key', () => {
  it('looks the policy up under the ACTIVE WORKSPACE, not the vault path the caller passed', async () => {
    await resolveAguiGate(call('run_command', { command: 'echo hi' }), {
      execOk: true,
      posture: 'trusted-afk',
      conversationId: 'conv-1',
      // Exactly what server.ts and agui-subagent.ts pass: the vault notes dir.
      workspacePath: VAULT_DIR
    } as never)

    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0].workspacePath).toBe(ACTIVE_WORKSPACE)
    expect(seen[0].workspacePath).not.toBe(VAULT_DIR)
  })
})
