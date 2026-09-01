// buildDuinGraph — the ONE shared construction/product merge builder.
// Phase B-1 of the store consolidation (PLANNING/DUIN_STORE_CONSOLIDATION_BUILD_PLAN.md).
//
// The construction-merge logic is currently TRIPLICATED across three callers, each
// with a different edge-dedup discipline:
//   - applyConstruction()  construct.ts            → /graph + graph-insight (mergedGraph)
//                          directed-triple dedup (`src|target|type`)
//   - liveGraph() inline   retrieve-agent.ts       → retrieval traversal
//                          NO edge dedup
//   - overlayConstruction() brain-graph-native.ts  → the home MAP
//                          undirected-pair dedup (one typed edge per unordered pair)
//
// This module owns EXACTLY the shared substance so B-2 can rewire the three callers
// onto it without changing any edge count / degree:
//   (a) construction entity-node dedup (base/native node wins an id collision),
//   (b) construction edge mapping (RELATION_TO_EDGE) + self-edge + dangling-endpoint drop,
//   (c) PARAMETERIZED edge-dedup — `dedup: 'none' | 'directed' | 'undirected'`,
//   (d) product inclusion (readGraphNative result INJECTED) with an OPTIONAL
//       `canonicalizeProduct` that runs normalizeStoreId / normalizeEdgeEndpoint so a
//       product node like `vault:/A/Foo.md` actually MERGES onto the base note `A/Foo.md`
//       instead of forming a disconnected island (the retrieval-surface capability).
//
// It is a PURE function. Caller-specific DECORATIONS are intentionally NOT owned here
// (they are re-applied by each caller in B-2): applyConstruction's `confidence: 0.6`
// on edges, its note-node `classification` stamping, and its note→`track` derivation.
// See the header note in the test for the exact parity boundary.

import { RELATION_TO_EDGE } from './construct'
import { normalizeStoreId, normalizeEdgeEndpoint } from './canonical-id'
import type { ConstructedData, ConstructedEdge } from './types'
import type { GraphReadResult } from './graph-native'

/** How construction edges dedup against the base + each other. Maps 1:1 onto the
 *  three existing impls — see the module header. */
export type DedupMode = 'none' | 'directed' | 'undirected'

export interface BuildDuinGraphOpts {
  /** The caller's ALREADY-BUILT base graph (deriveGraph view, or the MAP `buildGraph`
   *  base). Injected — buildDuinGraph never re-derives it. `edges` is the flat edge
   *  list (the MAP caller passes `graph.links`). Cloned, never mutated. */
  base: {
    nodes: ReadonlyArray<{ id?: unknown }>
    edges: ReadonlyArray<{ source?: unknown; target?: unknown; type?: unknown }>
  }
  /** The LLM construction (entities + typed edges). Null/undefined ⇒ skip that layer. */
  construction?: ConstructedData | null
  /** The product/store graph (readGraphNative result). Injected so C1 can swap the
   *  source without touching this builder. Undefined/null ⇒ skip the product layer. */
  product?: GraphReadResult | null
  /** Construction-edge dedup discipline (the axis the 3 callers differ on). */
  dedup: DedupMode
  /** When true, canonicalize product node ids (normalizeStoreId) + edge endpoints
   *  (normalizeEdgeEndpoint) BEFORE the byId merge — the retrieval overlay that makes
   *  a `vault:/…` node fold onto its note relpath. Default false (store/MAP surfaces
   *  keep the bare product id space for byte-parity). */
  canonicalizeProduct?: boolean
  /** When set, tag each ADDED construction entity node with `layer: <productLayer>` and
   *  `group: <kind>` (the MAP's node shape — overlayConstruction uses 'construction').
   *  Unset ⇒ construction nodes carry `note` instead (the retrieval/render shape). */
  productLayer?: string
  /** OPT-IN topic floor (see pruneUnstructuredTopics). Deliberately per-caller, not global:
   *  this builder is shared by the rendered MAP, `/graph`, and the RETRIEVAL traversal, and
   *  dropping nodes from retrieval is a different decision with a different evidence bar.
   *  Only the MAP passes true. */
  pruneUnstructuredTopics?: boolean
}

export interface BuiltGraph {
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}

