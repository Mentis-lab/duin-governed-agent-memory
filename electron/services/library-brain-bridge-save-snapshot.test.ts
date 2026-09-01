// Regression: artifact:saveToLibrary blind-overwrote a vault page with a bare writeFileSync.
//
// Failing scenario this locks down: the user asks the brain for a dashboard. The generated HTML is
// a body-only fragment (or a bare SVG) with no <title> and no <h1>, so ArtifactPanel's
// deriveArtifactName falls back to the literal string 'artifact' and the file lands at
// <vault>/Documents/artifact.html. They re-open it later via artifact:readVaultFile, edit it in the
// workbench, and save again. Then they generate a SECOND, unrelated artifact that also lacks
// <title>/<h1> and click "Save to Library" — which resolves the SAME path. The old
// saveHtmlToVault did existsSync-free writeFileSync: the first dashboard plus every hand edit made
// after re-opening it was gone. No .trash copy, no .bak, no journal line, and the graph node is
// derived from the file rather than a second copy of it — so nothing on disk held those bytes. The
// toast still said `Saved "artifact" to your library`, i.e. positive confirmation at the exact
// moment prior content was destroyed.
//
// The collision is wider than the fallback name: UNSAFE_TITLE_CHARS folds whitespace, '-', '/' and
// ':' all to '_', so "Q3 Plan", "Q3-Plan" and "Q3/Plan" alias onto one Q3_Plan.html too.
//
// Pattern A: the correct guard already existed (vault-trash's snapshotToTrash, whose own doc
// comment describes this precise hazard), and both sibling overwrite sites — agui-executors'
// executeWriteNote and memory-store's snapshotPriorVersion — already call it. This one call site
// skipped it.
//
// These tests fail against the pre-fix function (bare writeFileSync ⇒ empty .trash, prior HTML
// gone, no `replaced` flag). saveHtmlToVaultIn takes the vault dir as an explicit seam so no
// electron `app` / better-sqlite3 is in the import graph — the suite really executes.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveHtmlToVaultIn } from './library-brain-bridge'
import { TRASH_DIR_NAME, TOMBSTONE_JOURNAL } from './local-brain/vault-trash'

let vault: string

const FIRST_DASHBOARD =
  '<div class="grid"><h2>Revenue</h2>' +
  Array.from({ length: 60 }, (_, i) => `<div class="cell" data-row="${i}">Q3 figure ${i}</div>`).join('') +
  '</div>'
const SECOND_ARTIFACT = '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>'

const docPath = (title: string): string => join(vault, 'Documents', `${title}.html`)

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
  vault = mkdtempSync(join(tmpdir(), 'duin-vault-artifact-'))
})
afterEach(() => {
  rmSync(vault, { recursive: true, force: true })
})

