// graph-native — native replacement for the orphaned read-only duin.db product graph.
// readGraphNative(vault) returns the IDENTICAL GraphReadResult shape as
// the old duin.db readGraph, but re-sourced from the LIVE vault + .duin/_state
// loaders instead of the frozen SQLite snapshot. Phase C1-T1 of the store
// consolidation (PLANNING/DUIN_STORE_CONSOLIDATION_BUILD_PLAN.md).
//
// Ids are BARE (store id space) — kind-prefixing is a retrieval-surface concern
// (canonical-id.ts), NOT applied here. Consumers of readGraph get the same 6-key
// object so they need no reshape.
//
// Producer map (store kind → source):
//   move        ← future-nodes.jsonl  (buildStreamGraph, kind 'stream', declared 0)
//   milestone/event/release ← anchor decls (extendWithAnchors, kind 'anchor' relabelled)
//   insight     ← .duin/_state/insights.jsonl                     (declared 0)
//   track       ← DEFAULT_TRACKS / tracks.json (listTracks)
//   risk/issue  ← problems-native (problem→issue, risk→risk, owed dropped)
//   person/org  ← entities-native (id vault:/<rel>)
//   card/project/goal/action ← cards-native (net-new producers)
// Edges:
//   contains       track→move (bucketFuturesByTrack) + project→card (cardEdges)
//   feeds          move→anchor (EXPLICIT only; fuzzy inferred suppressed)
//   builds_toward  anchor→anchor (extendWithAnchors)
//   guides         goal→project (heuristic domain match — best-effort)
//   references     action→card (cardEdges)
import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import {
  listCards,
  listCardProjects,
  listNorthStarGoals,
  listActions,
  cardEdges,
  goalGuideEdges,
  loadGoalDomains,
  walkNotes,
  type StoreNode,
  type StoreEdge
} from './cards-native'
import { buildCausalGraph, readAnchorDecls } from './causal-substrate'
import { listTracks, bucketFuturesByTrack } from './tracks-native'
import { listProblems } from './problems-native'
import { listVaultEntities } from './entities-native'

/** The DUIN product/store graph read result — nodes + edges + rollups by kind/type.
 *  Re-homed here from the retired SQLite reader (C1-T3): graph-native is now
 *  the sole owner + producer, so nothing orphaned when the SQLite reader was deleted. */
export interface GraphReadResult {
  nodes: Record<string, unknown>[]
  edges: { src: string; dst: string; type: string }[]
  by_kind: Record<string, { declared: number; inferred: number }>
  by_edge: Record<string, number>
  node_count: number
  edge_count: number
}

const EMPTY: GraphReadResult = { nodes: [], edges: [], by_kind: {}, by_edge: {}, node_count: 0, edge_count: 0 }

const stripPrefix = (id: string): string => id.slice(id.indexOf(':') + 1)

/** insight nodes from .duin/_state/insights.jsonl (bare 8-hex ids, declared=0). */
function loadInsightNodes(vaultDir: string): StoreNode[] {
  let raw: string
  try {
    raw = readFileSync(join(vaultDir, '.duin', '_state', 'insights.jsonl'), 'utf-8')
  } catch {
    return []
  }
  const out: StoreNode[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const id = String(o.id ?? '').trim()
    if (!id) continue
    out.push({
      id,
      kind: 'insight',
      declared: 0,
      status: '',
      title: String(o.headline ?? o.title ?? ''),
      lane: String(o.track ?? ''),
      body: String(o.why ?? ''),
      provenance: `inferred:${String(o.type ?? 'insight')}`,
      confidence: typeof o.confidence === 'number' ? o.confidence : null,
      extra: { type: o.type ?? '', sources: o.sources ?? [], suggested_move: o.suggested_move ?? '' }
    })
  }
  return out
}

/** track nodes (declared=1) from listTracks. */
function loadTrackNodes(vaultDir: string): StoreNode[] {
  const res = listTracks(vaultDir) as {
    tracks: { id: string; label: string; goal?: string; lane?: string; status?: string; next_decide_by?: string; move_count?: number }[]
  }
  return res.tracks.map((t) => ({
    id: t.id,
    kind: 'track',
    declared: 1,
    status: t.status ?? '',
    title: t.label,
    lane: t.lane ?? '',
    decide_by: t.next_decide_by ?? '',
    extra: { goal: t.goal ?? '', move_count: t.move_count ?? 0 }
  }))
}

