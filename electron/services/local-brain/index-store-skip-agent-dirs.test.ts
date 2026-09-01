import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { collectNoteFiles, AGENT_CONFIG_DIRS } from './index-store'

// Release M11 (A6 F7): a vault that doubles as a repo carries agent/tool configuration trees —
// `.claude/` (Claude Code memory, commands, hooks), `.codex/`, `.agents/`, `.cursor/` rules,
// `.github/` workflows. They are instructions written FOR an agent, not the operator's knowledge,
// and indexing them put that text into the pool the brain answers from. collectNoteFiles is pure
// fs, so this runs under vitest where the DB ops don't (same harness as the .brain/memory test).
describe('collectNoteFiles — agent/tool config trees are skipped', () => {
  let vault: string
  const rel = (v: string, abs: string): string => abs.slice(v.length + 1).split('\\').join('/')

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-skip-'))
    writeFileSync(join(vault, 'real-note.md'), '# Real\n', 'utf-8')
    for (const d of AGENT_CONFIG_DIRS) {
      mkdirSync(join(vault, d, 'deep'), { recursive: true })
      writeFileSync(join(vault, d, 'CLAUDE.md'), '# instructions for an agent\n', 'utf-8')
      writeFileSync(join(vault, d, 'deep', 'rule.md'), 'do this\n', 'utf-8')
    }
    // A look-alike content folder must still be indexed: only the exact names are skipped.
    mkdirSync(join(vault, '.claude-notes'), { recursive: true })
    writeFileSync(join(vault, '.claude-notes', 'keep.md'), 'content\n', 'utf-8')
    // ...and a nested copy under a content folder is skipped too (the walk checks every level).
    mkdirSync(join(vault, 'projects', 'app', '.github'), { recursive: true })
    writeFileSync(join(vault, 'projects', 'app', '.github', 'workflow.md'), 'ci\n', 'utf-8')
    writeFileSync(join(vault, 'projects', 'app', 'design.md'), 'design\n', 'utf-8')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('collects notes but nothing under .claude/.codex/.agents/.cursor/.github at any depth', () => {
    const rels = collectNoteFiles(vault).map((f) => rel(vault, f))
    expect(rels).toContain('real-note.md')
    expect(rels).toContain('projects/app/design.md')
    expect(rels).toContain('.claude-notes/keep.md')
    for (const d of AGENT_CONFIG_DIRS) {
      expect(rels.some((r) => r.startsWith(`${d}/`)), d).toBe(false)
    }
    expect(rels.some((r) => r.includes('/.github/'))).toBe(false)
  })

  it('pins the list itself', () => {
    expect([...AGENT_CONFIG_DIRS]).toEqual(['.claude', '.codex', '.agents', '.cursor', '.github'])
  })
})