describe('saveHtmlToVaultIn — preserve before overwrite', () => {
  it('snapshots the first dashboard to .trash when a second nameless artifact takes its path', () => {
    // Both artifacts lack <title>/<h1>, so ArtifactPanel derives the same fallback name.
    const first = saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)
    expect(first).toMatchObject({ ok: true, title: 'artifact' })
    expect(trashFiles()).toEqual([]) // a fresh create must not churn .trash

    const second = saveHtmlToVaultIn(vault, 'artifact', SECOND_ARTIFACT)

    expect(second.ok).toBe(true)
    // The save really happened — this is not a refuse-to-write fix.
    expect(readFileSync(docPath('artifact'), 'utf-8')).toBe(SECOND_ARTIFACT)
    // …and the first dashboard is still recoverable, byte-identical.
    const tombstones = trashFiles()
    expect(tombstones).toHaveLength(1)
    expect(trashBody(tombstones[0])).toBe(FIRST_DASHBOARD)
    // The caller is told, so the toast can stop reporting a replace as a clean create.
    expect(second.ok && second.replaced).toBe(`${TRASH_DIR_NAME}/${tombstones[0]}`)
  })

  it('preserves hand edits made after re-opening the page in the workbench', () => {
    // The read/edit round trip: save → openPageInWorkbench reads it back → user edits → save.
    saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)
    const reopened = readFileSync(docPath('artifact'), 'utf-8')
    const handEdited = reopened.replace('<h2>Revenue</h2>', '<h2>Revenue — Theo: check the Q3 cell 41 figure</h2>')
    saveHtmlToVaultIn(vault, 'artifact', handEdited)

    // An unrelated artifact now lands on the same derived path.
    saveHtmlToVaultIn(vault, 'artifact', SECOND_ARTIFACT)

    // The edited body exists ONLY in the vault file — it must be recoverable from .trash.
    const bodies = trashFiles().map(trashBody)
    expect(bodies).toContain(handEdited)
    expect(bodies.some((b) => b.includes('check the Q3 cell 41 figure'))).toBe(true)
  })

  it('journals what was replaced, from where, when and by whom', () => {
    saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)
    saveHtmlToVaultIn(vault, 'artifact', SECOND_ARTIFACT)

    const j = journal()
    expect(j).toHaveLength(1)
    expect(j[0].from).toBe('Documents/artifact.html')
    expect(j[0].actor).toBe('artifact:save-to-library')
    expect(j[0].op).toBe('overwrite')
    expect(j[0].to).toMatch(new RegExp(`^${TRASH_DIR_NAME}/`))
    expect(Number.isNaN(Date.parse(j[0].at))).toBe(false)
  })

  it('distinct human titles that alias onto one filename also snapshot', () => {
    // sanitizeTitle folds whitespace, '-' and '/' to '_' — three different titles, one file.
    expect(saveHtmlToVaultIn(vault, 'Q3 Plan', '<p>spaces</p>')).toMatchObject({ ok: true, title: 'Q3_Plan' })
    saveHtmlToVaultIn(vault, 'Q3-Plan', '<p>dash</p>')
    saveHtmlToVaultIn(vault, 'Q3/Plan', '<p>slash</p>')

    expect(readFileSync(docPath('Q3_Plan'), 'utf-8')).toBe('<p>slash</p>')
    expect(trashFiles().map(trashBody).sort()).toEqual(['<p>dash</p>', '<p>spaces</p>'])
  })

  it('does not clobber a pre-existing hand-written Documents/*.html', () => {
    mkdirSync(join(vault, 'Documents'), { recursive: true })
    writeFileSync(docPath('artifact'), '<p>hand-authored, never generated</p>', 'utf-8')

    saveHtmlToVaultIn(vault, 'artifact', SECOND_ARTIFACT)

    expect(trashFiles().map(trashBody)).toEqual(['<p>hand-authored, never generated</p>'])
  })

  it('an IDENTICAL re-save snapshots nothing — one entry per actual alteration, not per click', () => {
    saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)
    const again = saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)

    expect(again.ok).toBe(true)
    expect(again.ok && again.replaced).toBeUndefined()
    expect(trashFiles()).toEqual([])
  })

  it('does not clobber an earlier snapshot when the same page is replaced twice', () => {
    saveHtmlToVaultIn(vault, 'artifact', '<p>FIRST</p>')
    saveHtmlToVaultIn(vault, 'artifact', '<p>SECOND</p>')
    saveHtmlToVaultIn(vault, 'artifact', '<p>THIRD</p>')

    expect(trashFiles().map(trashBody).sort()).toEqual(['<p>FIRST</p>', '<p>SECOND</p>'])
    expect(readFileSync(docPath('artifact'), 'utf-8')).toBe('<p>THIRD</p>')
  })

  it('refuses the destructive write when the prior bytes cannot be preserved', () => {
    saveHtmlToVaultIn(vault, 'artifact', FIRST_DASHBOARD)
    // Make .trash un-creatable by planting a FILE where the trash DIRECTORY must go.
    writeFileSync(join(vault, TRASH_DIR_NAME), 'not a directory', 'utf-8')

    const res = saveHtmlToVaultIn(vault, 'artifact', SECOND_ARTIFACT)

    expect(res.ok).toBe(false)
    // The decisive part: proceeding blind is the one outcome that cannot be undone.
    expect(readFileSync(docPath('artifact'), 'utf-8')).toBe(FIRST_DASHBOARD)
    rmSync(join(vault, TRASH_DIR_NAME), { force: true })
  })

  it('still refuses an unconfigured vault, and traversal stays flattened inside Documents', () => {
    expect(saveHtmlToVaultIn('', 'artifact', FIRST_DASHBOARD)).toMatchObject({ ok: false })
    // sanitizeTitle folds the separators, so a traversal name becomes one flat basename
    // rather than escaping — and the write still lands under Documents/.
    const res = saveHtmlToVaultIn(vault, '../../../etc/passwd', 'x')
    expect(res).toMatchObject({ ok: true, title: '.._.._.._etc_passwd' })
    expect(res.ok && res.path).toBe(docPath('.._.._.._etc_passwd'))
    expect(existsSync(join(vault, '..', 'passwd.html'))).toBe(false)
    expect(trashFiles()).toEqual([])
  })
})