const asRec = (o: unknown): Record<string, unknown> => o as Record<string, unknown>
const str = (v: unknown): string => String(v ?? '')

/** Undirected pair key — MUST match overlayConstruction (brain-graph-native.ts:476). */
const pairKey = (s: string, t: string): string => (s < t ? s + ' ' + t : t + ' ' + s)

/** Map a construction relation → the rendered edge type. Total record; `?? ce.type`
 *  mirrors the two overlay callers and stays safe for any raw string. */
const edgeType = (ce: ConstructedEdge): string => RELATION_TO_EDGE[ce.type] ?? ce.type

/**
 * Build the unified DUIN graph: base ⊕ construction ⊕ product. Pure; the base is
 * cloned (spread) so the caller's arrays are never mutated. Insertion order is
 * base → construction entities → construction edges → product, preserving each
 * source impl's observable ordering.
 */
export function buildDuinGraph(opts: BuildDuinGraphOpts): BuiltGraph {
  const { base, construction, product, dedup, canonicalizeProduct, productLayer } = opts

  const nodes: Record<string, unknown>[] = base.nodes.map((n) => ({ ...asRec(n) }))
  const edges: Record<string, unknown>[] = base.edges.map((e) => ({ ...asRec(e) }))

  // byId over the merged node set — base wins every id collision (native/base
  // authoritative), matching all three impls.
  const byId = new Map<string, Record<string, unknown>>()
  for (const n of nodes) {
    const id = str(n.id)
    if (id && !byId.has(id)) byId.set(id, n)
  }

  if (construction) {
    // ② ENTITY→NOTE spine resolver (identity-spine §5). A construction entity's `note`
    // is its provenance-note relpath; the note NODE's id is the full relpath. Resolve
    // exact-id first, else a basename-suffix match against the BASE note ids (the same
    // resolution the census / brain-health resolvesNote use). Snapshot the base id space
    // BEFORE entities are appended so an entity never resolves onto another entity.
    const baseIds = new Set<string>(byId.keys())
    const baseByBasename = new Map<string, string>()
    for (const id of baseIds) {
      if (!/\.[^./\\]+$/.test(id)) continue // only file-like ids anchor a basename key
      const base = id.slice(id.lastIndexOf('/') + 1)
      if (!baseByBasename.has(base)) baseByBasename.set(base, id)
    }
    const resolveNoteId = (note?: string): string | undefined => {
      if (!note) return undefined
      if (baseIds.has(note)) return note
      const base = note.slice(note.lastIndexOf('/') + 1)
      return baseByBasename.get(base)
    }

    // (a) entity nodes — dedup by id; a colliding id keeps the base/native node.
    // ② emit the entity→note spine edge for EVERY entity (not just the first at a given id),
    // so when the resolver collapses N churning fragments onto ONE canonical id, that node
    // inherits the UNION of its fragments' provenance notes (ProjectA/pitch.md AND ProjectA/roadmap.md,
    // not just whichever fragment happened to land the node first). DEFAULT-ON + additive; only
    // when `note` resolves to a REAL existing note node; self/dangling-safe. De-duplicated by
    // unordered endpoint pair so a merged group doesn't emit the same tether twice. Pushed
    // before appendConstructionEdges so the per-mode dedup also absorbs any duplicate LLM edge.
    const emittedNoteEdge = new Set<string>()
    for (const e of construction.entities) {
      if (!byId.has(e.id)) {
        const node: Record<string, unknown> = productLayer
          ? { id: e.id, kind: e.kind, label: e.label || e.id, layer: productLayer, group: e.kind }
          : { id: e.id, kind: e.kind, label: e.label, note: e.note }
        nodes.push(node)
        byId.set(e.id, node)
      }
      // Only tether a CONSTRUCTION-owned entity id (not a pre-existing base node — a base
      // node keeps its own provenance and must stay byte-parity, so an entity whose id
      // COLLIDES with a base node emits no spine edge, matching the pre-spine behavior).
      const noteId = resolveNoteId(e.note)
      if (noteId && noteId !== e.id && !baseIds.has(e.id)) {
        const k = pairKey(e.id, noteId)
        if (!emittedNoteEdge.has(k)) {
          emittedNoteEdge.add(k)
          edges.push({ source: e.id, target: noteId, type: 'mentions' })
        }
      }
    }
    // (b)+(c) edges — map relation→type, drop self + dangling, dedup per `dedup`.
    appendConstructionEdges(construction.edges, edges, byId, dedup)
  }

  // (d) product inclusion — injected readGraphNative result.
  if (product) mergeProduct(product, nodes, edges, byId, canonicalizeProduct === true)

  // (e)(f)(g) MAP-only relevance pipeline, opt-in per caller. ORDER IS LOAD-BEARING and is the
  // whole reason this is one pipeline rather than three independent passes:
  //   e. fold mechanical duplicates      — consolidates edges onto ONE surviving node
  //   f. emit sub-topic `part-of` edges  — gives a child a real relation to its parent
  //   g. apply the relevance floor       — LAST, so it judges the enriched graph
  // Flooring first would delete entities for missing exactly the edges (e) and (f) are about to
  // supply. a real company with no relation looks like noise; the same company merged with its duplicates and
  // tethered to its parent is structure. Cull on the final picture, never the intermediate one.
  if (opts.pruneUnstructuredTopics) {
    let g: BuiltGraph = { nodes, edges }
    if (graphDedupeEnabled()) g = mergeMechanicalDuplicates(g)
    if (subtopicEdgesEnabled()) g = linkSubtopicsToParents(g)
    if (topicFloorEnabled()) g = pruneUnstructuredTopics(g)
    return g
  }

  return { nodes, edges }
}

