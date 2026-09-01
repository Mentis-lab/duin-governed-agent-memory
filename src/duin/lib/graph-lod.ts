// Level-of-detail cull for the brain graph.
//
// Culling the DATA rather than its visibility is what shrinks the simulation: forceManyBody is
// O(n log n) and rebuilds a quadtree per tick, so nodes that are merely hidden still cost.
// This runs only above a node floor, drops the two highest-count / lowest-signal link families,
// and never removes structure the operator navigates by.
//
// Extracted from brain-shell.tsx so the graph maths is testable on its own. The domain
// predicates (what counts as a cornerstone, which link types are bulk) stay with the component
// that knows the domain and are passed in.

export type LodNode = { id: string;[k: string]: unknown };
export type LodLink = { source: unknown; target: unknown; type?: string;[k: string]: unknown };

export type LodOptions = {
  /** Link families removed before degree is computed (e.g. `mentions`, `synonym`). */
  bulkLinkTypes: Set<string>;
  /** Kept regardless of how sparsely linked — the structure the operator navigates by. */
  isRoleKept: (n: LodNode) => boolean;
  /** A node also survives on its own merits at or above this degree. Default 2. */
  minDegree?: number;
};

/** force-graph rewrites link source/target from an id to the node object once it has run. */
export const idOf = (v: unknown): string =>
  (v && typeof v === "object" ? (v as { id: string }).id : (v as string));

/**
 * Apply the cull. Returns the nodes and links that should actually be simulated and drawn.
 *
 * The subtle part is the rescue pass. A node kept for its ROLE is kept unconditionally, but
 * its neighbours are not — so a node that is well connected in the source graph can arrive
 * here with every one of its edges culled. That is not a cosmetic problem: a degree-0 node has
 * no link force acting on it, so the charge force alone decides where it goes and it is flung
 * to the rim, reading as a stray filament shooting off the map. For any kept node that would
 * otherwise be isolated we re-admit its highest-degree neighbour, so it re-attaches to
 * structure rather than to another leaf.
 */
export function cullForLod<N extends LodNode, L extends LodLink>(
  nodes: N[],
  links: L[],
  o: LodOptions
): { nodes: N[]; links: L[] } {
  const minDegree = o.minDegree ?? 2;
  const keptLinks: L[] = [];
  const bulkLinks: L[] = [];
  for (const l of links) (o.bulkLinkTypes.has(l.type as string) ? bulkLinks : keptLinks).push(l);

  const deg = new Map<string, number>();
  for (const l of keptLinks) {
    const s = idOf(l.source), t = idOf(l.target);
    deg.set(s, (deg.get(s) || 0) + 1);
    deg.set(t, (deg.get(t) || 0) + 1);
  }

  const keep = new Set<string>();
  for (const n of nodes) {
    if (o.isRoleKept(n) || (deg.get(n.id) || 0) >= minDegree) keep.add(n.id);
  }

  /** neighbour -> the link that reaches it, so a rescue can re-admit the EDGE, not just the node.
   *  Admitting the node alone would leave it drawn but unattached, which is the same picture. */
  const index = (ls: L[]): Map<string, { via: L; other: string }[]> => {
    const m = new Map<string, { via: L; other: string }[]>();
    for (const l of ls) {
      const s = idOf(l.source), t = idOf(l.target);
      let a = m.get(s); if (!a) { a = []; m.set(s, a); } a.push({ via: l, other: t });
      let b = m.get(t); if (!b) { b = []; m.set(t, b); } b.push({ via: l, other: s });
    }
    return m;
  };
  const adj = index(keptLinks);
  const bulkAdj = index(bulkLinks);

  // Rescue pass. One hop only: a rescued neighbour is not itself re-examined, so this cannot
  // cascade across the graph.
  //
  // BULK EDGES ARE THE FALLBACK, and that is the load-bearing half. `mentions` and `synonym` are
  // dropped up front because at overview zoom they are noise — but on the live vault they are 61%
  // of all links (10,649 + 2,351 of 21,132) and they are the ONLY connection **3,327** nodes have.
  // A node kept for its role with nothing but a `mentions` edge was therefore stranded at degree 0
  // and, with charge the only force acting on it, flung to the rim. Those nodes are not unrelated
  // to the core body — a game's characters and creatures reached the graph precisely BECAUSE the
  // notes mention them. The relationship was recorded, and then thrown away.
  //
  // So: prefer a strong edge, accept a weak one over none. Re-admitting ONE `mentions` edge for a
  // node that would otherwise float is strictly more honest than drawing it unconnected, and it
  // costs one link per rescued node rather than reinstating all 13,000.
  const rescued = new Set<L>();
  const pick = (cands: { via: L; other: string }[] | undefined): { via: L; other: string } | null => {
    if (!cands || cands.length === 0) return null;
    let best = cands[0];
    for (const c of cands) if ((deg.get(c.other) || 0) > (deg.get(best.other) || 0)) best = c;
    return best;
  };
  for (const id of Array.from(keep)) {
    const strong = adj.get(id);
    if (strong && strong.some((e) => keep.has(e.other))) continue; // already attached to something kept
    const chosen = pick(strong) ?? pick(bulkAdj.get(id));
    if (!chosen) continue; // genuinely isolated in the source graph — nothing to attach it to
    keep.add(chosen.other);
    rescued.add(chosen.via);
  }

  const emitted = keptLinks.filter((l) => keep.has(idOf(l.source)) && keep.has(idOf(l.target)));
  for (const l of rescued) if (!emitted.includes(l)) emitted.push(l);
  return { nodes: nodes.filter((n) => keep.has(n.id)), links: emitted };
}

