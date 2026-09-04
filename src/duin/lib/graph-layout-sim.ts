// The brain-graph force simulation, built and re-parameterised in ONE place.
//
// The layout worker used to bake the force parameters into the simulation at construction
// and had no way to change them afterwards — so a slider drag re-serialised the whole graph
// (15k nodes, 59k links) and restarted the settle from alpha 1 on every pixel of travel. The
// graph jumped, the thumb stuttered. `applyForceParams` is the seam that fixes that: the
// same function configures a fresh simulation and re-tunes a running one, so the two paths
// can never disagree about what a slider value means.
//
// Pure d3-force, no worker globals, no DOM — importable from the worker, the renderer and
// a node test alike. The numbers live in graph-layout-forces.ts.
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type ForceLink, type ForceManyBody, type ForceX, type ForceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import { COLLISION, linkStrengthFor, type ForceParams } from "./graph-layout-forces";

export type { ForceParams } from "./graph-layout-forces";

/** `idx` is ours; d3 owns `index` and rewrites it on every nodes() call. */
export interface SimNode extends SimulationNodeDatum { idx: number }
export interface SimEdge extends SimulationLinkDatum<SimNode> { source: SimNode; target: SimNode }

/**
 * Build a STOPPED simulation over `nodes`/`edges` carrying `p`. `deg` is the per-index
 * degree the adaptive link strength reads — computed by the caller, who has the links.
 * `radius`, when given, is each node's drawn radius (world units) and switches collision on:
 * nodes then keep `COLLISION.padding` of clear space between their edges.
 *
 * There is deliberately NO forceCenter. It translates the whole system so the centroid sits
 * on the origin; with the core pinned at the origin that translation fought the pinned node
 * on every tick, and the "Center force" slider changed a translation gain rather than a pull.
 * forceX/forceY are the per-node inward pull, and the slider drives them directly.
 */
export function buildSimulation(
  nodes: SimNode[],
  edges: SimEdge[],
  deg: ArrayLike<number>,
  p: ForceParams,
  radius?: ArrayLike<number>
): Simulation<SimNode, SimEdge> {
  const sim = forceSimulation<SimNode>(nodes)
    .force("charge", forceManyBody<SimNode>())
    .force("link", forceLink<SimNode, SimEdge>(edges).id((d) => d.idx))
    .force("x", forceX<SimNode>(0))
    .force("y", forceY<SimNode>(0))
    .stop();
  if (radius) {
    // Not alpha-scaled (d3's forceCollide never is), so it holds at the end of a settle, which
    // is exactly when overlap would otherwise be visible. One iteration: measured +4 ms per tick
    // on the live drawn set, all of it off the main thread.
    sim.force("collide", forceCollide<SimNode>((d) => (radius[d.idx] ?? 0) + COLLISION.padding).strength(COLLISION.strength).iterations(1));
  }
  applyForceParams(sim, deg, p);
  return sim;
}

/**
 * Write `p` onto the simulation's forces in place. Safe on a running simulation: every d3
 * force re-initialises itself when a setter is called, so the next tick uses the new value.
 */
export function applyForceParams(
  sim: Simulation<SimNode, SimEdge>,
  deg: ArrayLike<number>,
  p: ForceParams
): void {
  (sim.force("charge") as ForceManyBody<SimNode> | undefined)?.strength(p.charge);
  const link = sim.force("link") as ForceLink<SimNode, SimEdge> | undefined;
  if (link) {
    link.distance(p.linkDistance);
    // d3's adaptive default, scaled, against the same degree counts the UI uses.
    link.strength((l) => linkStrengthFor(p.linkStrengthScale, deg[l.source.idx], deg[l.target.idx]));
  }
  (sim.force("x") as ForceX<SimNode> | undefined)?.strength(p.positional);
  (sim.force("y") as ForceY<SimNode> | undefined)?.strength(p.positional);
  sim.velocityDecay(p.velocityDecay);
}
