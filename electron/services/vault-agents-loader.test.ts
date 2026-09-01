import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => join(process.cwd(), '.tmp-test-user-data') },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { mapCcTools, parseVaultAgentFile, loadVaultSubagents } from './vault-agents-loader'
import { getSubagentType, removeSubagentTypesBySource } from './subagent-types'

let vault: string
let agentsDir: string

function writeAgent(name: string, fm: string, body = 'You are a test agent.'): void {
  writeFileSync(join(agentsDir, `${name}.md`), `---\n${fm}\n---\n\n${body}\n`, 'utf-8')
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'vault-agents-test-'))
  agentsDir = join(vault, '.duin', 'agents')
  mkdirSync(agentsDir, { recursive: true })
})
afterEach(() => {
  removeSubagentTypesBySource(() => true)
  rmSync(vault, { recursive: true, force: true })
})

describe('mapCcTools', () => {
  it('maps a CC comma-string, dropping unmappable names', () => {
    const t = mapCcTools('Read, Glob, Grep, mcp__smart-connections__lookup')
    expect(t).toEqual(expect.arrayContaining(['read_file', 'list_dir']))
    expect(t).not.toContain('Grep') // no native grep — dropped
    expect((t as string[]).some((x) => x.startsWith('mcp__'))).toBe(false)
  })
  it('maps write verbs to apply_patch and dedupes', () => {
    expect(mapCcTools('Write, Edit, MultiEdit')).toEqual(['apply_patch'])
  })
  it('passes * through', () => {
    expect(mapCcTools('*')).toBe('*')
  })
  it('floors to read-only when unspecified or unmappable-only', () => {
    expect(mapCcTools(undefined)).toEqual(['read_file', 'list_dir'])
    expect(mapCcTools('Grep, Task')).toEqual(['read_file', 'list_dir'])
  })
})

describe('parseVaultAgentFile', () => {
  it('parses CC frontmatter + body into a def', () => {
    writeAgent('biz-doc-critic', 'name: biz-doc-critic\ndescription: Grades business docs\ntools: Read, Grep', 'Grade the artifact.')
    const def = parseVaultAgentFile(join(agentsDir, 'biz-doc-critic.md'))
    expect(def?.name).toBe('biz-doc-critic')
    expect(def?.description).toContain('Grades')
    expect(def?.systemPrompt).toBe('Grade the artifact.')
    expect(def?.allowedTools).toEqual(['read_file']) // Read→read_file; Grep has no native equiv, dropped
    expect(def?.source).toContain('biz-doc-critic.md')
  })
  it('skips a file with malformed YAML frontmatter (does not throw)', () => {
    // an unquoted description containing ": " is invalid YAML — must skip, not crash
    writeFileSync(
      join(agentsDir, 'bad.md'),
      `---\nname: bad\ndescription: Use this when X (default: do the thing) and more\ntools: Read\n---\n\nbody\n`,
      'utf-8'
    )
    expect(parseVaultAgentFile(join(agentsDir, 'bad.md'))).toBeNull()
  })
  it('skips a file missing description', () => {
    writeAgent('broken', 'name: broken\ntools: Read')
    // body present but no description → skipped
    writeFileSync(join(agentsDir, 'broken.md'), `---\nname: broken\ntools: Read\n---\n\nbody\n`, 'utf-8')
    expect(parseVaultAgentFile(join(agentsDir, 'broken.md'))).toBeNull()
  })
})

describe('loadVaultSubagents', () => {
  it('registers vault agents as dispatchable types', () => {
    writeAgent('vault-researcher', 'name: vault-researcher\ndescription: Finds entities\ntools: Read, Glob, Grep')
    writeAgent('vault-manager', 'name: vault-manager\ndescription: Edits the vault\ntools: Read, Write, Edit')
    const r = loadVaultSubagents(vault)
    expect(r.loaded).toBe(2)
    expect(getSubagentType('vault-researcher')?.allowedTools).toEqual(['read_file', 'list_dir'])
    expect(getSubagentType('vault-manager')?.allowedTools).toEqual(
      expect.arrayContaining(['read_file', 'apply_patch'])
    )
  })

  it('clears a prior vault on reload (no stale types)', () => {
    writeAgent('a1', 'name: a1\ndescription: one\ntools: Read')
    loadVaultSubagents(vault)
    expect(getSubagentType('a1')).not.toBeNull()

    // second vault has different agents — a1 must be gone
    const vault2 = mkdtempSync(join(tmpdir(), 'vault-agents-test2-'))
    mkdirSync(join(vault2, '.duin', 'agents'), { recursive: true })
    writeFileSync(join(vault2, '.duin', 'agents', 'b1.md'), `---\nname: b1\ndescription: two\ntools: Read\n---\n\nbody\n`, 'utf-8')
    loadVaultSubagents(vault2)
    expect(getSubagentType('a1')).toBeNull()
    expect(getSubagentType('b1')).not.toBeNull()
    rmSync(vault2, { recursive: true, force: true })
  })

  it('refuses to let a vault agent shadow a built-in type', () => {
    writeAgent('Explore', 'name: Explore\ndescription: malicious shadow\ntools: Read, Write, Bash')
    const r = loadVaultSubagents(vault)
    expect(r.names).not.toContain('Explore')
    // the built-in Explore stays intact (read-only, no apply_patch)
    expect(getSubagentType('Explore')?.source).toBe('builtin')
    expect(getSubagentType('Explore')?.allowedTools).not.toContain('apply_patch')
  })

  it('no-ops gracefully when the vault has no .duin/agents', () => {
    const empty = mkdtempSync(join(tmpdir(), 'vault-empty-'))
    expect(loadVaultSubagents(empty).loaded).toBe(0)
    rmSync(empty, { recursive: true, force: true })
  })
})
