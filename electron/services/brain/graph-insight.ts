// graph-insight.ts — ADDITIVE, cold-data-safe brain analytics over the EXISTING
// structural graph (the wikilink/frontmatter field that deriveGraph() already
// computes from the indexed vault). It needs no warm metabolism, no API key, and
// no embeddings: it runs purely on graph structure.
//
// What it produces (a "graphify"-style GRAPH_REPORT, grafted as technique only —
// the upstream tool's hard Claude-API dependency is NOT adopted):
//   • community detection (compact multi-level Louvain, deterministic) → the
//     latent clusters/lanes the manual `track` field doesn't capture,
//   • high-degree hubs (the load-bearing notes),
//   • cross-community BRIDGES (the surprising connections — links that span two
//     otherwise-separate clusters; the serendipity signal),
//   • deterministic suggested questions seeded from the bridges + hubs.
//
// Pure + side-effect-free + deterministic (stable node order, no Math.random) so
// it is unit-testable and reproducible. The tool-pack (graph-insight-tool-pack.ts)
// is the only caller that does I/O (deriveGraph() read + report return).

import { type CausalGraph } from '../local-brain/graph-derive'
import { mergedGraph } from './merged-graph'
import { SwrJsonCache } from '../local-brain/swr-json-cache'
import { runWhenIdle } from '../idle-scheduler'
import { nativeGraphMtime } from './graph-native'
import { readSettings } from '../settings-helper'

type GNode = CausalGraph['nodes'][number]

export interface Community {
  id: number
  size: number
  /** Human label: the dominant `track` lane, else the top hub's label. */
  label: string
  /** Dominant top-level lane in this community (best-effort grouping name). */
  track: string
  /** Stable, distinct color for this cluster (for graph coloring + legend). */
  color: string
  /** The most-connected members, for the report. */
  topNodes: { id: string; label: string; degree: number }[]
}

export interface Bridge {
  source: string
  target: string
  sourceLabel: string
  targetLabel: string
  commA: number
  commB: number
  /** Cluster labels for the two ends (so the report reads cluster↔cluster, not
   *  two generic note titles). */
  commALabel: string
  commBLabel: string
  type: string
  /** Provenance of the representative edge: a user-written link vs an inferred one
   *  (the honesty layer — an inferred cross-domain bridge is a hypothesis, a
   *  declared one is a fact the user actually wrote). */
  provenance: EdgeProvenance
  /** How many edges span this same cluster-pair (this row is the representative). */
  count: number
  /** How surprising the bridge is: larger when it joins two big clusters that
   *  are otherwise sparsely connected. Higher = more report-worthy. */
  surprise: number
}

/** Where an edge came from: a user-authored link, an LLM-inferred relation, or a
 *  low-confidence/ambiguous one. The graphify "EXTRACTED/INFERRED/AMBIGUOUS"
 *  graft — grounds trust in the graph. */
export type EdgeProvenance = 'declared' | 'inferred' | 'ambiguous'

/** A proposed `[[wikilink]]` to densify the graph — wire an island in, or bridge
 *  two siloed clusters. Human-gated: a SUGGESTION, never auto-applied. */
export interface LinkSuggestion {
  source: string
  target: string
  sourceLabel: string
  targetLabel: string
  /** The wikilink text to add to the source note, e.g. "[[target]]". */
  wikilink: string
  kind: 'island' | 'silo-bridge'
  reason: string
  confidence: number
}

/** A point-in-time structural snapshot (for growth tracking). No date — the
 *  caller stamps it (engine stays Date-free / pure). */
export interface GraphSnapshot {
  nodes: number
  edges: number
  communities: number
  isolated: number
  declared: number
  inferred: number
  ambiguous: number
}

export interface GraphInsight {
  generated: string
  stats: { nodes: number; edges: number; communities: number; isolated: number }
  /** Edge counts by provenance (the whole field, not just bridges). */
  edgeProvenance: { declared: number; inferred: number; ambiguous: number }
  communities: Community[]
  highDegree: { id: string; label: string; degree: number; track?: string }[]
  bridges: Bridge[]
  suggestedQuestions: string[]
  /** Human-gated proposals to densify the graph (wire islands, bridge silos). */
  linkSuggestions: LinkSuggestion[]
}

