// Brain Health benchmark (4-axis) — a mostly-DETERMINISTIC scorer over the live
// brain graph that turns the invariants in DUIN_BRAIN_GRAPH_ARCHITECTURE_AND_
// IDENTITY_SPINE.md into a runnable number. It answers "is the brain graph
// coherent, grounded, fresh, and clean?" the same way capability-gap.ts answers
// "where am I weak" — a PURE core (`computeBrainHealth`) over INJECTED deps, plus
// a thin live loader (`computeBrainHealthLive`, in brain-health-live.ts) that
// gathers those deps from the running app.
//
// The four axes map onto the doc's invariants:
//   COHERENCE  → I1 (one entity = one node) + I2 (entity↔note) + I6 (one graph)
//   GROUNDING  → the retrieval moat (§4): multi-hop reachability + citable neighbours
//   FRESHNESS  → the three clocks (§1): index / construction / cascade / learning
//   PURITY     → I4/I8 (no machine-scaffolding or prompt-echo as knowledge)
//
// PURITY of the CORE is the whole point: `computeBrainHealth` performs NO I/O, no
// Date.now()/new Date() (the report time is injected as `builtAt`), no DB reads —
// every signal arrives pre-loaded in `deps`, so each axis scorer unit-tests
// against a hand-built fixture. clusterAliases (claim-entities) is the only import
// and it is itself pure (type-only deps).

import { clusterAliases } from './claim-entities'
import { CJK_CLASS } from './cjk-tokens'

// ──────────────────── injected shapes (minimal, source-compatible) ────────────

/** A graph node — compatible with both BrainGraph (brain-graph-native) nodes and
 *  the retriever's GraphView nodes. Only `id` is required; the rest sharpen the
 *  scoring when present. */
export interface HealthNode {
  id: string
  kind?: string
  label?: string
  /** brain-graph layer, when present: 'core' | 'product' | 'vault' | 'construction' | 'folder'. */
  layer?: string
}
export interface HealthEdge {
  source: string
  target: string
  type?: string
}
export interface HealthGraph {
  nodes: HealthNode[]
  edges: HealthEdge[]
}

/** One construction entity, as cached in brain-construction.json (before the
 *  builder deletes `note` at construct.ts:308-313). */
export interface HealthEntity {
  id: string
  kind?: string
  label: string
  /** The provenance note relpath — the bridge back to the identity spine. */
  note?: string
}

export interface HealthConstruction {
  entities: HealthEntity[]
  /** ISO timestamp the construction cache was built (for constructionAgeMin). */
  builtAt?: string | null
}

export interface HealthIndexStats {
  /** Distinct note files currently indexed (index-store indexedCount()). */
  indexedNoteFiles: number
  /** Distinct chunk-FILES in the chunk store — the 283-vs-50 pollution signal. */
  indexedChunkFiles: number
  /** Real note files walked on disk (the clean denominator). */
  vaultNoteFiles: number
}

export interface HealthLiveness {
  /** Is /state/store-graph sourced live (readGraphNative) vs a frozen snapshot? */
  storeGraphLive: boolean
  /** Count of learning verdicts / active forecast patterns firing (ledgers). */
  learningResolved: number
}

export interface BrainHealthDeps {
  /** Report time — INJECTED (the pure fn never calls Date.now()/new Date()). */
  builtAt: string
  /** The assembled brain graph (BrainGraph or GraphView), adapted to {nodes,edges}. */
  graph: HealthGraph
  /** The construction cache (entities + builtAt); null when nothing built. */
  construction: HealthConstruction | null
  index: HealthIndexStats
  liveness: HealthLiveness
  /** OPTIONAL embeddings aligned to the DISTINCT entity labels (dedup by cosine
   *  clustering). Absent ⇒ deterministic normalized-label fallback. */
  entityVecs?: number[][] | null
  /** OPTIONAL id-stability Jaccard vs the newest construction backup. Absent ⇒ skipped. */
  idStabilityJaccard?: number | null
  /** OPTIONAL grounding seeds; absent ⇒ auto-derive the top-degree note nodes. */
  seeds?: string[] | null
  /** OPTIONAL axis-weight override (defaults below). */
  weights?: Partial<AxisWeights>
}

// ──────────────────── report shape ────────────────────

