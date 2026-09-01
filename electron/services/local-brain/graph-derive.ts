// Derive a CausalGraph from the indexed notes so the Brain view renders a
// real, notes-grounded field instead of the bundled demo.
//
// The CausalGraph / CausalNode / CausalEdge shapes are the renderer's contract
// (src/components/brain/graph-types.ts) and the engine's (electron/services/
// brain/types.ts). The electron tsconfig project can't import across the src/
// boundary, so the relevant subset is mirrored here — keep field names in
// lockstep (same precedent as the RagCollection / settings-store duplication).
//
// Keyless richness: beyond file→node + [[wikilink]]/[md](link) edges, we parse
// each note's YAML frontmatter for `type`/`kind`, `date`/`due`/`decide_by`, and
// `tags`/`risk`. That lets the foresight engines (decision-window, deadline-
// collision) light up from structured notes with NO LLM — the notes-extract
// LLM pass enriches plain prose notes on top of this.

import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { allChunks, fileMtimes, notesChunksVersion } from './index-store'
import { scanConcepts } from '../brain/concept-index'
import { isRootFoundation } from '../brain/foundation-files'
import { readSettings } from '../settings-helper'
import { parseDateFromName } from './note-date'

// Kept in lockstep with the full CausalKind in electron/services/brain/types.ts
// + src/components/brain/graph-types.ts. Historically this local mirror omitted
// the entity kinds (person/org/project/topic) and outcome/step; it is aligned to
// the complete set here so the three declarations don't drift.
type CausalKind =
  | 'anchor'
  | 'driver'
  | 'stream'
  | 'gate'
  | 'risk'
  | 'dependency'
  | 'resource'
  | 'outcome'
  | 'step'
  | 'decision'
  | 'milestone'
  | 'release'
  | 'event'
  // A built, viewable document surface (HTML decks/tutorials/explainers).
  | 'page'
  // Entity kinds surfaced by the construction pass (construct.ts).
  | 'person'
  | 'org'
  | 'project'
  | 'topic'
  // Additive graph-unification kinds (Phase 0).
  | 'product'
  | 'place'

type RiskLevel = 'red' | 'amber' | 'green'

interface CausalNode {
  id: string
  kind: CausalKind
  label: string
  track?: string
  in_degree?: number
  converges?: boolean
  date?: string
  decide_by?: string
  risk?: RiskLevel
  /** File last-modified time (ms) — for recency display in the graph. */
  mtime?: number
}

interface CausalEdge {
  source: string
  target: string
  type: string
  confidence?: number
}

export interface CausalGraph {
  nodes: CausalNode[]
  edges: CausalEdge[]
  anchor?: string | null
  today?: string
  stats?: { nodes: number; edges: number; converge_nodes?: number }
}

// Match the harness brain's full field: render the whole indexed vault, not a
// 150-node slice. High safety ceiling only guards a pathological/symlinked tree;
// the index walk (MAX_FILES) is the real bound on how many notes reach here.
const MAX_NODES = 5000

interface Frontmatter {
  type?: string
  date?: string
  decide_by?: string
  tags: string[]
  risk?: RiskLevel
}

const ISO = /\d{4}-\d{2}-\d{2}/

/** Parse a leading `---`…`---` YAML-ish block. Tolerant: only the few keys we
 *  use, simple `key: value` and inline/locked list forms for tags. */
