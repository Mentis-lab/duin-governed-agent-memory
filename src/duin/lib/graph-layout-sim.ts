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
// a node test alike.
import {
  forceCenter, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type ForceCenter, type ForceLink, type ForceManyBody, type ForceX, type ForceY,
  type Simulation, type SimulationLinkDatum, type SimulationNodeDatum,
} from "d3-force";
import { positionalStrength } from "./graph-layout-forces";

/** `idx` is ours; d3 owns `index` and rewrites it on every nodes() call. */
export interface SimNode extends SimulationNodeDatum { idx: number }
export interface SimEdge extends SimulationLinkDatum<SimNode> { source: SimNode; target: SimNode }

/** The four slider-driven forces plus damping — everything a layout run can be re-tuned on. */
export type ForceParams = {
  charge: number;
  linkDistance: number;
  /** < 0 reproduces d3's adaptive default: 1 / min(deg(a), deg(b)). */
  linkStrength: number;
  centerStrength: number;
  velocityDecay: number;
};

/**
 * Build a STOPPED simulation over `nodes`/`edges` carrying `p`. `deg` is the per-index
 * degree the adaptive link strength reads — computed by the caller, who has the links.
 */
export function buildSimulation(
  nodes: SimNode[],
  edges: SimEdge[],
  deg: ArrayLike<number>,
  p: ForceParams
): Simulation<SimNode, SimEdge> {
  const sim = forceSimulation<SimNode>(nodes)
    .force("charge", forceManyBody<SimNode>())
    .force("link", forceLink<SimNode, SimEdge>(edges).id((d) => d.idx))
    // forceCenter re-centres the whole system; forceX/forceY are what actually hold an
    // individual node in. Both are driven off the same "Center force" slider so the control
    // means one thing. Keep this identical to brain-shell.tsx's main-thread configuration —
    // the two must agree or the on-screen engine fights whatever the worker returns.
    .force("center", forceCenter<SimNode>())
    .force("x", forceX<SimNode>(0))
    .force("y", forceY<SimNode>(0))
    .stop();
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
    if (p.linkStrength < 0) {
      // d3's adaptive default, evaluated against the same degree counts the UI uses.
      link.strength((l) => 1 / Math.min(deg[l.source.idx] || 1, deg[l.target.idx] || 1));
    } else {
      link.strength(p.linkStrength);
    }
  }
  (sim.force("center") as ForceCenter<SimNode> | undefined)?.strength(p.centerStrength);
  const positional = positionalStrength(p.centerStrength);
  (sim.force("x") as ForceX<SimNode> | undefined)?.strength(positional);
  (sim.force("y") as ForceY<SimNode> | undefined)?.strength(positional);
  sim.velocityDecay(p.velocityDecay);
}
