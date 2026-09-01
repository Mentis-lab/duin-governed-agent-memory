import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeIdentityFiles } from './write-identity'
import { loadBrain, buildBrainGroundingBlock } from './brain-root'

// Representative generator output (src/lib/brain-identity.ts is tested separately for its
// exact shape). Here we prove: write-identity persists these to a vault root, honors
// no-clobber, and the REAL grounding loader reads them back into a non-empty block —
// i.e. the cold-start gap is closed end-to-end at the module level, no app, temp dir only.
const ME_MD = [
  '---',
  'type: identity',
  'generated: 2026-07-01',
  '---',
  '',
  '# Gao',
  '',
  '发行负责人',
  '',
  '## Who I am',
  '- Role: 发行负责人',
  '- Works on: 北澜 · AI',
  ''
].join('\n')
const BRAIN_MD = ["# BRAIN.md — Gao's DUIN", '', '## Operating contract', '- Ground every answer in the vault', ''].join('\n')

describe('write-identity — cold-start foundation files (A1)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-id-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('writes ME.md + BRAIN.md, scaffolds .brain/, and they GROUND via the real loader', () => {
    const res = writeIdentityFiles({ notesDir: dir, meMd: ME_MD, brainMd: BRAIN_MD })
    expect(res.ok).toBe(true)
    expect(res.wrote).toEqual(['BRAIN.md', 'ME.md'])
    expect(existsSync(join(dir, 'ME.md'))).toBe(true)
    expect(existsSync(join(dir, 'BRAIN.md'))).toBe(true)
    expect(existsSync(join(dir, '.brain', 'memory'))).toBe(true) // ensureBrainRoot ran

    // The real grounding loader now returns a non-empty identity block (the gap closed).
    const loaded = loadBrain(dir)
    expect(loaded).not.toBeNull()
    const block = buildBrainGroundingBlock(loaded)
    expect(block).toContain('WHO YOU ARE')
    expect(block).toContain('Gao')
    expect(block).toContain('发行负责人') // bilingual survives the round-trip
    expect(block).toContain('Operating contract')
  })

  it('skips ME.md when empty, still writes BRAIN.md and grounds on the contract', () => {
    const res = writeIdentityFiles({ notesDir: dir, meMd: '', brainMd: BRAIN_MD })
    expect(res.wrote).toEqual(['BRAIN.md'])
    expect(existsSync(join(dir, 'ME.md'))).toBe(false)
    expect(buildBrainGroundingBlock(loadBrain(dir))).toContain('Operating contract')
  })

  it('no-clobber: never overwrites an existing foundation file by default', () => {
    writeFileSync(join(dir, 'ME.md'), '# My hand-written identity\n', 'utf-8')
    const res = writeIdentityFiles({ notesDir: dir, meMd: ME_MD, brainMd: BRAIN_MD })
    expect(res.skipped).toContain('ME.md')
    expect(res.wrote).toContain('BRAIN.md')
    expect(readFileSync(join(dir, 'ME.md'), 'utf-8')).toContain('hand-written identity')
  })

  it('overwrite:true replaces existing files', () => {
    writeFileSync(join(dir, 'BRAIN.md'), 'old contract', 'utf-8')
    const res = writeIdentityFiles({ notesDir: dir, meMd: ME_MD, brainMd: BRAIN_MD, overwrite: true })
    expect(res.wrote).toContain('BRAIN.md')
    expect(readFileSync(join(dir, 'BRAIN.md'), 'utf-8')).toContain("Gao's DUIN")
  })

  it('errors cleanly on a missing notesDir (no partial writes to the wrong place)', () => {
    const res = writeIdentityFiles({ notesDir: join(dir, 'does-not-exist'), meMd: ME_MD, brainMd: BRAIN_MD })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not found/)
  })
})