/** Link families that carry no structural claim — co-occurrence bookkeeping, not relations.
 *  Mirrors the renderer's LOD_BULK_LINKS (brain-shell.tsx) deliberately: the same two
 *  families are the ones the level-of-detail cull discards first, for the same reason. */
const BULK_EDGE_TYPES = new Set(['mentions', 'synonym'])

/** A node id that names a file — the note ids the vault contributes. Same shape test the
 *  entity→note spine resolver above uses, so "has provenance" means the same thing twice. */
const isFileId = (id: string): boolean => /\.[^./\\]+$/.test(id)

/** `DUIN_GRAPH_TOPIC_FLOOR=0` disables the floor and restores the prior graph byte-for-byte. */
export function topicFloorEnabled(): boolean {
  return process.env.DUIN_GRAPH_TOPIC_FLOOR !== '0'
}
/** `DUIN_GRAPH_DEDUPE=0` disables the mechanical duplicate fold. */
export function graphDedupeEnabled(): boolean {
  return process.env.DUIN_GRAPH_DEDUPE !== '0'
}
/** `DUIN_GRAPH_SUBTOPIC=0` disables sub-topic `part-of` edges. */
export function subtopicEdgesEnabled(): boolean {
  return process.env.DUIN_GRAPH_SUBTOPIC !== '0'
}

/** Kinds whose LABEL is a NAME. Deliberately excludes `decision` and `event`, whose labels are
 *  statements ("Build DUIN as local-first", "月魂不做QTE") — a statement is never a sub-topic, and
 *  treating one as such is what made a bare verb like "Build" look like the parent of 21 nodes. */
const NAME_KINDS = new Set(['person', 'org', 'project', 'topic'])

/** Winner precedence when duplicates fold. Mirrors entity-kind-collapse's KIND_PRECEDENCE — most
 *  specific first — so the map and the store agree on which kind wins a label. */
const KIND_RANK = ['person', 'org', 'project', 'event', 'decision', 'topic']

/** An id-shaped string the extractor echoed back as a NAME (`'project:duin'`, `'person:theo-quill'`).
 *  1,069 live store nodes carry one. It is never a real name. */
const ID_SHAPED = /^(?:person|org|topic|project|event|decision|entity|concept|place|product):/i
/** A trailing gloss: `Acme (ACM)`, `张三 (Zhang San)` — a rendering of the SAME name, not a qualifier. */
const APPOSITIVE = /\s*[（(][^)）]*[)）]\s*$/

/** Traditional→simplified for the characters this vault actually collides on. NOT a full OpenCC
 *  table and not meant to be — a starter set, extended when a real collision shows up. It exists
 *  because a name written in traditional and in simplified is ONE person, and no amount of
 *  case-folding will tell you so. */
