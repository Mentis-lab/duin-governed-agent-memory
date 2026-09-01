// Scaffold vault writes must be TRACEABLE, not blocked.
//
// The vault is meant to self-evolve, so scaffold is allowed to rewrite a note the operator wrote by
// hand. What it must never do is rewrite one silently. Before this, three entity-note writes and the
// starter RULES were bare writeFileSync calls — and the original had already been unlinkSync'd by an
// earlier step, so an LLM-chosen filename could replace hundreds of hand-written lines with a 6-line
// stub leaving no record of what changed, when, or where the original went.
//
// The contract these tests pin: an alteration always produces (a) the prior content preserved as a real
// file, (b) a machine-readable ledger row, and (c) a stamp in the note itself. If any of those cannot be
// produced, the write is skipped instead — an untraceable edit is the failure being fixed.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('../providers/registry', () => ({ chatOnce: vi.fn(), routeModel: () => null }))

import { scaffoldHarness } from './scaffold-harness'

const LEDGER = join('.duin', '_state', 'scaffold-alterations.jsonl')
const readLedger = (vault: string): Record<string, unknown>[] => {
  const p = join(vault, LEDGER)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l))
}

let vault: string
beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-scaffold-'))
})

/** A substantial hand-written note — the thing that used to be replaced by a stub. */
const HANDWRITTEN =
  '# Project Lamprey\n\n' +
  Array.from({ length: 120 }, (_, i) => `Hand-written line ${i} about the judgment harness and its constraints.`).join('\n')

describe('scaffold — altering an operator note leaves a trace', () => {
  it('preserves the prior content, ledgers the alteration, and stamps the new note', async () => {
    // Seed a hand-written note where scaffold will want to place a starter rule.
    mkdirSync(join(vault, 'DUIN', 'Rules'), { recursive: true })
    const target = join(vault, 'DUIN', 'Rules', 'tasks.md')
    writeFileSync(target, HANDWRITTEN)
    // Give the walker something to classify so the run reaches the RULES step.
    writeFileSync(join(vault, 'note.md'), '# A note\n\nSome content about the work.\n')

    await scaffoldHarness(vault)

    const rows = readLedger(vault)
    const row = rows.find((r) => String(r.path).endsWith('Rules/tasks.md'))
    expect(row, 'an alteration of a hand-written rule must be ledgered').toBeTruthy()
    expect(row!.by).toBe('scaffold:starter-rule')
    expect(Number(row!.priorBytes)).toBe(HANDWRITTEN.length)

    // (a) the prior content still exists somewhere recoverable
    const copy = join(vault, String(row!.priorCopy))
    expect(existsSync(copy)).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe(HANDWRITTEN)

    // (c) the replacement says so in its own frontmatter
    const now = readFileSync(target, 'utf8')
    expect(now).toMatch(/altered-by: scaffold:starter-rule/)
    expect(now).toMatch(/altered-at: \d{4}-\d{2}-\d{2}T/)
    expect(now).toMatch(/prior-copy: /)
  })

  it('does NOT ledger or stamp when there was nothing to replace', async () => {
    writeFileSync(join(vault, 'note.md'), '# A note\n\nSome content about the work.\n')
    await scaffoldHarness(vault)
    const rules = join(vault, 'DUIN', 'Rules', 'tasks.md')
    if (existsSync(rules)) expect(readFileSync(rules, 'utf8')).not.toMatch(/altered-by:/)
    expect(readLedger(vault).some((r) => String(r.path).endsWith('Rules/tasks.md'))).toBe(false)
  })

  it('a re-run is a no-op: writing identical bytes is not an "alteration"', async () => {
    writeFileSync(join(vault, 'note.md'), '# A note\n\nSome content about the work.\n')
    await scaffoldHarness(vault)
    const first = readLedger(vault).length
    await scaffoldHarness(vault)
    // The second pass rewrites the same starter content; that must not accumulate ledger noise.
    const added = readLedger(vault).slice(first).filter((r) => String(r.by) === 'scaffold:starter-rule')
    expect(added).toHaveLength(0)
  })

  it('preserved copies never overwrite each other', async () => {
    mkdirSync(join(vault, 'DUIN', 'Rules'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Rules', 'tasks.md'), HANDWRITTEN)
    writeFileSync(join(vault, 'note.md'), '# A note\n\nContent.\n')
    await scaffoldHarness(vault)
    // Put a DIFFERENT hand-written file at the same path and run again.
    writeFileSync(join(vault, 'DUIN', 'Rules', 'tasks.md'), HANDWRITTEN + '\nsecond distinct version\n')
    await scaffoldHarness(vault)

    const rows = readLedger(vault).filter((r) => String(r.path).endsWith('Rules/tasks.md'))
    expect(rows.length).toBeGreaterThanOrEqual(2)
    const copies = new Set(rows.map((r) => String(r.priorCopy)))
    expect(copies.size).toBe(rows.length) // distinct destinations — no clobbering the earlier rescue
    for (const c of copies) expect(existsSync(join(vault, c))).toBe(true)
  })

  it('a hand-written DIAGNOSIS.md is preserved rather than silently replaced', async () => {
    // DIAGNOSIS.md was the one foundation name hardcoded as "always ours to overwrite", so it had no
    // preservation path at all.
    const diag = join(vault, 'DIAGNOSIS.md')
    writeFileSync(diag, '# My own diagnosis notes\n\nThings I concluded by hand.\n')
    writeFileSync(join(vault, 'note.md'), '# A note\n\nContent.\n')
    await scaffoldHarness(vault)

    const inbox = join(vault, 'DUIN', '00 Inbox')
    const preserved = existsSync(inbox)
      ? readdirSync(inbox).filter((f) => f.toLowerCase().includes('diagnosis'))
      : []
    const ledgered = readLedger(vault).some((r) => String(r.path).includes('DIAGNOSIS'))
    expect(preserved.length > 0 || ledgered).toBe(true)
  })
})

// SOUL.md must survive an in-place scaffold at the vault ROOT.
//
// The in-place mover files any root .md it does not recognize into a pillar folder,
// and it recognizes them via FOUNDATION_FILES. SOUL.md is generated by okf-scaffold
// / the boot backfill rather than by this module, so it was absent from that set —
// meaning a scaffold run would relocate the operator's character file. loadBrain
// reads the vault ROOT only, so the file would still exist while silently ceasing
// to load: the worst shape of failure, because nothing reports it.
describe('scaffold — foundation files stay at the vault root', () => {
  it('does not relocate SOUL.md', async () => {
    const soul = join(vault, 'SOUL.md')
    writeFileSync(soul, '---\ntype: soul\n---\n\n# SOUL\n\nI would rather be useful than agreeable.\n')
    // Give the walker a real note so the run reaches the move loop.
    writeFileSync(join(vault, 'note.md'), '# A note\n\nSome content about the work.\n')

    await scaffoldHarness(vault)

    expect(existsSync(soul), 'SOUL.md must still be at the vault root').toBe(true)
    expect(readFileSync(soul, 'utf8')).toContain('useful than agreeable')
  })
})
