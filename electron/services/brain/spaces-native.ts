// spaces-native — TS port of server.py:list_spaces. Top-level ARENA spaces with a
// cross-type rollup (notes / decisions / people per arena) for the per-space right bar.
// Arena-first vaults only; a legacy `03 Projects` vault has no top-level arenas → [].
// Pure reads. Reuses projectDesc (identical to Python project_desc) from projects-native.
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { projectDesc } from './projects-native'
import { isArenaCandidate } from './arena-folders'

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}
const readText = (p: string): string => {
  try {
    return readFileSync(p, 'utf-8').replace(/\r\n?/g, '\n')
  } catch {
    return ''
  }
}

// Dirs never walked when counting an arena's contents (port of _DISCOVER_SKIP).
const DISCOVER_SKIP = new Set([
  '.duin', '.obsidian', '.git', '.smart-env', '.brain', '.trash', '.codex',
  'node_modules', '__pycache__', '.venv', 'dist', 'dist2', 'build', 'out',
  '_agui_outputs', '_agui_uploads', 'even-g2-companion', '99 Attachments'
])

/** Every .md under base, skipping framework/junk + dot dirs. Port of _iter_md. */
function* iterMd(base: string): Generator<string> {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (DISCOVER_SKIP.has(e.name) || e.name.startsWith('.')) continue
      yield* iterMd(join(base, e.name))
    } else if (e.name.endsWith('.md')) {
      yield join(base, e.name)
    }
  }
}

/** True if the file's frontmatter declares type/kind == value (or value in a tags line).
 *  Port of _frontmatter_is with key='type'. Reads only the head (first 1000 chars). */
function frontmatterIsType(path: string, value: string): boolean {
  let head: string
  try {
    head = readFileSync(path, 'utf-8').replace(/\r\n?/g, '\n').slice(0, 1000)
  } catch {
    return false
  }
  if (!head.startsWith('---')) return false
  const end = head.indexOf('\n---', 3)
  const fm = end !== -1 ? head.slice(0, end) : head
  const v = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') // re.escape
  if (new RegExp(`^\\s*(?:type|kind)\\s*:\\s*${v}\\b`, 'mi').test(fm)) return true
  if (new RegExp(`^\\s*tags\\s*:.*\\b${v}\\b`, 'mi').test(fm)) return true
  return false
}

export interface Space {
  name: string
  notes: number
  decisions: number
  people: number
  desc: string
}

export function listSpaces(vaultDir: string | null): Space[] {
  if (!vaultDir) return []
  const base = vaultDir
  const rows: Space[] = []
  let names: string[]
  try {
    names = readdirSync(base).sort()
  } catch {
    return rows
  }
  for (const name of names) {
    const p = join(base, name)
    if (!isDir(p) || !isArenaCandidate(name)) continue
    let notes = 0
    let decisions = 0
    let people = 0
    for (const path of iterMd(p)) {
      notes += 1
      if (frontmatterIsType(path, 'decision')) decisions += 1
      else if (frontmatterIsType(path, 'person')) people += 1
    }
    if (notes === 0) continue
    let desc = ''
    for (const hub of ['BRAIN.md', 'README.md', 'INDEX.md', '_index.md']) {
      const hp = join(p, hub)
      if (isFile(hp)) {
        desc = projectDesc(readText(hp))
        break
      }
    }
    rows.push({ name, notes, decisions, people, desc })
  }
  rows.sort((a, b) => b.notes - a.notes)
  return rows
}

export function listSpacesWrapped(vaultDir: string | null): { spaces: Space[] } {
  return { spaces: listSpaces(vaultDir) }
}