export interface AxisReport {
  score: number // 0-100
  metrics: Record<string, number>
  notes: string
}
export interface BrainHealthReport {
  overall: number // 0-100 weighted avg of the 4 axes
  weakestAxis: string
  axes: {
    coherence: AxisReport
    grounding: AxisReport
    freshness: AxisReport
    purity: AxisReport
  }
  builtAt: string
}

export interface AxisWeights {
  coherence: number
  grounding: number
  freshness: number
  purity: number
}

// Axis weights (document + overrideable). Coherence + purity dominate because the
// identity-spine defects (I1/I2/I4) are the root of every downstream symptom; the
// retrieval moat (grounding) is the payoff; freshness is a liveness sanity floor.
export const DEFAULT_AXIS_WEIGHTS: AxisWeights = {
  coherence: 0.3,
  grounding: 0.25,
  freshness: 0.2,
  purity: 0.25
}

// ──────────────────── small pure helpers ────────────────────

const clamp = (x: number, lo = 0, hi = 100): number => (x < lo ? lo : x > hi ? hi : x)
const round1 = (x: number): number => Math.round(x * 10) / 10
const round3 = (x: number): number => Math.round(x * 1000) / 1000

/** Weighted average of {score,weight} pairs; ignores zero-weight terms. */
function weightedAvg(parts: { score: number; weight: number }[]): number {
  let s = 0
  let w = 0
  for (const p of parts) {
    if (p.weight <= 0) continue
    s += p.score * p.weight
    w += p.weight
  }
  return w === 0 ? 0 : s / w
}

/** Everything that is NOT alphanumeric or CJK. The CJK side is the tokenizer's full
 *  class (kanji + KANA), not the bare ideograph range — a pure-kana label (まとめ)
 *  otherwise normalized to '' and folded onto every other kana-only label. */
const NORM_LABEL_STRIP_RE = new RegExp(`[^a-z0-9${CJK_CLASS}]`, 'g')

/** Normalize a label for exact/near dedup: lowercase, strip everything but
 *  alphanumerics + CJK (so "PartnerCo", "PartnerCo.", "《PartnerCo》" fold). */
export function normLabel(s: string): string {
  return (s ?? '').toLowerCase().replace(NORM_LABEL_STRIP_RE, '')
}

/** A node is a NOTE (a real vault file / spine anchor) when it's vault-layer, a
 *  'note'-kind node, or its id is a .md relpath. */
export function isNoteNode(n: HealthNode): boolean {
  return n.layer === 'vault' || n.kind === 'note' || /\.md$/i.test(n.id)
}

/** Entity kinds a construction pass mints (used to detect entity-neighbours). */
const ENTITY_KINDS = new Set(['person', 'org', 'project', 'topic', 'decision', 'event'])
/** A NON-folded construction entity: a construction-layer node, or an entity-kind
 *  node whose id is NOT already a note relpath (a folded entity IS its note node,
 *  so it counts as a note, not an entity, for grounding). Synthetic layout hubs
 *  (⑦ — __folder__/__projidx__/__idx__/CORE) are layout scaffolding, NOT entities,
 *  so they are excluded from every entity metric (explicit guard; they already fail
 *  the kind/layer test, but this makes the invariant load-bearing + regression-proof). */
function isEntityNode(n: HealthNode): boolean {
  if (isNoteNode(n)) return false
  if (isLayoutHub(n)) return false
  return n.layer === 'construction' || (n.kind !== undefined && ENTITY_KINDS.has(n.kind))
}

/** Undirected adjacency over the edge set (endpoints must be real nodes). */
function buildAdj(graph: HealthGraph): Map<string, string[]> {
  const ids = new Set(graph.nodes.map((n) => n.id))
  const adj = new Map<string, string[]>()
  for (const n of graph.nodes) adj.set(n.id, [])
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) continue
    adj.get(e.source)!.push(e.target)
    adj.get(e.target)!.push(e.source)
  }
  return adj
}

/** Connected components (undirected). Returns the largest component as a Set plus
 *  all component sizes (descending). PURE + deterministic. */
