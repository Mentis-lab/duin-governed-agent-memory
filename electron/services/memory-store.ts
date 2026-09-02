import { app, BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync
} from 'fs'
import { basename, join, resolve } from 'path'
import chokidar, { FSWatcher } from 'chokidar'
import { getDb } from './database'
import { tombstoneToTrash, snapshotToTrash, recordCreation, recordExternalDeletion, TRASH_DIR_NAME } from './local-brain/vault-trash'
import {
  MemoryType,
  MemorySource,
  MemoryWriteInput,
  MEMORY_SOURCE_LABELS,
  isMemorySource,
  memorySlug,
  MEMORY_PROJECT_SLUG_RE,
  toMemoryProjectSlug,
  parseMemoryMarkdown,
  serializeMemoryMarkdown
} from './memory-frontmatter'

// File-backed memory store (parity Track 3, prompt D1).
//
// Memory files live at
//   userData/lamprey-memory/<projectSlug>/<slug>.md
//
// The SQLite `memory_index` table mirrors the files for typed list /
// FTS search; the files themselves are canonical, so external editors
// (and version control) can mutate the store freely. A chokidar
// watcher catches external edits and re-syncs the mirror so the next
// `listMemoryFiles()` reads up-to-date rows.
//
// The legacy renderer + tool ecosystem still hits `memory:add` /
// `memory:list` etc. with numeric ids. Those handlers fall through to
// the back-compat shims below, which write/read files under the
// `__global__` project slug with `type: project`.
//
// When the SQLite binding is unavailable (test environments where the
// native better-sqlite3 binding is built for Electron's ABI, not for
// system Node), the store falls back to an in-memory mirror keyed on
// the file `name`. The fallback mirrors only what the SQLite index
// holds; the files themselves remain canonical either way.

const DEFAULT_PROJECT_SLUG = '__global__'
const MIGRATION_MARKER = '.migrated-from-sqlite'
const MEMORY_INDEX_FILENAME = 'MEMORY.md'
const MEMORY_INDEX_MAX_LINES = 200
// `[[link-name]]` pattern — link targets are memory slugs so we accept
// the same chars `memorySlug()` emits. Spaces inside the brackets are
// tolerated and slug-normalized on resolve.
const MEMORY_LINK_RE = /\[\[([^[\]\n]+?)\]\]/g

export interface MemoryFile {
  name: string
  projectSlug: string
  description: string
  type: MemoryType
  /** Where this memory came from. `unknown` for anything written before
   *  provenance existed — never back-inferred. See memory-frontmatter.ts. */
  source: MemorySource
  body: string
  filePath: string
  sourceConversationId: string | null
  createdAt: number
  updatedAt: number
  /**
   * Set only when a `mode: 'create'` write had its slug disambiguated because the
   * requested name already belonged to a different memory. Carries the slug the
   * caller asked for, so the UI can say "saved as X, not the Y you typed" instead
   * of letting the redirect pass unremarked.
   */
  slugRedirectedFrom?: string
}

// Legacy shape preserved for the in-flight UI + IPC handlers. `id` is
// the rowid of the mirror row (or a synthesized monotonic id under the
// memory fallback) so the legacy `memory:update(id)` / `delete(id)`
// paths can still address a specific entry.
export interface LegacyMemoryEntry {
  id: number
  content: string
  createdAt: number
  updatedAt: number
  sourceConversationId?: string
  // New optional surface so callers that *can* read the typed shape
  // (post-D3 UI, tools tagged for typed memory) get the type/name
  // without forcing the legacy callers to migrate.
  name?: string
  description?: string
  type?: MemoryType
  projectSlug?: string
  filePath?: string
}

let baseDirCache: string | null = null
let watcher: FSWatcher | null = null
let initialized = false

// In-memory mirror keyed by name. Populated by scanAndSync on every
// list/read, regardless of whether the DB path is available — so the
// fallback path is always primed with the latest on-disk state.
const memoryMirror = new Map<string, MemoryFile>()
const memoryRowIds = new Map<string, number>()
let nextMemoryRowId = 1

let useFallback = false
function activateFallback(reason: string): void {
  if (!useFallback) {
    useFallback = true
    console.warn(`[memory-store] SQLite mirror unavailable, falling back to memory: ${reason}`)
  }
}

function memoryBaseDir(): string {
  if (baseDirCache) return baseDirCache
  baseDirCache = join(app.getPath('userData'), 'lamprey-memory')
  return baseDirCache
}

function projectDir(projectSlug: string): string {
  const base = memoryBaseDir()
  return join(base, projectSlug)
}

