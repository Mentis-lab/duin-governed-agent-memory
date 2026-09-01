import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  readAgentsMd,
  resolveAgentsMdPath,
  agentsMdDuplicates,
  invalidateAgentsMd
} from './agents-md-loader'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'duin-agentsmd-'))
  invalidateAgentsMd()
})

afterEach(() => {
  invalidateAgentsMd()
  rmSync(root, { recursive: true, force: true })
})

describe('resolveAgentsMdPath', () => {
  it('is null when the workspace has no operating-instructions file', () => {
    expect(resolveAgentsMdPath(root)).toBeNull()
    expect(readAgentsMd(root)).toBe('')
  })

  it('points at the file whose contents readAgentsMd returns', () => {
    writeFileSync(join(root, 'BRAIN.md'), 'the contract', 'utf8')
    // Compared case-insensitively on purpose. The candidate list is probed in
    // priority order with existsSync, so on a case-insensitive filesystem the
    // resolved spelling is `brain.md` (first candidate) even though the file on
    // disk is `BRAIN.md`. That mismatch is exactly why the dedup below folds
    // case on win32 rather than comparing strings.
    expect(resolveAgentsMdPath(root)?.toLowerCase()).toBe(join(root, 'BRAIN.md').toLowerCase())
    expect(readAgentsMd(root)).toBe('the contract')
  })
})

describe('cache is keyed by root', () => {
  // The cache used to hold only content + timestamp. Two workspaces read inside
  // the same 5s window got each other's operating contract, and the dedup below
  // would then compare against a path from the wrong vault.
  it('does not serve one workspace the other workspace contract', () => {
    const other = mkdtempSync(join(tmpdir(), 'duin-agentsmd-b-'))
    try {
      writeFileSync(join(root, 'BRAIN.md'), 'contract A', 'utf8')
      writeFileSync(join(other, 'BRAIN.md'), 'contract B', 'utf8')
      expect(readAgentsMd(root)).toBe('contract A')
      expect(readAgentsMd(other)).toBe('contract B')
      expect(readAgentsMd(root)).toBe('contract A')
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

describe('agentsMdDuplicates', () => {
  it('is false when nothing else has the file in the prompt', () => {
    writeFileSync(join(root, 'BRAIN.md'), 'the contract', 'utf8')
    expect(agentsMdDuplicates(root, [])).toBe(false)
    expect(agentsMdDuplicates(root, [join(root, 'ME.md')])).toBe(false)
  })

  it('is true when the identity block already carries the same file', () => {
    writeFileSync(join(root, 'BRAIN.md'), 'the contract', 'utf8')
    expect(agentsMdDuplicates(root, [join(root, 'SOUL.md'), join(root, 'BRAIN.md')])).toBe(true)
  })

  it('sees through separator style and unnormalized segments', () => {
    writeFileSync(join(root, 'BRAIN.md'), 'the contract', 'utf8')
    const sub = join(root, 'sub')
    mkdirSync(sub)
    expect(agentsMdDuplicates(root, [join(sub, '..', 'BRAIN.md')])).toBe(true)
    expect(agentsMdDuplicates(root, [`${root}/BRAIN.md`])).toBe(true)
  })

  it('is false when the two readers resolved genuinely different vaults', () => {
    // Multi-vault: <agents_md> follows the active workspace, the identity block
    // follows localBrainNotesDir. Different files with the same basename must
    // BOTH ship — deduping on basename alone would drop real content.
    const otherVault = mkdtempSync(join(tmpdir(), 'duin-agentsmd-c-'))
    try {
      writeFileSync(join(root, 'BRAIN.md'), 'workspace contract', 'utf8')
      expect(agentsMdDuplicates(root, [join(otherVault, 'BRAIN.md')])).toBe(false)
    } finally {
      rmSync(otherVault, { recursive: true, force: true })
    }
  })

  it('is false when there is no agents-md file at all', () => {
    expect(agentsMdDuplicates(root, [join(root, 'BRAIN.md')])).toBe(false)
  })
})