export function connectedComponents(graph: HealthGraph): { main: Set<string>; sizes: number[] } {
  const adj = buildAdj(graph)
  const seen = new Set<string>()
  let main = new Set<string>()
  const sizes: number[] = []
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const comp = new Set<string>([start])
    seen.add(start)
    const stack = [start]
    while (stack.length) {
      const u = stack.pop()!
      for (const v of adj.get(u) ?? []) {
        if (!seen.has(v)) {
          seen.add(v)
          comp.add(v)
          stack.push(v)
        }
      }
    }
    sizes.push(comp.size)
    if (comp.size > main.size) main = comp
  }
  sizes.sort((a, b) => b - a)
  return { main, sizes }
}

/** Degree of every node (undirected, self/dangling-safe). */
export function nodeDegrees(graph: HealthGraph): Map<string, number> {
  const deg = new Map<string, number>()
  for (const n of graph.nodes) deg.set(n.id, 0)
  for (const e of graph.edges) {
    if (deg.has(e.source)) deg.set(e.source, deg.get(e.source)! + 1)
    if (deg.has(e.target)) deg.set(e.target, deg.get(e.target)! + 1)
  }
  return deg
}

/** Distinct NOTE nodes reachable from `seedId` within `k` undirected hops — the
 *  same bounded bidirectional expansion the deterministic retriever's graphExpand
 *  uses (k=2), reimplemented pure so the core needs no index-store import. The
 *  seed itself is excluded. */
export function reachableNotes(graph: HealthGraph, seedId: string, k = 2): Set<string> {
  const adj = buildAdj(graph)
  const noteIds = new Set(graph.nodes.filter(isNoteNode).map((n) => n.id))
  const reached = new Set<string>()
  const dist = new Map<string, number>([[seedId, 0]])
  let frontier = [seedId]
  for (let d = 1; d <= k; d++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        if (dist.has(v)) continue
        dist.set(v, d)
        next.push(v)
        if (v !== seedId && noteIds.has(v)) reached.add(v)
      }
    }
    frontier = next
  }
  return reached
}

/** ⑧ Entity-reachability (the moat-unlock sub-signal). Multi-source BFS OUTWARD from
 *  every NOTE node; returns the set of ENTITY nodes reached within `k` undirected hops
 *  — i.e. the entities woven into the note graph (reachable from a citable note). Before
 *  the identity spine (P1 entity→note edge) entities are orphaned and this set is ~empty;
 *  after it, whitelisted duplicates collapse and every entity tethers to its provenance
 *  note, so the fraction climbs. O(V+E) — adjacency built ONCE (not per-entity). PURE. */
export function reachableEntitiesFromNotes(graph: HealthGraph, k = 2): Set<string> {
  const adj = buildAdj(graph)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const noteIds = graph.nodes.filter(isNoteNode).map((n) => n.id)
  const reachedEntities = new Set<string>()
  const dist = new Map<string, number>()
  for (const id of noteIds) dist.set(id, 0)
  let frontier = noteIds
  for (let d = 1; d <= k; d++) {
    const next: string[] = []
    for (const u of frontier) {
      for (const v of adj.get(u) ?? []) {
        if (dist.has(v)) continue
        dist.set(v, d)
        next.push(v)
        const n = byId.get(v)
        if (n && isEntityNode(n)) reachedEntities.add(v)
      }
    }
    frontier = next
  }
  return reachedEntities
}

/** Count distinct real entities among `labels` by clustering. Uses the semantic
 *  clusterAliases (cosine + union-find) when aligned `vecs` are supplied; else
 *  falls back to a deterministic normalized-label fold. PURE. */
export function distinctEntityCount(labels: string[], vecs?: number[][] | null): number {
  if (labels.length === 0) return 0
  if (vecs && vecs.length === labels.length) {
    // Semantic clustering → number of distinct canonical labels.
    const map = clusterAliases(labels, vecs)
    return new Set(map.values()).size
  }
  // Deterministic fallback: distinct normalized labels.
  return new Set(labels.map(normLabel)).size
}