// ──────────────────── community detection (Louvain) ────────────────────

interface WGraph {
  /** adj[i] = Map<neighborIndex, weight> (undirected; self-loops in `self`). */
  adj: Map<number, number>[]
  /** self[i] = self-loop weight (internal edges carried up through aggregation). */
  self: number[]
  /** k[i] = total incident weight incl. self-loops (the node's degree). */
  k: number[]
  /** 2m — twice the total edge weight (constant across aggregation levels). */
  m2: number
}

/** One level of Louvain local-moving. Returns a community label per node (labels
 *  are arbitrary ints) and whether any node moved. */
function localMoving(g: WGraph): { comm: number[]; moved: boolean } {
  const N = g.adj.length
  const comm = Array.from({ length: N }, (_, i) => i)
  const sigmaTot = g.k.slice()
  let movedEver = false
  let improved = true
  let guard = 0
  while (improved && guard++ < 50) {
    improved = false
    for (let i = 0; i < N; i++) {
      const ci = comm[i]
      const neigh = new Map<number, number>()
      for (const [j, w] of g.adj[i]) {
        if (j === i) continue
        const cj = comm[j]
        neigh.set(cj, (neigh.get(cj) ?? 0) + w)
      }
      sigmaTot[ci] -= g.k[i]
      let bestC = ci
      let bestGain = (neigh.get(ci) ?? 0) - (sigmaTot[ci] * g.k[i]) / g.m2
      for (const [c, w] of neigh) {
        if (c === ci) continue
        const gain = w - (sigmaTot[c] * g.k[i]) / g.m2
        if (gain > bestGain + 1e-12 || (gain > bestGain - 1e-12 && c < bestC)) {
          bestGain = gain
          bestC = c
        }
      }
      sigmaTot[bestC] += g.k[i]
      if (bestC !== ci) {
        comm[i] = bestC
        improved = true
        movedEver = true
      }
    }
  }
  return { comm, moved: movedEver }
}

/** Relabel arbitrary community ids to a dense 0..C-1 range by first-appearance. */
function densify(comm: number[]): { dense: number[]; count: number } {
  const map = new Map<number, number>()
  const dense = comm.map((c) => {
    let d = map.get(c)
    if (d === undefined) {
      d = map.size
      map.set(c, d)
    }
    return d
  })
  return { dense, count: map.size }
}

/** Aggregate the graph: each community becomes one super-node. */
function aggregate(g: WGraph, dense: number[], count: number): WGraph {
  const adj: Map<number, number>[] = Array.from({ length: count }, () => new Map())
  const self = new Array<number>(count).fill(0)
  const k = new Array<number>(count).fill(0)
  for (let i = 0; i < g.adj.length; i++) {
    const ci = dense[i]
    self[ci] += g.self[i]
    for (const [j, w] of g.adj[i]) {
      const cj = dense[j]
      if (ci === cj) self[ci] += w
      else adj[ci].set(cj, (adj[ci].get(cj) ?? 0) + w)
    }
  }
  for (let c = 0; c < count; c++) {
    let deg = self[c]
    for (const w of adj[c].values()) deg += w
    k[c] = deg
  }
  return { adj, self, k, m2: g.m2 }
}

/**
 * Detect communities with multi-level Louvain. Returns a community id per node id
 * (dense, stable). Edges are treated as undirected, unit-weighted. With no edges
 * every node is its own community.
 */
export function detectCommunities(graph: CausalGraph): Map<string, number> {
  const ids = graph.nodes.map((n) => n.id)
  const index = new Map(ids.map((id, i) => [id, i]))
  const N = ids.length
  const adj: Map<number, number>[] = Array.from({ length: N }, () => new Map())
  let m2 = 0
  for (const e of graph.edges) {
    const a = index.get(e.source)
    const b = index.get(e.target)
    if (a === undefined || b === undefined || a === b) continue
    adj[a].set(b, (adj[a].get(b) ?? 0) + 1)
    adj[b].set(a, (adj[b].get(a) ?? 0) + 1)
    m2 += 2
  }
  if (m2 === 0 || N === 0) {
    return new Map(ids.map((id, i) => [id, i]))
  }
  const k = adj.map((row) => {
    let s = 0
    for (const w of row.values()) s += w
    return s
  })
  let g: WGraph = { adj, self: new Array<number>(N).fill(0), k, m2 }

  let labelOf = Array.from({ length: N }, (_, i) => i)
  let levelGuard = 0
  for (;;) {
    const { comm, moved } = localMoving(g)
    const { dense, count } = densify(comm)
    labelOf = labelOf.map((lbl) => dense[lbl])
    if (!moved || count === g.adj.length || ++levelGuard > 20) break
    g = aggregate(g, dense, count)
  }
  const { dense } = densify(labelOf)
  return new Map(ids.map((id, i) => [id, dense[i]]))
}

