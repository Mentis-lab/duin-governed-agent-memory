import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  mkdirSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { join, basename, resolve, sep } from 'path'
import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { parseWorkflowScript, type WorkflowMeta } from './workflow-meta'

// Workflow library — discovers `.js` workflow scripts shipped with Lamprey
// (`resources/workflows/`) plus user-authored ones (`userData/workflows/scripts/`).
// Both directories are scanned at startup; user scripts shadow built-ins of the
// same name.
//
// B1 introduced the runner. B4 ships the library + the nested-workflow API:
// `workflow('adversarial-verify', { claim })` resolves the script and runs it
// inline within the current workflow. The 4 built-ins demonstrate canonical
// patterns described in the parity plan §4.

export interface LibraryEntry {
  /** From the script's `export const meta = { name: ... }`. */
  name: string
  /** From meta.description. */
  description: string
  /** Absolute path to the source file. */
  filePath: string
  /** Fully validated meta object. */
  meta: WorkflowMeta
  /** Raw script source — what the runner needs. */
  source: string
  /** 'builtin' for shipped scripts, 'user' for userData ones. */
  origin: 'builtin' | 'user'
}

const library = new Map<string, LibraryEntry>()
let initialised = false

function builtinDir(): string {
  if (is.dev) return join(__dirname, '../../resources/workflows')
  return join(process.resourcesPath, 'workflows')
}

function userDir(): string {
  try {
    return join(app.getPath('userData'), 'workflows', 'scripts')
  } catch {
    return ''
  }
}

function ensureDir(dir: string): void {
  if (!dir) return
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function scanDir(dir: string, origin: 'builtin' | 'user'): LibraryEntry[] {
  if (!dir || !existsSync(dir)) return []
  const entries: LibraryEntry[] = []
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.js')) continue
    const filePath = join(dir, name)
    try {
      const stats = statSync(filePath)
      if (!stats.isFile()) continue
      const source = readFileSync(filePath, 'utf-8')
      const parsed = parseWorkflowScript(source)
      entries.push({
        name: parsed.meta.name,
        description: parsed.meta.description,
        filePath,
        meta: parsed.meta,
        source,
        origin
      })
    } catch (err) {
      console.warn(`[workflow-library] failed to load ${filePath}:`, err)
    }
  }
  return entries
}

export function initializeWorkflowLibrary(): void {
  if (initialised) return
  initialised = true
  library.clear()
  const builtinEntries = scanDir(builtinDir(), 'builtin')
  for (const entry of builtinEntries) library.set(entry.name, entry)
  const u = userDir()
  ensureDir(u)
  const userEntries = scanDir(u, 'user')
  for (const entry of userEntries) library.set(entry.name, entry) // user wins
  console.log(`[workflow-library] loaded ${library.size} workflows`)
}

export function getWorkflow(name: string): LibraryEntry | null {
  if (!initialised) initializeWorkflowLibrary()
  return library.get(name) ?? null
}

export function listWorkflows(): LibraryEntry[] {
  if (!initialised) initializeWorkflowLibrary()
  return [...library.values()].sort((a, b) => a.name.localeCompare(b.name))
}

function workflowSlug(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'workflow'
  )
}

function workflowFileName(name: string): string {
  return `${workflowSlug(name)}.js`
}

// ---------------------------------------------------------------------------
// U10 — save must not silently destroy an existing workflow.
//
// saveUserWorkflow was a bare writeFileSync with no existsSync check, no
// confirm and no versioning at any layer, and MetaScaffolder hands every author
// the SAME default name ('new-workflow') while no load-for-edit path exists —
// so the second author's Save deleted the first author's script. userData/
// workflows/scripts is not in backup-runner's covered set either, so the
// destroyed file was in no backup.
// ---------------------------------------------------------------------------

/** The placeholder name workflowScaffold() seeds the editor with. Saving under it
 *  is refused: it is not a name anyone chose, and it is the collision everyone
 *  walks into. */
export const SCAFFOLD_DEFAULT_NAME = 'new-workflow'

export type WorkflowSaveErrorCode = 'conflict' | 'scaffold-name'

/** Structured so the IPC layer can tell the renderer WHICH refusal happened
 *  (prompt to overwrite vs. prompt for a name) instead of one opaque string. */
export class WorkflowSaveError extends Error {
  readonly code: WorkflowSaveErrorCode
  readonly workflowName: string
  readonly filePath?: string
  constructor(
    code: WorkflowSaveErrorCode,
    workflowName: string,
    message: string,
    filePath?: string
  ) {
    super(message)
    this.name = 'WorkflowSaveError'
    this.code = code
    this.workflowName = workflowName
    this.filePath = filePath
  }
}

/** Where a replaced/deleted script is kept. Not a `.js` entry, so scanDir skips
 *  it and a trashed copy never re-enters the library. */