// Prompt-echo / prototype fixtures that must never appear as real knowledge (I8):
// the construct.ts:165 `jordan-lee` few-shot plus the eval-harness synthetic nodes.
const FIXTURE_RE = /(?:^|[:/\s-])(?:jordan-lee|prototype-v2|artifact-a|note-a|ghost)(?:$|[:/\s-])/i
/** A node id/label derived from `_`-prefixed machine-scaffolding (I4). */
function isScaffoldId(id: string): boolean {
  // Match the indexer's exclusion policy exactly (identity-spine P5, "machine files only"):
  // ONLY `_`-prefixed BASENAMES are scaffolding (machine files — _dashboard/_metrics/_log/
  // _prototype-*/_concept-index). `DUIN/Meta/` design cards are REAL knowledge and are NOT
  // flagged — dropping the old DUIN/Meta clause stops purity penalizing those kept cards.
  // Do NOT flag `_`-prefixed DIRECTORIES holding legit content with normal filenames
  // (ProjectA/…/_原始转录/*.md, 半导体/…/_ocr/*.md) — those are real notes, not scaffolding.
  const base = id.split('/').pop() || id
  return base.startsWith('_')
}
/** A synthetic layout hub, not a knowledge node (I4 / ⑦). */
function isLayoutHub(n: HealthNode): boolean {
  return (
    n.kind === 'core' ||
    n.layer === 'core' ||
    n.layer === 'folder' ||
    /^(?:__|CORE$|__folder__|__projidx__|__idx__)/.test(n.id) ||
    n.id.startsWith('__')
  )
}

// ──────────────────── axis scorers (each PURE, each unit-testable) ────────────

/**
 * COHERENCE — identity integrity (I1/I2/I6).
 * - dedupRate            = 1 − distinctRealEntities/totalEntities (higher ⇒ worse)
 * - entityNoteConnectivity = fraction of entities whose `note` resolves to a real
 *   note node AND whose entity node sits in the main component (the KILLER metric;
 *   ≈0 today because the note bridge is deleted at construct.ts:308-313)
 * - mainComponentFraction = largest CC / all nodes
 * - idStability (optional) = Jaccard of entity-id sets vs the newest backup
 */
export function scoreCoherence(deps: BrainHealthDeps): AxisReport {
  const ents = deps.construction?.entities ?? []
  const total = ents.length

  // dedup
  const distinct = distinctEntityCount(ents.map((e) => e.label), deps.entityVecs)
  const dedupRate = total > 0 ? 1 - distinct / total : 0
  // 0 dupes → 100; a 20% duplicate fraction → 0 (linear).
  const dedupScore = clamp(100 * (1 - dedupRate / 0.2))

  // entity→note connectivity
  const { main, sizes } = connectedComponents(deps.graph)
  const nodeIds = new Set(deps.graph.nodes.map((n) => n.id))
  const noteIds = new Set(deps.graph.nodes.filter(isNoteNode).map((n) => n.id))
  const noteBasenames = new Set([...noteIds].map((id) => id.slice(id.lastIndexOf('/') + 1)))
  const resolvesNote = (note?: string): boolean => {
    if (!note) return false
    if (noteIds.has(note)) return true
    const base = note.slice(note.lastIndexOf('/') + 1)
    return noteBasenames.has(base)
  }
  let connected = 0
  for (const e of ents) {
    if (resolvesNote(e.note) && nodeIds.has(e.id) && main.has(e.id)) connected++
  }
  const entityNoteConnectivity = total > 0 ? connected / total : 0
  const connScore = clamp(100 * entityNoteConnectivity)

  // main component fraction
  const allNodes = deps.graph.nodes.length
  const mainComponentFraction = allNodes > 0 ? main.size / allNodes : 0
  const mainScore = clamp(100 * mainComponentFraction)

  // id stability (optional)
  const hasStability = typeof deps.idStabilityJaccard === 'number'
  const idStability = hasStability ? (deps.idStabilityJaccard as number) : 0
  const stabScore = clamp(100 * idStability)

  const score = weightedAvg([
    { score: connScore, weight: 0.45 },
    { score: dedupScore, weight: 0.25 },
    { score: mainScore, weight: 0.2 },
    { score: stabScore, weight: hasStability ? 0.1 : 0 }
  ])

  return {
    score: round1(score),
    metrics: {
      dedupRate: round3(dedupRate),
      totalEntities: total,
      distinctEntities: distinct,
      entityNoteConnectivity: round3(entityNoteConnectivity),
      mainComponentFraction: round3(mainComponentFraction),
      componentCount: sizes.length,
      ...(hasStability ? { idStability: round3(idStability) } : {})
    },
    notes:
      total === 0
        ? 'no construction entities — coherence unmeasurable from entities (component-only)'
        : `${connected}/${total} entities reach the spine (in-main + note-resolved); ${sizes.length} components; dedup ${(dedupRate * 100).toFixed(1)}%`
  }
}