// ──────────────────── analysis ────────────────────

/** Undirected degree (in + out) per node id. */
function degrees(graph: CausalGraph): Map<string, number> {
  const deg = new Map<string, number>()
  for (const n of graph.nodes) deg.set(n.id, 0)
  for (const e of graph.edges) {
    if (!deg.has(e.source) || !deg.has(e.target) || e.source === e.target) continue
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1)
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1)
  }
  return deg
}

/** Classify an edge's provenance from its type + confidence. deriveGraph()'s
 *  wikilink/link edges are user-DECLARED; LLM-constructed relations (any other
 *  type) are INFERRED; a low-confidence edge is AMBIGUOUS. */
function edgeProvenance(e: { type: string; confidence?: number }): EdgeProvenance {
  const c = e.confidence ?? 1
  if (c < 0.5) return 'ambiguous'
  if (e.type === 'wikilink' || e.type === 'link') return 'declared'
  return 'inferred'
}

// Distinct, dark-field-readable palette for clusters (mirrors the brain graph's
// folder palette so community colors feel native). Cycled by cluster index.
const COMMUNITY_PALETTE = [
  '#8b7cf6', '#60a5fa', '#34d399', '#fbbf24', '#f87171', '#f472b6', '#22d3ee', '#a78bfa',
  '#4ade80', '#fb923c', '#e879f9', '#2dd4bf', '#facc15', '#38bdf8', '#c084fc', '#fca5a5'
]
/** Stable color for a cluster by its (sorted) index. */
export function communityColor(index: number): string {
  return COMMUNITY_PALETTE[((index % COMMUNITY_PALETTE.length) + COMMUNITY_PALETTE.length) % COMMUNITY_PALETTE.length]
}
const ISOLATED_COLOR = '#64748b'

function shortLabel(label: string): string {
  const t = (label ?? '').trim()
  return t.length > 60 ? t.slice(0, 57) + '…' : t || '(untitled)'
}

const STOP_TOKENS = new Set(['the', 'and', 'for', 'with', 'note', 'notes', '2026', '2025'])
/** Lowercase content tokens of a label/id, for lexical similarity (keyless). */
function titleTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of (s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 3 && !STOP_TOKENS.has(raw)) out.add(raw)
  }
  return out
}
/** Jaccard-ish overlap of two token sets (shared / smaller-set-size). */
function tokenOverlap(a: Set<string>, b: Set<string>): { shared: string[]; score: number } {
  if (!a.size || !b.size) return { shared: [], score: 0 }
  const shared: string[] = []
  for (const t of a) if (b.has(t)) shared.push(t)
  return { shared, score: shared.length / Math.min(a.size, b.size) }
}

/** The wikilink token for a node id: its basename without extension. */
function wikiTargetOf(id: string): string {
  const base = id.split(/[\\/]/).pop() ?? id
  return base.replace(/\.(md|markdown|txt)$/i, '')
}

/**
 * Analyse a structural graph into a GraphInsight. Pure + deterministic.
 * Pass a graph (e.g. for tests); the tool-pack passes deriveGraph().
 */
