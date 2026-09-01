import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { brainStateDir, checkBrainVault } from './brain-state-dir'

describe('brain-state-dir — the canonical resolver + grounding guard', () => {
  it('brainStateDir joins the canonical .duin/_state segment', () => {
    expect(brainStateDir(join('x', 'vault'))).toBe(join('x', 'vault', '.duin', '_state'))
  })

  it('checkBrainVault: null for a proper DUIN vault (.duin present)', () => {
    const v = mkdtempSync(join(tmpdir(), 'duin-'))
    mkdirSync(join(v, '.duin'))
    expect(checkBrainVault(v)).toBeNull()
  })

  it('checkBrainVault: WARNS for a legacy .claude-only vault (the legacy-vault mismatch)', () => {
    const v = mkdtempSync(join(tmpdir(), 'rg-'))
    mkdirSync(join(v, '.claude'))
    const warn = checkBrainVault(v)
    expect(warn).toMatch(/no .duin/)
    expect(warn).toMatch(/EMPTY native state/)
  })

  it('checkBrainVault: null for unset, missing, or fresh/empty vault (nothing to guard)', () => {
    expect(checkBrainVault(null)).toBeNull()
    expect(checkBrainVault(undefined)).toBeNull()
    expect(checkBrainVault(join(tmpdir(), 'nope-does-not-exist-xyz'))).toBeNull()
    expect(checkBrainVault(mkdtempSync(join(tmpdir(), 'fresh-')))).toBeNull()
  })
})
