// Force constants shared by the two engines that lay out the brain graph: the worker
// (`graph-layout.worker.ts`) and the on-screen react-force-graph instance configured in
// `brain-shell.tsx`. They MUST agree — if they disagree, whichever settles last visibly
// undoes the other.
//
// This module exists only to hold that agreement. It is deliberately side-effect free and
// dependency free so both a worker and the renderer can import it; the worker module itself
// installs an `onmessage` handler on `self`, so importing a value out of it would run that
// handler in the renderer.

/**
 * How much of `centerStrength` becomes an actual per-node pull toward the origin.
 *
 * `forceCenter` does NOT attract anything. It computes the centroid of all nodes and
 * translates every node by the same vector so the centroid lands on target — a translation,
 * not a compression. So a node that charge has pushed out has nothing pulling it back, and
 * raising "Center force" cannot bring it in. `forceX`/`forceY` are the only forces in this
 * simulation that act per node toward a point.
 *
 * The multiplier keeps the useful range where d3 positional forces live (~0.003 spread ..
 * ~0.03 default .. ~0.06 tight). Deliberately weak: strong enough that a degree-0 node
 * cannot escape to infinity, weak enough that connected structure still spreads out.
 */
export const POSITIONAL_FROM_CENTER = 0.06;

/** The per-node inward strength for a given `centerStrength`. One definition, both engines. */
export function positionalStrength(centerStrength: number): number {
  return centerStrength * POSITIONAL_FROM_CENTER;
}