function parseFrontmatter(text: string): Frontmatter {
  const fm: Frontmatter = { tags: [] }
  // eslint-disable-next-line no-irregular-whitespace -- intentional optional BOM (U+FEFF) before YAML frontmatter
  const m = text.match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return fm
  const dateKeys = ['date', 'due', 'deadline', 'created', 'when']
  for (const rawLine of m[1].split(/\r?\n/)) {
    const line = rawLine.trim()
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    let val = kv[2].trim().replace(/^["']|["']$/g, '')
    if ((key === 'type' || key === 'kind' || key === 'category') && val) fm.type = val.toLowerCase()
    else if (key === 'decide_by' || key === 'decide-by' || key === 'decideby') {
      const d = val.match(ISO)
      if (d) fm.decide_by = d[0]
    } else if (dateKeys.includes(key) && !fm.date) {
      const d = val.match(ISO)
      if (d) fm.date = d[0]
    } else if (key === 'risk' || key === 'severity') {
      const v = val.toLowerCase()
      fm.risk = v.startsWith('r') || v === 'high' || v === 'critical' ? 'red'
        : v.startsWith('a') || v === 'med' || v === 'medium' ? 'amber' : 'green'
    } else if (key === 'tags' || key === 'tag') {
      // inline `[a, b]` or `a, b` or a single token
      val = val.replace(/^\[|\]$/g, '')
      fm.tags.push(...val.split(/[,\s]+/).map((t) => t.replace(/^#/, '').toLowerCase()).filter(Boolean))
    }
  }
  return fm
}

const TYPE_TO_KIND: Record<string, CausalKind> = {
  decision: 'decision', decide: 'decision',
  milestone: 'milestone', goal: 'anchor', objective: 'anchor',
  release: 'release', launch: 'release', ship: 'release',
  risk: 'risk', blocker: 'risk', threat: 'risk', issue: 'risk',
  resource: 'resource', asset: 'resource',
  'mental-model': 'resource', mental_model: 'resource', framework: 'resource', principle: 'resource', lens: 'resource',
  dependency: 'dependency', depends: 'dependency',
  driver: 'driver', lever: 'driver',
  event: 'event', meeting: 'event',
  gate: 'gate',
  index: 'anchor', moc: 'anchor', map: 'anchor', hub: 'anchor',
  note: 'stream', project: 'stream',
  page: 'page', document: 'page', html: 'page', artifact: 'page'
}

/** Title heuristic: first markdown H1, else the filename without extension. */
function deriveTitle(relpath: string, text: string): string {
  const h1 = text.match(/^\s*#\s+(.+?)\s*$/m)
  if (h1 && h1[1].trim()) return h1[1].trim()
  const base = relpath.split('/').pop() ?? relpath
  return base.replace(/\.(md|markdown|txt|html|htm)$/i, '')
}

/** Node kind: frontmatter type → tags → filename heuristic → 'stream'. */
function deriveKind(relpath: string, fm: Frontmatter): CausalKind {
  if (fm.type && TYPE_TO_KIND[fm.type]) return TYPE_TO_KIND[fm.type]
  for (const t of fm.tags) if (TYPE_TO_KIND[t]) return TYPE_TO_KIND[t]
  // An .html/.htm file is a built page surface regardless of (absent) frontmatter.
  if (/\.html?$/i.test(relpath)) return 'page'
  const base = (relpath.split('/').pop() ?? relpath).toLowerCase()
  if (/^(index|readme|home|moc|map|toc)\b/.test(base) || base === 'index.md') return 'anchor'
  if (/\b(risk|blocker|threat)\b/.test(base)) return 'risk'
  if (/\b(decision|decide)\b/.test(base)) return 'decision'
  return 'stream'
}

/** Top-level folder becomes the lane; root files share the 'notes' lane. */
function deriveLane(relpath: string): string {
  const parts = relpath.split('/')
  return parts.length > 1 ? parts[0] : 'notes'
}

/** Normalize a link target to a candidate relpath id (drop anchors, add .md). */
function normalizeTarget(raw: string): string {
  let t = raw.trim().split('#')[0].split('|')[0].trim()
  if (!t) return ''
  t = t.replace(/\\/g, '/')
  return t
}

/**
 * Build the CausalGraph. Each note → one node (id = relpath), typed + dated from
 * its frontmatter where present. Edges come from `[[wikilinks]]` and markdown
 * `[text](target.md)` links resolving to another indexed note. Empty index →
 * empty graph (renderer falls back to the bundled demo).
 */
// parseDateFromName moved to ./note-date on 2026-08-03 and is imported above. It used to live here,
// module-private, with one caller — and then the index needed the same rule to persist note_date.
// Two copies of "what date is this note" would drift, and the drift would be invisible: the graph
// would show one date while a retrieval window filtered on another.

// Root foundation files are DUIN's own scaffolding (grounding contract + index),
// NOT user notes — a vault whose only indexed files are these is still a cold
// start (renders the concept skeleton, not a foundation-only graph). The list
// itself lives in brain/foundation-files, shared with the native graph builder
// and the scaffold mover.

// OKF concept `type:` → CausalKind, for the cold-start skeleton. Foundation +
// goal-shaped concepts become anchors (hubs); the rest map to a sensible kind so
// the first-run graph renders a legible TYPED skeleton, not a blank canvas.
const CONCEPT_TYPE_TO_KIND: Record<string, CausalKind> = {
  identity: 'anchor',
  'operating-instructions': 'anchor',
  goals: 'anchor',
  'strategic-goals': 'anchor',
  objective: 'anchor',
  planning: 'anchor',
  project: 'stream',
  active: 'stream',
  task: 'stream',
  decision: 'decision',
  risk: 'risk',
  instinct: 'driver',
  knowledge: 'resource',
  reference: 'resource',
  person: 'resource',
  inbox: 'resource'
}

/**
 * First-run concept skeleton (DUIN_MEMORY_OKF_DESIGN §4). Reads the vault's
 * foundation concepts (BRAIN.md / ME.md / GOALS.md at root) + the typed
 * `.brain/memory` concepts and emits them as NAMESPACED (`concept:*`) typed graph
 * nodes so a fresh, note-less vault renders a real typed skeleton instead of a
 * blank graph. Namespacing keeps these off the real notes graph — they only ever
 * supplement an EMPTY graph (see deriveGraph), so a populated vault is untouched.
 */
function conceptSkeleton(notesDir: string | null | undefined): CausalGraph {
  const dir = typeof notesDir === 'string' ? notesDir.trim() : ''
  if (!dir || !existsSync(dir)) return { nodes: [], edges: [], stats: { nodes: 0, edges: 0 } }

  const nodes: CausalNode[] = []
  const edges: CausalEdge[] = []
  const seen = new Set<string>()

  const add = (id: string, kind: CausalKind, label: string): string | null => {
    if (seen.has(id)) return id
    seen.add(id)
    nodes.push({ id, kind, label, track: 'brain', in_degree: 0 })
    return id
  }

  // Foundation concepts at vault root — the hubs of the skeleton.
  let anchorId: string | null = null
  for (const [name, type] of [
    ['SOUL.md', 'soul'],
    ['BRAIN.md', 'operating-instructions'],
    ['ME.md', 'identity'],
    ['GOALS.md', 'goals']
  ] as const) {
    const full = join(dir, name)
    if (!existsSync(full)) continue
    let text: string
    try {
      text = readFileSync(full, 'utf-8')
    } catch {
      continue
    }
    const id = `concept:${name.replace(/\.md$/i, '')}`
    add(id, CONCEPT_TYPE_TO_KIND[type] ?? 'anchor', deriveTitle(name, text))
    if (name === 'BRAIN.md') anchorId = id
  }

  // Typed `.brain/memory` concepts.
  const memoryDir = join(dir, '.brain', 'memory')
  for (const c of scanConcepts(memoryDir)) {
    const kind = CONCEPT_TYPE_TO_KIND[c.type] ?? 'stream'
    add(`concept:${c.id}`, kind, c.name)
  }

  if (nodes.length === 0) return { nodes: [], edges: [], stats: { nodes: 0, edges: 0 } }

  // Wire every non-anchor concept toward the foundation anchor so the skeleton is
  // one connected field (not scattered dots). Anchor = BRAIN, else the first node.
  const anchor = anchorId ?? nodes[0].id
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  for (const n of nodes) {
    if (n.id === anchor) continue
    edges.push({ source: n.id, target: anchor, type: 'grounds', confidence: 0.6 })
    const tgt = nodeById.get(anchor)
    if (tgt) tgt.in_degree = (tgt.in_degree ?? 0) + 1
  }

  return {
    nodes,
    edges,
    anchor,
    today: new Date().toISOString().slice(0, 10),
    stats: { nodes: nodes.length, edges: edges.length, converge_nodes: 0 }
  }
}

/**
 * @param notesDir the vault dir (for the first-run concept skeleton). Omitted →
 *   resolved from settings (localBrainNotesDir). Only consulted when the notes
 *   index is EMPTY, so a populated vault's graph is byte-identical.
 */
// Module memo: deriveGraph is pure over notes_chunks, but the grounding path
// rebuilt it from the full corpus 2-3× per chat turn (and the /graph route
// recomputed it on every poll). Cache the built graph keyed by the chunks
// version; hand every caller a structuredClone so nobody can mutate the cached
// copy — mergedGraph() returns deriveGraph()'s result directly when there's no
// construction. A 30s TTL backstops any missed invalidation.
let _deriveCache: { key: string; graph: CausalGraph; t: number } | null = null
const DERIVE_TTL_MS = 30_000

export function deriveGraph(notesDir?: string | null): CausalGraph {
  const key = `${notesDir ?? ''}:${notesChunksVersion()}`
  const now = Date.now()
  if (!_deriveCache || _deriveCache.key !== key || now - _deriveCache.t >= DERIVE_TTL_MS) {
    _deriveCache = { key, graph: deriveGraphUncached(notesDir), t: now }
  }
  return structuredClone(_deriveCache.graph)
}

function deriveGraphUncached(notesDir?: string | null): CausalGraph {
  const chunks = allChunks()

  // Reassemble per-file text from its chunks.
  const fileText = new Map<string, string>()
  for (const c of chunks) {
    fileText.set(c.file, (fileText.get(c.file) ?? '') + '\n' + c.text)
  }

  // The `.brain/memory/*` concept notes are now indexed for RETRIEVAL (chat
  // search/cite), so they show up in allChunks(). They must NOT become raw nodes
  // in the causal graph: they surface ONLY as the namespaced `concept:*` cold-start
  // skeleton (conceptSkeleton, which reads them straight from the filesystem). Drop
  // the whole `.brain/` subtree here so (a) the cold-start gate below still sees only
  // root-foundation files on a fresh vault, and (b) a populated vault's graph is
  // byte-identical — concepts appear exactly once, and only when the graph is empty.
  const files = [...fileText.keys()].filter((f) => !f.startsWith('.brain/')).slice(0, MAX_NODES)

  // Cold start: no REAL user notes indexed (root foundation files — BRAIN/ME/GOALS
  // — are DUIN's own scaffolding, not user content). Supplement the blank graph
  // with the typed concept skeleton so first-run isn't "I have nothing in your
  // brain yet". A vault with any real note renders exactly as before.
  if (files.every((f) => isRootFoundation(f))) {
    const dir = notesDir ?? (typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null)
    return conceptSkeleton(dir)
  }
  const fileSet = new Set(files)
  const byBasename = new Map<string, string>()
  for (const f of files) {
    const base = (f.split('/').pop() ?? f).replace(/\.(md|markdown|txt|html|htm)$/i, '').toLowerCase()
    if (!byBasename.has(base)) byBasename.set(base, f)
  }

  const resolve = (rawTarget: string): string | null => {
    const t = normalizeTarget(rawTarget)
    if (!t) return null
    if (fileSet.has(t)) return t
    for (const ext of ['.md', '.markdown', '.txt', '.html', '.htm']) {
      if (fileSet.has(t + ext)) return t + ext
    }
    const base = (t.split('/').pop() ?? t).replace(/\.(md|markdown|txt|html|htm)$/i, '').toLowerCase()
    return byBasename.get(base) ?? null
  }

  const mtimes = fileMtimes()
  const nodes: CausalNode[] = files.map((f) => {
    const text = fileText.get(f) ?? ''
    const fm = parseFrontmatter(text)
    const kind = deriveKind(f, fm)
    const node: CausalNode = {
      id: f,
      kind,
      label: deriveTitle(f, text),
      track: deriveLane(f),
      in_degree: 0
    }
    // Recency timestamp: prefer a date in the filename (daily notes fade by their
    // own date, testable immediately), else the indexed file last-modified time.
    const td = parseDateFromName(f)
    if (td) node.mtime = td
    else {
      const mt = mtimes.get(f)
      if (mt) node.mtime = mt
    }
    if (fm.date) node.date = fm.date
    // A decision needs a decide_by for the decision-window detector; fall back
    // to the note's date if no explicit decide_by is set.
    if (kind === 'decision') node.decide_by = fm.decide_by ?? fm.date
    else if (fm.decide_by) node.decide_by = fm.decide_by
    if (fm.risk) node.risk = fm.risk
    else if (kind === 'risk') node.risk = 'amber'
    return node
  })
  const nodeById = new Map(nodes.map((n) => [n.id, n]))

  const wikilink = /\[\[([^\]]+?)\]\]/g
  const mdlink = /\[[^\]]*?\]\(([^)]+?)\)/g

  const edgeKeys = new Set<string>()
  const edges: CausalEdge[] = []
  const addEdge = (source: string, target: string, type: string): void => {
    if (source === target) return
    const key = `${source} ${target} ${type}`
    if (edgeKeys.has(key)) return
    edgeKeys.add(key)
    edges.push({ source, target, type, confidence: 0.7 })
    const tgt = nodeById.get(target)
    if (tgt) tgt.in_degree = (tgt.in_degree ?? 0) + 1
  }

  for (const f of files) {
    const text = fileText.get(f) ?? ''
    let m: RegExpExecArray | null
    wikilink.lastIndex = 0
    while ((m = wikilink.exec(text)) !== null) {
      const target = resolve(m[1])
      if (target) addEdge(f, target, 'wikilink')
    }
    mdlink.lastIndex = 0
    while ((m = mdlink.exec(text)) !== null) {
      const href = m[1]
      if (/^(https?:|mailto:|#)/i.test(href.trim())) continue
      const target = resolve(href)
      if (target) addEdge(f, target, 'link')
    }
  }

  // Mark convergence points (a real signal the world-state/insight engines use).
  let convergeCount = 0
  for (const n of nodes) {
    if ((n.in_degree ?? 0) >= 2) {
      n.converges = true
      convergeCount++
    }
  }

  // Prefer a goal/anchor as the field anchor; else the highest-in-degree node.
  const anchorNode =
    nodes.find((n) => n.kind === 'anchor') ??
    [...nodes].sort((a, b) => (b.in_degree ?? 0) - (a.in_degree ?? 0))[0]

  return {
    nodes,
    edges,
    anchor: anchorNode?.id ?? null,
    today: new Date().toISOString().slice(0, 10),
    stats: { nodes: nodes.length, edges: edges.length, converge_nodes: convergeCount }
  }
}