const TRAD_SIMP: Record<string, string> = {
  慶: '庆', 國: '国', 華: '华', 東: '东', 傳: '传', 語: '语', 會: '会', 學: '学', 實: '实',
  點: '点', 開: '开', 關: '关', 專: '专', 業: '业', 產: '产', 動: '动', 發: '发', 遊: '游',
  戲: '戏', 網: '网', 電: '电', 際: '际', 龍: '龙', 鳳: '凤', 陳: '陈', 張: '张'
}

/**
 * The MERGE KEY — what makes two nodes the same real thing. Four mechanical rules, no inference:
 * strip an echoed id prefix, strip a parenthetical gloss, fold traditional→simplified, then the
 * case/whitespace collapse `normName` already does.
 *
 * Measured on one live store, these four alone collapse 759 clusters over 1,681 nodes: a single
 * project was living under its bare name, its romanised gloss, and three kind-prefixed echoes of
 * its own id at once (`'project:x'` / `'org:x'` / `'person:x'`), and one person existed as
 * five nodes across simplified/traditional, a gloss, and an echoed id.
 *
 * This is a KEY, not a rename — the surviving node keeps its own display label untouched.
 */
export function mergeKey(label: string): string {
  let s = String(label ?? '').trim()
  s = s.replace(ID_SHAPED, '')
  s = s.replace(APPOSITIVE, '')
  s = s.replace(/[一-鿿]/g, (ch) => TRAD_SIMP[ch] ?? ch)
  return s.replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * Fold nodes that the merge key says are one thing. FILE-BACKED nodes never fold — a note is a
 * document, its identity is its path, and two notes with similar titles are still two documents.
 * Edges are rewired onto the winner, self-edges dropped, and the result deduped by
 * (source, target, type) so a fold cannot inflate degree.
 *
 * Winner: a real name beats an echoed id, then KIND_RANK (most specific kind wins, matching
 * entity-kind-collapse), then higher degree, then id — so the choice is deterministic.
 */
export function mergeMechanicalDuplicates(g: BuiltGraph): BuiltGraph {
  const degree = new Map<string, number>()
  for (const e of g.edges) {
    degree.set(str(e.source), (degree.get(str(e.source)) ?? 0) + 1)
    degree.set(str(e.target), (degree.get(str(e.target)) ?? 0) + 1)
  }
  const groups = new Map<string, Record<string, unknown>[]>()
  for (const n of g.nodes) {
    const id = str(n.id)
    if (!id || isFileId(id)) continue // documents are identified by path, never folded
    const k = mergeKey(str(n.label ?? id))
    if (k.length < 2) continue // too short to be a safe key
    const arr = groups.get(k)
    if (arr) arr.push(n)
    else groups.set(k, [n])
  }
  const rewrite = new Map<string, string>()
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const rank = (n: Record<string, unknown>): number => {
      const i = KIND_RANK.indexOf(str(n.kind))
      return i < 0 ? KIND_RANK.length : i
    }
    const winner = members.reduce((a, b) => {
      const ai = ID_SHAPED.test(str(a.label)) ? 1 : 0
      const bi = ID_SHAPED.test(str(b.label)) ? 1 : 0
      if (ai !== bi) return ai < bi ? a : b
      if (rank(a) !== rank(b)) return rank(a) < rank(b) ? a : b
      const ad = degree.get(str(a.id)) ?? 0
      const bd = degree.get(str(b.id)) ?? 0
      if (ad !== bd) return ad > bd ? a : b
      return str(a.id) <= str(b.id) ? a : b
    })
    for (const m of members) if (m !== winner) rewrite.set(str(m.id), str(winner.id))
  }
  if (rewrite.size === 0) return g

  const to = (id: string): string => rewrite.get(id) ?? id
  const seen = new Set<string>()
  const outEdges: Record<string, unknown>[] = []
  for (const e of g.edges) {
    const s = to(str(e.source)), t = to(str(e.target))
    if (!s || !t || s === t) continue // a fold can turn a real edge into a self-loop
    const k = `${s}\0${t}\0${str(e.type)}`
    if (seen.has(k)) continue
    seen.add(k)
    outEdges.push({ ...e, source: s, target: t })
  }
  return { nodes: g.nodes.filter((n) => !rewrite.has(str(n.id))), edges: outEdges }
}