/** risk + issue nodes (declared=1) from problems-native. problem→issue, risk→risk;
 *  owed decisions are dropped (the frozen store carried no owed/decision kind). */
function loadProblemNodes(vaultDir: string): StoreNode[] {
  const KMAP: Record<string, string> = { risk: 'risk', problem: 'issue' }
  const out: StoreNode[] = []
  for (const n of listProblems(vaultDir).nodes) {
    const kind = KMAP[n.kind]
    if (!kind) continue
    out.push({
      id: n.id,
      kind,
      declared: 1,
      status: n.state || n.meta || '',
      title: n.title,
      body: n.detail || '',
      source_ref: n.path,
      extra: { links: n.links }
    })
  }
  return out
}

/** person + org nodes (declared=1) from entities-native — id kept as `vault:/<rel>`. */
function loadEntityNodes(vaultDir: string): StoreNode[] {
  const { people, orgs } = listVaultEntities(vaultDir)
  const mk = (e: { id?: string; name: string; kind: string; org: string }): StoreNode => ({
    id: String(e.id ?? ''),
    kind: e.kind,
    declared: 1,
    title: e.name,
    lane: e.org || '',
    source_ref: String(e.id ?? ''),
    extra: e.kind === 'person' ? { org: e.org, source: 'vault' } : { source: 'vault' }
  })
  return [...people, ...orgs].filter((e) => e.id).map(mk)
}

/** move + anchor(milestone/event/release) nodes and their feeds/builds_toward edges
 *  from the causal substrate. Only kind stream/anchor are kept (the substrate's
 *  driver/decision/outcome/step/gate/dependency/resource kinds are non-store). */
function loadCausalNodesEdges(vaultDir: string): { nodes: StoreNode[]; edges: StoreEdge[] } {
  const cg = buildCausalGraph(vaultDir)
  const declKind = new Map(readAnchorDecls(vaultDir).map((d) => [d.id, d.kind]))
  const nodes: StoreNode[] = []
  for (const n of cg.nodes) {
    if (n.kind === 'stream') {
      nodes.push({
        id: stripPrefix(n.id),
        kind: 'move',
        declared: 0,
        status: 'open',
        title: String(n.label ?? ''),
        lane: typeof n.track === 'string' ? n.track : '',
        decide_by: typeof n.decide_by === 'string' ? n.decide_by : '',
        target: typeof n.date === 'string' ? n.date : '',
        provenance: 'inferred:projection',
        extra: { anchor_id: n.anchor_id ?? '', steps: n.steps ?? [] }
      })
    } else if (n.kind === 'anchor') {
      const bare = stripPrefix(n.id)
      nodes.push({
        id: bare,
        kind: declKind.get(bare) ?? 'milestone',
        declared: 1,
        status: '',
        title: String(n.label ?? ''),
        lane: typeof n.track === 'string' ? n.track : '',
        target: typeof n.date === 'string' ? n.date : '',
        extra: { kind: declKind.get(bare) ?? 'milestone' }
      })
    }
  }
  const edges: StoreEdge[] = []
  for (const e of cg.edges) {
    if (e.type === 'feeds') {
      if (e.explicit !== true) continue // suppress the fuzzy inferred:true feeds
      edges.push({ src: stripPrefix(e.source), dst: stripPrefix(e.target), type: 'feeds' })
    } else if (e.type === 'builds_toward') {
      edges.push({ src: stripPrefix(e.source), dst: stripPrefix(e.target), type: 'builds_toward' })
    }
  }
  return { nodes, edges }
}

/**
 * Native read of the DUIN product/store graph, at the identical GraphReadResult shape
 * readGraph returns — assembled live from every native producer instead of the frozen
 * duin.db. Bare id space. Pure; returns EMPTY for a null/empty vault.
 */
