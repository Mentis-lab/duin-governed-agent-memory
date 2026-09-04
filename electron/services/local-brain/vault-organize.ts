// vault-organize — the operator's hand on the vault's shape: rename a note, move it, rename a
// folder, create a folder or a note. Everything here is confined to the connected notes folder,
// refuses the machine's own subtrees (.brain, .duin, .trash), never clobbers, preserves any
// note it rewrites to <vault>/.trash first (the same discipline as /state/doc/save), and
// journals every act to <vault>/.duin/_state/organize-journal.jsonl so a rename is a recorded
// operator decision, not an unexplained diff.
//
// Links follow the file. A note is addressed by `[[wikilinks]]` on its basename (and, less
// often, its path) and by markdown links on its path; graph-derive resolves the same way. A
// rename without rewriting those silently breaks the graph, so rename rewrites them across the
// vault, and move / folder-rename rewrite the path forms that a move breaks.
//
// Pure with respect to Electron: takes `vaultDir` explicitly, so the node test suite proves the
// contract on a temp vault. The routes in brain-native-routes-2.ts supply the dir and the
// re-index.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, appendFileSync, type Dirent } from 'fs'
import { basename, dirname, extname, join, normalize, sep } from 'path'
import { recordCreation, snapshotToTrash } from './vault-trash'

/** Note-ish extensions the doc routes accept; mirrors server.ts DOC_EXTS. */
export const NOTE_EXTS = ['.md', '.markdown', '.txt', '.canvas', '.json', '.jsonl', '.csv', '.yaml', '.yml']
/** Files whose links are rewritten. Only markdown carries wikilinks. */
const LINK_EXTS = new Set(['.md', '.markdown'])
/** Subtrees the operator's hand never reaches through this module: the brain's own state, the
 *  harness trees, the recovery layer, and version control. */
const PROTECTED_TOP = new Set(['.brain', '.duin', '.trash', '.git', '.obsidian', 'node_modules'])
export const ORGANIZE_JOURNAL_REL = '.duin/_state/organize-journal.jsonl'

export type OrganizeResult<T> = ({ ok: true } & T) | { ok: false; error: string }

export interface LinkRewriteSummary {
  /** Link occurrences rewritten. */
  linksUpdated: number
  /** Notes whose bytes changed. */
  notesTouched: number
}

const toPosix = (p: string): string => p.replace(/\\/g, '/')

/** Vault-relative, forward-slash form of an absolute path inside the vault. */
export function vaultRel(vaultDir: string, abs: string): string {
  const root = normalize(vaultDir)
  const full = normalize(abs)
  const rel = full === root ? '' : full.startsWith(root + sep) ? full.slice(root.length + 1) : full
  return toPosix(rel)
}

/** Reject a name that cannot be a file or folder name on any platform, or that would hide the
 *  item from the vault (a leading dot). */
export function sanitizeName(raw: string): OrganizeResult<{ name: string }> {
  const name = (raw ?? '').trim()
  if (!name) return { ok: false, error: 'a name is required' }
  if (name.length > 200) return { ok: false, error: 'that name is too long' }
  if (/[\\/:*?"<>|]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 32)) return { ok: false, error: 'a name cannot contain \\ / : * ? " < > |' }
  if (name.startsWith('.')) return { ok: false, error: 'a name cannot start with a dot' }
  if (name.endsWith('.') || name.endsWith(' ')) return { ok: false, error: 'a name cannot end with a dot or a space' }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name.replace(/\.[^.]*$/, ''))) return { ok: false, error: 'that name is reserved by the operating system' }
  return { ok: true, name }
}

/** Resolve a vault-relative path to an absolute one inside the vault, refusing traversal and
 *  the protected subtrees. `kind` says what the caller expects to find there. */
