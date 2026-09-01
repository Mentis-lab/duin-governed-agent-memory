import { readdirSync, readFileSync, statSync } from 'fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'

// Browsing a skill's bundled assets. skill-loader's `supportingFiles` deliberately
// stays SHALLOW because the delete/archive path keys off it and only archives what it
// lists — widening it there would make `skills:delete` destroy nested content it never
// preserved. So the browse surface is a separate read-only walk: it sees the whole
// `scripts/` + `references/` + `assets/` layout the Agent Skills convention produces,
// and touches nothing destructive.

export interface SkillFileEntry {
  /** POSIX-style path relative to the skill root; the definition itself is `SKILL.md`. */
  path: string
  size: number
  /** `text` renders inline, `image` renders as a preview, `binary` is listed only. */
  kind: 'text' | 'image' | 'binary'
}

/** Walk stops that keep a pathological skill directory from hanging the UI. */
const MAX_FILES = 500
const MAX_DEPTH = 8
/** Above this a file is reported but not returned as text — the viewer is a viewer. */
const MAX_READ_BYTES = 512 * 1024

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.DS_Store'])

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.csv', '.tsv',
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.ps1', '.bat',
  '.html', '.htm', '.css', '.xml', '.sql', '.rb', '.go', '.rs', '.java', '.c', '.h', '.cpp'
])
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'])

function classify(filePath: string): SkillFileEntry['kind'] {
  const ext = extname(filePath).toLowerCase()
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (TEXT_EXTS.has(ext)) return 'text'
  // Extensionless files (LICENSE, Makefile, a bare `run`) are overwhelmingly text.
  return ext === '' ? 'text' : 'binary'
}

/** The directory a skill's assets live in, or null for a flat `<slug>.md` skill —
 *  those have nowhere to put an asset, so they have none. */
export function skillRoot(skillFilePath: string): string | null {
  return basename(skillFilePath).toLowerCase() === 'skill.md' ? dirname(skillFilePath) : null
}

function toPosix(p: string): string {
  return p.split(sep).join('/')
}

function walk(dir: string, root: string, depth: number, out: SkillFileEntry[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries: string[]
  try {
    entries = readdirSync(dir).sort()
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    let stats: ReturnType<typeof statSync>
    try {
      stats = statSync(full)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      walk(full, root, depth + 1, out)
    } else if (stats.isFile()) {
      const rel = toPosix(relative(root, full))
      // The definition is surfaced under its canonical spelling regardless of the
      // on-disk case, so the file picker's first entry always reads `SKILL.md`.
      out.push({
        path: rel.toLowerCase() === 'skill.md' ? 'SKILL.md' : rel,
        size: stats.size,
        kind: classify(full)
      })
    }
  }
}

/** Every file bundled with a skill, definition first, then the rest alphabetically. */
export function listSkillFiles(skillFilePath: string): SkillFileEntry[] {
  const root = skillRoot(skillFilePath)
  if (!root) {
    // Flat skill: the definition is the whole skill.
    try {
      return [{ path: 'SKILL.md', size: statSync(skillFilePath).size, kind: 'text' }]
    } catch {
      return []
    }
  }
  const out: SkillFileEntry[] = []
  walk(root, root, 0, out)
  const definition = out.filter((f) => f.path === 'SKILL.md')
  const rest = out.filter((f) => f.path !== 'SKILL.md').sort((a, b) => a.path.localeCompare(b.path))
  return [...definition, ...rest]
}

export interface SkillFileContent {
  path: string
  size: number
  kind: SkillFileEntry['kind']
  /** Present for `text` files under the read cap. */
  text?: string
  /** Present for `image` files under the read cap, as a `data:` URI. */
  dataUri?: string
  /** Set when the file exists but is too large or too binary to show inline. */
  tooLarge?: boolean
}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon'
}

/** Read one bundled file. `relPath` is resolved INSIDE the skill directory — a
 *  traversal attempt (`../../id_rsa`) resolves outside the root and is refused, so a
 *  crafted skill can't turn the viewer into an arbitrary-file reader. */
export function readSkillFile(skillFilePath: string, relPath: string): SkillFileContent | null {
  const root = skillRoot(skillFilePath)
  const target =
    relPath === 'SKILL.md' && !root
      ? skillFilePath
      : root
        ? resolve(root, relPath === 'SKILL.md' ? basename(skillFilePath) : relPath)
        : null
  if (!target) return null
  if (root) {
    const base = resolve(root)
    if (target !== base && !target.startsWith(base + sep)) return null
  }

  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(target)
  } catch {
    return null
  }
  if (!stats.isFile()) return null

  const kind = relPath === 'SKILL.md' ? 'text' : classify(target)
  const meta = { path: relPath, size: stats.size, kind }
  if (stats.size > MAX_READ_BYTES) return { ...meta, tooLarge: true }

  try {
    if (kind === 'image') {
      const mime = MIME_BY_EXT[extname(target).toLowerCase()] ?? 'application/octet-stream'
      return { ...meta, dataUri: `data:${mime};base64,${readFileSync(target).toString('base64')}` }
    }
    if (kind === 'binary') return { ...meta, tooLarge: true }
    return { ...meta, text: readFileSync(target, 'utf-8') }
  } catch (err) {
    console.error('[skill-files] failed to read', target, err)
    return null
  }
}
