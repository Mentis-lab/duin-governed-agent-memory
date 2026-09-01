import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, type Dirent } from 'fs'
import { join, resolve, sep } from 'path'
import { atomicWriteFileSync } from '../atomic-write'
import { sanitizeTitle } from '../library-brain-bridge'
import { parseCanvas } from './canvas-outline'

// Canvas blueprints live in the vault as real .canvas files, so they are
// editable in DUIN, indexed by the retriever, and openable by any JSON Canvas
// tool. Mirrors library-brain-bridge's HTML save: sanitized name, vault jail,
// atomic write.

export const CANVAS_SUBDIR = 'Canvases'

export type SaveCanvasResult = { ok: true; path: string; rel: string } | { ok: false; error: string }

/** Save a canvas by NAME into the vault's Canvases folder. */
export function saveCanvasToVaultIn(
  notesDir: string,
  name: string,
  json: string
): SaveCanvasResult {
  if (!notesDir) return { ok: false, error: 'No vault folder is configured' }
  // Refuse to write something that is not a canvas. A file with a .canvas
  // extension that does not parse is worse than no file: it breaks the loader,
  // the indexer and every other JSON Canvas tool that opens it.
  try {
    parseCanvas(json)
  } catch (err) {
    return { ok: false, error: `Not a valid canvas: ${(err as Error).message}` }
  }
  const title = sanitizeTitle(name) || 'Untitled'
  const dir = join(notesDir, CANVAS_SUBDIR)
  const abs = resolve(dir, `${title}.canvas`)
  const root = resolve(notesDir)
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: 'path escapes the vault' }
  }
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    atomicWriteFileSync(abs, json)
    return { ok: true, path: abs, rel: `${CANVAS_SUBDIR}/${title}.canvas` }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

/** Save a canvas back to an EXISTING vault-relative path. Distinct from
 *  saveCanvasToVaultIn, which files a NEW blueprint by name under Canvases/ —
 *  a window opened on `Projects/plan.canvas` must write back to that file, not
 *  fork a second copy under a different folder. */
export function saveCanvasAtIn(notesDir: string, rel: string, json: string): SaveCanvasResult {
  if (!notesDir) return { ok: false, error: 'No vault folder is configured' }
  if (!rel || !rel.toLowerCase().endsWith('.canvas')) {
    return { ok: false, error: 'Not a canvas path' }
  }
  try {
    parseCanvas(json)
  } catch (err) {
    return { ok: false, error: `Not a valid canvas: ${(err as Error).message}` }
  }
  const root = resolve(notesDir)
  const abs = resolve(root, rel.replace(/\\/g, '/'))
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { ok: false, error: 'path escapes the vault' }
  }
  try {
    atomicWriteFileSync(abs, json)
    return { ok: true, path: abs, rel }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
}

export interface VaultCanvas {
  name: string
  rel: string
}

/** Every .canvas in the vault, so the app can offer them without depending on
 *  an external file browser. Shallow-walked with a depth guard — a blueprint
 *  buried twelve levels deep is not a case worth a full recursive scan. */
export function listCanvasesIn(notesDir: string, maxDepth = 4): VaultCanvas[] {
  if (!notesDir || !existsSync(notesDir)) return []
  const out: VaultCanvas[] = []
  const root = resolve(notesDir)
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= 500) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (out.length >= 500) return
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        // Skip VCS/editor/app-state trees for the same reason the indexer does.
        if (e.name.startsWith('.') || e.name === 'node_modules') continue
        walk(full, depth + 1)
      } else if (e.isFile() && e.name.toLowerCase().endsWith('.canvas')) {
        const rel = full.slice(root.length + 1).replace(/\\/g, '/')
        out.push({ name: e.name.replace(/\.canvas$/i, ''), rel })
      }
    }
  }
  walk(root, 0)
  out.sort((a, b) => a.rel.localeCompare(b.rel))
  return out
}

/** Read a canvas by vault-relative path. Returns null for anything outside the
 *  vault or not a .canvas — the caller gets no way to read arbitrary files. */
export function readCanvasIn(notesDir: string, rel: string): string | null {
  if (!notesDir || !rel) return null
  if (!rel.toLowerCase().endsWith('.canvas')) return null
  const root = resolve(notesDir)
  const abs = resolve(root, rel.replace(/\\/g, '/'))
  if (abs !== root && !abs.startsWith(root + sep)) return null
  try {
    if (!existsSync(abs) || statSync(abs).isDirectory()) return null
    return readFileSync(abs, 'utf-8')
  } catch {
    return null
  }
}