export function resolveVaultPath(
  vaultDir: string,
  rel: string,
  kind: 'file' | 'dir'
): OrganizeResult<{ abs: string; rel: string }> {
  if (!vaultDir) return { ok: false, error: 'no brain folder is set' }
  let r = toPosix(rel ?? '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (r.startsWith('vault:')) r = r.slice('vault:'.length).replace(/^\/+/, '')
  if (kind === 'file' && !r) return { ok: false, error: 'a path is required' }
  const segments = r.split('/').filter(Boolean)
  if (segments.some((s) => s === '..' || s === '.')) return { ok: false, error: 'invalid path' }
  if (segments.length > 0 && (PROTECTED_TOP.has(segments[0].toLowerCase()) || segments.some((s) => s.startsWith('.')))) {
    return { ok: false, error: 'that folder belongs to the machine, not the vault' }
  }
  const root = normalize(vaultDir)
  const abs = normalize(join(root, ...segments))
  if (abs !== root && !abs.startsWith(root + sep)) return { ok: false, error: 'invalid path' }
  if (kind === 'file' && !NOTE_EXTS.some((e) => abs.toLowerCase().endsWith(e))) return { ok: false, error: 'not a note' }
  return { ok: true, abs, rel: segments.join('/') }
}

function stripExt(rel: string): string {
  const ext = extname(rel)
  return ext ? rel.slice(0, -ext.length) : rel
}

/** Rewrite `[text](target)` links whose decoded target `map` maps to a new one. A target that
 *  was percent-encoded (Obsidian writes `%20`) is written back encoded. */
function rewriteMdLinks(text: string, map: (target: string) => string | null, onHit: () => void): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (whole, raw: string) => {
    let decoded = raw
    try {
      decoded = decodeURI(raw)
    } catch {
      /* a malformed percent-escape is left as it was */
    }
    const target = toPosix(decoded).replace(/^\.\//, '')
    const mapped = map(target)
    if (mapped === null) return whole
    onHit()
    return `](${decoded !== raw ? encodeURI(mapped) : mapped})`
  })
}

/**
 * Rewrite every link that addresses `oldRel` so it addresses `newRel` instead.
 *  - `[[Name]]`, `[[Name|alias]]`, `[[Name#heading]]`, `[[Name#heading|alias]]`: the basename
 *    form, matched case-insensitively (graph-derive resolves basenames that way). Rewritten only
 *    when the basename actually changes, so a move never touches basename links.
 *  - `[[folder/Name]]` (with or without the extension): the path form.
 *  - `[Text](folder/Name.md)` and `[Text](./folder/Name.md)`: markdown links on the exact path.
 * `[[Older]]` and `[[Name-2]]` are left alone: the match is the whole target, not a prefix.
 */
export function rewriteLinks(text: string, oldRel: string, newRel: string): { text: string; count: number } {
  const oldPath = toPosix(oldRel)
  const newPath = toPosix(newRel)
  const oldBase = stripExt(basename(oldPath))
  const newBase = stripExt(basename(newPath))
  const oldPathNoExt = stripExt(oldPath)
  const newPathNoExt = stripExt(newPath)
  const baseChanged = oldBase.toLowerCase() !== newBase.toLowerCase()
  let count = 0

  const mapTarget = (target: string): string | null => {
    const t = toPosix(target).replace(/^\.\//, '')
    const tl = t.toLowerCase()
    if (baseChanged && tl === oldBase.toLowerCase()) return newBase
    if (tl === oldPathNoExt.toLowerCase()) return newPathNoExt
    if (tl === oldPath.toLowerCase()) return newPath
    return null
  }

  const wiki = text.replace(/\[\[([^\]\n]+?)\]\]/g, (whole, inner: string) => {
    const pipe = inner.indexOf('|')
    const head = pipe >= 0 ? inner.slice(0, pipe) : inner
    const tail = pipe >= 0 ? inner.slice(pipe) : ''
    const hash = head.indexOf('#')
    const target = hash >= 0 ? head.slice(0, hash) : head
    const section = hash >= 0 ? head.slice(hash) : ''
    const mapped = mapTarget(target.trim())
    if (mapped === null) return whole
    count++
    return `[[${mapped}${section}${tail}]]`
  })

  const md = rewriteMdLinks(wiki, (t) => {
    const tl = t.toLowerCase()
    if (tl === oldPath.toLowerCase()) return newPath
    if (baseChanged && !t.includes('/') && tl === (oldBase + extname(oldPath)).toLowerCase()) return basename(newPath)
    return null
  }, () => count++)

  return { text: md, count }
}

/** Every markdown note in the vault the operator can reach: the same tree the graph reads,
 *  minus the machine's and the recovery layer's subtrees. */
export function collectNoteFiles(vaultDir: string): string[] {
  const out: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 24) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || PROTECTED_TOP.has(e.name.toLowerCase())) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.isFile() && LINK_EXTS.has(extname(e.name).toLowerCase())) out.push(p)
    }
  }
  walk(vaultDir, 0)
  return out
}

/** Rewrite links across the vault, preserving each changed note to .trash first. */
function rewriteAcrossVault(vaultDir: string, oldRel: string, newRel: string, actor: string): LinkRewriteSummary {
  let linksUpdated = 0
  let notesTouched = 0
  for (const abs of collectNoteFiles(vaultDir)) {
    let text: string
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('[[') && !text.includes('](')) continue
    const r = rewriteLinks(text, oldRel, newRel)
    if (r.count === 0 || r.text === text) continue
    const snap = snapshotToTrash(vaultDir, abs, actor, 'link-rewrite')
    if (!snap.ok) continue // never rewrite a note whose prior bytes could not be preserved
    writeFileSync(abs, r.text, 'utf8')
    linksUpdated += r.count
    notesTouched++
  }
  return { linksUpdated, notesTouched }
}

