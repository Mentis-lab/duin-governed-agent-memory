// doc-native — TS port of server.py:read_doc + resolve_wikilink (the doc viewer). read_doc
// returns raw file content for a vault-relative path (traversal-safe, allowed extensions).
// resolve_wikilink finds the .md whose basename matches an Obsidian [[link]] target. Pure reads.
import { readFileSync, readdirSync, statSync } from 'fs'
import { normalize, join, sep } from 'path'
import { isVaultWalkDir } from './vault-dirs'

const ALLOWED = ['.md', '.py', '.ps1', '.json', '.jsonl', '.txt', '.tmpl', '.csv', '.yaml', '.yml']
// A [[wikilink]] resolve descends only into real vault-content dirs (isVaultWalkDir —
// the SAME rule the graph + method walkers use, so a resolve can never land in a dir
// the graph excluded, e.g. `.duin/_eval-fixtures/` snapshot vaults shadowing a note).
// Templates are additionally non-linkable (methods/notes never target a raw template).
const TEMPLATE_DIR = '07 Templates'

/** Validate a vault-relative path → absolute inside the vault, allowed ext, no traversal. */
function docAbspath(vaultDir: string, rel: string): string | null {
  let r = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (r.startsWith('vault:')) r = r.slice('vault:'.length).replace(/^\/+/, '')
  const base = normalize(vaultDir)
  const full = normalize(join(base, r))
  if (!(full === base || full.startsWith(base + sep))) return null
  if (!ALLOWED.some((e) => full.toLowerCase().endsWith(e))) return null
  return full
}

export function readDoc(vaultDir: string | null, rel: string): string | null {
  if (!vaultDir) return null
  const full = docAbspath(vaultDir, rel)
  if (!full) return null
  try {
    if (!statSync(full).isFile()) return null
  } catch {
    return null
  }
  try {
    return readFileSync(full, 'utf-8').replace(/\r\n?/g, '\n') // Python text-mode universal newlines
  } catch {
    return null
  }
}

/** Find the .md whose basename matches a [[link]] target → vault-relative path, or null. */
export function resolveWikilink(vaultDir: string | null, name: string): string | null {
  if (!vaultDir || !name) return null
  let target = name.split('|')[0].split('#')[0].split('/').pop()!.trim()
  if (target.toLowerCase().endsWith('.md')) target = target.slice(0, -3)
  target = target.toLowerCase()
  if (!target) return null
  const base = normalize(vaultDir)

  // os.walk top-down: this dir's files (in listing order) first, then recurse.
  const walk = (rel: string): string | null => {
    let entries: import('fs').Dirent[]
    try {
      entries = readdirSync(join(base, rel), { withFileTypes: true })
    } catch {
      return null
    }
    const subdirs: string[] = []
    for (const e of entries) {
      if (e.isDirectory()) {
        if (isVaultWalkDir(e.name) && e.name !== TEMPLATE_DIR) subdirs.push(e.name)
      } else if (e.name.endsWith('.md') && e.name.slice(0, -3).toLowerCase() === target) {
        return (rel ? `${rel}/${e.name}` : e.name).replace(/\\/g, '/')
      }
    }
    for (const sd of subdirs) {
      const hit = walk(rel ? `${rel}/${sd}` : sd)
      if (hit !== null) return hit
    }
    return null
  }
  return walk('')
}

/** Handler-shaped wrappers (mirror the Python route bodies: 200 payload or 404 {error}). */
export function docResponse(vaultDir: string | null, rel: string): { ok: boolean; body: unknown } {
  const content = readDoc(vaultDir, rel)
  return content === null ? { ok: false, body: { error: 'not found' } } : { ok: true, body: { path: rel, content } }
}
export function resolveResponse(vaultDir: string | null, name: string): { ok: boolean; body: unknown } {
  const path = resolveWikilink(vaultDir, name)
  return path === null ? { ok: false, body: { error: 'unresolved' } } : { ok: true, body: { path } }
}