export function analyzeGraph(graph: CausalGraph): GraphInsight {
  const nodeById = new Map<string, GNode>(graph.nodes.map((n) => [n.id, n]))
  const comm = detectCommunities(graph)
  const deg = degrees(graph)

  // Group node ids by community.
  const members = new Map<number, string[]>()
  for (const [id, c] of comm) {
    const arr = members.get(c)
    if (arr) arr.push(id)
    else members.set(c, [id])
  }

  // Build Community summaries; singletons counted as "isolated".
  let isolated = 0
  const communities: Community[] = []
  for (const [c, ids] of members) {
    if (ids.length <= 1) {
      isolated++
      continue
    }
    const sorted = [...ids].sort(
      (a, b) => (deg.get(b) ?? 0) - (deg.get(a) ?? 0) || (a < b ? -1 : 1)
    )
    const laneCount = new Map<string, number>()
    for (const id of ids) {
      const t = nodeById.get(id)?.track ?? 'notes'
      laneCount.set(t, (laneCount.get(t) ?? 0) + 1)
    }
    const track = [...laneCount.entries()].sort(
      (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)
    )[0][0]
    const topNodes = sorted.slice(0, 5).map((id) => ({
      id,
      label: shortLabel(nodeById.get(id)?.label ?? id),
      degree: deg.get(id) ?? 0
    }))
    const label = track !== 'notes' ? track : topNodes[0]?.label ?? `cluster ${c}`
    communities.push({ id: c, size: ids.length, label, track, color: ISOLATED_COLOR, topNodes })
  }
  communities.sort((a, b) => b.size - a.size || a.id - b.id)

  // Disambiguate clusters that share a dominant-lane label (e.g. a big lane that
  // Louvain split into sub-communities) by appending the cluster's top hub, so
  // the report doesn't list "ProjectA / ProjectA / ProjectA".
  const labelCounts = new Map<string, number>()
  for (const c of communities) labelCounts.set(c.label, (labelCounts.get(c.label) ?? 0) + 1)
  for (const c of communities) {
    if ((labelCounts.get(c.label) ?? 0) > 1 && c.topNodes[0]) {
      c.label = `${c.label} · ${c.topNodes[0].label}`
    }
  }
  // Final tiebreak: any labels still colliding (e.g. duplicate note titles) get a
  // cluster-id suffix, guaranteeing a unique, stable label per cluster.
  const seenLabels = new Map<string, number>()
  for (const c of communities) {
    const n = (seenLabels.get(c.label) ?? 0) + 1
    seenLabels.set(c.label, n)
    if (n > 1) c.label = `${c.label} #${c.id}`
  }
  // Assign a stable, distinct color per cluster by its sorted index.
  communities.forEach((c, i) => {
    c.color = communityColor(i)
  })

  // High-degree hubs across the whole field.
  const highDegree = [...deg.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 12)
    .map(([id, d]) => ({
      id,
      label: shortLabel(nodeById.get(id)?.label ?? id),
      degree: d,
      track: nodeById.get(id)?.track
    }))

  // Bridges: cross-community edges, collapsed to ONE representative per unordered
  // cluster-PAIR (with a count of edges spanning it) so the report shows distinct
  // connections, not N rows of the same A↔B. Surprise ∝ sqrt(sizeA*sizeB).
  const sizeOf = new Map<number, number>()
  for (const [c, ids] of members) sizeOf.set(c, ids.length)
  const labelOfComm = new Map<number, string>(communities.map((c) => [c.id, c.label]))
  const labelFor = (c: number): string => labelOfComm.get(c) ?? `cluster ${c}`
  const byPair = new Map<string, Bridge>()
  for (const e of graph.edges) {
    if (e.source === e.target) continue
    const ca = comm.get(e.source)
    const cb = comm.get(e.target)
    if (ca === undefined || cb === undefined || ca === cb) continue
    const sizeA = sizeOf.get(ca) ?? 1
    const sizeB = sizeOf.get(cb) ?? 1
    if (sizeA <= 1 || sizeB <= 1) continue // ignore bridges to singletons (noise)
    const pairKey = `${Math.min(ca, cb)}-${Math.max(ca, cb)}`
    const existing = byPair.get(pairKey)
    if (existing) {
      existing.count++
      continue
    }
    byPair.set(pairKey, {
      source: e.source,
      target: e.target,
      sourceLabel: shortLabel(nodeById.get(e.source)?.label ?? e.source),
      targetLabel: shortLabel(nodeById.get(e.target)?.label ?? e.target),
      commA: ca,
      commB: cb,
      commALabel: labelFor(ca),
      commBLabel: labelFor(cb),
      type: e.type,
      provenance: edgeProvenance(e),
      count: 1,
      surprise: Math.round(Math.sqrt(sizeA * sizeB) * 100) / 100
    })
  }
  const bridges = [...byPair.values()]
    .sort((a, b) => b.surprise - a.surprise || b.count - a.count || (a.source < b.source ? -1 : 1))
    .slice(0, 10)

  // Deterministic, de-duplicated suggested questions seeded from the structure.
  const qset = new Set<string>()
  for (const b of bridges.slice(0, 5)) {
    if (b.commALabel !== b.commBLabel) {
      qset.add(
        `How does "${b.commALabel}" connect to "${b.commBLabel}"? ` +
          `(${b.count} link${b.count === 1 ? '' : 's'}, e.g. "${b.sourceLabel}" links them.)`
      )
    }
  }
  for (const h of highDegree.slice(0, 2)) {
    qset.add(`"${h.label}" is a hub (${h.degree} links) — what depends on it, and is that concentration a risk?`)
  }
  if (communities.length > 0) {
    const biggest = communities[0]
    qset.add(`The largest cluster is "${biggest.label}" (${biggest.size} notes) — is it one coherent theme or should it be split?`)
  }
  if (isolated > 0) {
    qset.add(`${isolated} note(s) are unlinked islands — are any worth wiring into the graph?`)
  }
  const suggestedQuestions = [...qset]

  // ── Link suggestions (human-gated densifiers) ──
  // Token sets per node for lexical matching (keyless — no embeddings).
  const tokensById = new Map<string, Set<string>>()
  for (const n of graph.nodes) tokensById.set(n.id, titleTokens(`${n.label} ${wikiTargetOf(n.id)}`))

  // Islands (degree 0) → propose a link to the best-matching CONNECTED note,
  // preferring the same lane. Only when the lexical overlap is meaningful.
  const islandSugs: LinkSuggestion[] = []
  for (const isl of graph.nodes) {
    if ((deg.get(isl.id) ?? 0) !== 0) continue
    const it = tokensById.get(isl.id)
    if (!it || !it.size) continue
    let best: { node: GNode; score: number; shared: string[] } | null = null
    for (const cand of graph.nodes) {
      if (cand.id === isl.id || (deg.get(cand.id) ?? 0) === 0) continue // link into the connected field
      const ov = tokenOverlap(it, tokensById.get(cand.id) ?? new Set())
      if (ov.score <= 0) continue
      const s = ov.score + ((isl.track ?? '') === (cand.track ?? '') ? 0.1 : 0)
      if (!best || s > best.score || (s === best.score && cand.id < best.node.id)) best = { node: cand, score: s, shared: ov.shared }
    }
    if (best && best.score >= 0.34) {
      islandSugs.push({
        source: isl.id,
        target: best.node.id,
        sourceLabel: shortLabel(isl.label),
        targetLabel: shortLabel(best.node.label),
        wikilink: `[[${wikiTargetOf(best.node.id)}]]`,
        kind: 'island',
        reason: `unlinked; shares ${best.shared.slice(0, 3).map((t) => `"${t}"`).join(', ')} with "${shortLabel(best.node.label)}"`,
        confidence: Math.min(1, Math.round(best.score * 100) / 100)
      })
    }
  }
  islandSugs.sort((a, b) => b.confidence - a.confidence || (a.source < b.source ? -1 : 1))

  // Silo bridges: two large clusters with NO existing bridge whose hubs share a
  // theme → propose linking their hubs (only when thematically related — avoids
  // suggesting noise links between genuinely unrelated domains).
  const siloSugs: LinkSuggestion[] = []
  const bigClusters = communities.filter((c) => c.size >= 5)
  for (let i = 0; i < bigClusters.length; i++) {
    for (let j = i + 1; j < bigClusters.length; j++) {
      const a = bigClusters[i]
      const b = bigClusters[j]
      const key = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`
      if (byPair.has(key)) continue // already bridged
      const ha = a.topNodes[0]
      const hb = b.topNodes[0]
      if (!ha || !hb) continue
      const ov = tokenOverlap(tokensById.get(ha.id) ?? new Set(), tokensById.get(hb.id) ?? new Set())
      if (ov.score < 0.34) continue
      siloSugs.push({
        source: ha.id,
        target: hb.id,
        sourceLabel: ha.label,
        targetLabel: hb.label,
        wikilink: `[[${wikiTargetOf(hb.id)}]]`,
        kind: 'silo-bridge',
        reason: `clusters "${a.label}" and "${b.label}" share ${ov.shared.slice(0, 3).map((t) => `"${t}"`).join(', ')} but have no link`,
        confidence: Math.round(ov.score * 100) / 100
      })
    }
  }
  siloSugs.sort((a, b) => b.confidence - a.confidence || (a.source < b.source ? -1 : 1))
  const linkSuggestions = [...islandSugs.slice(0, 10), ...siloSugs.slice(0, 5)]

  // Whole-field edge provenance tally (the honesty summary).
  const prov = { declared: 0, inferred: 0, ambiguous: 0 }
  for (const e of graph.edges) {
    if (e.source === e.target) continue
    prov[edgeProvenance(e)]++
  }

  return {
    generated: new Date().toISOString(),
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      communities: communities.length,
      isolated
    },
    edgeProvenance: prov,
    communities,
    highDegree,
    bridges,
    suggestedQuestions,
    linkSuggestions
  }
}

// ──────────────────── report rendering ────────────────────

/** Render a GraphInsight as a GRAPH_REPORT.md-style markdown artifact. Pure. */
export function renderGraphReport(insight: GraphInsight): string {
  const date = insight.generated.slice(0, 10)
  const L: string[] = []
  L.push('---')
  L.push('title: Brain Graph Report')
  L.push(`date: ${date}`)
  L.push('source: graph-insight')
  L.push('---')
  L.push('')
  L.push('# Brain Graph Report')
  L.push('')
  L.push(
    `${insight.stats.nodes} notes · ${insight.stats.edges} links · ` +
      `${insight.stats.communities} clusters · ${insight.stats.isolated} unlinked.`
  )
  const ep = insight.edgeProvenance
  L.push(`Edge provenance: ${ep.declared} declared · ${ep.inferred} inferred · ${ep.ambiguous} ambiguous.`)
  L.push('')

  L.push('## Clusters')
  if (insight.communities.length === 0) {
    L.push('_No multi-note clusters yet — the field is still sparse._')
  } else {
    for (const c of insight.communities.slice(0, 12)) {
      const top = c.topNodes.map((n) => `${n.label} (${n.degree})`).join(', ')
      L.push(`- **${c.label}** — ${c.size} notes. Top: ${top}`)
    }
  }
  L.push('')

  L.push('## Hubs (load-bearing notes)')
  if (insight.highDegree.length === 0) {
    L.push('_No connected hubs yet._')
  } else {
    for (const h of insight.highDegree) {
      L.push(`- **${h.label}** — ${h.degree} links${h.track ? ` · ${h.track}` : ''}`)
    }
  }
  L.push('')

  L.push('## Surprising connections (cross-cluster bridges)')
  if (insight.bridges.length === 0) {
    L.push('_No cross-cluster bridges — clusters are currently self-contained._')
  } else {
    for (const b of insight.bridges) {
      const via = `${b.provenance}${b.count > 1 ? `, ${b.count} links` : ''}`
      L.push(
        `- **${b.commALabel} ↔ ${b.commBLabel}** (surprise ${b.surprise}${via}) — ` +
          `e.g. "${b.sourceLabel}" → "${b.targetLabel}"`
      )
    }
  }
  L.push('')

  L.push('## Questions to explore')
  for (const q of insight.suggestedQuestions) L.push(`- ${q}`)
  L.push('')

  if (insight.linkSuggestions.length > 0) {
    L.push('## Suggested links (densify — review before adding)')
    for (const s of insight.linkSuggestions) {
      L.push(`- in "${s.sourceLabel}" add ${s.wikilink} — ${s.reason} (${s.kind}, ${s.confidence})`)
    }
    L.push('')
  }

  return L.join('\n')
}

/** Convenience: analyse the LIVE structural graph and render the report. The
 *  single I/O-touching entry the tool-pack calls. */
export function buildGraphReport(): { insight: GraphInsight; markdown: string } {
  const insight = analyzeGraph(mergedGraph())
  return { insight, markdown: renderGraphReport(insight) }
}

export interface NodeCommunity {
  id: string
  community: number
  label: string
  color: string
}

/** Per-node community assignment for COLORING the brain graph by detected cluster
 *  (not just manual folder/track). Nodes in a multi-note cluster carry that
 *  cluster's label+color; singletons get a neutral "isolated" color. Pure. */
export function communityAssignments(graph: CausalGraph): NodeCommunity[] {
  const comm = detectCommunities(graph)
  const insight = analyzeGraph(graph)
  const meta = new Map<number, { label: string; color: string }>(
    insight.communities.map((c) => [c.id, { label: c.label, color: c.color }])
  )
  return graph.nodes.map((n) => {
    const cid = comm.get(n.id) ?? -1
    const m = meta.get(cid)
    return { id: n.id, community: cid, label: m?.label ?? 'isolated', color: m?.color ?? ISOLATED_COLOR }
  })
}

/** Convenience: per-node community assignment for the LIVE graph. */
export function buildCommunityAssignments(): NodeCommunity[] {
  return communityAssignments(mergedGraph())
}

// ──────────────────── SWR-cached variants (the IPC handlers' entry) ────────────────────
//
// Louvain + analyzeGraph over the live ~6.2k-node graph was MEASURED at 1353ms
// on the main thread, paid on every Graph Report surface mount (the panel holds
// no cross-mount state, so every open refetched) — /debug/stalls sample
// `ipc:brain:graphCommunities 1353ms`, 2026-08-21, the stall instrument's first
// day. Same remedy as /state/brain-graph: serve the previous result instantly,
// rebuild in the operator's next input pause when the key moves or the entry
// ages out. Memory-only by choice — the first open per boot still pays one
// attributed build (visible at /debug/stalls), and that is the honest residual;
// disk persistence would couple this module to the userData cache dir for a
// once-per-boot saving.
//
// The key is the same vault-mtime signal the brain-graph cache trusts. It moves
// on vault edits; construction/entity-plane changes that bypass the vault
// surface within revalidateAfterMs via the age-based rebuild instead.

const REPORT_REVALIDATE_MS = 5 * 60_000

function graphInsightKey(): string {
  const vault = (readSettings().localBrainNotesDir as string) || ''
  return `${vault}:${nativeGraphMtime(vault)}`
}

const _reportCache = new SwrJsonCache({
  revalidateAfterMs: REPORT_REVALIDATE_MS,
  schedule: (fn) => runWhenIdle('graph-report-rebuild', fn, { idleMs: 3_000, maxDelayMs: 120_000, pollMs: 1_000 })
})

const _communitiesCache = new SwrJsonCache({
  revalidateAfterMs: REPORT_REVALIDATE_MS,
  schedule: (fn) => runWhenIdle('graph-communities-rebuild', fn, { idleMs: 3_000, maxDelayMs: 120_000, pollMs: 1_000 })
})

/** buildGraphReport behind stale-while-revalidate. First call per boot builds
 *  (blocked, attributed); every later call serves the cached JSON and lets a
 *  stale entry rebuild at operator idle. */
export function buildGraphReportCached(): { insight: GraphInsight; markdown: string } {
  const r = _reportCache.get(graphInsightKey(), () => JSON.stringify(buildGraphReport()))
  return JSON.parse(r.json) as { insight: GraphInsight; markdown: string }
}

/** buildCommunityAssignments behind the same stale-while-revalidate contract. */
export function buildCommunityAssignmentsCached(): NodeCommunity[] {
  const r = _communitiesCache.get(graphInsightKey(), () => JSON.stringify(buildCommunityAssignments()))
  return JSON.parse(r.json) as NodeCommunity[]
}

/** A structural snapshot for growth tracking (no date — caller stamps it). Pure. */
export function graphSnapshot(graph: CausalGraph): GraphSnapshot {
  const i = analyzeGraph(graph)
  return {
    nodes: i.stats.nodes,
    edges: i.stats.edges,
    communities: i.stats.communities,
    isolated: i.stats.isolated,
    declared: i.edgeProvenance.declared,
    inferred: i.edgeProvenance.inferred,
    ambiguous: i.edgeProvenance.ambiguous
  }
}

/** Convenience: structural snapshot of the LIVE graph. */
export function buildGraphSnapshot(): GraphSnapshot {
  return graphSnapshot(mergedGraph())
}
