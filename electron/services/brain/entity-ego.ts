// entity-ego — PURE assembly of the Relations surface's ego graph.
//
// The persistent entity plane had no read shape a UI could render: neighborsOf/parentsOf return
// bare id strings (no label, no kind, no edge type). This module walks the plane through injected
// lookups and returns a hydrated, CAPPED subgraph — caps are the contract (the panel must never
// receive the whole-vault hairball; when clipped it says so via stats.truncated and the UI renders
// "+N clipped" instead of pretending completeness).
//
// PURE + injected I/O, same discipline as the seam: deps carry edgesOf/nodesByIds so tests run on
// fixtures and production wires entity-graph-store. The beliefs join reuses matchEntities — ONE
// matching rule set across seam projection and this surface.

import { matchEntities, type EntityCatalogEntry } from './concept-materialize'
import type { CatalogAliasGroup } from './concept-materialize'
import { edgesOf, nodesByIds, findNodeIdByLabel, type EntityEdgeRow } from './entity-graph-store'
import { loadAliasGroups, activeAliasGroups } from './entity-resolver'
import { getOperatorFacts, isFactLive, type OperatorFact } from './operator-model'

export interface EgoDeps {
  edgesOf: (id: string) => EntityEdgeRow[]
  nodesByIds: (ids: string[]) => Array<{ id: string; label: string; kind: string; source: string }>
}

export interface EgoNode {
  id: string
  label: string
  kind: string
  source: string
  beliefCount?: number
}

export interface EgoEdge {
  src: string
  dst: string
  type: string
  /** Direction relative to the node the edge was DISCOVERED from (the anchor at hop 1). */
  dir: 'in' | 'out'
}

export interface EgoGraph {
  anchor: string
  nodes: EgoNode[]
  edges: EgoEdge[]
  stats: { nodes: number; edges: number; truncated: boolean }
}

const DEPTH_MAX = 3
const PER_NODE_CAP_DEFAULT = 40
const TOTAL_CAP_DEFAULT = 400

/** BFS from `anchor` to `depth` hops, deterministic (edges sorted by type→src→dst before the
 *  per-node cap applies), deduped, capped. Unknown anchor ⇒ empty graph, never a throw. */
export function buildEntityEgoGraph(
  anchor: string,
  deps: EgoDeps,
  opts?: { depth?: number; perNodeCap?: number; totalCap?: number }
): EgoGraph {
  const depth = Math.max(1, Math.min(DEPTH_MAX, opts?.depth ?? 1))
  const perNodeCap = Math.max(1, opts?.perNodeCap ?? PER_NODE_CAP_DEFAULT)
  const totalCap = Math.max(1, opts?.totalCap ?? TOTAL_CAP_DEFAULT)

  const [anchorRow] = deps.nodesByIds([anchor])
  if (!anchorRow) {
    return { anchor, nodes: [], edges: [], stats: { nodes: 0, edges: 0, truncated: false } }
  }

  const nodeIds = new Set<string>([anchor])
  const edges: EgoEdge[] = []
  const seenEdge = new Set<string>()
  let truncated = false
  let frontier = [anchor]

  for (let hop = 0; hop < depth && frontier.length; hop++) {
    const next: string[] = []
    for (const at of frontier) {
      const incident = deps
        .edgesOf(at)
        .slice()
        .sort((a, b) =>
          a.type < b.type ? -1 : a.type > b.type ? 1 : a.src < b.src ? -1 : a.src > b.src ? 1 : a.dst < b.dst ? -1 : 1
        )
      if (incident.length > perNodeCap) truncated = true
      for (const e of incident.slice(0, perNodeCap)) {
        const key = `${e.src}|${e.dst}|${e.type}`
        if (seenEdge.has(key)) continue
        const other = e.src === at ? e.dst : e.src
        if (!nodeIds.has(other) && nodeIds.size >= totalCap) {
          truncated = true
          continue
        }
        seenEdge.add(key)
        edges.push({ src: e.src, dst: e.dst, type: e.type, dir: e.src === at ? 'out' : 'in' })
        if (!nodeIds.has(other)) {
          nodeIds.add(other)
          next.push(other)
        }
      }
    }
    frontier = next
  }

  const nodes = deps.nodesByIds([...nodeIds]) as EgoNode[]
  return { anchor, nodes, edges, stats: { nodes: nodes.length, edges: edges.length, truncated } }
}

/** PURE anchor resolution, in trust order: exact store id → store label → whitelist group
 *  (any surface form of a matching group that the store carries) → VIRTUAL anchor from the
 *  group itself. The live gap this closes: a canonical project name can exist only as a
 *  hand-authored whitelist group — the store holds composites ("<project> playtest" …) but
 *  no bare node, so a store-only lookup returned an empty graph for the marquee anchor. */