// `projectSlug` becomes a directory segment (`join(base, projectSlug)`), so an
// unsanitized value is a path-traversal vector: `..\..\..\evil` escapes the
// `lamprey-memory` sandbox and `writeFileSync` would plant an attacker-controlled
// `.md` anywhere the process can write. This was invisible because the FILENAME is
// slugged (`memorySlug()` -> [a-z0-9_]) so the write *looked* sanitized — but the
// directory segment never was, and three untrusted write surfaces reach it: the
// `memory:write` IPC, `importMemories` (crafted export JSON), and the workflow
// `memory.write` dep (model-authored JS). Every legitimate slug is `memorySlug()`
// output or DEFAULT_PROJECT_SLUG ('__global__'), all matching /^[a-z0-9_]+$/, so we
// REJECT anything else rather than re-slugging — running '__global__' through
// memorySlug() would collapse it to 'global' and orphan the default project.
// Trusted producers that speak a different slug dialect (projects-store emits
// hyphens) translate UPSTREAM via `toMemoryProjectSlug`; this stays a hard reject
// so the untrusted surfaces above are refused rather than quietly rewritten.
// The character set is defined beside memorySlug(), the only thing that can
// manufacture a conforming value, so guard and normaliser cannot drift apart.
function assertSafeProjectSlug(projectSlug: string): void {
  if (!MEMORY_PROJECT_SLUG_RE.test(projectSlug)) {
    throw new Error(
      `invalid projectSlug ${JSON.stringify(projectSlug)}: memory project slugs must match [a-z0-9_]`
    )
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function isMemoryFile(name: string): boolean {
  return name.toLowerCase().endsWith('.md') && !name.toLowerCase().startsWith('memory.')
}

function listProjectSlugs(): string[] {
  const base = memoryBaseDir()
  ensureDir(base)
  const out: string[] = []
  for (const entry of readdirSync(base)) {
    // Dot-directories are never project slugs (`memorySlug()` emits only
    // [a-z0-9_]), and `<base>/.trash` in particular holds tombstoned memory
    // files — scanning it would resurrect every deleted memory on the next
    // `scanAndSync()` and re-index it as a live entry.
    if (entry.startsWith('.')) continue
    const full = join(base, entry)
    try {
      if (statSync(full).isDirectory()) out.push(entry)
    } catch {
      // ignore dangling entries
    }
  }
  if (out.length === 0) {
    ensureDir(projectDir(DEFAULT_PROJECT_SLUG))
    out.push(DEFAULT_PROJECT_SLUG)
  }
  return out
}

function parseFile(filePath: string, projectSlug: string): MemoryFile | null {
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const fallbackName = basename(filePath, '.md')
    const parsed = parseMemoryMarkdown(raw, fallbackName)
    const stats = statSync(filePath)
    return {
      name: parsed.name,
      projectSlug,
      description: parsed.description,
      type: parsed.type,
      source: parsed.source,
      body: parsed.body,
      filePath,
      sourceConversationId: null,
      createdAt: Math.floor(stats.birthtimeMs || stats.ctimeMs || Date.now()),
      updatedAt: Math.floor(stats.mtimeMs || Date.now())
    }
  } catch (err) {
    console.error('[memory-store] failed to parse file', filePath, err)
    return null
  }
}

function rememberRowId(name: string): number {
  let id = memoryRowIds.get(name)
  if (id !== undefined) return id
  id = nextMemoryRowId++
  memoryRowIds.set(name, id)
  return id
}

function upsertIndexRow(file: MemoryFile): void {
  memoryMirror.set(file.name, file)
  rememberRowId(file.name)
  if (useFallback) return
  try {
    const db = getDb()
    db.prepare(
      `INSERT INTO memory_index
         (name, project_slug, type, source, description, body, source_conversation_id,
          file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         project_slug = excluded.project_slug,
         type         = excluded.type,
         source       = excluded.source,
         description  = excluded.description,
         body         = excluded.body,
         file_path    = excluded.file_path,
         updated_at   = excluded.updated_at`
    ).run(
      file.name,
      file.projectSlug,
      file.type,
      isMemorySource(file.source) ? file.source : 'unknown',
      file.description,
      file.body,
      file.sourceConversationId,
      file.filePath,
      file.createdAt,
      file.updatedAt
    )
  } catch (err) {
    activateFallback((err as Error)?.message ?? 'unknown')
  }
}

function deleteIndexRowByName(name: string): void {
  memoryMirror.delete(name)
  memoryRowIds.delete(name)
  if (useFallback) return
  try {
    const db = getDb()
    db.prepare('DELETE FROM memory_index WHERE name = ?').run(name)
  } catch (err) {
    activateFallback((err as Error)?.message ?? 'unknown')
  }
}

/** Paths the store itself just moved into `.trash` (softDeleteMemoryFile). chokidar reports that rename as
 *  an `unlink` too; the entry tells noteExternalUnlink that the journal line already exists. Consumed on the
 *  matching unlink, so it holds at most the deletes still in flight. */
const selfDeleted = new Set<string>()

/** The watcher's `unlink` handler (exported on __memoryStoreTest). A file removed OUTSIDE the app — Explorer,
 *  `rm`, a sync client — used to reach the store only as a dropped index row. The app's own delete journals a
 *  tombstone that moat-durability's boot rehydrate honors; an external delete journaled nothing, so the vault
 *  mirror's copy came back on the next launch. Journal it the same way, minus the bytes there are none of. */
function noteExternalUnlink(filePath: string): void {
  const resolved = resolve(filePath)
  if (!selfDeleted.delete(resolved) && !existsSync(resolved)) {
    recordExternalDeletion(memoryBaseDir(), resolved, 'memory-store', 'external-unlink')
  }
  deleteIndexRowByFilePath(resolved)
  broadcastChange()
}

function deleteIndexRowByFilePath(filePath: string): void {
  const resolved = resolve(filePath)
  for (const [name, file] of memoryMirror) {
    if (file.filePath === resolved) {
      memoryMirror.delete(name)
      memoryRowIds.delete(name)
      break
    }
  }
  if (useFallback) return
  try {
    const db = getDb()
    db.prepare('DELETE FROM memory_index WHERE file_path = ?').run(resolved)
  } catch (err) {
    activateFallback((err as Error)?.message ?? 'unknown')
  }
}

/**
 * Adopt `.md` files written at the memory ROOT into the default project.
 *
 * The store's path contract is `<base>/<projectSlug>/<name>.md`, and `scanAndSync` honors it by
 * walking `listProjectSlugs()` — which returns DIRECTORIES only. A file written straight to
 * `<base>` therefore matches no project and is never scanned, never indexed, never retrievable.
 * It is not an error state anyone can see: the file is on disk, looks filed, and is invisible
 * forever. Measured 2026-07-30: `lark-cli-default.md`, a real operator preference, had been
 * sitting at the root since 07-29 while `memory_index` held 2 rows.
 *
 * Adopting (moving) rather than indexing in place is deliberate. `writeMemoryFile` always derives
 * its path as `join(projectDir(slug), <slug>.md)` and never consults an existing record, so
 * indexing a root file where it lies would leave TWO paths for one memory name: the next edit
 * would write the project copy while the root copy kept being scanned, and the mirror is keyed by
 * name. One contract, honored, beats two contracts that disagree.
 *
 * Never clobbers: a name that already exists in the default project is left alone and reported,
 * because silently overwriting one of the operator's two memories would be worse than the bug.
 */
/** The index key a memory file claims — frontmatter `name`, else the basename. Null if unreadable. */
function nameOf(filePath: string): string | null {
  try {
    return parseMemoryMarkdown(readFileSync(filePath, 'utf-8'), basename(filePath, '.md')).name
  } catch {
    return null
  }
}

/** Every index key already claimed inside `dir`. Small directory; read fresh so it cannot go stale. */
function namesIn(dir: string): Set<string> {
  const out = new Set<string>()
  try {
    for (const f of readdirSync(dir)) {
      if (!isMemoryFile(f)) continue
      const n = nameOf(join(dir, f))
      if (n) out.add(n)
    }
  } catch {
    /* unreadable dir → no claims we can prove; the existsSync check still applies */
  }
  return out
}

function adoptRootLevelMemories(): void {
  const base = memoryBaseDir()
  ensureDir(base)
  let entries: string[]
  try {
    entries = readdirSync(base)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith('.') || !isMemoryFile(entry)) continue
    const full = join(base, entry)
    try {
      if (!statSync(full).isFile()) continue
      const destDir = projectDir(DEFAULT_PROJECT_SLUG)
      ensureDir(destDir)
      const dest = join(destDir, entry)
      // Collide on the INDEX KEY, not on the filename.
      //
      // The index and the in-memory mirror are keyed on `MemoryFile.name` — frontmatter `name`,
      // falling back to the basename — so two different FILENAMES can be one memory. Checking only
      // `existsSync(dest)` let a root-level `my-pref.md` whose frontmatter says `my_pref` land
      // beside an existing `my_pref.md`; `scanAndSync` then indexed both, whichever `readdirSync`
      // returned last won the key, and the other memory silently vanished from the index while its
      // file sat on disk. That turned "invisible" into "shadows something real" — strictly worse
      // than the bug being fixed, and exactly what this guard claims to prevent.
      const claimed = nameOf(full)
      const taken = claimed ? namesIn(destDir) : null
      if (existsSync(dest) || (claimed && taken?.has(claimed))) {
        console.warn(
          `[memory-store] root-level memory ${full} cannot be adopted: the name "${claimed ?? entry}" ` +
            `is already taken in ${DEFAULT_PROJECT_SLUG}/. Left in place (still unindexed) rather ` +
            'than shadowing the existing memory.'
        )
        continue
      }
      renameSync(full, dest)
      console.log(`[memory-store] adopted root-level memory ${entry} into ${DEFAULT_PROJECT_SLUG}/`)
    } catch (err) {
      console.warn(`[memory-store] failed to adopt root-level memory ${entry}:`, (err as Error)?.message)
    }
  }
}

