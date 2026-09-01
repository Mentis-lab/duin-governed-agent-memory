// Regression: writeLibrarySidecar blind-overwrote a vault note with a bare writeFileSync.
//
// Failing scenario this locks down: the user has a hand-written `<vault>/Documents/Roadmap.md`,
// wikilinked from other notes. They drag `Roadmap.pdf` into the RAG Library. Ingest succeeds,
// reaches status 'ready', and ingest.ts calls onDocumentReady — wired unconditionally at
// electron/ipc/rag.ts:251 with no feature flag, the sole precondition being localBrainNotesDir,
// the normal configured state. sanitizeTitle('Roadmap.pdf') → 'Roadmap', so the sidecar resolves
// to the SAME path and the old code replaced the user's note in place with the PDF's extracted
// text under `type: document` frontmatter. No .trash copy, no .bak, no journal line, no toast —
// the write only logged when writeFileSync THREW, never when it silently replaced.
//
// The second, filename-coincidence-free case is deterministic and was already live: every
// re-ingest of an already-ingested document rewrote its sidecar, destroying any annotation the
// user had added to it. Read-only inspection of the real vault shows sidecars from this exact
// path (budget_notes.md, d.md, buffbuff_v3.md), so this was firing on real data.
//
// Not a rebuildable cache: moat-backup's SOURCES cover only .duin/_state ledgers,
// brain-construction.json and three userData JSONs — no vault .md files at all — and the graph
// node is derived from the file rather than a second copy of it.
//
// Pattern A: the correct guard already existed and five sibling call sites use it
// (import-agent-system.ts, agui-executors.ts, doc-save.ts, memory-store.ts, and
// saveHtmlToVaultIn in this very file, on the same Documents/ dir via the same sanitizeTitle).
// Pattern B: a TOTAL extraction failure was already safe — buildSidecar returns null on empty
// text and we abstain — while a CORRECT, fully-populated extraction was the one that destroyed.
//
// These tests fail against the pre-fix function (bare writeFileSync ⇒ empty .trash, the
// hand-written note gone). writeLibrarySidecarIn takes the vault dir as an explicit seam so no
// electron `app` / better-sqlite3 is in the import graph — the suite really executes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { writeLibrarySidecarIn } from './library-brain-bridge'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './local-brain/vault-trash'
import type { DocumentReadyInfo } from './rag/ingest'

let vault: string

const HAND_WRITTEN_ROADMAP = [
  '# Roadmap',
  '',
  'Hand-written. Linked from [[Q3 Planning]] and [[Team Sync]].',
  '',
  '- [ ] decide on the storage rewrite',
  '- [x] ship the ingest pipeline'
].join('\n')

const doc = (over: Partial<DocumentReadyInfo> = {}): DocumentReadyInfo => ({
  documentId: 'doc-1',
  collectionId: 'c',
  displayName: 'Roadmap.pdf',
  sourcePath: 'C:\\Users\\me\\Roadmap.pdf',
  mime: 'application/pdf',
  text: 'Extracted PDF text: quarterly roadmap slides, 42 pages of vendor boilerplate.',
  ...over
})

const notePath = (title: string): string => join(vault, 'Documents', `${title}.md`)
const AT = new Date('2026-07-19T10:00:00Z')

function trashFiles(): string[] {
  const d = join(vault, TRASH_DIR_NAME)
  return existsSync(d) ? readdirSync(d).filter((f) => f !== TOMBSTONE_JOURNAL).sort() : []
}

function trashBody(name: string): string {
  return readFileSync(join(vault, TRASH_DIR_NAME, name), 'utf-8')
}