export function resolveEgoAnchor(
  raw: string,
  groups: ReadonlyArray<CatalogAliasGroup>,
  probe: { hasNode: (id: string) => boolean; findByLabel: (label: string) => string | null }
): { id: string } | { virtual: { id: string; label: string; kind: string } } | null {
  const q = String(raw ?? '').trim()
  if (!q) return null
  if (probe.hasNode(q)) return { id: q }
  const direct = probe.findByLabel(q)
  if (direct) return { id: direct }
  const norm = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase()
  const nq = norm(q)
  for (const g of groups ?? []) {
    const surfaces = [g.canonical, ...(g.aliases ?? [])]
    if (!surfaces.some((s) => norm(String(s ?? '')) === nq)) continue
    for (const s of surfaces) {
      const hit = probe.findByLabel(String(s ?? ''))
      if (hit) return { id: hit }
    }
    return {
      virtual: {
        id: g.canonicalId,
        label: g.canonical,
        kind: String(g.canonicalId ?? '').split(':')[0] || 'entity'
      }
    }
  }
  return null
}

/** The statuses the surface shows AND can adjudicate: candidate (awaiting the human gate),
 *  provisional (on probation), promoted (governing). Vetoed/reverted/invalidated stay out —
 *  they are retracted history (the Learning panel is that audit record), and the drawer's
 *  fall-back-to-list behaviour relies on an adjudicated-away belief leaving the payload. */
const GOVERNABLE_STATUSES: ReadonlySet<string> = new Set(['candidate', 'provisional', 'promoted'])

/** PURE: the live, governable slice of the operator store — what the Relations drawer may show
 *  and act on. A promoted-only join (the seam's portability rule) made the drawer's Promote
 *  action unreachable: promoteFact is the HUMAN gate (candidate → probation), and with only
 *  promoted facts arriving there was never anything to promote. */
export function governableBeliefFacts(facts: OperatorFact[]): OperatorFact[] {
  return (facts ?? []).filter((f) => f && GOVERNABLE_STATUSES.has(f.status) && isFactLive(f))
}

/** LIVE glue — one call for both the HTTP route and the IPC mirror. Loads the whitelist FIRST
 *  (nothing loads it at boot — same lesson as seam-reconcile) so anchor resolution can fall
 *  through store → whitelist; a whitelist-only entity gets a VIRTUAL anchor whose ego is its
 *  beliefs (no store edges — honest, not empty). Unknown anchor ⇒ empty graph, not an error. */
export function liveEntityEgoGraph(
  notesDir: string | null,
  anchorRaw: string,
  depth?: number
): EgoGraph & { beliefs: EgoBelief[] } {
  const raw = String(anchorRaw ?? '').trim()
  try {
    loadAliasGroups(notesDir)
  } catch {
    /* whitelist optional — store-only resolution still works */
  }
  const groups = activeAliasGroups()
  const resolved = resolveEgoAnchor(raw, groups, {
    hasNode: (id) => nodesByIds([id]).length > 0,
    findByLabel: findNodeIdByLabel
  })
  const governable = (): OperatorFact[] => governableBeliefFacts(getOperatorFacts())
  if (resolved && 'virtual' in resolved) {
    const v = resolved.virtual
    const anchorNode: EgoNode = { id: v.id, label: v.label, kind: v.kind, source: 'whitelist' }
    const beliefs = beliefsAbout(anchorNode, groups, governable())
    anchorNode.beliefCount = beliefs.length
    return {
      anchor: v.id,
      nodes: [anchorNode],
      edges: [],
      stats: { nodes: 1, edges: 0, truncated: false },
      beliefs
    }
  }
  const anchorId = resolved && 'id' in resolved ? resolved.id : raw
  const graph = buildEntityEgoGraph(anchorId, { edgesOf, nodesByIds }, { depth })
  let beliefs: EgoBelief[] = []
  const anchorNode = graph.nodes.find((n) => n.id === graph.anchor)
  if (anchorNode) {
    beliefs = beliefsAbout(anchorNode, groups, governable())
    anchorNode.beliefCount = beliefs.length
  }
  return { ...graph, beliefs }
}

export interface EgoBelief {
  factId: string
  text: string
  kind: string
  status: string
}

/** Governing rules first, probation next, waiting-for-the-gate last — the drawer's read order.
 *  (No promotedAt on the wire: OperatorFact carries no promotion timestamp to report.) */
const STATUS_RANK: Record<string, number> = { promoted: 0, provisional: 1, candidate: 2 }

/** Operator facts ABOUT the anchor — the same label/alias matching the seam projection uses
 *  (matchEntities), with the anchor's whitelist group (if any) supplying aliases. PURE. */
export function beliefsAbout(
  anchorNode: { id: string; label: string },
  aliasGroups: ReadonlyArray<CatalogAliasGroup>,
  facts: OperatorFact[]
): EgoBelief[] {
  const group = (aliasGroups ?? []).find((g) => g?.canonicalId === anchorNode.id)
  const entry: EntityCatalogEntry = {
    label: anchorNode.label,
    entityId: anchorNode.id,
    aliases: group ? [group.canonical, ...group.aliases] : []
  }
  const out: EgoBelief[] = []
  for (const f of facts ?? []) {
    if (!f?.fact) continue
    if (matchEntities(String(f.fact), [entry]).length === 0) continue
    out.push({
      factId: String(f.id),
      text: String(f.fact),
      kind: String(f.kind ?? 'context'),
      status: String(f.status ?? '')
    })
  }
  return out.sort((a, b) => (STATUS_RANK[a.status] ?? 3) - (STATUS_RANK[b.status] ?? 3))
}