function trashDir(): string {
  const dir = userDir()
  return dir ? join(dir, '.trash') : ''
}

/** Keep the version we are about to replace or remove. The directory is covered
 *  by NO backup set today (see the cross-lane note on backup-runner), so without
 *  this an overwrite/delete is unrecoverable. Best-effort: a failure here must
 *  not block the operation the user asked for. */
function keepRecoverableCopy(filePath: string): string | null {
  try {
    const dir = trashDir()
    if (!dir) return null
    ensureDir(dir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const dest = join(dir, `${basename(filePath, '.js')}.${stamp}.js`)
    copyFileSync(filePath, dest)
    return dest
  } catch (err) {
    console.warn('[workflow-library] could not keep a recoverable copy:', err)
    return null
  }
}

function readIfPresent(filePath: string): string | null {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
  } catch {
    return null
  }
}

export function validateWorkflowSource(source: string): WorkflowMeta {
  return parseWorkflowScript(source).meta
}

export function saveUserWorkflow(
  source: string,
  opts?: { overwrite?: boolean }
): LibraryEntry {
  if (!initialised) initializeWorkflowLibrary()
  const parsed = parseWorkflowScript(source)
  const name = parsed.meta.name
  if (workflowSlug(name) === SCAFFOLD_DEFAULT_NAME) {
    throw new WorkflowSaveError(
      'scaffold-name',
      name,
      `"${name}" is the scaffold placeholder — give the workflow a real name before saving.`
    )
  }
  const dir = userDir()
  ensureDir(dir)
  const filePath = join(dir, workflowFileName(name))
  const existing = readIfPresent(filePath)
  // Only a DIFFERENT body is a conflict: re-saving identical content overwrites
  // nothing and loses nothing, so blocking it would just make Save feel broken.
  if (existing !== null && existing !== source) {
    if (!opts?.overwrite) {
      throw new WorkflowSaveError(
        'conflict',
        name,
        `A workflow named "${name}" already exists. Saving would replace it.`,
        filePath
      )
    }
    keepRecoverableCopy(filePath)
  }
  writeFileSync(filePath, source, 'utf-8')
  const entry: LibraryEntry = {
    name,
    description: parsed.meta.description,
    filePath,
    meta: parsed.meta,
    source,
    origin: 'user'
  }
  library.set(entry.name, entry)
  return entry
}

export type WorkflowDeleteResult =
  | { deleted: true; filePath: string; backup: string | null }
  | { deleted: false; reason: 'not-found' | 'builtin' }

/**
 * Remove a USER-authored workflow. No delete existed at any layer before, which
 * is half of why an accidental overwrite was terminal — there was no way to
 * clean up either. Built-ins are never touched; the replaced file is kept in
 * .trash so a mis-click stays recoverable. Re-scans afterwards so a built-in the
 * deleted user script was SHADOWING comes back.
 */
export function deleteUserWorkflow(name: string): WorkflowDeleteResult {
  if (!initialised) initializeWorkflowLibrary()
  const entry = library.get(name)
  if (!entry) return { deleted: false, reason: 'not-found' }
  if (entry.origin !== 'user') return { deleted: false, reason: 'builtin' }
  const dir = userDir()
  const resolvedPath = resolve(entry.filePath)
  // Containment guard: only ever unlink inside the user scripts directory.
  if (!dir || !resolvedPath.startsWith(resolve(dir) + sep)) {
    return { deleted: false, reason: 'builtin' }
  }
  if (!existsSync(resolvedPath)) {
    library.delete(name)
    return { deleted: false, reason: 'not-found' }
  }
  const backup = keepRecoverableCopy(resolvedPath)
  unlinkSync(resolvedPath)
  // Full re-scan: dropping the map entry alone would hide a built-in of the same
  // name that this user script had been shadowing.
  initialised = false
  initializeWorkflowLibrary()
  return { deleted: true, filePath: resolvedPath, backup }
}

// Test seam — bypass disk discovery and inject entries directly.
export const __workflowLibraryTest = {
  reset(): void {
    library.clear()
    initialised = false
  },
  register(entry: LibraryEntry): void {
    library.set(entry.name, entry)
    initialised = true
  },
  builtinDir,
  userDir,
  scanDir,
  /** Synchronous helper for tests that need to confirm a resources/ file
   *  parses cleanly; bypasses the chokidar / app.getPath layers. */
  parsePath(filePath: string): LibraryEntry {
    const source = readFileSync(filePath, 'utf-8')
    const parsed = parseWorkflowScript(source)
    return {
      name: parsed.meta.name,
      description: parsed.meta.description,
      filePath: resolve(filePath),
      meta: parsed.meta,
      source,
      origin: 'builtin'
    }
  },
  builtinFileNames(): string[] {
    const dir = builtinDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.js'))
      .map((f) => basename(f))
  }
}