/**
 * GROUNDING — the retrieval moat (§4).
 * - reachability          = avg distinct notes reachable at k=2 from the seed set
 * - citableNeighborFraction = fraction of the seeds' ENTITY neighbours whose id
 *   resolves to a citable note id (low today — entities aren't note ids)
 * - entityReachability (⑧ v1.1) = fraction of ALL graph entities reachable from a
 *   note node within k=2 hops. The seed-local reach + citable signals SATURATE at 100
 *   (a well-connected vault reaches hundreds of notes; only ~6 entity-neighbours exist),
 *   so P1/P2's GLOBAL identity-spine connectivity gain was invisible. This global
 *   sub-signal registers it: ~0 when entities are orphaned (pre-spine), climbing as the
 *   entity→note edge tethers every entity and dedup collapses the churning fragments.
 * Model-backed spRecallAtK is opt-in (deep=1) and NOT part of this deterministic core.
 */
export function scoreGrounding(deps: BrainHealthDeps): AxisReport {
  const graph = deps.graph
  const deg = nodeDegrees(graph)
  // Auto-derive seeds: top-degree NOTE nodes (deterministic tie-break by id).
  const SEED_N = 8
  let seedIds: string[]
  if (deps.seeds && deps.seeds.length) {
    seedIds = deps.seeds.slice()
  } else {
    seedIds = graph.nodes
      .filter(isNoteNode)
      .sort((a, b) => (deg.get(b.id)! - deg.get(a.id)!) || (a.id < b.id ? -1 : 1))
      .slice(0, SEED_N)
      .map((n) => n.id)
  }

  // reachability
  let reachSum = 0
  for (const s of seedIds) reachSum += reachableNotes(graph, s, 2).size
  const avgReach = seedIds.length ? reachSum / seedIds.length : 0
  const REACH_TARGET = 25 // distinct notes at k=2 is a well-connected seed
  const reachScore = clamp(100 * (avgReach / REACH_TARGET))

  // citable entity-neighbours: 1-hop neighbours of the seeds that are ENTITY nodes,
  // and of those the fraction that RESOLVE to a citable note — i.e. the entity is
  // tethered to at least one note node (the entity→note bridge). Today the bridge
  // is deleted (construct.ts:308-313) so entities are orphaned and none are citable.
  const adj = buildAdj(graph)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const noteIds = new Set(graph.nodes.filter(isNoteNode).map((n) => n.id))
  const seedSet = new Set(seedIds)
  const entityNeighbours = new Set<string>()
  for (const s of seedIds) {
    for (const v of adj.get(s) ?? []) {
      if (seedSet.has(v)) continue
      const n = byId.get(v)
      if (n && isEntityNode(n)) entityNeighbours.add(v)
    }
  }
  const resolvesToNote = (entityId: string): boolean => {
    if (noteIds.has(entityId)) return true // a folded entity id IS a note
    for (const v of adj.get(entityId) ?? []) if (noteIds.has(v)) return true // tethered to a note
    return false
  }
  let citable = 0
  for (const id of entityNeighbours) if (resolvesToNote(id)) citable++
  const citableNeighborFraction = entityNeighbours.size ? citable / entityNeighbours.size : 0
  const citableScore = entityNeighbours.size ? clamp(100 * citableNeighborFraction) : 0

  // ⑧ entity-reachability (v1.1): GLOBAL fraction of entities woven into the note graph.
  const entityNodeCount = graph.nodes.filter(isEntityNode).length
  const reachedEntities = entityNodeCount ? reachableEntitiesFromNotes(graph, 2).size : 0
  const entityReachability = entityNodeCount ? reachedEntities / entityNodeCount : 0
  const entityReachScore = clamp(100 * entityReachability)
  // Dynamic weight: the sub-signal only participates when the graph HAS entities (mirrors
  // the idStability pattern), so an entity-free synthetic fixture isn't penalized.
  const hasEntities = entityNodeCount > 0

  const score = weightedAvg([
    { score: reachScore, weight: 0.5 },
    { score: citableScore, weight: 0.2 },
    { score: entityReachScore, weight: hasEntities ? 0.3 : 0 }
  ])

  return {
    score: round1(score),
    metrics: {
      seedCount: seedIds.length,
      avgNotesReachedK2: round1(avgReach),
      entityNeighbours: entityNeighbours.size,
      citableNeighborFraction: round3(citableNeighborFraction),
      entityNodes: entityNodeCount,
      entityReachability: round3(entityReachability)
    },
    notes: entityNeighbours.size
      ? `seeds reach ${round1(avgReach)} notes @k2; ${citable}/${entityNeighbours.size} entity-neighbours citable; ${reachedEntities}/${entityNodeCount} entities reachable from a note @k2`
      : `seeds reach ${round1(avgReach)} notes @k2; ${reachedEntities}/${entityNodeCount} entities reachable from a note @k2 (seeds reach no entity-neighbours directly)`
  }
}