function scanAndSync(): void {
  const seen = new Set<string>()
  // Before honoring the path contract, rescue anything written outside it.
  adoptRootLevelMemories()
  for (const slug of listProjectSlugs()) {
    const dir = projectDir(slug)
    ensureDir(dir)
    for (const entry of readdirSync(dir)) {
      if (!isMemoryFile(entry)) continue
      const full = join(dir, entry)
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (!stats.isFile()) continue
      const file = parseFile(full, slug)
      if (!file) continue
      file.filePath = resolve(full)
      upsertIndexRow(file)
      seen.add(file.name)
    }
  }

  // Drop INDEXED entries whose backing file is gone.
  //
  // This used to diff against `memoryMirror`, a process-local Map that starts EMPTY on
  // every launch and is filled by this very scan moments earlier. So it could only ever
  // notice a deletion that happened while this process was running — a file deleted
  // between sessions was re-seen as "not in the mirror either", matched nothing, and its
  // memory_index row survived forever. The durable index is the thing that can be stale
  // across a restart, so the durable index is what has to be diffed.
  const indexed = new Set<string>([...memoryMirror.keys(), ...indexedNamesFromDb()])
  const stale: string[] = []
  for (const name of indexed) {
    if (!seen.has(name)) stale.push(name)
  }
  for (const name of stale) deleteIndexRowByName(name)
}

/** Names currently carried by the durable index. Empty on the fallback path (there is
 *  no DB to be stale) and on any read failure — a sweep that cannot read the index must
 *  delete nothing rather than guess. */
function indexedNamesFromDb(): string[] {
  if (useFallback) return []
  try {
    const rows = getDb().prepare('SELECT name FROM memory_index').all() as Array<{ name: string }>
    return rows.map((r) => r.name).filter((n) => typeof n === 'string')
  } catch (err) {
    console.warn('[memory-store] could not read the index for the stale sweep:', (err as Error)?.message)
    return []
  }
}

function broadcastChange(): void {
  // The memory index is regenerated as part of the broadcast so a single
  // write touches both the renderer cache and the on-disk MEMORY.md
  // (which the system-prompt builder pulls on every chat turn).
  try {
    regenerateMemoryIndexAllProjects()
  } catch (err) {
    console.error('[memory-store] index regen failed:', (err as Error).message)
  }
  const list = listMemoryFiles()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('memory:changed', list)
  }
}

// ───────────────────────────────────────────────────────────────────────
// D2 — MEMORY.md always-loaded index + [[link]] graph
// ───────────────────────────────────────────────────────────────────────

function memoryIndexPath(projectSlug: string = DEFAULT_PROJECT_SLUG): string {
  return join(projectDir(projectSlug), MEMORY_INDEX_FILENAME)
}

