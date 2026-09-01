// Regression: the Outputs panel's "+ New output" silently obliterated an existing vault note.
//
// Failing scenario this locks down: the user creates an output from the title "Board brief".
// OutputsPanel slugifies it to `board-brief` and saveDoc's `Outputs/board-brief.md`. Over the
// following weeks the note grows to several hundred lines with status/project frontmatter
// (edited in DocView, BrainExplorerPanel, or Obsidian). The user then opens Tools > Outputs >
// "+ New output" to update it, types the SAME title plus a two-line body, and hits Save. The
// slug collides exactly; the panel synthesizes a fresh 5-line stub — it never read the old
// bytes, so the new content cannot contain them — and POSTed it to /state/doc/save, whose
// handler was a bare mkdirSync + writeFileSync ("Create OR overwrite"). The hundreds of lines
// were gone from disk with no .trash entry, no journal record, and toast.success('Output
// saved'). deriveOutputs projects FROM these notes (derive-knowledge isOutput → inFolder
// ['Outputs']), so the markdown was the source of truth, not a rebuildable cache.
//
// Pattern A: the guard already existed one import away — brain-native-routes-2 imports
// tombstoneToTrash from vault-trash and uses it in the SIBLING /state/doc/delete route, and
// vault-trash's snapshotToTrash is documented for exactly this rewrite case. The three other
// saveDoc callers are read-then-write and cannot lose content; this was the one call site
// that skipped the guard.
//
// These tests fail against the pre-fix handler (bare writeFileSync ⇒ no .trash, prior body
// gone, unqualified { ok: true }). Pure fs — no better-sqlite3 / electron in the import graph,
// so the suite really executes rather than skipping silently.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveVaultDoc } from './doc-save'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './vault-trash'

let vault: string

// What the note grew into after the panel first created it.
const GROWN =
  `---\ntype: output\ntitle: Board brief\nstatus: in-review\nproject: Q3 Board\ncreated: 2026-05-02T09:00:00.000Z\n---\n\n` +
  Array.from({ length: 400 }, (_, i) => `line ${i + 1}: hand-written board brief detail`).join('\n') +
  '\n'

// What OutputsPanel synthesizes on the second save — path AND body from scratch.
const STUB = `---\ntype: output\ntitle: Board brief\ncreated: 2026-07-19T10:00:00.000Z\n---\n\nfirst line\nsecond line`

const OUTPUT_REL = 'Outputs/board-brief.md'

function abs(rel: string): string {
  return join(vault, ...rel.split('/'))
}

function seed(rel: string, body: string): string {
  const p = abs(rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, body, 'utf-8')
  return p
}

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

function journal(): Record<string, string>[] {
  const p = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-docsave-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('/state/doc/save — preserve before overwrite', () => {
  it('the slug-collision re-save keeps the 400 grown lines recoverable', () => {
    const p = seed(OUTPUT_REL, GROWN)

    const res = saveVaultDoc(vault, p, STUB, 'ui:doc-save', OUTPUT_REL)

    expect(res.ok).toBe(true)
    // The save really happened — this is not a refuse-to-write fix; the vault self-evolves.
    expect(readFileSync(p, 'utf-8')).toBe(STUB)
    // …and every prior byte, frontmatter included, is still there.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, tombstones[0]), 'utf-8')).toBe(GROWN)
    // The caller is TOLD, so the panel can stop reporting a plain success.
    expect(res.ok && res.replaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('journals what was replaced, from where, when and by whom', () => {
    seed(OUTPUT_REL, GROWN)
    saveVaultDoc(vault, abs(OUTPUT_REL), STUB, 'ui:doc-save', OUTPUT_REL)

    const j = journal()
    expect(j).toHaveLength(1)
    expect(j[0].from).toBe(OUTPUT_REL)
    expect(j[0].actor).toBe('ui:doc-save')
    expect(j[0].op).toBe('overwrite')
    expect(j[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(Number.isNaN(Date.parse(j[0].at))).toBe(false)
  })

  it('a pre-existing hand-written note at the derived slug is preserved too', () => {
    // No collision-in-panel required: deriveOutputs treats Outputs/ as canonical, so a
    // hand-authored lowercase-hyphenated note there is a live target for the first save.
    const handWritten = '# Board brief\n\nwritten in Obsidian, never touched by the panel\n'
    const p = seed(OUTPUT_REL, handWritten)

    saveVaultDoc(vault, p, STUB, 'ui:doc-save', OUTPUT_REL)

    expect(readFileSync(join(vault, TRASH_DIR_NAME, trashFiles()[0]), 'utf-8')).toBe(handWritten)
  })

  it('pattern B — a nearly-empty body is exactly the case that must stay recoverable', () => {
    // The panel does not require a body at all; only the title is validated.
    const p = seed(OUTPUT_REL, GROWN)
    const empty = `---\ntype: output\ntitle: Board brief\ncreated: 2026-07-19T10:00:00.000Z\n---\n\n`

    const res = saveVaultDoc(vault, p, empty, 'ui:doc-save', OUTPUT_REL)

    expect(res.ok).toBe(true)
    expect(readFileSync(p, 'utf-8')).toBe(empty)
    expect(readFileSync(join(vault, TRASH_DIR_NAME, trashFiles()[0]), 'utf-8')).toBe(GROWN)
  })

  it('creating a NEW output leaves no tombstone (no false alarm, no .trash churn)', () => {
    const res = saveVaultDoc(vault, abs('Outputs/brand-new.md'), STUB, 'ui:doc-save', 'Outputs/brand-new.md')
    expect(res.ok).toBe(true)
    expect(res.ok && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
    expect(readFileSync(abs('Outputs/brand-new.md'), 'utf-8')).toBe(STUB)
  })

  it('an unchanged re-save snapshots nothing — one entry per real alteration, not per save', () => {
    // DocView/BrainExplorer save a draft seeded from the loaded doc; an untouched save
    // must not fill .trash with duplicates.
    const p = seed(OUTPUT_REL, GROWN)
    const res = saveVaultDoc(vault, p, GROWN, 'ui:doc-save', OUTPUT_REL)
    expect(res.ok).toBe(true)
    expect(res.ok && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('does not clobber an earlier snapshot when same-named notes are re-saved', () => {
    seed('Outputs/brief.md', 'FIRST\n')
    saveVaultDoc(vault, abs('Outputs/brief.md'), 'X\n', 'ui:doc-save', 'Outputs/brief.md')
    seed('01 Projects/brief.md', 'SECOND\n')
    saveVaultDoc(vault, abs('01 Projects/brief.md'), 'Y\n', 'ui:doc-save', '01 Projects/brief.md')

    const bodies = trashFiles().map((f) => readFileSync(join(vault, TRASH_DIR_NAME, f), 'utf-8')).sort()
    expect(bodies).toEqual(['FIRST\n', 'SECOND\n'])
  })

  it('refuses the destructive write when the prior bytes cannot be preserved', () => {
    const p = seed(OUTPUT_REL, GROWN)
    // Make .trash un-creatable by planting a FILE where the trash DIRECTORY must go.
    writeFileSync(join(vault, TRASH_DIR_NAME), 'not a directory', 'utf-8')

    const res = saveVaultDoc(vault, p, STUB, 'ui:doc-save', OUTPUT_REL)

    expect(res.ok).toBe(false)
    // The decisive part: proceeding blind is the one outcome that cannot be undone.
    expect(readFileSync(p, 'utf-8')).toBe(GROWN)
    rmSync(join(vault, TRASH_DIR_NAME), { force: true })
  })
})
