import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { readSettings } from './settings-helper'
import { snapshotToTrash } from './local-brain/vault-trash'
import type { DocumentReadyInfo } from './rag/ingest'

// P1 — library → brain bridge. When a document finishes ingesting into the RAG
// library (lamprey.db), write its extracted text as a markdown SIDECAR NOTE into
// the vault. The existing brain reindex/watcher then turns that note into a
// graph node — so a dropped PDF/Office/iWork file shows up in the brain graph,
// searchable next to the user's notes. This is the additive "documents → memory
// nodes" bridge (decision #6 option a): vault stays markdown-truth, no risky
// cross-DB merge. Best-effort — the caller never fails ingest on a bridge error.

const DOCS_SUBDIR = 'Documents'

// Whitespace + filesystem-illegal chars + dash. Dash is placed LAST (literal),
// and whitespace is `\s` (not a bare space in a range) to avoid the `[ -x]`
// range-misparse that silently dropped spaces.
const UNSAFE_TITLE_CHARS = /[\s\\/:*?"<>|-]+/g

/** Filename-safe title from a display name (drops extension + illegal chars). */
export function sanitizeTitle(name: string): string {
  return (
    name
      .replace(/\.[^.\\/]+$/, '') // drop trailing extension
      .replace(UNSAFE_TITLE_CHARS, '_')
      .replace(/^_+|_+$/g, '') // trim leading/trailing underscores
      .slice(0, 120) || 'document'
  )
}

/** Strip a single leading YAML frontmatter block, so a sidecar we write doesn't
 *  nest the officeParser-emitted frontmatter under our own. */
export function stripLeadingFrontmatter(text: string): string {
  const m = /^\ufeff?---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return m ? text.slice(m[0].length) : text
}

/** Build the sidecar note content (frontmatter + heading + body). Pure — unit-tested. */
export function buildSidecar(
  doc: DocumentReadyInfo,
  todayIso: string
): { title: string; content: string } | null {
  const body = stripLeadingFrontmatter((doc.text ?? '').trim()).trim()
  if (!body) return null
  const title = sanitizeTitle(doc.displayName)
  const source = doc.sourcePath ? doc.sourcePath.replace(/\\/g, '/') : doc.displayName
  const fm = [
    '---',
    'type: document',
    `title: ${JSON.stringify(title)}`,
    `source: ${JSON.stringify(source)}`,
    `doc_id: ${doc.documentId}`,
    `mime: ${doc.mime}`,
    `ingested: ${todayIso}`,
    'tags: [document, library]',
    '---'
  ].join('\n')
  return { title, content: `${fm}\n\n# ${title}\n\n${body}\n` }
}

export type SaveHtmlResult =
  | { ok: true; path: string; title: string; replaced?: string }
  | { ok: false; error: string }

/** Save raw HTML into `<vault>/Documents/<title>.html` — a first-class "page"
 *  surface. The notes watcher/reindex turns it into a `page` graph node (indexed
 *  on its rendered text via loaders/html.ts), while the raw file stays on disk so
 *  it re-opens in the artifact workbench. Sandboxed to the notes dir.
 *
 *  PRESERVE before overwriting. The target path is derived, not chosen: ArtifactPanel's
 *  deriveArtifactName falls back to the literal 'artifact' whenever the HTML has no
 *  <title> and no <h1> — the common shape of a generated dashboard or a bare SVG — and
 *  sanitizeTitle then folds whitespace, '-', '/' and ':' all to '_' and truncates at 120,
 *  so "Q3 Plan", "Q3-Plan" and "Q3/Plan" alias onto one file too. Two unrelated Save to
 *  Library clicks therefore resolve to the SAME path, and the old bare writeFileSync
 *  replaced the first artifact's bytes in place while the toast reported a plain success.
 *  That is not a rebuildable cache: brain-shell's openPageInWorkbench reads this file back
 *  through artifact:readVaultFile and re-opens it in the workbench, where the source and
 *  visual editors write through into the very state Save to Library persists — so hand
 *  edits made after re-opening exist ONLY here. Nothing else on disk holds them: the graph
 *  node is derived, moat-backup does not cover vault files, and there was no .bak, no
 *  .trash copy and no journal line.
 *
 *  So route the pre-existing bytes through the SAME .trash primitive the sibling writers
 *  use — snapshotToTrash copies rather than renames, leaving the original in place for the
 *  write, and journals what was replaced, from where, when and by whom. The guard already
 *  existed (vault-trash.ts:81; agui-executors' executeWriteNote and memory-store's
 *  snapshotPriorVersion both call it before their own overwrites); this call site was the
 *  one skipping it. Preserve+record rather than refuse-to-write, because re-saving an
 *  artifact you re-opened and edited is a legitimate in-place update — it just has to be
 *  recoverable. Content-addressed, so an unchanged re-save snapshots nothing and .trash
 *  gets one entry per ACTUAL alteration. Creating a new page is untouched.
 *
 *  If the snapshot FAILS we do not write: the live bytes are the thing at risk, and
 *  proceeding blind is the one outcome that cannot be undone. */
export function saveHtmlToVaultIn(notesDir: string, name: string, html: string): SaveHtmlResult {
  if (!notesDir) return { ok: false, error: 'No vault/library folder is configured' }
  const title = sanitizeTitle(name)
  const dir = join(notesDir, DOCS_SUBDIR)
  const abs = resolve(dir, `${title}.html`)
  if (abs !== resolve(notesDir) && !abs.startsWith(resolve(notesDir) + sep))
    return { ok: false, error: 'path escapes the vault' }
  let replaced: string | undefined
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    let prior: string | null = null
    try {
      prior = readFileSync(abs, 'utf-8')
    } catch {
      // Unreadable prior content is exactly the case worth preserving — fall through and snapshot.
    }
    if (prior !== html) {
      const s = snapshotToTrash(
        notesDir,
        abs,
        'artifact:save-to-library',
        `overwritten by Save to Library of ${title}.html`
      )
      if (!s.ok) return { ok: false, error: `the existing page could not be preserved: ${s.error}` }
      replaced = s.trashRel
    }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(abs, html, 'utf-8')
  return { ok: true, path: abs, title, ...(replaced ? { replaced } : {}) }
}

/** Settings-reading wrapper — the seam above takes the vault dir explicitly so it is
 *  testable without electron's `app`. */
export function saveHtmlToVault(name: string, html: string): SaveHtmlResult {
  return saveHtmlToVaultIn((readSettings().localBrainNotesDir as string) || '', name, html)
}

/** Read a vault file by its graph-node relpath (e.g. `Documents/Deck.html`),
 *  sandboxed to the notes dir. Returns the raw content, or null if missing/outside.
 *  Used to re-open a `page` node's raw HTML in the artifact workbench. */
export function readVaultFile(relpath: string): string | null {
  const notesDir = (readSettings().localBrainNotesDir as string) || ''
  if (!notesDir) return null
  const abs = resolve(notesDir, relpath)
  if (abs !== resolve(notesDir) && !abs.startsWith(resolve(notesDir) + sep)) return null
  try {
    return readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
}

export type SidecarResult =
  | { ok: true; written: false; skipped: string }
  | { ok: true; written: true; path: string; title: string; replaced?: string }
  | { ok: false; error: string }

/** Write the sidecar into `<vault>/Documents/<title>.md`. Best-effort, sandboxed
 *  to the notes dir. No-op when no vault is configured or the doc has no text.
 *
 *  PRESERVE before overwriting — the same hazard, and the same fix, as saveHtmlToVaultIn
 *  above. The target path is DERIVED from the dropped file's name, never chosen by the
 *  user, and sanitizeTitle folds whitespace, '-', '/', ':' and '*?"<>|' all to '_' before
 *  truncating at 120 — so `Roadmap.pdf` lands on `Documents/Roadmap.md`, and 'Q3 Plan.pdf',
 *  'Q3-Plan.docx' and 'Q3/Plan' all alias onto one Documents/Q3_Plan.md. Two things get
 *  destroyed by the old bare writeFileSync:
 *
 *    1. A hand-written vault note that happens to share the derived stem. Dragging
 *       Roadmap.pdf into the RAG Library replaced the user's wikilinked Roadmap.md in
 *       place with the PDF's extracted text under `type: document` frontmatter.
 *    2. Deterministically, on EVERY re-ingest: any annotation the user added to a sidecar
 *       we wrote earlier. That one needs no filename coincidence at all.
 *
 *  Neither is a rebuildable cache. moat-backup does not cover vault files (see the comment
 *  block on saveHtmlToVaultIn), the graph node is derived from the file rather than a second
 *  copy of it, and there was no .bak, no .trash copy and no journal line — the write only
 *  logged when writeFileSync THREW, never when it silently replaced.
 *
 *  Pattern B: a TOTAL extraction failure was already safe (buildSidecar returns null on
 *  empty text and we abstain), while a CORRECT, fully-populated extraction landing on a
 *  colliding name was the one that destroyed. The guarded case was the harmless one.
 *
 *  So route the prior bytes through the SAME .trash primitive the sibling writers use —
 *  snapshotToTrash copies rather than renames, leaving the original in place for the write,
 *  and journals what was replaced, from where, when and by whom. Preserve+record+stamp
 *  rather than refuse-to-write: a re-ingest legitimately refreshes the extracted body, it
 *  just has to be recoverable. Content-addressed, so an unchanged re-ingest snapshots
 *  nothing and writes nothing. If the snapshot FAILS we do not write — the live bytes are
 *  the thing at risk, and proceeding blind is the one outcome that cannot be undone. */
export function writeLibrarySidecarIn(
  notesDir: string,
  doc: DocumentReadyInfo,
  now: Date = new Date()
): SidecarResult {
  if (!notesDir) return { ok: true, written: false, skipped: 'no vault configured' }
  const built = buildSidecar(doc, now.toISOString().slice(0, 10))
  if (!built) return { ok: true, written: false, skipped: 'document has no extracted text' }
  const dir = join(notesDir, DOCS_SUBDIR)
  const abs = resolve(dir, `${built.title}.md`)
  // Sandbox: never escape the notes dir.
  if (abs !== resolve(notesDir) && !abs.startsWith(resolve(notesDir) + sep))
    return { ok: false, error: 'path escapes the vault' }
  let replaced: string | undefined
  try {
    if (existsSync(abs) && !statSync(abs).isDirectory()) {
      let prior: string | null = null
      try {
        prior = readFileSync(abs, 'utf-8')
      } catch {
        // Unreadable prior content is exactly the case worth preserving — fall through and snapshot.
      }
      if (prior === built.content)
        return { ok: true, written: false, skipped: 'sidecar already up to date' }
      const s = snapshotToTrash(
        notesDir,
        abs,
        'library:sidecar',
        `overwritten by library ingest of ${doc.displayName} (doc ${doc.documentId})`
      )
      if (!s.ok) return { ok: false, error: `the existing note could not be preserved: ${s.error}` }
      replaced = s.trashRel
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(abs, built.content, 'utf-8')
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? 'sidecar write failed' }
  }
  return { ok: true, written: true, path: abs, title: built.title, ...(replaced ? { replaced } : {}) }
}

/** Settings-reading wrapper — the seam above takes the vault dir explicitly so it is
 *  testable without electron's `app`. Best-effort: the caller never fails ingest on a
 *  bridge error, but a refused write is logged loudly because it means a vault note is
 *  sitting there unpreserved. */
export function writeLibrarySidecar(doc: DocumentReadyInfo, now: Date = new Date()): void {
  const res = writeLibrarySidecarIn((readSettings().localBrainNotesDir as string) || '', doc, now)
  if (!res.ok) console.warn('[library-brain-bridge] sidecar write failed:', res.error)
  else if (res.written && res.replaced)
    console.warn(
      `[library-brain-bridge] sidecar replaced an existing note ${res.path} — prior content preserved at ${res.replaced}`
    )
}