function indexLineFor(file: MemoryFile): string {
  // Mirror the format used in the user's hand-authored MEMORY.md
  // (CLAUDE.md memory section):
  //   - [Title](slug.md) — one-line hook
  // Falls back to the slug when no description is present so the user
  // still gets a clickable file pointer.
  //
  // PROVENANCE rides on the line, because this index IS the <memory_index> block
  // injected every turn. A model that cannot tell "the operator told me this" from
  // "I concluded this myself" has to treat both as equally certain, which is how a
  // guess gets repeated back as a fact. Marking it inline is deliberately not a
  // setting: a provenance filter nobody switches on protects nobody, whereas a
  // labelled line is always in front of the model. 'unknown' is left unmarked —
  // most memories predate the field, and tagging them all would be noise that
  // devalues the marks that carry information.
  const fileName = `${file.name}.md`
  const title = file.description?.trim() || file.name
  const hook = file.description?.trim() || `${file.type} memory`
  const mark = file.source && file.source !== 'unknown' ? ` _(${MEMORY_SOURCE_LABELS[file.source]})_` : ''
  return `- [${title}](${fileName}) — ${hook}${mark}`
}

/**
 * Write `MEMORY.md` for a single project. The file is a 1-line-per-entry
 * index of every memory in that project, capped at MEMORY_INDEX_MAX_LINES
 * (matches the system-prompt truncation so the on-disk index and the
 * injected `<memory_index>` block stay consistent).
 */
export function regenerateMemoryIndex(
  projectSlug: string = DEFAULT_PROJECT_SLUG
): string {
  const dir = projectDir(projectSlug)
  ensureDir(dir)
  // Don't fire scanAndSync here — broadcastChange's callers already drove
  // a write/delete that populated the in-memory mirror, and re-scanning
  // would pull *this* MEMORY.md (it's filtered by isMemoryFile, so
  // actually it can't — but skipping the scan keeps regen cheap).
  const files = listFromMirror({ projectSlug })
  // Stable sort: type first (so user/feedback/project/reference group
  // visually), then by description/name. This keeps the index diff-stable
  // across small edits.
  files.sort((a, b) => {
    if (a.type !== b.type) return a.type.localeCompare(b.type)
    const left = (a.description || a.name).toLowerCase()
    const right = (b.description || b.name).toLowerCase()
    return left.localeCompare(right)
  })
  const lines = files.slice(0, MEMORY_INDEX_MAX_LINES).map(indexLineFor)
  const truncated = files.length > MEMORY_INDEX_MAX_LINES
  const body =
    lines.length === 0
      ? '# Memory index\n\n_(no memories yet)_\n'
      : `# Memory index\n\n${lines.join('\n')}\n${
          truncated ? `\n_(+ ${files.length - MEMORY_INDEX_MAX_LINES} more)_\n` : ''
        }`
  const path = memoryIndexPath(projectSlug)
  writeFileSync(path, body, 'utf-8')
  return body
}

function regenerateMemoryIndexAllProjects(): void {
  // Collect slugs from both the mirror and the FS so a project that
  // has no entries left (everything deleted) still gets its MEMORY.md
  // collapsed back to the empty-state placeholder.
  const slugs = new Set<string>([DEFAULT_PROJECT_SLUG])
  for (const file of memoryMirror.values()) slugs.add(file.projectSlug)
  for (const slug of listProjectSlugs()) slugs.add(slug)
  for (const slug of slugs) {
    try {
      regenerateMemoryIndex(slug)
    } catch (err) {
      console.error(
        `[memory-store] regenerate MEMORY.md failed for ${slug}:`,
        (err as Error).message
      )
    }
  }
}

/**
 * Read the on-disk MEMORY.md for a project, returning the raw text.
 * Returns an empty string when no index exists yet. The system-prompt
 * builder calls this on every chat turn to inject the `<memory_index>`
 * block.
 */
export function loadMemoryIndex(
  projectSlug: string = DEFAULT_PROJECT_SLUG
): string {
  const path = memoryIndexPath(projectSlug)
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf-8')
  } catch (err) {
    console.error('[memory-store] loadMemoryIndex failed:', (err as Error).message)
    return ''
  }
}

/**
 * Build the `<memory_index>` system-prompt block for a project. Returns
 * an empty string when the index would be empty so chat.ts can skip the
 * block entirely (rather than emit a noisy empty tag).
 */
export function buildMemoryIndexBlock(
  projectSlug: string = DEFAULT_PROJECT_SLUG
): string {
  const raw = loadMemoryIndex(projectSlug)
  const trimmed = raw.trim()
  if (!trimmed || /\(no memories yet\)/i.test(trimmed)) return ''
  // Cap the injected payload at MEMORY_INDEX_MAX_LINES so a corrupted /
  // unexpectedly long MEMORY.md (e.g. user pasted notes) can't blow up
  // the prompt budget.
  const lines = trimmed.split('\n').slice(0, MEMORY_INDEX_MAX_LINES + 4) // header + spacer + lines
  return `<memory_index>\n${lines.join('\n')}\n</memory_index>`
}

export interface BrokenMemoryLink {
  from: string
  fromFilePath: string
  target: string
}

function extractLinks(body: string): string[] {
  const out = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = MEMORY_LINK_RE.exec(body)) !== null) {
    const cleaned = m[1].trim()
    if (cleaned) out.add(cleaned)
  }
  return [...out]
}

/**
 * Scan every memory body for `[[link-name]]` markers and return the
 * ones whose target slug has no matching file. D3's MemoryLinkGraph
 * surfaces these as "to-write" pips so the user can convert a casual
 * cross-reference into a real entry.
 */
export function getBrokenMemoryLinks(
  projectSlug: string = DEFAULT_PROJECT_SLUG
): BrokenMemoryLink[] {
  scanAndSync()
  const files = listFromMirror({ projectSlug })
  const knownSlugs = new Set(files.map((f) => f.name))
  const out: BrokenMemoryLink[] = []
  for (const file of files) {
    for (const raw of extractLinks(file.body)) {
      const target = memorySlug(raw)
      if (target === file.name) continue
      if (knownSlugs.has(target)) continue
      out.push({ from: file.name, fromFilePath: file.filePath, target })
    }
  }
  return out
}

