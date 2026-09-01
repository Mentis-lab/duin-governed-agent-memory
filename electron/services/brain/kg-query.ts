// kg-query — multi-hop, point-in-time traversal over the persistent entity graph (world-model Stage 1).
//
// WHY THIS EXISTS: entity-graph-store accumulated entity_nodes/entity_edges on every capture, but the
// only reader was the relink cascade consuming its own writes — a WRITTEN·NEVER·READ sink. This is the
// read-back consumer. It turns the store into what Stage 1 calls the "multi-hop substrate": walk the
// graph from a seed entity, then answer WITH THE CLAIMS THAT WERE TRUE AT A GIVEN INSTANT.
//
// The as-of half reuses claimsAsOf (claim-metabolism), the bitemporal point-in-time filter the ledger
// already implements: validFrom <= t < validTo. That is the Graphiti-style property the memory axis is
// benchmarked on — "what did I believe on 2026-06-01", not just "what do I believe now".
//
// PURE + INJECTABLE: all IO arrives through `deps` so this is unit-testable without the electron
// module graph. Read-only — it never writes a node, an edge, or a claim.

import { claimsAsOf, entityKeyOf, type Claim } from './claim-metabolism'
import { loadLedger } from './claim-ledger'
import { liveNodes, neighborsOf } from './entity-graph-store'

export interface KgQueryOpts {
  seed: string
  /** Traversal depth. Clamped to 0..4 — beyond that a personal graph returns most of itself. */
  hops?: number
  /** Point-in-time instant (epoch ms). Omit/null = now. */
  asOf?: number | null
  /** Max nodes returned; the walk stops early and reports `truncated`. */
  limit?: number
}

export interface KgNode {
  id: string
  label: string
  kind: string
  /** Distance from the seed set: 0 = a seed itself. */
  hop: number
}

export interface KgQueryResult {
  seed: string
  resolvedSeeds: string[]
  hops: number
  asOf: string | null
  nodes: KgNode[]
  edges: { src: string; dst: string }[]
  claims: Claim[]
  truncated: boolean
  /** 'empty' when the persistent graph has no live nodes (flag off, or nothing captured yet). */
  entityGraph: 'live' | 'empty'
  note?: string
}

export interface KgQueryDeps {
  liveNodes: () => Array<{ id: string; label: string; kind: string }>
  neighborsOf: (id: string) => string[]
  loadClaims: (vaultDir: string) => Claim[]
}

const realDeps: KgQueryDeps = {
  liveNodes,
  neighborsOf,
  loadClaims: (v) => loadLedger(v)
}

const norm = (s: string) => s.trim().toLowerCase()

/** Resolve a free-text seed to node ids: exact id, then exact label, then label substring.
 *  Ordered most-precise-first so an exact hit is never diluted by fuzzy matches. */
function resolveSeeds(seed: string, nodes: Array<{ id: string; label: string }>): string[] {
  const q = norm(seed)
  if (!q) return []
  const byId = nodes.filter((n) => norm(n.id) === q)
  if (byId.length) return byId.map((n) => n.id)
  const byLabel = nodes.filter((n) => norm(n.label) === q)
  if (byLabel.length) return byLabel.map((n) => n.id)
  return nodes.filter((n) => norm(n.label).includes(q)).map((n) => n.id)
}

/** Every string a claim can cite an entity by. */
const refsOf = (c: Claim): string[] => [c.subject, c.object, entityKeyOf(c), ...c.justifications]

export function kgQuery(vaultDir: string, opts: KgQueryOpts, deps: KgQueryDeps = realDeps): KgQueryResult {
  const hops = Math.max(0, Math.min(4, opts.hops ?? 2))
  const limit = Math.max(1, opts.limit ?? 200)
  const asOfMs = opts.asOf ?? Date.now()

  const all = deps.liveNodes()
  const index = new Map(all.map((n) => [n.id, n]))
  const seeds = resolveSeeds(opts.seed, all)

  // Breadth-first so `hop` is a true shortest-path distance, not discovery order.
  const nodes: KgNode[] = []
  const edges: { src: string; dst: string }[] = []
  const seen = new Set<string>()
  let truncated = false
  let frontier = seeds.filter((id) => {
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
  for (const id of frontier) {
    const n = index.get(id)
    if (n) nodes.push({ id: n.id, label: n.label, kind: n.kind, hop: 0 })
  }
  for (let hop = 1; hop <= hops && frontier.length && !truncated; hop++) {
    const next: string[] = []
    for (const src of frontier) {
      for (const dst of deps.neighborsOf(src)) {
        edges.push({ src, dst })
        if (seen.has(dst)) continue
        seen.add(dst)
        if (nodes.length >= limit) {
          truncated = true
          break
        }
        const n = index.get(dst)
        // A neighbour with no live node row is a retired/unknown id — keep the edge (it is real
        // provenance) but do not invent a node for it.
        if (n) nodes.push({ id: n.id, label: n.label, kind: n.kind, hop })
        next.push(dst)
      }
      if (truncated) break
    }
    frontier = next
  }

  // Claims true AT the instant, restricted to the reached subgraph. Matching is by id OR label,
  // because claims cite entities either way (the same rule gatherWorldState uses for anchors).
  const reached = new Set<string>()
  for (const n of nodes) {
    reached.add(norm(n.id))
    reached.add(norm(n.label))
  }
  // With an empty graph, fall back to the raw seed string so the endpoint still answers.
  if (!reached.size) reached.add(norm(opts.seed))

  let claims: Claim[]
  try {
    claims = claimsAsOf(deps.loadClaims(vaultDir), asOfMs).filter((c) =>
      refsOf(c).some((r) => r && reached.has(norm(r)))
    )
  } catch {
    claims = []
  }

  return {
    seed: opts.seed,
    resolvedSeeds: seeds,
    hops,
    asOf: new Date(asOfMs).toISOString(),
    nodes,
    edges,
    claims,
    truncated,
    entityGraph: all.length ? 'live' : 'empty',
    note: all.length
      ? undefined
      : 'persistent entity graph is empty (DUIN_ENTITY_GRAPH off, or nothing captured yet) — answered from the claim ledger by seed string only'
  }
}
