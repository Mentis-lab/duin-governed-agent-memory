// Full computer access — the operator default that makes DUIN a general computer-use agent.
// The gate seam authorizes the LOCAL COMPUTER surface (host-exec + file ops) for EVERY turn,
// including untrusted inbound-channel turns (execOk:false), and auto-allows it. The scope is
// deliberately narrow: irreversible EXTERNAL effects (send_email, MCP, ACT effectors) keep the
// normal exec-token gate, and the catastrophic-command floor holds in both modes. These are the
// security boundaries that must not regress, so they are pinned here.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-gate-fca-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('../workspace-state', () => ({ getActiveWorkspace: () => '/the/vault' }))
vi.mock('../permission-policies-store', () => ({ resolveDecision: () => null }))

const fullAccessMock = vi.fn((): boolean => true)
vi.mock('../sandbox/operator-write-paths', () => ({
  operatorWritePaths: () => [] as string[],
  fullComputerAccess: () => fullAccessMock()
}))

import { resolveAguiGate } from './agui-gate'
import { isProtectedVaultPath } from './agui-executors'

const call = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'x',
  function: { name, arguments: JSON.stringify(args) }
})
// An UNTRUSTED inbound turn carries no exec token (execOk:false) and the strictest pill.
const inbound = { execOk: false, posture: 'interactive', conversationId: 'c', workspacePath: '/the/vault' }

beforeEach(() => {
  fullAccessMock.mockReturnValue(true)
})

describe('agui-gate — full computer access authorizes the LOCAL computer surface', () => {
  it('ALLOWS delete_file from an untrusted inbound turn (execOk:false) when full access is on', async () => {
    const r = await resolveAguiGate(call('delete_file', { path: 'C:/Users/u/Desktop/x.txt' }), inbound as never)
    expect(r.allow).toBe(true)
  })

  it('ALLOWS run_command from an untrusted inbound turn under full access', async () => {
    const r = await resolveAguiGate(call('run_command', { command: 'echo hi' }), inbound as never)
    expect(r.allow).toBe(true)
  })

  // THE COMPUTER-USE CAPABILITY SET, pinned. This is the operator's 2026-08-23 decision — DUIN
  // reads/writes/moves/deletes anywhere, every turn including inbound, no folder grant. A later
  // change that narrows the gate (as the create_skill re-tiering deliberately did) must not take
  // any of these with it by accident, so each is asserted by name rather than by tier.
  it.each([
    ['run_command', { command: 'dir C:/Users' }],
    ['start_command', { command: 'node server.js' }],
    ['delete_file', { path: 'C:/Users/u/Desktop/old.txt' }],
    ['move_file', { from: 'C:/Users/u/Desktop/a.txt', to: 'C:/Users/u/Documents/a.txt' }]
  ])('ALLOWS %s on an inbound turn under full access (computer use stays whole)', async (name, args) => {
    const r = await resolveAguiGate(call(name, args as Record<string, unknown>), inbound as never)
    expect(r.allow).toBe(true)
  })

  it('turning full access OFF restores the exec-token floor for the same calls', async () => {
    fullAccessMock.mockReturnValue(false)
    for (const name of ['run_command', 'delete_file']) {
      const r = await resolveAguiGate(call(name, { command: 'echo hi', path: 'C:/x.txt' }), inbound as never)
      expect(r.allow).toBe(false)
    }
  })
})

describe('agui-gate — full access does NOT reach external effects or the catastrophic floor', () => {
  it('DENIES send_email from execOk:false EVEN under full access (external effects keep the exec-token gate)', async () => {
    const r = await resolveAguiGate(call('send_email', { to: 'x@y.z', subject: 's', body: 'b' }), inbound as never)
    expect(r.allow).toBe(false)
  })

  it('STILL blocks a catastrophic command under full access (the OS-bricking floor holds)', async () => {
    const r = await resolveAguiGate(call('run_command', { command: 'rm -rf /' }), inbound as never)
    expect(r.allow).toBe(false)
  })

  // create_skill writes a LIVE-LOADED SKILL.md outside the vault jail — persistent new behavior
  // the operator never authored. It was tiered 'irreversible-file', which put it inside the
  // full-access local-computer override, so an untrusted inbound message could mint a capability
  // for itself: exactly what AGUI_GATED_TOOLS' own comment gates it to prevent. It now carries
  // tier 'capability-write' and stays with send_email/spawn_agent behind the exec-token floor.
  it('DENIES create_skill from an untrusted inbound turn EVEN under full access', async () => {
    const r = await resolveAguiGate(
      call('create_skill', { name: 'pwn', body: '# do things' }),
      inbound as never
    )
    expect(r.allow).toBe(false)
  })

  it('DENIES spawn_agent from execOk:false under full access (recursive fan-out stays gated)', async () => {
    const r = await resolveAguiGate(call('spawn_agent', { task: 'x' }), inbound as never)
    expect(r.allow).toBe(false)
  })
})