export function readGraphNative(vault: string | null): GraphReadResult {
  if (!vault) return EMPTY

  // ONE vault walk, shared by every card-layer producer. Before this, listCards,
  // listCardProjects (via listCards), listActions and cardEdges each re-walked
  // the entire vault synchronously — five full walks per graph build, all on the
  // main thread, inside the rebuild the operator's surface-open just scheduled.
  const notes = walkNotes(vault)

  const causal = loadCausalNodesEdges(vault)
  const projects = listCardProjects(vault, notes)
  const goals = listNorthStarGoals(vault)

  const nodeGroups: StoreNode[][] = [
    causal.nodes,
    loadInsightNodes(vault),
    loadTrackNodes(vault),
    loadProblemNodes(vault),
    loadEntityNodes(vault),
    listCards(vault, notes),
    projects,
    goals,
    listActions(vault, notes)
  ]

  // Assemble nodes (dedup by bare id, first-wins).
  const byId = new Map<string, StoreNode>()
  for (const group of nodeGroups) {
    for (const n of group) {
      const id = String(n.id ?? '').trim()
      if (!id || byId.has(id)) continue
      byId.set(id, n)
    }
  }

  // Assemble edges, then drop any whose endpoint isn't a node (no dangling).
  const rawEdges: StoreEdge[] = [
    ...causal.edges,
    ...bucketFuturesByTrack(vault).map((b) => ({ src: b.trackId, dst: b.futureId, type: 'contains' })),
    ...cardEdges(vault, notes),
    ...goalGuideEdges(goals, projects, loadGoalDomains(vault))
  ]
  const edges: StoreEdge[] = []
  for (const e of rawEdges) {
    if (!e || !e.src || !e.dst || e.src === e.dst) continue
    if (!byId.has(e.src) || !byId.has(e.dst)) continue
    edges.push({ src: e.src, dst: e.dst, type: e.type })
  }

  const nodes = [...byId.values()]
  const by_kind: Record<string, { declared: number; inferred: number }> = {}
  for (const n of nodes) {
    if (!by_kind[n.kind]) by_kind[n.kind] = { declared: 0, inferred: 0 }
    by_kind[n.kind][n.declared ? 'declared' : 'inferred'] += 1
  }
  const by_edge: Record<string, number> = {}
  for (const e of edges) by_edge[e.type] = (by_edge[e.type] ?? 0) + 1

  return {
    nodes: nodes as Record<string, unknown>[],
    edges,
    by_kind,
    by_edge,
    node_count: nodes.length,
    edge_count: edges.length
  }
}

/**
 * Cache key for the native product graph: the MAX mtime (ms) over the live inputs
 * readGraphNative reads, replacing the retired duin.db mtime. Returns 0 when the
 * vault is null or none of the inputs exist.
 *
 * Covers the machine-written hot files (future-nodes.jsonl, insights.jsonl, and the
 * other .duin/_state jsonl) directly, and the scattered markdown/JSON sources (GOALS.md,
 * _agui_entities.json, _Owed-Decisions.md, anchor decls, card notes) via their containing
 * directories — a directory's mtime bumps on child add/remove. An in-place nested edit
 * a directory mtime alone would miss is backstopped by the consumer's revalidate age:
 * /graph still uses a 30s TTL, while /state/brain-graph now re-checks after 5 minutes
 * and rebuilds in the background rather than expiring the entry (see swr-json-cache.ts).
 */
export function nativeGraphMtime(vault: string | null): number {
  if (!vault) return 0
  const state = join(vault, '.duin', '_state')
  const candidates = [
    vault, // top-level add/remove (cards, entities, GOALS.md siblings)
    state, // _state churn (jsonl add/remove)
    join(state, 'future-nodes.jsonl'),
    join(state, 'channel-futures.jsonl'),
    join(state, 'insights.jsonl'),
    join(state, 'channel-anchors.jsonl'),
    join(vault, 'GOALS.md'),
    join(vault, '_agui_entities.json'),
    join(vault, '03 Projects'), // anchor decls + card/action notes
    join(vault, '05 Decisions', '_Owed-Decisions.md')
  ]
  let max = 0
  for (const p of candidates) {
    try {
      const m = statSync(p).mtimeMs
      if (m > max) max = m
    } catch {
      /* missing input — skip */
    }
  }
  return max
}
