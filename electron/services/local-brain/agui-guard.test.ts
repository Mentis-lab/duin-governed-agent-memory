import { describe, it, expect } from 'vitest'
import { isGatedTool, execAuthorized, deniedResult, AGUI_GATED_TOOLS } from './agui-guard'

describe('agui-guard — gated tool set', () => {
  it('gates host-exec + irreversible ops + spawn_agent, not reads/vault-writes', () => {
    for (const t of ['run_command', 'start_command', 'delete_file', 'move_file', 'spawn_agent', 'create_skill', 'delegate_task']) expect(isGatedTool(t)).toBe(true)
    for (const t of ['read_file', 'list_dir', 'search_files', 'write_file', 'edit_file', 'web_fetch']) expect(isGatedTool(t)).toBe(false)
  })
  it('non-strings are never gated', () => {
    expect(isGatedTool(undefined)).toBe(false)
    expect(isGatedTool(null)).toBe(false)
    expect(isGatedTool(42)).toBe(false)
  })
  it('the gated set is the host/irreversible tools plus spawn_agent, send_email, create_skill, and delegate_task', () => {
    // create_skill added 2026-08-22 (F5): a SKILL.md is live-loaded as an executable capability
    // outside the vault jail, so an untrusted inbound turn creating one is a persistent-behavior
    // side-door — gated at the deny-first rule like spawn_agent.
    // delegate_task added 2026-08-27 (external executor, PLANNING/DUIN_EXTERNAL_EXECUTOR_PLAN.md):
    // it spawns another harness as a child process — shell access by construction — so it takes
    // the same deny-first path and the spawn-recursive tier.
    expect([...AGUI_GATED_TOOLS].sort()).toEqual([
      'create_skill',
      'delegate_task',
      'delete_file',
      'move_file',
      'run_command',
      'send_email',
      'spawn_agent',
      'start_command'
    ])
  })
})

describe('agui-guard — execAuthorized (fail-safe deny)', () => {
  const TOKEN = 'a1b2c3d4-token-value-0987'
  it('authorizes only an exact-match token', () => {
    expect(execAuthorized(TOKEN, TOKEN)).toBe(true)
  })
  it('denies a wrong token', () => {
    expect(execAuthorized('a1b2c3d4-token-value-XXXX', TOKEN)).toBe(false)
    expect(execAuthorized('a1b2c3d4-token-value-098', TOKEN)).toBe(false) // shorter
    expect(execAuthorized(TOKEN + 'x', TOKEN)).toBe(false) // longer
  })
  it('FAIL-SAFE: no server token configured → deny (even with a header)', () => {
    expect(execAuthorized(TOKEN, null)).toBe(false)
    expect(execAuthorized(TOKEN, undefined)).toBe(false)
    expect(execAuthorized(TOKEN, '')).toBe(false)
  })
  it('FAIL-SAFE: missing/blank/non-string header → deny', () => {
    expect(execAuthorized(undefined, TOKEN)).toBe(false)
    expect(execAuthorized('', TOKEN)).toBe(false)
    expect(execAuthorized(['x'], TOKEN)).toBe(false) // node lowercases dup headers to arrays
  })
})

describe('agui-guard — deniedResult', () => {
  it('names the tool and explains the gate + the escape hatch', () => {
    const r = deniedResult('run_command')
    expect(r).toContain('run_command')
    expect(r).toContain('deny-first')
    expect(r.toLowerCase()).toContain('read')
  })
})