// ── FOCUS NEIGHBOURHOOD ───────────────────────────────────────────────────────────
//
// Two operator reports, hours apart, that pull in opposite directions and both hold:
//
//   "the connection highlights are so connected it's no longer relevant."
//     A flat N-hop BFS through one hub lit most of the graph — "what is this connected
//     to?" answered with "everything": true, and useless.
//
//   "connection depth highlighting is currently broken."
//     The answer to the first report was a degree GATE: a node over a threshold was
//     included but never expanded through. On the live vault (15k nodes, median degree
//     2) the derived threshold came out at 12, 75% of an ordinary node's neighbours sat
//     above it, and the median lit set was 4 at every depth from 2 to 5 — stepping the
//     depth control from 1 to 2 changed nothing for 47 of 80 anchors. Depth was a no-op.
//
// The rule that satisfies both is a per-node FAN-OUT BUDGET. A node reached at hop k
// expands through at most `fanOut` of its unseen neighbours — its lowest-degree ones,
// the relationships specific enough to say something — so every extra hop lights more
// (the second report) while a hub contributes a handful rather than its thousand (the
// first). Measured on the same vault, 80 ordinary anchors, median lit set per depth:
// flat BFS 3 / 78 / 3980 / 11327 / 14501; degree gate 3 / 4 / 4 / 4 / 4; this rule
// 3 / 15 / 29 / 75 / 139, with 0 of 80 anchors where a step changed nothing.
//
// The anchor itself is never budgeted: focusing a hub is a deliberate question — "what
// does this touch?" — and refusing to answer because the node has many edges would
// suppress the one case where the operator asked on purpose.

export interface FocusOptions {
  /** Hops to expand. 1 = anchor + direct neighbours. */
  depth: number
  /** Hard ceiling on the lit set. Truncation is hop-ordered, so the nearest survive. */
  maxLit?: number
}

/**
 * How many of a NON-anchor node's unseen neighbours it expands through per hop —
 * lowest-degree first. The anchor is never budgeted. Tuned on the live vault (see the
 * header); one constant rather than an option, because nothing in the product varies it.
 */
export const DEFAULT_FAN_OUT = 6

/**
 * The lit set for an anchor: itself, plus everything within `depth` hops, each non-anchor
 * node contributing at most DEFAULT_FAN_OUT of its most specific neighbours.
 *
 * Returns a set including the anchor. Deterministic and independent of insertion order:
 * the budget picks by (degree, id), and `maxLit` truncates by hop.
 */
export function focusNeighbourhood(
  anchor: string,
  neighbours: Map<string, Set<string>>,
  opts: FocusOptions
): Set<string> {
  const depth = Math.max(1, opts.depth)
  const fanOut = DEFAULT_FAN_OUT
  const maxLit = opts.maxLit ?? Infinity
  const degreeOf = (id: string): number => neighbours.get(id)?.size ?? 0

  const seen = new Set<string>([anchor])
  let frontier: string[] = [anchor]

  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = []
    for (const id of frontier) {
      const candidates: string[] = []
      for (const nb of neighbours.get(id) ?? []) if (!seen.has(nb)) candidates.push(nb)
      if (id !== anchor && candidates.length > fanOut) {
        candidates.sort((a, b) => degreeOf(a) - degreeOf(b) || (a < b ? -1 : a > b ? 1 : 0))
        candidates.length = fanOut
      }
      for (const nb of candidates) {
        seen.add(nb)
        next.push(nb)
        if (seen.size >= maxLit) return seen
      }
    }
    if (next.length === 0) break
    frontier = next
  }
  return seen
}
