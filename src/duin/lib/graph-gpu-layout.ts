// The GPU layout: cosmos.gl's own force simulation as the brain map's physics.
//
// Until now the layout was a d3-force worker streaming position snapshots into the renderer
// (sim off on the GPU). That kept the main thread free but left the map without node drag and
// without any force that knows about clusters. cosmos runs the same family of forces in a
// fragment shader, settles a 6k-node map in seconds, moves neighbours live under a drag, can
// gather detected communities, pins the core, and is deterministic under a seed. Measured in
// the offline harness on the live map (RTX 3060 Ti, 4,082 nodes / 10,441 links, 2026-09-02):
// converged in ~12 s at decay 700, median on-screen link 25 px vs the worker's 30 px at the
// same framing (more local structure, not a blob).
//
// Pure mappings only. The renderer applies them; the worker stays as the escape hatch
// (`localStorage.brainLayout=worker`).

/** The operator's four Layout sliders, 0..100 with 50 = the shipped look. */
export type LayoutSliders = { nodeSpacing: number; linkLength: number; linkForce: number; centerForce: number }

/** cosmos simulation coefficients (config.d.ts `simulation*`). */
export type GpuSimParams = {
  simulationRepulsion: number
  simulationLinkDistance: number
  simulationLinkSpring: number
  simulationGravity: number
  simulationCenter: number
  simulationFriction: number
  simulationDecay: number
  simulationCluster: number
}

/** Two linear ramps meeting at the mid anchor, so 50 lands EXACTLY on `atMid` (the same shape
 *  brain-shell uses for the d3 worker, kept here so the sliders feel identical on either engine). */
export function ramp(v: number, atLow: number, atMid: number, atHigh: number): number {
  const t = Math.max(0, Math.min(100, v))
  return t <= 50 ? atLow + (atMid - atLow) * (t / 50) : atMid + (atHigh - atMid) * ((t - 50) / 50)
}

/** Ticks the simulation takes to cool. ~600 frames is a 10 s settle at 60 fps: long enough to
 *  read as one motion, short enough that a refresh does not feel like a re-layout. */
export const GPU_SIM_DECAY = 600

/** How hard a detected community pulls its members together while Clusters is on. Off = 0. */
export const CLUSTER_PULL = 0.35

/**
 * Sliders → simulation coefficients. Mid values are cosmos's tuned defaults for a space of
 * 8192 (repulsion 1, link distance 10, spring 1, gravity 0.25); the ramps reach a third and
 * three times of those, which is the same span the worker's charge ramp covered.
 */
export function simParams(s: LayoutSliders, clustersOn: boolean): GpuSimParams {
  return {
    simulationRepulsion: ramp(s.nodeSpacing, 0.35, 1, 3),
    simulationLinkDistance: ramp(s.linkLength, 4, 10, 30),
    simulationLinkSpring: ramp(s.linkForce, 0.3, 1, 2.5),
    simulationGravity: ramp(s.centerForce, 0.05, 0.25, 0.8),
    simulationCenter: 0,
    simulationFriction: 0.85,
    simulationDecay: GPU_SIM_DECAY,
    simulationCluster: clustersOn ? CLUSTER_PULL : 0,
  }
}

/**
 * cosmos wants dense cluster indices from 0 with `undefined` for "no cluster". Community ids
 * are sparse ints with -1 for isolated. Returns the per-point array in `nodes` order, or null
 * when nothing is clustered (so the caller clears the force rather than pushing 6k undefineds).
 */
export function denseClusters(
  nodes: { id: string }[],
  communityOf: ReadonlyMap<string, number> | null | undefined,
): (number | undefined)[] | null {
  if (!communityOf || communityOf.size === 0) return null
  const dense = new Map<number, number>()
  const out: (number | undefined)[] = new Array(nodes.length)
  let any = false
  for (let i = 0; i < nodes.length; i++) {
    const c = communityOf.get(nodes[i].id)
    if (c == null || c < 0) { out[i] = undefined; continue }
    let d = dense.get(c)
    if (d === undefined) { d = dense.size; dense.set(c, d) }
    out[i] = d
    any = true
  }
  return any ? out : null
}

/** Alpha for a (re)start: the first layout gets the full energy; a refresh that changed the
 *  node set gets enough to seat the newcomers without re-scattering the rest; a slider or a
 *  cluster toggle re-heats in place. */
export const START_ALPHA = { initial: 1, structural: 0.35, reheat: 0.25 } as const

/** Wall-clock cap on a settle. GPU_SIM_DECAY is a tick count (10 s at 60 fps, measured 1.5 ms
 *  of GPU per tick at the LOD budget on a desktop card); an integrated laptop GPU runs the same
 *  ticks at a lower rate, and a settle past this many milliseconds reads as a hang. The
 *  renderer pauses the simulation and takes the layout as it stands. */
export const SETTLE_MAX_MS = 15_000

export function settleShouldStop(startedAt: number, now: number, maxMs = SETTLE_MAX_MS): boolean {
  return now - startedAt >= maxMs
}