export interface OrganizeJournalEntry {
  at: string
  actor: string
  op: 'rename' | 'move' | 'rename-folder' | 'create-folder' | 'create'
  from?: string
  to: string
  linksUpdated?: number
  notesTouched?: number
}

/** Append one operator act. Never throws; the act already happened. */
export function appendOrganizeJournal(vaultDir: string, entry: Omit<OrganizeJournalEntry, 'at'>): void {
  try {
    const p = join(vaultDir, ...ORGANIZE_JOURNAL_REL.split('/'))
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
  } catch {
    /* the rename is on disk; a missing journal line must not undo it */
  }
}

function occupied(abs: string): boolean {
  // existsSync is case-insensitive on Windows and macOS default volumes, which is the right
  // answer for "would this rename collide" on those systems; on Linux an exact-case check is
  // the only one the filesystem itself makes.
  return existsSync(abs)
}

/** Rename a note in place (same folder). `newName` may omit the extension; the old one is kept. */
export function renameNote(
  vaultDir: string,
  rel: string,
  newName: string,
  opts: { actor: string; updateLinks?: boolean }
): OrganizeResult<{ path: string } & LinkRewriteSummary> {
  const src = resolveVaultPath(vaultDir, rel, 'file')
  if (!src.ok) return src
  if (!existsSync(src.abs) || !statSync(src.abs).isFile()) return { ok: false, error: 'note not found' }
  const name = sanitizeName(newName)
  if (!name.ok) return name
  const oldExt = extname(src.abs)
  const givenExt = extname(name.name)
  const finalName = NOTE_EXTS.includes(givenExt.toLowerCase()) ? name.name : name.name + oldExt
  const abs = join(dirname(src.abs), finalName)
  const newRel = vaultRel(vaultDir, abs)
  if (newRel === src.rel) return { ok: true, path: src.rel, linksUpdated: 0, notesTouched: 0 }
  if (newRel.toLowerCase() !== src.rel.toLowerCase() && occupied(abs)) return { ok: false, error: 'a note with that name already exists here' }
  renameSync(src.abs, abs)
  const links = opts.updateLinks === false ? { linksUpdated: 0, notesTouched: 0 } : rewriteAcrossVault(vaultDir, src.rel, newRel, opts.actor)
  appendOrganizeJournal(vaultDir, { actor: opts.actor, op: 'rename', from: src.rel, to: newRel, ...links })
  return { ok: true, path: newRel, ...links }
}

/** Move a note into another folder ('' = the vault root). The folder is created if missing. */
export function moveNote(
  vaultDir: string,
  rel: string,
  toFolder: string,
  opts: { actor: string }
): OrganizeResult<{ path: string } & LinkRewriteSummary> {
  const src = resolveVaultPath(vaultDir, rel, 'file')
  if (!src.ok) return src
  if (!existsSync(src.abs) || !statSync(src.abs).isFile()) return { ok: false, error: 'note not found' }
  const dst = resolveVaultPath(vaultDir, toFolder, 'dir')
  if (!dst.ok) return dst
  if (existsSync(dst.abs) && !statSync(dst.abs).isDirectory()) return { ok: false, error: 'that is not a folder' }
  const abs = join(dst.abs, basename(src.abs))
  const newRel = vaultRel(vaultDir, abs)
  if (newRel === src.rel) return { ok: true, path: src.rel, linksUpdated: 0, notesTouched: 0 }
  if (occupied(abs)) return { ok: false, error: 'a note with that name already exists in that folder' }
  mkdirSync(dst.abs, { recursive: true })
  renameSync(src.abs, abs)
  const links = rewriteAcrossVault(vaultDir, src.rel, newRel, opts.actor)
  appendOrganizeJournal(vaultDir, { actor: opts.actor, op: 'move', from: src.rel, to: newRel, ...links })
  return { ok: true, path: newRel, ...links }
}

/** Rename a folder in place. Basename links keep resolving on their own; the path forms that
 *  named the old folder are rewritten. */
