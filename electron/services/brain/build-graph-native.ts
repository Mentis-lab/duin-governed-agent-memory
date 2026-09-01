// build-graph-native — TS port of server.py:build_graph. Walks every folder of the
// vault (skipping .git/.obsidian/.trash/node_modules + _agui outputs, KEEPING tooling
// dot-folders), nodes = notes grouped by top-level folder, edges = resolved [[wikilinks]].
// A fresh filesystem walk (NOT the index/causal deriveGraph). Backs /state/store-graph,
// /state/folders, /state/graph-diff. Pure read.
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { scanConcepts } from './concept-index'
import { isVaultWalkDir } from './vault-dirs'
import { CJK_CLASS } from './cjk-tokens'
import { isRootFoundation } from './foundation-files'

// The app's own state dirs (.brain/.duin) are pruned from the walk by isVaultWalkDir;
// their `.brain/memory` concepts are re-injected below as TYPED namespaced nodes, but
// only when the product graph is otherwise empty (the cold-start skeleton).
// Group + id namespace for the first-run concept skeleton nodes.
const CONCEPT_GROUP = '.concepts'
// Root foundation files are DUIN's own scaffolding (grounding contract + index),
// NOT user notes — so they don't count toward "is this vault populated?". A vault
// whose only `.md` are these is still a cold start. The list itself lives in
// ./foundation-files, shared with graph-derive and the scaffold mover.
const WIKILINK = /\[\[([^\]|#]+)/g
// The tag body's CJK class is the tokenizer's full class (kanji + KANA), not the bare
// ideograph range — `#まとめ` otherwise truncated at the first kana and lost its tag.
const TAG = new RegExp(`(?:^|\\s)#([0-9A-Za-z${CJK_CLASS}/_-]+)`, 'g')
// Same widening for the inline-frontmatter `tags:` scan (`#` is a member here because
// the inline form may carry it) — a kana tag survives instead of splitting on its kana.
const FM_TAG = new RegExp(`[0-9A-Za-z${CJK_CLASS}/_#-]+`, 'g')
const HTML_EXT = /\.html?$/i
const HREF = /<a\s+[^>]*href\s*=\s*["']([^"'#?]+)/gi

/** Opt-in: index authored .html/.htm as first-class graph nodes (the C260709 HTML-node gap —
 *  HTML lands in the file/index graph but never the composite brain-graph, which is .md-only).
 *  DEFAULT OFF → byte-identical to the Python .md-only build_graph, so the still-proxied
 *  /state/graph-diff parity and the /state/folders set are unchanged until an operator opts in. */
function graphIncludeHtml(): boolean {
  const v = (process.env.DUIN_GRAPH_INCLUDE_HTML ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** A machine-scaffolding note FILE (identity-spine P5 "machine files only" policy):
 *  its BASENAME starts with `_` (machine-generated logs/indexes/dashboards —
 *  _concept-index.md, _dashboard.md, _MOVED.md, _*-log.md, _Decisions.md, …). These
 *  are NOT knowledge and must never render as MAP graph nodes. Scoped to the FILE
 *  basename ONLY, so real notes living inside `_`-prefixed content DIRS (ProjectA/…/_原始转录/*.md,
 *  半导体/…/_ocr/*.md) — normal filenames — are unaffected. `DUIN/Meta/` design cards are
 *  REAL knowledge and are NOT scaffolding (kept). Mirrors index-store collectNoteFiles /
 *  notes-watcher shouldIgnore / brain-health isScaffoldId. */
export function isScaffoldNoteFile(relOrName: string): boolean {
  const base = relOrName.slice(Math.max(relOrName.lastIndexOf('/'), relOrName.lastIndexOf('\\')) + 1)
  return base.startsWith('_')
}

/** A STRUCTURAL folder/git-plumbing file that is not knowledge, regardless of where it
 *  lives: `README.md` (and dedup-renamed `README-2.md`), a folder-index placeholder
 *  `index.md`, and git-keep markers `.gitkeep.md` / `.gitkeep-2.md`. These carry no real
 *  content — they only mark or title a directory — yet they were minting empty `note`/`card`
 *  graph nodes (a README under DUIN/Knowledge or DUIN/Instincts even typed as a `card`), so
 *  the Explorer showed titled-but-bodyless items. Complement to isScaffoldNoteFile's
 *  `_`-basename rule. Tight anchored patterns so real notes (`index-of-terms.md`,
 *  `readme-driven-design.md`) are NOT caught. Only `.md/.html` reach this (walkNotes gate). */
export function isStructuralNoteFile(relOrName: string): boolean {
  const base = relOrName.slice(Math.max(relOrName.lastIndexOf('/'), relOrName.lastIndexOf('\\')) + 1).toLowerCase()
  return (
    /^readme(-\d+)?\.(md|html?)$/.test(base) ||
    /^index\.(md|html?)$/.test(base) ||
    /^\.gitkeep(-\d+)?\.(md|html?)$/.test(base)
  )
}

/** Strip the note extension for the display label (.md / .html / .htm). */
function stripNoteExt(name: string): string {
  if (name.endsWith('.md')) return name.slice(0, -3)
  const l = name.toLowerCase()
  if (l.endsWith('.html')) return name.slice(0, -5)
  if (l.endsWith('.htm')) return name.slice(0, -4)
  return name
}

function frontmatterTags(text: string): Set<string> {
  const out = new Set<string>()
  if (!text.startsWith('---')) return out
  const end = text.indexOf('\n---', 3)
  if (end < 0) return out
  const fm = text.slice(3, end)
  // Python's `\s*` here EATS the newline, so a block list captures only its FIRST item as
  // "inline" (`- partner-co` → `partner-co`). Replicate exactly (JS \s also matches \n).
  const m = /^tags:\s*(.*)$/m.exec(fm)
  if (!m) return out
  const inline = m[1].trim()
  if (inline) {
    for (const raw of inline.replace(/^[[\]]+|[[\]]+$/g, '').match(FM_TAG) ?? []) {
      const t = raw.replace(/^#+/, '').toLowerCase()
      if (t && t !== '-') out.add(t)
    }
  } else {
    for (const line of fm.slice((m.index ?? 0) + m[0].length).split('\n')) {
      const lm = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (lm) {
        const t = lm[1].trim().replace(/^#+/, '').toLowerCase()
        if (t && t !== '-') out.add(t)
      } else if (line.trim() && !/^[ \t]/.test(line)) break
    }
  }
  return out
}

interface GraphNode {
  id: string
  label: string
  group: string
  deg: number
}
export interface BuildGraph {
  nodes: GraphNode[]
  links: { source: string; target: string }[]
  folders: string[]
  note_refs: Record<string, string[]>
  note_tags: Record<string, string[]>
}

/** Walk the vault top-down (os.walk order), collecting .md notes (and .html/.htm when
 *  includeHtml) as [rel, basename, topFolder]. */
function walkNotes(base: string, rel: string, includeHtml: boolean): [string, string, string][] {
  let entries: import('fs').Dirent[]
  try {
    entries = readdirSync(join(base, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const here: [string, string, string][] = []
  const subdirs: string[] = []
  for (const e of entries) {
    if (e.isDirectory()) {
      if (isVaultWalkDir(e.name)) subdirs.push(e.name)
    } else if (e.name.endsWith('.md') || (includeHtml && HTML_EXT.test(e.name))) {
      // Scaffolding hygiene (identity-spine P5): `_`-prefixed machine FILES (logs/
      // indexes/dashboards) are NOT knowledge — exclude them from the MAP note cloud
      // so they never mint `kind:'note'` graph nodes. Scoped to the basename, so real
      // notes inside `_`-prefixed content DIRS survive. DUIN/Meta is NOT excluded here.
      if (isScaffoldNoteFile(e.name)) continue
      // Structural folder/git plumbing (README / index / .gitkeep) — titled but bodyless;
      // never a knowledge node. Same rationale as the `_`-basename rule above.
      if (isStructuralNoteFile(e.name)) continue
      const r = rel ? `${rel}/${e.name}` : e.name
      const top = r.includes('/') ? r.split('/', 1)[0] : '(root)'
      here.push([r, stripNoteExt(e.name), top])
    }
  }
  // top-down: this dir's files first, then recurse into subdirs in listing order
  for (const sd of subdirs) here.push(...walkNotes(base, rel ? `${rel}/${sd}` : sd, includeHtml))
  return here
}

export function buildGraph(vaultDir: string | null): BuildGraph {
  const empty: BuildGraph = { nodes: [], links: [], folders: [], note_refs: {}, note_tags: {} }
  if (!vaultDir) return empty
  const includeHtml = graphIncludeHtml()
  const notes = walkNotes(vaultDir, '', includeHtml)

  // Cold start: the vault has NO real user notes (only DUIN's own foundation
  // files, if any). Render the typed OKF concept skeleton instead of a blank /
  // foundation-only graph. A vault with any real note skips this entirely, so its
  // graph is byte-identical to the pre-change build.
  if (notes.every(([rel]) => isRootFoundation(rel))) {
    const empty: BuildGraph = { nodes: [], links: [], folders: [], note_refs: {}, note_tags: {} }
    supplementWithConcepts(vaultDir, empty.nodes, empty.links, empty.note_refs, empty.note_tags)
    empty.folders = [...new Set(empty.nodes.map((n) => n.group))].sort()
    return empty
  }

  const index = new Map<string, string>() // basename lower -> first rel
  for (const [rel, bn] of notes) {
    const key = bn.toLowerCase()
    if (!index.has(key)) index.set(key, rel)
  }

  const deg = new Map<string, number>(notes.map(([r]) => [r, 0]))
  const links: { source: string; target: string }[] = []
  const seen = new Set<string>()
  const noteRefs = new Map<string, Set<string>>()
  const noteTags = new Map<string, Set<string>>()

  for (const [rel] of notes) {
    let text: string
    try {
      // Match Python text-mode read: universal newlines (\r\n and lone \r → \n) BEFORE
      // the 40000-char cap, else wikilink targets + frontmatter parsing diverge on CRLF.
      text = readFileSync(join(vaultDir, rel), 'utf-8').replace(/\r\n?/g, '\n').slice(0, 40000)
    } catch {
      continue
    }
    const refs = new Set<string>()
    noteRefs.set(rel, refs)
    for (const m of text.matchAll(WIKILINK)) {
      let tgt = m[1].split('/').pop()!.trim().toLowerCase()
      if (tgt.endsWith('.md')) tgt = tgt.slice(0, -3)
      refs.add(tgt)
      const t = index.get(tgt)
      const pair = `${rel}\0${t}`
      if (t && t !== rel && !seen.has(pair)) {
        seen.add(pair)
        links.push({ source: rel, target: t })
        deg.set(rel, (deg.get(rel) ?? 0) + 1)
        deg.set(t, (deg.get(t) ?? 0) + 1)
      }
    }
    // HTML artifacts carry no [[wikilinks]] — resolve their <a href> targets to local notes so
    // an authored HTML node isn't isolated. Only when includeHtml; leaves the .md path untouched.
    if (includeHtml && HTML_EXT.test(rel)) {
      for (const m of text.matchAll(HREF)) {
        const tgt = m[1]
          .split(/[\\/]/)
          .pop()!
          .trim()
          .toLowerCase()
          .replace(/\.(md|html?)$/i, '')
        if (!tgt) continue
        refs.add(tgt)
        const t = index.get(tgt)
        const pair = `${rel} ${t}`
        if (t && t !== rel && !seen.has(pair)) {
          seen.add(pair)
          links.push({ source: rel, target: t })
          deg.set(rel, (deg.get(rel) ?? 0) + 1)
          deg.set(t, (deg.get(t) ?? 0) + 1)
        }
      }
    }
    const tags = new Set<string>()
    for (const m of text.matchAll(TAG)) tags.add(m[1].toLowerCase())
    for (const t of frontmatterTags(text)) tags.add(t)
    noteTags.set(rel, new Set([...tags].filter((t) => t && t !== '-')))
  }

  const nodes: GraphNode[] = notes.map(([r, bn, top]) => ({ id: r, label: bn, group: top, deg: deg.get(r) ?? 0 }))
  const refsOut: Record<string, string[]> = {}
  for (const [k, v] of noteRefs) refsOut[k] = [...v].sort()
  const tagsOut: Record<string, string[]> = {}
  for (const [k, v] of noteTags) tagsOut[k] = [...v].sort()
  const folders = [...new Set(nodes.map((n) => n.group))].sort()
  return { nodes, links, folders, note_refs: refsOut, note_tags: tagsOut }
}

/** Emit the first-run concept skeleton into an (empty) BuildGraph. Foundation
 *  concepts (SOUL/BRAIN/ME/GOALS at root) become the hubs; `.brain/memory` concepts
 *  link toward BRAIN. Typedness rides in `note_tags` (the BuildGraph node shape
 *  has no `type` field). Mutates the passed collections. */
function supplementWithConcepts(
  vaultDir: string,
  nodes: GraphNode[],
  links: { source: string; target: string }[],
  refsOut: Record<string, string[]>,
  tagsOut: Record<string, string[]>
): void {
  const seen = new Set<string>()
  const put = (id: string, label: string, type: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    nodes.push({ id, label, group: CONCEPT_GROUP, deg: 0 })
    refsOut[id] = []
    tagsOut[id] = [type]
  }

  // Foundation hubs at vault root.
  let anchor: string | null = null
  for (const [name, type] of [
    ['SOUL.md', 'soul'],
    ['BRAIN.md', 'operating-instructions'],
    ['ME.md', 'identity'],
    ['GOALS.md', 'goals']
  ] as const) {
    if (!existsSync(join(vaultDir, name))) continue
    const id = `concept:${stripNoteExt(name)}`
    put(id, stripNoteExt(name), type)
    if (name === 'BRAIN.md') anchor = id
  }

  // Typed `.brain/memory` concepts.
  for (const c of scanConcepts(join(vaultDir, '.brain', 'memory'))) {
    put(`concept:${c.id}`, c.name, c.type === '(untyped)' ? '' : c.type)
  }

  if (nodes.length === 0) return
  const hub = anchor ?? nodes[0].id
  const degOf = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (n.id === hub) continue
    links.push({ source: n.id, target: hub })
    n.deg += 1
    const h = degOf.get(hub)
    if (h) h.deg += 1
  }
}