function journal(): Record<string, string>[] {
  const p = join(vault, TRASH_DIR_NAME, TOMBSTONE_JOURNAL)
  if (!existsSync(p)) return []
  return readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-sidecar-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('writeLibrarySidecarIn — preserve before overwrite', () => {
  it('snapshots a hand-written vault note that the derived sidecar path collides with', () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(notePath('Roadmap'), HAND_WRITTEN_ROADMAP, 'utf-8')

    const res = writeLibrarySidecarIn(vault, doc(), AT)

    // The ingest bridge still does its job — this is not a refuse-to-write fix.
    expect(res).toMatchObject({ ok: true, written: true, title: 'Roadmap' })
    expect(readFileSync(notePath('Roadmap'), 'utf-8')).toContain('type: document')
    // …and the user's note is still recoverable, byte-identical.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(trashBody(tombstones[0])).toBe(HAND_WRITTEN_ROADMAP)
    expect(res.ok && res.written && res.replaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('preserves hand annotations added to a previously written sidecar on re-ingest', () => {
    // The deterministic case — no filename coincidence needed, and already live on real data.
    writeLibrarySidecarIn(vault, doc(), AT)
    const annotated =
      readFileSync(notePath('Roadmap'), 'utf-8') +
      '\n## Theo\'s notes\n\nThe vendor numbers on p.12 contradict [[Q3 Budget]].\n'
    writeFileSync(notePath('Roadmap'), annotated, 'utf-8')

    // User re-ingests the same PDF (rag.ts reingest handler → onDocumentReady again).
    writeLibrarySidecarIn(vault, doc({ text: 'Re-extracted PDF text, slightly different.' }), AT)

    const bodies = trashFiles().map(trashBody)
    expect(bodies).toContain(annotated)
    expect(bodies.some((b) => b.includes('contradict [[Q3 Budget]]'))).toBe(true)
  })

  it('a fresh sidecar creates without churning .trash', () => {
    const res = writeLibrarySidecarIn(vault, doc(), AT)
    expect(res).toMatchObject({ ok: true, written: true })
    expect(res.ok && res.written && res.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('an UNCHANGED re-ingest snapshots nothing — one entry per actual alteration', () => {
    writeLibrarySidecarIn(vault, doc(), AT)
    const again = writeLibrarySidecarIn(vault, doc(), AT)

    expect(again).toMatchObject({ ok: true, written: false })
    expect(trashFiles()).toEqual([])
  })

  it('journals what was replaced, from where, when and by whom', () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(notePath('Roadmap'), HAND_WRITTEN_ROADMAP, 'utf-8')

    writeLibrarySidecarIn(vault, doc(), AT)

    const j = journal()
    expect(j).toHaveLength(1)
    expect(j[0].from).toBe('Documents/Roadmap.md')
    expect(j[0].actor).toBe('library:sidecar')
    expect(j[0].op).toBe('overwrite')
    expect(j[0].reason).toContain('Roadmap.pdf')
    expect(j[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(Number.isNaN(Date.parse(j[0].at))).toBe(false)
  })

  it('distinct source filenames that alias onto one sidecar also snapshot', () => {
    // sanitizeTitle folds whitespace, '-' and '/' to '_' — three source docs, one note.
    writeLibrarySidecarIn(vault, doc({ displayName: 'Q3 Plan.pdf', text: 'SPACES BODY' }), AT)
    writeLibrarySidecarIn(vault, doc({ displayName: 'Q3-Plan.docx', text: 'DASH BODY' }), AT)
    writeLibrarySidecarIn(vault, doc({ displayName: 'Q3/Plan', text: 'SLASH BODY' }), AT)

    expect(readFileSync(notePath('Q3_Plan'), 'utf-8')).toContain('SLASH BODY')
    const bodies = trashFiles().map(trashBody)
    expect(bodies).toHaveLength(2)
    expect(bodies.some((b) => b.includes('SPACES BODY'))).toBe(true)
    expect(bodies.some((b) => b.includes('DASH BODY'))).toBe(true)
  })

  it('does not clobber an earlier snapshot when the same note is replaced twice', () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(notePath('Roadmap'), HAND_WRITTEN_ROADMAP, 'utf-8')

    writeLibrarySidecarIn(vault, doc({ text: 'SECOND' }), AT)
    writeLibrarySidecarIn(vault, doc({ text: 'THIRD' }), AT)

    const bodies = trashFiles().map(trashBody)
    expect(bodies).toHaveLength(2)
    expect(bodies).toContain(HAND_WRITTEN_ROADMAP)
    expect(bodies.some((b) => b.includes('SECOND'))).toBe(true)
    expect(readFileSync(notePath('Roadmap'), 'utf-8')).toContain('THIRD')
  })

  it('refuses the destructive write when the prior bytes cannot be preserved', () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(notePath('Roadmap'), HAND_WRITTEN_ROADMAP, 'utf-8')
    // Make .trash un-creatable by planting a FILE where the trash DIRECTORY must go.
    writeFileSync(join(vault, TRASH_DIR_NAME), 'not a directory', 'utf-8')

    const res = writeLibrarySidecarIn(vault, doc(), AT)

    expect(res.ok).toBe(false)
    // The decisive part: proceeding blind is the one outcome that cannot be undone.
    expect(readFileSync(notePath('Roadmap'), 'utf-8')).toBe(HAND_WRITTEN_ROADMAP)
    rmSync(join(vault, TRASH_DIR_NAME), { force: true })
  })

  it('still abstains on an unconfigured vault and on a document with no extracted text', () => {
    expect(writeLibrarySidecarIn('', doc(), AT)).toMatchObject({ ok: true, written: false })
    // TOTAL extraction failure was always the safe case — keep it that way.
    expect(writeLibrarySidecarIn(vault, doc({ text: '' }), AT)).toMatchObject({
      ok: true,
      written: false
    })
    expect(existsSync(join(vault, 'Documents'))).toBe(false)
  })
})