function migrateLegacyEntries(): void {
  const base = memoryBaseDir()
  const markerPath = join(base, MIGRATION_MARKER)
  if (existsSync(markerPath)) return

  let rows: { id: number; content: string; created_at: number; updated_at: number; source_conversation_id: string | null }[] = []
  try {
    const db = getDb()
    rows = db.prepare(
      'SELECT id, content, created_at, updated_at, source_conversation_id FROM memory_entries ORDER BY id ASC'
    ).all() as any
  } catch (err) {
    // No legacy table available — either a fresh install or test env
    // without the SQLite binding. Either way, mark migration as done
    // so we don't keep trying on every boot.
    console.warn('[memory-store] legacy migration skipped:', (err as Error).message)
  }

  const targetDir = projectDir(DEFAULT_PROJECT_SLUG)
  ensureDir(targetDir)

  for (const row of rows) {
    const firstLine = (row.content.split('\n')[0] || '').trim()
    const baseName = firstLine ? memorySlug(firstLine) : `migrated_${row.id}`
    const fileName = `${baseName}__${row.id}`
    const filePath = join(targetDir, `${fileName}.md`)
    if (existsSync(filePath)) continue
    const description = firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine
    const markdown = serializeMemoryMarkdown({
      name: fileName,
      description,
      type: 'project',
      body: row.content
    })
    try {
      writeFileSync(filePath, markdown, 'utf-8')
    } catch (err) {
      console.error('[memory-store] migrate write failed', filePath, err)
    }
  }

  try {
    writeFileSync(markerPath, new Date().toISOString(), 'utf-8')
  } catch (err) {
    console.error('[memory-store] failed to write migration marker', err)
  }
}

export function initializeMemoryStore(): void {
  if (initialized) return
  initialized = true

  const base = memoryBaseDir()
  ensureDir(base)
  ensureDir(projectDir(DEFAULT_PROJECT_SLUG))

  migrateLegacyEntries()
  scanAndSync()

  watcher = chokidar.watch(base, {
    ignoreInitial: true,
    persistent: true,
    ignored: (p) => basename(p).startsWith('.'),
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
  })

  const onAddOrChange = (filePath: string) => {
    if (!isMemoryFile(basename(filePath))) return
    const slug = guessProjectSlugFromPath(filePath)
    if (!slug) return
    const file = parseFile(filePath, slug)
    if (!file) return
    file.filePath = resolve(filePath)
    upsertIndexRow(file)
    broadcastChange()
  }

  const onUnlink = (filePath: string) => {
    if (!isMemoryFile(basename(filePath))) return
    noteExternalUnlink(filePath)
  }

  watcher.on('add', onAddOrChange)
  watcher.on('change', onAddOrChange)
  watcher.on('unlink', onUnlink)
  watcher.on('error', (err) => console.error('[memory-store] watcher error:', err))

  console.log(`[memory-store] watching ${base}`)
}

export function shutdownMemoryStore(): void {
  if (watcher) {
    watcher.close().catch(() => {})
    watcher = null
  }
  initialized = false
}

function guessProjectSlugFromPath(filePath: string): string | null {
  const base = memoryBaseDir()
  const rel = resolve(filePath).slice(resolve(base).length).replace(/^[\\/]+/, '')
  const parts = rel.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2) return null
  return parts[0]
}

// ───────────────────────────────────────────────────────────────────────
// Typed file-backed API (new in D1)
// ───────────────────────────────────────────────────────────────────────