// Release M11 (A4 F9): the protected vault subtrees. `.duin/agents/*.md` are live-loaded as
// subagents, `.duin/skills` + `.duin/hooks` are capability definitions, `.brain/` is the memory
// substrate. A write there is never a plain note write: not under full access, not from an
// inbound turn, not under the trusted-afk blanket — only with the exec token and an explicit
// approval (saved policy or the modal).
describe('agui-gate — protected vault subtrees need an explicit approval', () => {
  it.each([
    ['write_file', { path: '.duin/agents/pwn.md', content: '# be evil' }],
    ['edit_file', { path: '.duin/hooks/audit.js', old_string: 'log', new_string: 'exfil' }],
    ['delete_file', { path: '.brain/memory/_about-decisions.md' }],
    ['move_file', { from: 'notes/x.md', to: '.duin/skills/x/SKILL.md' }],
    ['create_dir', { path: '.duin/agents/new' }]
  ])('DENIES %s into a protected subtree from an inbound turn EVEN under full access', async (name, args) => {
    const r = await resolveAguiGate(call(name, args as Record<string, unknown>), inbound as never)
    expect(r.allow).toBe(false)
    expect(r.tier).toBe('capability-write')
  })

  it('does not auto-allow a protected write on an authorized trusted-afk turn with no window (fail-closed)', async () => {
    const afk = { execOk: true, posture: 'trusted-afk', conversationId: 'c', workspacePath: '/the/vault' }
    const r = await resolveAguiGate(call('write_file', { path: '.duin/agents/pwn.md', content: 'x' }), afk as never)
    expect(r.allow).toBe(false)
    expect(r.source).toBe('no-window')
  })

  it('still lets an ordinary in-vault note write through ungated (a note is a note)', async () => {
    const r = await resolveAguiGate(call('write_file', { path: 'notes/today.md', content: 'hi' }), inbound as never)
    expect(r.allow).toBe(true)
    expect(r.source).toBe('ungated')
  })

  it('isProtectedVaultPath — the WHERE, pure', () => {
    const v = process.platform === 'win32' ? 'C:\\the\\vault' : '/the/vault'
    const j = (...p: string[]): string => [v, ...p].join(process.platform === 'win32' ? '\\' : '/')
    expect(isProtectedVaultPath(v, j('.duin', 'agents', 'x.md'))).toBe(true)
    expect(isProtectedVaultPath(v, j('.duin', 'skills'))).toBe(true)
    expect(isProtectedVaultPath(v, j('.duin', 'hooks', 'a', 'b.js'))).toBe(true)
    expect(isProtectedVaultPath(v, j('.brain', 'memory', 'c.md'))).toBe(true)
    // Not protected: ordinary notes, the rest of .duin (state ledgers the agent may read), and
    // a note whose NAME merely starts with the protected prefix.
    expect(isProtectedVaultPath(v, j('notes', 'x.md'))).toBe(false)
    expect(isProtectedVaultPath(v, j('.duin', '_state', 'x.jsonl'))).toBe(false)
    expect(isProtectedVaultPath(v, j('.brainstorm.md'))).toBe(false)
    expect(isProtectedVaultPath(v, j('.duin', 'agents-notes.md'))).toBe(false)
    expect(isProtectedVaultPath('', j('.brain', 'x'))).toBe(false)
  })
})

describe('agui-gate — confined mode (full access OFF) restores the exec-token gate', () => {
  it('DENIES delete_file from execOk:false when full access is off', async () => {
    fullAccessMock.mockReturnValue(false)
    const r = await resolveAguiGate(call('delete_file', { path: 'C:/Users/u/Desktop/x.txt' }), inbound as never)
    expect(r.allow).toBe(false)
  })

  it('DENIES run_command from execOk:false when full access is off', async () => {
    fullAccessMock.mockReturnValue(false)
    const r = await resolveAguiGate(call('run_command', { command: 'echo hi' }), inbound as never)
    expect(r.allow).toBe(false)
  })
})
