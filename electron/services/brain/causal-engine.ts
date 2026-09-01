// Causal engine — TS port of DUIN's causal_graph() + propagate()
// (server.py:3526 and :3964). Pure logic: no numerical/ML deps, no vault paths.
// It reads the causal field from a Store and (a) decorates it with in_degree /
// converges + an optional upstream-funnel filter, (b) FLOWS a node's slip or a
// decision outcome along the edges by lag — the prediction stream.

import type {
  CausalGraph,
  CausalNode,
  CausalEdge,
  PropagationResult,
  PropagationAffected
} from './types'
import type { Store } from './store'

// Edge types that carry a temporal slip downstream (the FLOW set in the Python
// propagate()). if_cleared/if_blocked are handled separately (branch pruning).
const FLOW = new Set(['requires', 'enables', 'gates', 'triggers', 'drives', 'feeds', 'builds_toward'])

const MAX_DEPTH = 8

/**
 * Build the causal graph from the Store: pass the field through, decorate each
 * node with in_degree + converges (in_degree >= 2). With `anchorId`, narrow to
 * that anchor's upstream convergence funnel + its least-slack critical path
 * (faithful to the Python anchor filter).
 */
export function causalGraph(store: Store, anchorId = ''): CausalGraph {
  const nodes = store.causalNodes()
  const edges = store.causalEdges()
  const today = store.today()

  const indeg = new Map<string, number>()
  for (const e of edges) indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1)
  for (const n of nodes) {
    n.in_degree = indeg.get(n.id) ?? 0
    n.converges = (indeg.get(n.id) ?? 0) >= 2
  }

  let outNodes = nodes
  let outEdges = edges
  if (anchorId) {
    const root = anchorId.startsWith('anchor:') ? anchorId : anchorId
    const nodeIds = new Set(nodes.map((n) => n.id))
    if (nodeIds.has(root)) {
      // reverse adjacency: target -> [sources]
      const radj = new Map<string, string[]>()
      for (const e of edges) {
        const arr = radj.get(e.target) ?? []
        arr.push(e.source)
        radj.set(e.target, arr)
      }
      const keep = new Set<string>([root])
      const frontier = [root]
      while (frontier.length) {
        const cur = frontier.pop() as string
        for (const src of radj.get(cur) ?? []) {
          if (!keep.has(src)) {
            keep.add(src)
            frontier.push(src)
          }
        }
      }
      outNodes = nodes.filter((n) => keep.has(n.id))
      outEdges = edges.filter((e) => keep.has(e.source) && keep.has(e.target))
    }
  }

  const convergeNodes = outNodes.filter((n) => n.converges).length
  return {
    nodes: outNodes,
    edges: outEdges,
    anchor: anchorId || null,
    today,
    stats: { nodes: outNodes.length, edges: outEdges.length, converge_nodes: convergeNodes }
  }
}

/**
 * Propagate a slip / decision along the causal edges. A slip at `nodeId` pushes
 * every downstream FLOW target later (lag preserved, max-wins per node).
 * `decision` = 'cleared' | 'blocked' activates one fork branch and prunes the
 * other. With no nodeId, propagates CURRENT slippage — every negative-slack node
 * flows its overdue downstream (= the live forecast). Faithful port of the
 * Python propagate(); affected set IS the prediction stream.
 */
/** Store wrapper — builds the Stack-A graph then propagates. Backward-compatible. */
export function propagate(
  store: Store,
  nodeId = '',
  shiftDays = 0,
  decision = ''
): PropagationResult {
  return propagateGraph(causalGraph(store), nodeId, shiftDays, decision)
}

/** Propagate slippage over ANY CausalGraph (Stack-A or the fs-native Stack-B substrate graph).
 *  Decoupled from Store so the live prediction stream can run over the SAME graph the UI renders
 *  (the two-brain fuse). Reads only nodes' id/label/kind/slack + edges' source/target/type. */
export function propagateGraph(
  g: CausalGraph,
  nodeId = '',
  shiftDays = 0,
  decision = ''
): PropagationResult {
  // Clamp the slip: non-finite → 0; bound to [0, 3650] days. A negative slip is
  // meaningless (and would mark downstream nodes with +0d without recursing);
  // an unbounded value bloats the affected set. Applies to both HTTP and IPC.
  shiftDays = Number.isFinite(shiftDays) ? Math.max(0, Math.min(3650, Math.trunc(shiftDays))) : 0

  const nodes = new Map<string, CausalNode>(g.nodes.map((n) => [n.id, n]))
  const adj = new Map<string, CausalEdge[]>()
  for (const e of g.edges) {
    const arr = adj.get(e.source) ?? []
    arr.push(e)
    adj.set(e.source, arr)
  }

  const affected = new Map<string, PropagationAffected>()

  const flow = (src: string, delta: number, depth = 0): void => {
    if (depth > MAX_DEPTH) return
    for (const e of adj.get(src) ?? []) {
      const tgt = e.target
      const tnode = nodes.get(tgt)
      if (FLOW.has(e.type) && delta) {
        const cur =
          affected.get(tgt) ??
          ({ id: tgt, label: tnode?.label ?? '', kind: tnode?.kind ?? '', shift_days: 0 } as PropagationAffected)
        if (delta > (cur.shift_days ?? 0)) {
          cur.shift_days = delta
          affected.set(tgt, cur)
          flow(tgt, delta, depth + 1)
        } else {
          affected.set(tgt, cur)
        }
      } else if ((e.type === 'if_cleared' || e.type === 'if_blocked') && decision) {
        const keep = (decision === 'cleared') === (e.type === 'if_cleared')
        affected.set(tgt, {
          id: tgt,
          label: tnode?.label ?? '',
          kind: tnode?.kind ?? '',
          branch: keep ? 'activated' : 'pruned'
        })
        if (keep) flow(tgt, shiftDays, depth + 1)
      }
    }
  }

  if (nodeId && nodes.has(nodeId)) {
    flow(nodeId, shiftDays)
  } else {
    for (const n of g.nodes) {
      if (typeof n.slack === 'number' && n.slack < 0) flow(n.id, -n.slack)
    }
  }

  const out = [...affected.values()].sort((a, b) => (b.shift_days ?? 0) - (a.shift_days ?? 0))
  return {
    origin: nodeId || 'live-slippage',
    shift_days: shiftDays,
    decision: decision || null,
    affected: out,
    count: out.length,
    note:
      'propagation along causal edges (lag-respecting); affected = the prediction stream. ' +
      'Later phases forward-date these to the calibration ledger so edges earn confidence over time.'
  }
}