function rowToMemoryFile(row: any): MemoryFile {
  return {
    name: row.name,
    projectSlug: row.project_slug,
    description: row.description,
    type: row.type,
    // A row from a DB migrated before v45 landed has no column value yet.
    source: isMemorySource(row.source) ? row.source : 'unknown',
    body: row.body,
    filePath: row.file_path,
    sourceConversationId: row.source_conversation_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export interface MemoryListFilter {
  type?: MemoryType
  projectSlug?: string
  /** Restrict to these provenances. Omitted → every source, matching prior behavior.
   *  An EMPTY array means "no source qualifies" and returns nothing — it is a real
   *  filter the caller built, not an absent one, so it must not silently widen. */
  sources?: readonly MemorySource[]
}

function listFromMirror(filter?: MemoryListFilter): MemoryFile[] {
  const out: MemoryFile[] = []
  for (const file of memoryMirror.values()) {
    if (filter?.type && file.type !== filter.type) continue
    if (filter?.projectSlug && file.projectSlug !== filter.projectSlug) continue
    if (filter?.sources && !filter.sources.includes(file.source)) continue
    out.push({ ...file })
  }
  return out.sort((a, b) => (b.updatedAt - a.updatedAt) || a.name.localeCompare(b.name))
}

export function listMemoryFiles(filter?: MemoryListFilter): MemoryFile[] {
  // Re-scan on each list so external edits show up even if chokidar
  // hasn't fired yet (tests bypass the watcher; production code calls
  // are still in the microsecond range because the dir is small).
  scanAndSync()
  if (useFallback) return listFromMirror(filter)
  try {
    const db = getDb()
    const where: string[] = []
    const params: any[] = []
    if (filter?.type) {
      where.push('type = ?')
      params.push(filter.type)
    }
    if (filter?.projectSlug) {
      where.push('project_slug = ?')
      params.push(filter.projectSlug)
    }
    if (filter?.sources) {
      // Empty array → `IN ()` is a syntax error, and `1=0` is the honest reading:
      // the caller restricted to nothing, so nothing matches.
      if (filter.sources.length === 0) where.push('1 = 0')
      else {
        where.push(`source IN (${filter.sources.map(() => '?').join(',')})`)
        params.push(...filter.sources)
      }
    }
    const sql =
      'SELECT * FROM memory_index' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY updated_at DESC, name ASC'
    return (db.prepare(sql).all(...params) as any[]).map(rowToMemoryFile)
  } catch (err) {
    activateFallback((err as Error)?.message ?? 'unknown')
    return listFromMirror(filter)
  }
}

export function readMemoryFile(name: string): MemoryFile | null {
  scanAndSync()
  if (useFallback) {
    const found = memoryMirror.get(name)
    return found ? { ...found } : null
  }
  try {
    const db = getDb()
    const row = db.prepare('SELECT * FROM memory_index WHERE name = ?').get(name) as any
    return row ? rowToMemoryFile(row) : null
  } catch (err) {
    activateFallback((err as Error)?.message ?? 'unknown')
    const found = memoryMirror.get(name)
    return found ? { ...found } : null
  }
}

/**
 * Preserve the bytes this write is about to replace.
 *
 * `writeMemoryFile` is a blind `writeFileSync` over a path that usually already exists,
 * and memory `.md` files are the source of truth — `scanAndSync()` reads files INTO the
 * SQLite index, never the reverse, and nothing regenerates a body the user hand-authored
 * in the Memory panel editor. The delete path was already routed through the vault-trash
 * primitive so a removal is recoverable; the overwrite path is the sibling call site that
 * skipped it, and an overwrite destroys the prior content exactly as permanently.
 *
 * That gap is load-bearing for the consolidate-memory workflow, which merges entries by
 * REWRITING one under an existing name and deleting the others. Its own safety comment
 * claims a misjudged merge is reversible because the deletes are soft — but the merge
 * target itself was being overwritten with no copy, so the hand-written body it replaced
 * was the one thing the trash could not give back.
 *
 * Content-addressed on purpose: identical rewrites (an editor save with no edits, a
 * re-scan, an idempotent workflow re-run) snapshot nothing, so `.trash` accumulates one
 * entry per *actual* alteration rather than one per save.
 *
 * If the snapshot fails we still write. Refusing would strand the user's edit, and the
 * live file is not the copy at risk here — this is a best-effort audit trail, and the
 * failure is surfaced rather than swallowed.
 */
function snapshotPriorVersion(filePath: string, nextMarkdown: string, reason: string): void {
  if (!existsSync(filePath)) return
  try {
    if (readFileSync(filePath, 'utf-8') === nextMarkdown) return
  } catch {
    // Unreadable prior content is exactly the case worth preserving — fall through.
  }
  const result = snapshotToTrash(memoryBaseDir(), filePath, 'memory-store', reason)
  if (!result.ok) {
    console.error('[memory-store] prior-version snapshot failed before overwrite', filePath, result.error)
  }
}

/**
 * First free `<slug>.md` in `dir`, suffixing `_2`, `_3`, … past anything taken.
 *
 * Extracted from `pickAutoName` (which now calls it) because the typed create path
 * needed the same guarantee: the legacy `memory:add` entrypoint has always refused
 * to land on an occupied slug, and there was no reason the typed one should not.
 * Checks the mirror as well as the filesystem so a name held only in the in-memory
 * fallback still counts as taken.
 */
function uniqueMemorySlug(dir: string, slug: string): string {
  let candidate = slug
  let suffix = 1
  while (memoryMirror.has(candidate) || existsSync(join(dir, `${candidate}.md`))) {
    suffix += 1
    candidate = `${slug}_${suffix}`
  }
  return candidate
}

/**
 * `mode` distinguishes "save this entry" from "make me a new entry".
 *
 * `'overwrite'` (the default, and the only prior behaviour) targets the slug by name:
 * the editor's in-place save, and the consolidate workflow's deliberate rewrite of a
 * merge target, both MEAN to land on an existing file. Their prior bytes are snapshotted
 * by `snapshotPriorVersion`, so that replacement is recorded and recoverable.
 *
 * `'create'` says the caller believes no such entry exists yet. It cannot verify that
 * itself — `memorySlug` lives in the electron layer and the renderer cannot reproduce it,
 * so a free-text name typed into the New-memory form ("Feedback: no coauthor trailer!")
 * silently resolved onto an unrelated existing file's slug and replaced it wholesale.
 * Two distinct names sharing a 60-char prefix collided the same way, since `memorySlug`
 * truncates at SLUG_MAX. Under `'create'` the slug is disambiguated instead, so both
 * memories survive and the caller is told via `slugRedirectedFrom`.
 */
export type MemoryWriteMode = 'create' | 'overwrite'

export function writeMemoryFile(input: MemoryWriteInput & {
  projectSlug?: string
  sourceConversationId?: string | null
  mode?: MemoryWriteMode
}): MemoryFile {
  const projectSlug = input.projectSlug?.trim() || DEFAULT_PROJECT_SLUG
  // Guard the traversal vector at the single write choke point — all three
  // untrusted surfaces (memory:write IPC, importMemories, workflow memory.write)
  // funnel through here before the directory segment reaches the filesystem.
  assertSafeProjectSlug(projectSlug)
  const dir = projectDir(projectSlug)
  ensureDir(dir)

  const requestedSlug = memorySlug(input.name)
  const slug = input.mode === 'create' ? uniqueMemorySlug(dir, requestedSlug) : requestedSlug
  const redirectedFrom = slug === requestedSlug ? undefined : requestedSlug
  if (redirectedFrom) {
    console.warn(
      `[memory-store] create requested "${input.name}" -> slug "${redirectedFrom}", ` +
        `which is taken; saved as "${slug}" so the existing memory is left intact`
    )
  }
  const finalName = slug
  const filePath = join(dir, `${slug}.md`)
  // Provenance the caller declared. Absent → 'unknown': the write paths that
  // genuinely know their origin pass it, and inventing one for the rest would
  // put a confident lie in the column that exists to prevent exactly that.
  const source: MemorySource = isMemorySource(input.source) ? input.source : 'unknown'
  const markdown = serializeMemoryMarkdown({
    name: finalName,
    description: input.description ?? '',
    type: input.type,
    source,
    body: input.body
  })
  // A memory created under a name that was DELETED earlier has to supersede that delete in the
  // tombstone journal: moat-durability's boot rehydrate reads the journal to decide which
  // vault-projected memories the user threw away, and a stale delete line would keep this
  // re-creation from ever being restored on a reinstall. Only a genuine create needs the line — an
  // edit lands on a path that already exists, which no delete line can be claiming.
  const isNewFile = !existsSync(filePath)
  snapshotPriorVersion(filePath, markdown, `memory:overwrite ${finalName}`)
  writeFileSync(filePath, markdown, 'utf-8')
  if (isNewFile) recordCreation(memoryBaseDir(), filePath, 'memory-store')

  const stats = statSync(filePath)
  const file: MemoryFile = {
    name: finalName,
    projectSlug,
    description: (input.description ?? '').trim(),
    type: input.type,
    source,
    body: input.body.trim(),
    filePath: resolve(filePath),
    sourceConversationId: input.sourceConversationId ?? null,
    createdAt: Math.floor(stats.birthtimeMs || stats.ctimeMs || Date.now()),
    updatedAt: Math.floor(stats.mtimeMs || Date.now())
  }
  upsertIndexRow(file)
  broadcastChange()
  // Not persisted to the index row — it describes THIS call, not the entry.
  return redirectedFrom ? { ...file, slugRedirectedFrom: redirectedFrom } : file
}

/**
 * Soft-delete a memory file into `<lamprey-memory>/.trash`, mirroring the vault-note
 * delete path. Memory files are hand-authored via the Memory panel editor and nothing
 * regenerates them, so an `unlinkSync` here is unrecoverable — there is no snapshot,
 * no `.bak`, and the SQLite index row is dropped in the same breath. The tombstone
 * journal records what was removed, from where, when and by whom.
 *
 * Never throws: a failed soft-delete leaves the bytes on disk, which is the safe side.
 */
function softDeleteMemoryFile(filePath: string, reason: string): void {
  if (!existsSync(filePath)) return
  selfDeleted.add(resolve(filePath)) // the watcher's unlink for this rename must not journal a second delete
  const result = tombstoneToTrash(memoryBaseDir(), filePath, 'memory-store', reason)
  if (!result.ok) {
    selfDeleted.delete(resolve(filePath)) // the file stayed put, so no unlink is coming
    console.error('[memory-store] soft-delete failed, leaving file in place', filePath, result.error)
  }
}

export function deleteMemoryFile(name: string): boolean {
  const existing = memoryMirror.get(name)
  if (!existing) {
    // Fall through to DB lookup for the edge case where the mirror is
    // out of sync (e.g. the watcher hasn't picked up an external edit).
    if (!useFallback) {
      try {
        const db = getDb()
        const row = db.prepare('SELECT file_path FROM memory_index WHERE name = ?').get(name) as
          | { file_path: string }
          | undefined
        if (!row) return false
        softDeleteMemoryFile(row.file_path, `memory:delete ${name}`)
        deleteIndexRowByName(name)
        broadcastChange()
        return true
      } catch (err) {
        activateFallback((err as Error)?.message ?? 'unknown')
      }
    }
    return false
  }
  softDeleteMemoryFile(existing.filePath, `memory:delete ${name}`)
  deleteIndexRowByName(name)
  broadcastChange()
  return true
}

export function searchMemoryFiles(query: string, limit = 50): MemoryFile[] {
  const q = query.trim()
  if (!q) return []
  scanAndSync()

  const fallbackSearch = (): MemoryFile[] => {
    const lc = q.toLowerCase()
    const out: MemoryFile[] = []
    for (const file of memoryMirror.values()) {
      const hay = `${file.name}\n${file.description}\n${file.body}`.toLowerCase()
      if (hay.includes(lc)) out.push({ ...file })
    }
    return out
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  }

  if (useFallback) return fallbackSearch()

  try {
    const db = getDb()
    const rows = db
      .prepare(
        `SELECT memory_index.*
         FROM memory_index_fts
         JOIN memory_index ON memory_index.rowid = memory_index_fts.rowid
         WHERE memory_index_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(q, limit) as any[]
    return rows.map(rowToMemoryFile)
  } catch (err) {
    console.warn('[memory-store] FTS query failed, falling back:', (err as Error).message)
    if (!useFallback) activateFallback((err as Error)?.message ?? 'unknown')
    return fallbackSearch()
  }
}

// ───────────────────────────────────────────────────────────────────────
// Legacy back-compat surface (preserves the pre-D1 IPC contract)
// ───────────────────────────────────────────────────────────────────────
//
// D3 rebuilds the renderer panel and stops calling these. Until then,
// the legacy MemoryPanel keeps working: each legacy memory becomes a
// file with `type: project` and an auto-generated name. The numeric
// `id` exposed to the renderer is the rowid of the mirror row (or a
// synthesized monotonic id under the memory fallback) so update /
// delete by id still target a specific file.

function pickAutoName(content: string, projectSlug: string): string {
  const firstLine = (content.split('\n')[0] || '').trim()
  const slug = firstLine ? memorySlug(firstLine) : 'memory'
  return uniqueMemorySlug(projectDir(projectSlug), slug)
}

function fileToLegacyEntry(file: MemoryFile): LegacyMemoryEntry {
  return {
    id: rememberRowId(file.name),
    content: file.body,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    sourceConversationId: file.sourceConversationId ?? undefined,
    name: file.name,
    description: file.description,
    type: file.type,
    projectSlug: file.projectSlug,
    filePath: file.filePath
  }
}

export function listMemories(): LegacyMemoryEntry[] {
  const files = listMemoryFiles()
  return files
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(fileToLegacyEntry)
}

export function addMemory(
  content: string,
  sourceConversationId?: string,
  projectSlug?: string
): LegacyMemoryEntry {
  // The only producer that passes `projectSlug` (chat.ts's `memory_add` branch) reads it
  // off the PROJECT ROW, and projects-store slugs are hyphen-separated — a dialect the
  // memory guard rejects. Translate at this seam so the hyphen never reaches
  // assertSafeProjectSlug, which then still guards an already-normalised value.
  // `toMemoryProjectSlug` returns '' for blank input, preserving the old default.
  const slug = toMemoryProjectSlug(projectSlug ?? '') || DEFAULT_PROJECT_SLUG
  const name = pickAutoName(content, slug)
  const description = (content.split('\n')[0] || '').trim().slice(0, 120)
  const file = writeMemoryFile({
    name,
    description,
    type: 'project',
    // This path exists to capture something out of a running conversation — the
    // provenance is structural, not guessed.
    source: 'session',
    body: content,
    sourceConversationId: sourceConversationId ?? null,
    projectSlug: slug
  })
  return fileToLegacyEntry(file)
}

function findFileByLegacyId(id: number): MemoryFile | null {
  for (const [name, rowId] of memoryRowIds) {
    if (rowId === id) {
      const file = memoryMirror.get(name)
      if (file) return file
    }
  }
  return null
}

export function updateMemory(id: number, content: string): LegacyMemoryEntry | null {
  const existing = findFileByLegacyId(id)
  if (!existing) return null
  const description = (content.split('\n')[0] || '').trim().slice(0, 120)
  const updated = writeMemoryFile({
    name: existing.name,
    description: description || existing.description,
    type: existing.type,
    // Rewriting a memory's body does not change where the memory came from.
    source: existing.source,
    body: content,
    projectSlug: existing.projectSlug,
    sourceConversationId: existing.sourceConversationId ?? null
  })
  return fileToLegacyEntry(updated)
}

export function deleteMemory(id: number): void {
  const existing = findFileByLegacyId(id)
  if (!existing) return
  deleteMemoryFile(existing.name)
}

export function clearAllMemories(): void {
  const files = listMemoryFiles()
  for (const file of files) {
    // Behind a UI confirm, but still hand-authored content — tombstone it so
    // "clear all" is recoverable from `<lamprey-memory>/.trash` too.
    softDeleteMemoryFile(file.filePath, 'memory:clearAll')
  }
  memoryMirror.clear()
  memoryRowIds.clear()
  if (!useFallback) {
    try {
      const db = getDb()
      db.prepare('DELETE FROM memory_index').run()
    } catch (err) {
      activateFallback((err as Error)?.message ?? 'unknown')
    }
  }
  broadcastChange()
}

export interface ExportEntry {
  name: string
  description: string
  type: MemoryType
  /** Optional so an export produced before provenance existed still imports. */
  source?: MemorySource
  projectSlug: string
  body: string
  createdAt: number
  updatedAt: number
}

export function exportMemories(): string {
  const files = listMemoryFiles()
  const out: ExportEntry[] = files.map((f) => ({
    name: f.name,
    description: f.description,
    type: f.type,
    source: f.source,
    projectSlug: f.projectSlug,
    body: f.body,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt
  }))
  return JSON.stringify(out, null, 2)
}

export function importMemories(
  entries:
    | ExportEntry[]
    | { content: string; sourceConversationId?: string | null }[]
): void {
  for (const raw of entries) {
    if ((raw as ExportEntry).body !== undefined && (raw as ExportEntry).name) {
      const entry = raw as ExportEntry
      writeMemoryFile({
        name: entry.name,
        description: entry.description ?? '',
        type: entry.type ?? 'project',
        // Round-trip: an export that carries provenance keeps it. Re-stamping a
        // restored backup as 'imported' would erase the operator's real history
        // on every export/import cycle. Only genuinely provenance-less entries
        // are labelled by how they arrived.
        source: isMemorySource(entry.source) ? entry.source : 'imported',
        body: entry.body,
        projectSlug: entry.projectSlug ?? DEFAULT_PROJECT_SLUG
      })
    } else if ((raw as { content: string }).content !== undefined) {
      const legacy = raw as { content: string; sourceConversationId?: string | null }
      addMemory(legacy.content, legacy.sourceConversationId ?? undefined)
    }
  }
}

// Old single `<memory>` block consumed by the system-prompt builder.
// D2 will introduce the `<memory_index>` block alongside this; for now
// we render the body of every memory file in stable order so the
// existing chat path keeps surfacing the same content.
export function buildMemoryBlock(): string {
  const entries = listMemories()
  if (entries.length === 0) return ''
  const lines = entries.map((e, i) => `${i + 1}. ${e.content}`)
  return `<memory>\n${lines.join('\n')}\n</memory>`
}

// Test hook — lets unit tests force re-init against a stubbed userData
// directory without leaking watchers between cases.
export const __memoryStoreTest = {
  resetForTests: (): void => {
    if (watcher) {
      watcher.close().catch(() => {})
      watcher = null
    }
    initialized = false
    baseDirCache = null
    memoryMirror.clear()
    memoryRowIds.clear()
    nextMemoryRowId = 1
    useFallback = false
    selfDeleted.clear()
  },
  forceFallback: (): void => {
    useFallback = true
  },
  isUsingFallback: (): boolean => useFallback,
  memoryBaseDir,
  memoryTrashDir: (): string => join(memoryBaseDir(), TRASH_DIR_NAME),
  noteExternalUnlink,
  projectDir,
  scanAndSync,
  DEFAULT_PROJECT_SLUG
}