/** A boundary between a parent name and its qualifier. */
const SUBTOPIC_SEP = /^[\s\-–—:/·|_]+\S/

/**
 * Emit `part-of` from a sub-topic to its parent, where the label says so: `DUIN Brain Graph` under
 * `DUIN Brain`, `Claude Code` under `Claude`, `ChinaJoy 2026` under `ChinaJoy`.
 *
 * On the live map **680 nodes matched this shape across 296 families, and 615 of them had NO edge
 * to their parent at all** — the hierarchy was sitting in the labels and the graph knew nothing
 * about it. This adds the relation rather than deleting the node: the map gains structure, families
 * become collapsible, and a child that genuinely belongs to something earns its keep under the
 * floor that runs after this.
 *
 * TWO GUARDS, both from measured false positives:
 *  - **Both ends must be NAME_KINDS.** A `decision`/`event` label is a statement, so prefix-matching
 *    them invents parentage: the bare verb "Build" appeared to parent 21 nodes whose titles merely
 *    began with it. Excluding statement kinds removes that whole class.
 *  - **The parent must already be a hub** (>= MIN_PARENT_DEGREE real relations), so a coincidental
 *    shared prefix on two orphans cannot manufacture a hierarchy.
 */
const MIN_PARENT_DEGREE = 2

export function linkSubtopicsToParents(g: BuiltGraph): BuiltGraph {
  const hard = new Map<string, number>()
  const linked = new Set<string>()
  for (const e of g.edges) {
    const s = str(e.source), t = str(e.target)
    linked.add(`${s}\0${t}`); linked.add(`${t}\0${s}`)
    if (BULK_EDGE_TYPES.has(str(e.type))) continue
    hard.set(s, (hard.get(s) ?? 0) + 1)
    hard.set(t, (hard.get(t) ?? 0) + 1)
  }
  const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase()
  const named = g.nodes.filter((n) => !isFileId(str(n.id)) && NAME_KINDS.has(str(n.kind)))
  const parentByLabel = new Map<string, Record<string, unknown>>()
  for (const n of named) {
    const k = norm(str(n.label ?? n.id))
    if (k.length >= 2 && !parentByLabel.has(k)) parentByLabel.set(k, n)
  }

  const added: Record<string, unknown>[] = []
  for (const child of named) {
    const s = norm(str(child.label ?? child.id))
    for (let cut = s.length - 1; cut > 1; cut--) {
      const parent = parentByLabel.get(s.slice(0, cut))
      if (!parent) continue
      if (!SUBTOPIC_SEP.test(s.slice(cut))) continue
      const pid = str(parent.id), cid = str(child.id)
      if (pid === cid) break
      if ((hard.get(pid) ?? 0) < MIN_PARENT_DEGREE) break // not a hub — no parentage to claim
      if (!linked.has(`${cid}\0${pid}`)) added.push({ source: cid, target: pid, type: 'part-of' })
      break // longest prefix wins; nearest parent only
    }
  }
  return added.length ? { nodes: g.nodes, edges: [...g.edges, ...added] } : g
}

/**
 * How many non-bulk relations a topic needs to count as structure. Operator-set.
 *
 * The first cut at ONE was too timid: it left 1,796 topics — still the largest kind in the graph,
 * ahead of the 931 notes — of which 1,012 held exactly one relation. Inspected, those were the same
 * glossary the floor exists to remove (a design doc's terms of art) plus loose prose fragments
 * carrying no note at all: "concise summaries", "multiple concurrent workstreams". A concept wired
 * to one other thing is a leaf hanging off a single mention, not a place on a map.
 *
 * THREE is the operator's call after seeing the graph at each setting, and it is a judgement about
 * what a map is for, not a fact to derive: a topic worth a node should sit at a junction. Measured
 * on the live graph — 1 → 5,639 nodes / 1,794 topics; 2 → 4,654 / 809; 3 → 4,320 / 475.
 *
 * Note this is now STRICTER than the renderer's level-of-detail `minDegree` (2, graph-lod.ts), so
 * the assembled graph leads the drawn one rather than trailing it. The `>=2 notes` escape below is
 * what keeps a genuinely recurring term that the extractor simply failed to relate.
 */
