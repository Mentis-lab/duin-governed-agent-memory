import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve, relative, sep, extname } from 'path'
import { messageOf } from './guarded'

// Filesystem-backed store of the HTML and Markdown files the assistant created.
//
// The canonical record is the files themselves under `userData/artifacts/**`.
// That tree already holds deep-research `.md` output (`artifacts/research/`);
// generated HTML/MD artifacts land in `artifacts/generated/`. We just SCAN the
// tree on demand — no manifest cache, no SQLite — so a file deleted in a file
// manager simply stops appearing. `readArtifactFile` is guarded to stay inside
// the artifacts root (path-traversal safe).

export type ArtifactFileExt = 'html' | 'md'

export interface ArtifactFileEntry {
  /** Absolute path on disk. */
  path: string
  /** Basename, e.g. `pitch-a1b2c3d4.html`. */
  name: string
  ext: ArtifactFileExt
  sizeBytes: number
  /** mtime in epoch ms — the sort key (newest first). */
  mtime: number
  /** Directory relative to the artifacts root, e.g. `generated` or `research`. */
  relDir: string
}

const EXT_MAP: Record<string, ArtifactFileExt> = {
  '.html': 'html',
  '.htm': 'html',
  '.md': 'md',
  '.markdown': 'md'
}

function rootDir(baseOverride?: string): string {
  return baseOverride ?? join(app.getPath('userData'), 'artifacts')
}

function walk(dir: string, acc: string[]): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    const full = join(dir, e.name)
    if (e.isDirectory()) walk(full, acc)
    else if (e.isFile() && extname(e.name).toLowerCase() in EXT_MAP) acc.push(full)
  }
}

/**
 * Scan the artifacts root for `.html`/`.md` files, newest first. Returns [] if
 * the directory doesn't exist yet.
 */
export function listArtifactFiles(baseOverride?: string): ArtifactFileEntry[] {
  const base = rootDir(baseOverride)
  if (!existsSync(base)) return []
  const files: string[] = []
  walk(base, files)
  const out: ArtifactFileEntry[] = []
  for (const full of files) {
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    const ext = EXT_MAP[extname(full).toLowerCase()]
    if (!ext) continue
    const rel = relative(base, full)
    const relDir = rel.includes(sep) ? rel.slice(0, rel.lastIndexOf(sep)) : ''
    out.push({
      path: full,
      name: full.slice(full.lastIndexOf(sep) + 1),
      ext,
      sizeBytes: st.size,
      mtime: st.mtimeMs,
      relDir
    })
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** True when `candidate` resolves to a location inside `base`. */
function isInside(base: string, candidate: string): boolean {
  const rel = relative(resolve(base), resolve(candidate))
  return rel !== '' && !rel.startsWith('..') && !resolve(candidate).endsWith(sep + '..')
}

/**
 * Read an artifact file by absolute path, but only if it lives inside the
 * artifacts root (path-traversal guard). Returns null on any miss.
 */
export function readArtifactFile(
  path: string,
  baseOverride?: string
): { path: string; name: string; ext: ArtifactFileExt; content: string } | null {
  const base = rootDir(baseOverride)
  if (!path || !isInside(base, path)) return null
  const ext = EXT_MAP[extname(path).toLowerCase()]
  if (!ext) return null
  if (!existsSync(path)) return null
  try {
    const content = readFileSync(path, 'utf-8')
    return { path, name: path.slice(path.lastIndexOf(sep) + 1), ext, content }
  } catch {
    return null
  }
}

function slugFor(ext: ArtifactFileExt, content: string): string {
  let title = ''
  if (ext === 'html') {
    const m =
      content.match(/<title[^>]*>([^<]+)<\/title>/i) || content.match(/<h1[^>]*>([^<]+)<\/h1>/i)
    if (m) title = m[1]
  } else {
    const m = content.match(/^\s*#\s+(.+)$/m)
    if (m) title = m[1]
  }
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || 'artifact'
}

/** Map a renderer artifact `type` to a persistable extension, or null to skip. */
export function extForArtifactType(type: string): ArtifactFileExt | null {
  const t = (type ?? '').toLowerCase()
  if (t === 'html') return 'html'
  if (t === 'md' || t === 'markdown') return 'md'
  return null
}

/**
 * Persist an assistant-authored artifact as a durable file under
 * `artifacts/generated/`. Idempotent: the filename embeds a content hash, so
 * re-opening the same artifact rewrites the same path (no duplicates). Only
 * html/md types are persisted; everything else is skipped. Never throws.
 */
export function persistArtifactFile(
  type: string,
  content: string,
  baseOverride?: string
): string | null {
  const ext = extForArtifactType(type)
  if (!ext || !content) return null
  const base = rootDir(baseOverride)
  const dir = join(base, 'generated')
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 8)
  const file = join(dir, `${slugFor(ext, content)}-${hash}.${ext}`)
  try {
    if (existsSync(file)) return file // idempotent — same content already on disk
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(file, content, 'utf-8')
    return file
  } catch (e) {
    console.debug('[artifacts-files-store] persist best-effort:', messageOf(e))
    return null
  }
}