/**
 * FRESHNESS — liveness of the three clocks (§1).
 * - indexCoverage       = indexed note files / vault note files
 * - constructionAgeMin  = (builtAt − construction.builtAt), scored vs the ~30min cadence
 * - cascadeLive         = store graph sourced live (not a frozen snapshot)
 * - learningActivity    = forecast/calibration verdicts firing
 */
export function scoreFreshness(deps: BrainHealthDeps): AxisReport {
  const { indexedNoteFiles, vaultNoteFiles } = deps.index

  const indexCoverage = vaultNoteFiles > 0 ? Math.min(1, indexedNoteFiles / vaultNoteFiles) : 0
  const coverageScore = clamp(100 * indexCoverage)

  // construction age
  const cBuilt = deps.construction?.builtAt
  let constructionAgeMin = Number.NaN
  let ageScore = 0
  if (cBuilt) {
    const ageMs = Date.parse(deps.builtAt) - Date.parse(cBuilt)
    constructionAgeMin = ageMs / 60000
    if (!Number.isFinite(constructionAgeMin)) {
      ageScore = 0
    } else if (constructionAgeMin <= 30) {
      ageScore = 100 // within cadence (or a future-clock skew) → fresh
    } else {
      // linear decay 30min → 180min (3h) → 0
      ageScore = clamp(100 * (1 - (constructionAgeMin - 30) / 150))
    }
  }

  const cascadeLive = deps.liveness.storeGraphLive
  const cascadeScore = cascadeLive ? 100 : 0

  const learningResolved = deps.liveness.learningResolved
  // presence-graded: ≥5 active verdicts/patterns → full marks
  const learnScore = clamp(100 * (learningResolved / 5))

  const score = weightedAvg([
    { score: coverageScore, weight: 0.35 },
    { score: ageScore, weight: 0.3 },
    { score: cascadeScore, weight: 0.2 },
    { score: learnScore, weight: 0.15 }
  ])

  return {
    score: round1(score),
    metrics: {
      indexCoverage: round3(indexCoverage),
      indexedNoteFiles,
      vaultNoteFiles,
      constructionAgeMin: Number.isFinite(constructionAgeMin) ? round1(constructionAgeMin) : -1,
      cascadeLive: cascadeLive ? 1 : 0,
      learningResolved
    },
    notes: `index ${(indexCoverage * 100).toFixed(0)}%; construction ${
      Number.isFinite(constructionAgeMin) ? round1(constructionAgeMin) + 'min old' : 'age unknown'
    }; cascade ${cascadeLive ? 'live' : 'FROZEN'}; ${learningResolved} learning verdicts`
  }
}

/**
 * PURITY — hygiene (I4/I8).
 * - scaffoldingLeak = nodes derived from `_`/DUIN-Meta scaffolding OR prompt-echo
 *   fixtures (jordan-lee, prototype-v2, artifact-a, note-a, ghost) — each a demerit
 * - staleChunkRatio = indexed chunk-FILES / real note files (283-vs-50); →1 healthier
 * - degree0Junk     = non-core, non-hub degree-0 nodes
 */