const MIN_TOPIC_RELATIONS = 3

/**
 * The floor extended past `topic`, to every kind the extractor mints. Operator-chosen, and it is a
 * REAL trade rather than free cleanup — say so plainly.
 *
 * Measured before this ran: of the construction-derived nodes, 65% of `org` (498/761), 60% of
 * `person` (276/462), 44% of `decision` (339/763) and 44% of `event` (280/630) carried no relation
 * and appeared in under two notes. Unlike the topic glossary, **those are largely REAL** — actual
 * companies, actual colleagues, actual design decisions. The defect they expose is
 * missing EDGES, not surplus nodes; the extractor never related them to anything.
 *
 * So the threshold is ONE, not three: an entity survives on a single relation. And it runs AFTER
 * the duplicate fold and the sub-topic pass precisely so an entity gets every chance to earn that
 * one edge first. What it still removes is the genuinely untethered tail. `DUIN_GRAPH_ENTITY_FLOOR=0`
 * turns it off and keeps the topic floor alone.
 */
const MIN_ENTITY_RELATIONS = 1
const FLOORED_ENTITY_KINDS = new Set(['org', 'person', 'decision', 'event'])

/** `DUIN_GRAPH_ENTITY_FLOOR=0` floors only `topic`, leaving org/person/decision/event untouched. */
export function entityFloorEnabled(): boolean {
  return process.env.DUIN_GRAPH_ENTITY_FLOOR !== '0'
}

/**
 * TOPIC FLOOR — a `topic` earns a node when it carries STRUCTURE.
 *
 * `topic` is the weakest kind in the extractor's vocabulary — `entity-kind-collapse.ts` has it
 * losing to every other kind — and on a mature vault it reaches roughly HALF of all rendered nodes,
 * several times the note count. Measured on one: 54.7% of topic nodes had no non-bulk edge at all,
 * and 2,105 of 3,908 appeared in exactly one note while relating to nothing. Those are real terms,
 * but they are a single document's GLOSSARY, not structure anyone can navigate by — each arrives
 * attached to its one note by a lone `mentions` edge and goes nowhere. The topics that matter
 * separate cleanly on the same measure, carrying 20–50 non-bulk edges apiece.
 *
 * So the floor is structural, not a stop-list and not a count cap: **survive with one real relation,
 * or with provenance in more than one note.** Both halves are load-bearing — the first keeps a
 * connected concept that happens to live in one file, the second keeps a recurring term that the
 * extractor never managed to relate to anything.
 *
 * SCOPE, deliberately narrow. Only `topic`, and only on the caller that opts in (the rendered MAP).
 * It does NOT touch the persistent store, so nothing is retired or deleted — the node is simply not
 * assembled into this view, and it returns the moment it earns an edge. It does NOT touch claim
 * subjects either: the ledger keys on its own `subject` strings and never resolves through the
 * graph, so a pruned `topic:` node cannot orphan a claim (the §6 hazard in the handoff is about
 * changing the EXTRACTOR's vocabulary, which this does not do).
 */
export function pruneUnstructuredTopics(g: BuiltGraph): BuiltGraph {
  const hardDegree = new Map<string, number>()
  const notesSeen = new Map<string, Set<string>>()
  for (const e of g.edges) {
    const s = str(e.source), t = str(e.target)
    if (!s || !t) continue
    if (BULK_EDGE_TYPES.has(str(e.type))) {
      // Provenance breadth: a bulk edge still tells us WHICH note mentioned the topic.
      for (const [a, b] of [[s, t], [t, s]] as const) {
        if (!isFileId(b)) continue
        let set = notesSeen.get(a)
        if (!set) { set = new Set(); notesSeen.set(a, set) }
        set.add(b)
      }
      continue
    }
    hardDegree.set(s, (hardDegree.get(s) ?? 0) + 1)
    hardDegree.set(t, (hardDegree.get(t) ?? 0) + 1)
  }

  const entityFloor = entityFloorEnabled()
  const dropped = new Set<string>()
  for (const n of g.nodes) {
    const kind = str(n.kind)
    const isTopic = kind === 'topic'
    const isEntity = entityFloor && FLOORED_ENTITY_KINDS.has(kind)
    if (!isTopic && !isEntity) continue
    const id = str(n.id)
    if (!id || isFileId(id)) continue // a document is never floored
    const need = isTopic ? MIN_TOPIC_RELATIONS : MIN_ENTITY_RELATIONS
    if ((hardDegree.get(id) ?? 0) >= need) continue // real structure
    if ((notesSeen.get(id)?.size ?? 0) >= 2) continue // recurs across documents
    dropped.add(id)
  }
  if (dropped.size === 0) return g

  return {
    nodes: g.nodes.filter((n) => !dropped.has(str(n.id))),
    // Drop the edges that referenced a pruned node, or the view keeps dangling endpoints —
    // which is what makes force-graph fling phantom nodes to the rim.
    edges: g.edges.filter((e) => !dropped.has(str(e.source)) && !dropped.has(str(e.target)))
  }
}