export function renameFolder(
  vaultDir: string,
  rel: string,
  newName: string,
  opts: { actor: string }
): OrganizeResult<{ path: string; notesMoved: number } & LinkRewriteSummary> {
  const src = resolveVaultPath(vaultDir, rel, 'dir')
  if (!src.ok) return src
  if (!src.rel) return { ok: false, error: 'the vault root cannot be renamed' }
  if (!existsSync(src.abs) || !statSync(src.abs).isDirectory()) return { ok: false, error: 'folder not found' }
  const name = sanitizeName(newName)
  if (!name.ok) return name
  const abs = join(dirname(src.abs), name.name)
  const newRel = vaultRel(vaultDir, abs)
  if (newRel === src.rel) return { ok: true, path: src.rel, notesMoved: 0, linksUpdated: 0, notesTouched: 0 }
  if (newRel.toLowerCase() !== src.rel.toLowerCase() && occupied(abs)) return { ok: false, error: 'a folder with that name already exists here' }
  const notesMoved = collectNoteFiles(src.abs).length
  renameSync(src.abs, abs)
  // Every note that lived under the old folder path is addressed by a new path form now.
  let linksUpdated = 0
  let notesTouched = 0
  const prefixOld = src.rel + '/'
  const prefixNew = newRel + '/'
  for (const noteAbs of collectNoteFiles(vaultDir)) {
    let text: string
    try {
      text = readFileSync(noteAbs, 'utf8')
    } catch {
      continue
    }
    if (!text.toLowerCase().includes(prefixOld.toLowerCase())) continue
    let count = 0
    const wikiRewritten = text
      .replace(/\[\[([^\]\n]+?)\]\]/g, (whole, inner: string) => {
        if (!inner.toLowerCase().startsWith(prefixOld.toLowerCase())) return whole
        count++
        return `[[${prefixNew}${inner.slice(prefixOld.length)}]]`
      })
    const rewritten = rewriteMdLinks(wikiRewritten, (t) => {
      if (!t.toLowerCase().startsWith(prefixOld.toLowerCase())) return null
      return prefixNew + t.slice(prefixOld.length)
    }, () => count++)
    if (count === 0 || rewritten === text) continue
    const snap = snapshotToTrash(vaultDir, noteAbs, opts.actor, 'link-rewrite')
    if (!snap.ok) continue
    writeFileSync(noteAbs, rewritten, 'utf8')
    linksUpdated += count
    notesTouched++
  }
  appendOrganizeJournal(vaultDir, { actor: opts.actor, op: 'rename-folder', from: src.rel, to: newRel, linksUpdated, notesTouched })
  return { ok: true, path: newRel, notesMoved, linksUpdated, notesTouched }
}

/** Create a folder (nested paths allowed). Creating one that exists is not an error. */
export function createFolder(vaultDir: string, rel: string, opts: { actor: string }): OrganizeResult<{ path: string; created: boolean }> {
  const dst = resolveVaultPath(vaultDir, rel, 'dir')
  if (!dst.ok) return dst
  if (!dst.rel) return { ok: false, error: 'a folder name is required' }
  for (const seg of dst.rel.split('/')) {
    const s = sanitizeName(seg)
    if (!s.ok) return s
  }
  if (existsSync(dst.abs)) {
    if (!statSync(dst.abs).isDirectory()) return { ok: false, error: 'a note with that name already exists' }
    return { ok: true, path: dst.rel, created: false }
  }
  mkdirSync(dst.abs, { recursive: true })
  appendOrganizeJournal(vaultDir, { actor: opts.actor, op: 'create-folder', to: dst.rel })
  return { ok: true, path: dst.rel, created: true }
}

/** Create an empty markdown note in a folder ('' = the root). Never overwrites. */
export function createNote(
  vaultDir: string,
  folderRel: string,
  name: string,
  opts: { actor: string; now?: Date }
): OrganizeResult<{ path: string }> {
  const dst = resolveVaultPath(vaultDir, folderRel, 'dir')
  if (!dst.ok) return dst
  const clean = sanitizeName(name)
  if (!clean.ok) return clean
  const fileName = NOTE_EXTS.includes(extname(clean.name).toLowerCase()) ? clean.name : clean.name + '.md'
  const abs = join(dst.abs, fileName)
  if (occupied(abs)) return { ok: false, error: 'a note with that name already exists here' }
  mkdirSync(dst.abs, { recursive: true })
  const day = (opts.now ?? new Date()).toISOString().slice(0, 10)
  const title = stripExt(fileName)
  writeFileSync(abs, `---\ncreated: ${day}\n---\n\n# ${title}\n\n`, 'utf8')
  recordCreation(vaultDir, abs, opts.actor)
  const rel = vaultRel(vaultDir, abs)
  appendOrganizeJournal(vaultDir, { actor: opts.actor, op: 'create', to: rel })
  return { ok: true, path: rel }
}
