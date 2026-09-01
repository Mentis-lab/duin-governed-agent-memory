import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFoundationFile, FOUNDATION_BASENAMES } from './write-identity'

// Phase 0 — the security-critical write spine for the Foundations pane. Pure fs,
// no electron, temp-dir vault. Proves: the basename whitelist REJECTS every
// non-foundation path (no traversal, no other names, no drive letters) and writes
// nothing; a first write creates the file with no snapshot; an overwrite snapshots
// the prior bytes to .trash (journalled op:'overwrite', actor:'foundations-pane')
// before replacing; an unchanged body snapshots nothing; a FAILED snapshot refuses
// the write and leaves the live bytes intact; and GOALS.md round-trips like ME/BRAIN.

describe('writeFoundationFile — whitelist + snapshot spine', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-found-'))
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('exposes exactly {SOUL,ME,BRAIN,GOALS}.md as the whitelist', () => {
    expect([...FOUNDATION_BASENAMES].sort()).toEqual(['BRAIN.md', 'GOALS.md', 'ME.md', 'SOUL.md'])
  })

  // ---- WHITELIST REJECTS non-foundation paths + traversal ----
  const rejected = [
    'notes/secret.md',
    '../../etc/hosts',
    '..\\x',
    'C:\\x',
    '.brain/identity.md',
    'MEMORY.md',
    'me.md', // case-sensitive: not a member
    'ME.md.bak',
    '',
    'sub/ME.md',
    './ME.md',
    'ME.md ' // trailing space is a different basename
  ]
  for (const bad of rejected) {
    it(`rejects ${JSON.stringify(bad)} and writes nothing`, () => {
      const before = readdirSync(dir)
      const res = writeFoundationFile(dir, bad, 'payload that must never land')
      expect(res.ok).toBe(false)
      expect(res.wrote).toBe(false)
      // Nothing new was created anywhere under the vault.
      expect(readdirSync(dir)).toEqual(before)
      // And in particular the payload did not reach any plausible target.
      expect(existsSync(join(dir, 'ME.md'))).toBe(false)
      expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false)
    })
  }

  it('rejects a foundation basename when the vault dir does not exist', () => {
    const res = writeFoundationFile(join(dir, 'nope'), 'ME.md', 'x')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/vault dir not found/)
  })

  it('rejects a non-string body', () => {
    // @ts-expect-error deliberate wrong type at the boundary
    const res = writeFoundationFile(dir, 'ME.md', 123)
    expect(res.ok).toBe(false)
    expect(existsSync(join(dir, 'ME.md'))).toBe(false)
  })

  // ---- CREATE a new file (no snapshot) ----
  it('creates a new file when absent — wrote:true, no snapshot, no .trash', () => {
    const res = writeFoundationFile(dir, 'ME.md', '# Me\n')
    expect(res.ok).toBe(true)
    expect(res.wrote).toBe(true)
    expect(res.replacedTrashRel).toBeUndefined()
    expect(readFileSync(join(dir, 'ME.md'), 'utf-8')).toBe('# Me\n')
    expect(existsSync(join(dir, '.trash'))).toBe(false)
  })

  // ---- SNAPSHOT-to-.trash on overwrite ----
  it('snapshots prior bytes to .trash before overwriting, and journals op:overwrite', () => {
    writeFileSync(join(dir, 'ME.md'), '# original identity\n', 'utf-8')
    const res = writeFoundationFile(dir, 'ME.md', '# edited identity\n')
    expect(res.ok).toBe(true)
    expect(res.replacedTrashRel).toBeDefined()

    // Live file holds the new body.
    expect(readFileSync(join(dir, 'ME.md'), 'utf-8')).toBe('# edited identity\n')

    // The named .trash path resolves to the PRIOR bytes.
    const recovered = join(dir, ...String(res.replacedTrashRel).split('/'))
    expect(existsSync(recovered)).toBe(true)
    expect(readFileSync(recovered, 'utf-8')).toBe('# original identity\n')

    // Journal line records op:'overwrite' + actor:'foundations-pane'.
    const journal = readFileSync(join(dir, '.trash', '_tombstones.jsonl'), 'utf-8').trim()
    const line = JSON.parse(journal.split(/\r?\n/).pop() as string)
    expect(line.op).toBe('overwrite')
    expect(line.actor).toBe('foundations-pane')
    expect(line.from).toBe('ME.md')
  })

  it('does NOT snapshot when the body is byte-identical', () => {
    writeFileSync(join(dir, 'BRAIN.md'), 'same\n', 'utf-8')
    const res = writeFoundationFile(dir, 'BRAIN.md', 'same\n')
    expect(res.ok).toBe(true)
    expect(res.replacedTrashRel).toBeUndefined()
    expect(existsSync(join(dir, '.trash'))).toBe(false)
  })

  it('allows clearing a file to empty — still snapshots the prior bytes first', () => {
    writeFileSync(join(dir, 'GOALS.md'), '# had content\n', 'utf-8')
    const res = writeFoundationFile(dir, 'GOALS.md', '')
    expect(res.ok).toBe(true)
    expect(res.replacedTrashRel).toBeDefined()
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).toBe('')
    const recovered = join(dir, ...String(res.replacedTrashRel).split('/'))
    expect(readFileSync(recovered, 'utf-8')).toBe('# had content\n')
  })

  // ---- REFUSE the write when the snapshot fails ----
  it('refuses the overwrite and leaves the live bytes UNCHANGED when the snapshot fails', async () => {
    writeFileSync(join(dir, 'BRAIN.md'), 'precious original\n', 'utf-8')
    // Mock the snapshot primitive to fail, mirroring an unwritable .trash.
    const trash = await import('../local-brain/vault-trash')
    vi.spyOn(trash, 'snapshotToTrash').mockReturnValue({ ok: false, error: 'disk full' })

    const res = writeFoundationFile(dir, 'BRAIN.md', 'REPLACEMENT that must not land\n')
    expect(res.ok).toBe(false)
    expect(res.wrote).toBe(false)
    expect(res.error).toMatch(/could not preserve/)
    // The live bytes are untouched — the whole point of the refusal.
    expect(readFileSync(join(dir, 'BRAIN.md'), 'utf-8')).toBe('precious original\n')
  })

  // ---- GOALS.md supported ----
  it('supports GOALS.md end-to-end (create then overwrite round-trip)', () => {
    const c = writeFoundationFile(dir, 'GOALS.md', '# GOALS\n## Strategic Tracks (cross-cycle)\n### Ship\n')
    expect(c.ok).toBe(true)
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).toContain('Strategic Tracks')
    const o = writeFoundationFile(dir, 'GOALS.md', '# GOALS v2\n')
    expect(o.ok).toBe(true)
    expect(o.replacedTrashRel).toBeDefined()
    expect(readFileSync(join(dir, 'GOALS.md'), 'utf-8')).toBe('# GOALS v2\n')
  })
})