/** Append construction edges under the chosen dedup discipline. Mutates `edges`. */
function appendConstructionEdges(
  cEdges: ConstructedEdge[],
  edges: Record<string, unknown>[],
  byId: Map<string, Record<string, unknown>>,
  dedup: DedupMode
): void {
  // Seed the dedup set from the EXISTING (base) edges so a construction edge that
  // duplicates a base edge is dropped — exactly as applyConstruction/overlayConstruction do.
  const directedSeen =
    dedup === 'directed'
      ? new Set(edges.map((e) => `${str(e.source)} ${str(e.target)} ${str(e.type)}`))
      : null
  const pairSeen =
    dedup === 'undirected' ? new Set(edges.map((e) => pairKey(str(e.source), str(e.target)))) : null

  for (const ce of cEdges) {
    if (ce.source === ce.target) continue // self
    if (!byId.has(ce.source) || !byId.has(ce.target)) continue // dangling
    const type = edgeType(ce)
    if (directedSeen) {
      const k = `${ce.source} ${ce.target} ${type}`
      if (directedSeen.has(k)) continue
      directedSeen.add(k)
    } else if (pairSeen) {
      const k = pairKey(ce.source, ce.target)
      if (pairSeen.has(k)) continue
      pairSeen.add(k)
    }
    edges.push({ source: ce.source, target: ce.target, type })
  }
}

/**
 * Merge the product/store graph into the node/edge set, deduped by id (base wins the
 * node slot, but the product UPDATES that node's label/kind in place — matching
 * liveGraph's overlayProductStore). When `canon`, node ids run through
 * normalizeStoreId and edge endpoints through normalizeEdgeEndpoint BEFORE the byId
 * lookup, so a `vault:/…` product node folds onto its base note relpath and an edge to
 * an unmapped id drops as dangling. Mutates `nodes`/`edges`/`byId`.
 */
function mergeProduct(
  product: GraphReadResult,
  nodes: Record<string, unknown>[],
  edges: Record<string, unknown>[],
  byId: Map<string, Record<string, unknown>>,
  canon: boolean
): void {
  // rawId → canonical id (built while normalizing nodes; reused for edge endpoints).
  const idMap = new Map<string, string>()

  for (const raw of product.nodes) {
    const rawId = str(raw.id)
    if (!rawId) continue
    const kind = raw.kind != null ? str(raw.kind) : 'stream'
    const id = canon ? normalizeStoreId(rawId, kind) : rawId
    if (!id) continue
    idMap.set(rawId, id)
    const title = raw.title != null ? str(raw.title) : ''
    const label = title || id
    const existing = byId.get(id)
    if (existing) {
      // Product is authoritative on a collision: update label/kind in place (no dup).
      existing.label = label
      existing.kind = kind
    } else {
      const node: Record<string, unknown> = { id, label, kind }
      nodes.push(node)
      byId.set(id, node)
    }
  }

  for (const e of product.edges) {
    if (!e) continue
    const src = canon ? normalizeEdgeEndpoint(str(e.src), idMap) : str(e.src)
    const dst = canon ? normalizeEdgeEndpoint(str(e.dst), idMap) : str(e.dst)
    if (!src || !dst || src === dst) continue // self (post-normalization) / empty
    if (!byId.has(src) || !byId.has(dst)) continue // dangling
    edges.push({ source: src, target: dst, type: e.type })
  }
}