export function scorePurity(deps: BrainHealthDeps): AxisReport {
  const nodes = deps.graph.nodes
  const total = nodes.length || 1

  // scaffolding + fixture leak
  let scaffoldLeak = 0
  let fixtureLeak = 0
  for (const n of nodes) {
    const hay = `${n.id} ${n.label ?? ''}`
    if (FIXTURE_RE.test(hay)) fixtureLeak++
    else if (isScaffoldId(n.id)) scaffoldLeak++
  }
  // also count fixture-echo entities that never became graph nodes (construction-only)
  for (const e of deps.construction?.entities ?? []) {
    const hay = `${e.id} ${e.label}`
    if (FIXTURE_RE.test(hay) && !deps.graph.nodes.some((n) => n.id === e.id)) fixtureLeak++
  }
  const leakCount = scaffoldLeak + fixtureLeak
  const leakFraction = leakCount / total
  // fraction-based: a 15% scaffolding share → 0. Fixtures are weighted 3× (a
  // prompt-echo is a worse smell than an indexed _concept-index file).
  const weightedLeakFraction = (scaffoldLeak + fixtureLeak * 3) / total
  const leakScore = clamp(100 * (1 - weightedLeakFraction / 0.15))

  // stale chunk ratio
  const { indexedChunkFiles, vaultNoteFiles } = deps.index
  const staleChunkRatio = vaultNoteFiles > 0 ? indexedChunkFiles / vaultNoteFiles : 1
  // symmetric distance from the ideal 1.0: over-indexing (stale) AND under-indexing both hurt.
  const staleScore = clamp(100 * Math.min(1, staleChunkRatio === 0 ? 0 : Math.min(staleChunkRatio, 1 / staleChunkRatio)))

  // degree-0 junk (excluding core + layout hubs)
  const deg = nodeDegrees(deps.graph)
  let degree0Junk = 0
  for (const n of nodes) {
    if ((deg.get(n.id) ?? 0) !== 0) continue
    if (isLayoutHub(n)) continue
    degree0Junk++
  }
  const junkFraction = degree0Junk / total
  // 10% orphan share → 0.
  const junkScore = clamp(100 * (1 - junkFraction / 0.1))

  const score = weightedAvg([
    { score: leakScore, weight: 0.4 },
    { score: staleScore, weight: 0.35 },
    { score: junkScore, weight: 0.25 }
  ])

  return {
    score: round1(score),
    metrics: {
      scaffoldingLeak: leakCount,
      scaffoldNodes: scaffoldLeak,
      fixtureLeak,
      leakFraction: round3(leakFraction),
      staleChunkRatio: round3(staleChunkRatio),
      indexedChunkFiles,
      degree0Junk
    },
    notes: `${leakCount} scaffolding/fixture leaks (${fixtureLeak} prompt-echo); stale-chunk ratio ${round3(
      staleChunkRatio
    )}; ${degree0Junk} orphan junk nodes`
  }
}

// ──────────────────── the pure benchmark ────────────────────

/**
 * Compute the 4-axis Brain Health report from INJECTED deps. PURE + deterministic:
 * no I/O, no clock reads (the report time is `deps.builtAt`). Every axis degrades
 * gracefully on sparse/empty inputs (never throws).
 */
export function computeBrainHealth(deps: BrainHealthDeps): BrainHealthReport {
  const weights: AxisWeights = { ...DEFAULT_AXIS_WEIGHTS, ...(deps.weights ?? {}) }

  const coherence = scoreCoherence(deps)
  const grounding = scoreGrounding(deps)
  const freshness = scoreFreshness(deps)
  const purity = scorePurity(deps)

  const overall = weightedAvg([
    { score: coherence.score, weight: weights.coherence },
    { score: grounding.score, weight: weights.grounding },
    { score: freshness.score, weight: weights.freshness },
    { score: purity.score, weight: weights.purity }
  ])

  const axisScores: [string, number][] = [
    ['coherence', coherence.score],
    ['grounding', grounding.score],
    ['freshness', freshness.score],
    ['purity', purity.score]
  ]
  const weakestAxis = axisScores.reduce((min, cur) => (cur[1] < min[1] ? cur : min))[0]

  return {
    overall: round1(overall),
    weakestAxis,
    axes: { coherence, grounding, freshness, purity },
    builtAt: deps.builtAt
  }
}
