import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { applyForceParams, buildSimulation, type ForceParams, type SimEdge, type SimNode } from './graph-layout-sim'
import { COLLISION } from './graph-layout-forces'

// The slider-drag path. A force change used to be sent to the worker as a whole new layout
// — 15k nodes serialised and a settle restarted from alpha 1 on every pixel — which is what
// made the graph jump and the sliders stutter. Now it is a `params` message that re-tunes
// the run in flight. These tests pin that the two paths agree (a fresh build and an in-place
// update land on the same forces) and that the worker honours the message protocol.

const P: ForceParams = { charge: -30, linkDistance: 30, linkStrengthScale: 1, positional: 0.03, velocityDecay: 0.4 }
const P2: ForceParams = { charge: -120, linkDistance: 90, linkStrengthScale: 3, positional: 0.15, velocityDecay: 0.4 }

function chain(deg: number[]): { nodes: SimNode[]; edges: SimEdge[]; deg: Uint32Array } {
  const nodes: SimNode[] = deg.map((_, i) => ({ idx: i, x: i * 10, y: 0 }))
  const edges: SimEdge[] = []
  for (let i = 1; i < nodes.length; i++) edges.push({ source: nodes[i - 1], target: nodes[i] })
  return { nodes, edges, deg: Uint32Array.from(deg) }
}

/** What the simulation actually holds, read back through d3's accessor getters. */
function readForces(sim: ReturnType<typeof buildSimulation>, edge: SimEdge) {
  const f = (name: string) => sim.force(name) as any
  return {
    charge: f('charge').strength()(edge.source),
    linkDistance: f('link').distance()(edge),
    linkStrength: f('link').strength()(edge),
    x: f('x').strength()(edge.source),
    y: f('y').strength()(edge.source),
    velocityDecay: sim.velocityDecay(),
  }
}

describe('graph-layout-sim — one configuration, two entry points', () => {
  it('a fresh build carries the requested forces', () => {
    const g = chain([1, 2, 1])
    const got = readForces(buildSimulation(g.nodes, g.edges, g.deg, P2), g.edges[0])
    // link strength: 3 / min(1, 2) capped at 1
    expect(got).toEqual({ charge: -120, linkDistance: 90, linkStrength: 1, x: 0.15, y: 0.15, velocityDecay: 0.4 })
  })

  it('applyForceParams on a running simulation lands EXACTLY where a fresh build would', () => {
    const g = chain([1, 2, 1])
    const live = buildSimulation(g.nodes, g.edges, g.deg, P)
    for (let i = 0; i < 20; i++) live.tick()
    applyForceParams(live, g.deg, P2)
    const h = chain([1, 2, 1])
    const fresh = buildSimulation(h.nodes, h.edges, h.deg, P2)
    expect(readForces(live, g.edges[1])).toEqual(readForces(fresh, h.edges[1]))
  })

  it('link strength is d3\'s adaptive 1 / min(degree) times the scale, from the degrees it was given', () => {
    const g = chain([3, 2, 5])
    const sim = buildSimulation(g.nodes, g.edges, g.deg, P)
    const strength = (sim.force('link') as any).strength()
    expect(strength(g.edges[0])).toBe(1 / 2) // min(3, 2)
    expect(strength(g.edges[1])).toBe(1 / 2) // min(2, 5)
    applyForceParams(sim, g.deg, { ...P, linkStrengthScale: 0.25 })
    expect((sim.force('link') as any).strength()(g.edges[0])).toBe(0.125)
  })

  it('there is no forceCenter: the pinned core is the centre, forceX/forceY the pull', () => {
    const g = chain([1, 1])
    const sim = buildSimulation(g.nodes, g.edges, g.deg, P)
    expect(sim.force('center')).toBeUndefined()
    expect(sim.force('x')).toBeDefined()
    expect(sim.force('y')).toBeDefined()
  })

  it('collision is on exactly when radii are given, on the drawn radius plus the pad', () => {
    const g = chain([1, 2, 1])
    expect(buildSimulation(g.nodes, g.edges, g.deg, P).force('collide')).toBeUndefined()
    const h = chain([1, 2, 1])
    const sim = buildSimulation(h.nodes, h.edges, h.deg, P, Float32Array.from([2, 3.5, 11]))
    const collide = sim.force('collide') as any
    expect(collide).toBeDefined()
    expect(collide.radius()(h.nodes[1])).toBeCloseTo(3.5 + COLLISION.padding, 6)
    expect(collide.strength()).toBe(COLLISION.strength)
    expect(collide.iterations()).toBe(1)
  })

  it('the simulation is built stopped — ticking is the worker\'s decision', () => {
    const g = chain([1, 1])
    const sim = buildSimulation(g.nodes, g.edges, g.deg, P)
    const before = g.nodes.map((n) => [n.x, n.y])
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(g.nodes.map((n) => [n.x, n.y])).toEqual(before)
      sim.tick()
      expect(g.nodes.map((n) => [n.x, n.y])).not.toEqual(before)
      resolve()
    }, 20))
  })
})

// ── the worker protocol, driven through a faked `self` ───────────────────────────────
//
// vitest runs in node, where there is no DedicatedWorkerGlobalScope. The module reads
// `self` at import, so a stand-in is installed first and the module imported dynamically.

type Msg = { token: number; done: boolean; ticks: number; pos: Float32Array }
const posted: Msg[] = []
let onmessage: ((e: { data: any }) => void) | null = null

const waitFor = (pred: () => boolean, ms = 10_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (pred()) return resolve()
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting on the worker'))
      setTimeout(tick, 5)
    }
    tick()
  })

function layoutRequest(token: number, n = 40) {
  const ids = Array.from({ length: n }, (_, i) => `n${i}`)
  const links: number[] = []
  for (let i = 1; i < n; i++) links.push(i - 1, i)
  return {
    kind: 'layout', token, ids,
    x: new Float32Array(n).fill(NaN), y: new Float32Array(n).fill(NaN), pinned: new Uint8Array(n),
    links: Uint32Array.from(links), radius: new Float32Array(n).fill(1.5), ...P, maxTicks: 400, snapshotMs: 1,
  }
}
/** The re-tune the worker tests send: stronger repulsion, longer links, a weaker inward pull —
 *  every change pushes the chain OUTWARD, so "spread grew" is the unambiguous check. (P2 above
 *  also raises the inward pull 5x, which on a 40-node chain wins against the repulsion.) */
const P_SPREAD: ForceParams = { charge: -120, linkDistance: 90, linkStrengthScale: 3, positional: 0.006, velocityDecay: 0.4 }
const paramsUpdate = (token: number, alpha = 0.3) => ({ kind: 'params', token, alpha, ...P_SPREAD })
const dones = (token: number) => posted.filter((m) => m.token === token && m.done)

describe('graph-layout.worker — a params update re-heats the run in flight', () => {
  beforeAll(async () => {
    ;(globalThis as any).self = {
      postMessage: (m: Msg) => { posted.push(m) },
      set onmessage(h: ((e: { data: any }) => void) | null) { onmessage = h },
      get onmessage(): ((e: { data: any }) => void) | null { return onmessage },
    }
    await import('./graph-layout.worker')
    expect(onmessage).toBeTypeOf('function')
  })
  afterAll(() => { delete (globalThis as any).self })

  it('THE SLIDER CASE: after a settle, a params message re-runs the SAME run to a second done, under the new forces', async () => {
    posted.length = 0
    onmessage!({ data: layoutRequest(1) })
    await waitFor(() => dones(1).length === 1)
    const settled = dones(1)[0]
    expect(settled.ticks).toBeGreaterThan(0)
    onmessage!({ data: paramsUpdate(1) })
    await waitFor(() => dones(1).length === 2)
    const resettled = dones(1)[1]
    // it ran again (a fresh tick budget, not the exhausted one) …
    expect(resettled.ticks).toBeGreaterThan(0)
    // … under different forces: charge -120, link distance 90 and a weaker pull spread a chain further than -30 / 30 / 0.03.
    const spread = (m: Msg) => { let s = 0; for (let i = 0; i < m.pos.length; i += 2) s += Math.hypot(m.pos[i], m.pos[i + 1]); return s }
    expect(spread(resettled)).toBeGreaterThan(spread(settled))
    // and every response describes the same node list.
    expect(resettled.pos.length).toBe(settled.pos.length)
  })

  it('a gentler alpha re-heats too, and moves the settled layout less than the full 0.3', async () => {
    // Two identical settles; one nudged at alpha 0.08, the other at 0.3, same new forces.
    const run = async (token: number, alpha: number) => {
      posted.length = 0
      onmessage!({ data: layoutRequest(token) })
      await waitFor(() => dones(token).length === 1)
      const before = Float32Array.from(dones(token)[0].pos)
      onmessage!({ data: paramsUpdate(token, alpha) })
      await waitFor(() => dones(token).length === 2)
      const after = dones(token)[1].pos
      let d = 0; for (let i = 0; i < before.length; i += 2) d += Math.hypot(after[i] - before[i], after[i + 1] - before[i + 1])
      return d
    }
    const gentle = await run(11, 0.08)
    const full = await run(12, 0.3)
    expect(gentle).toBeGreaterThan(0)
    expect(gentle).toBeLessThan(full)
  })

  it('a seeded layout request (alpha 0.3) settles in fewer ticks than an unseeded one', async () => {
    const run = async (token: number, seeded: boolean) => {
      posted.length = 0
      const req = layoutRequest(token, 60) as any
      if (seeded) {
        for (let i = 0; i < 60; i++) { req.x[i] = i * 30; req.y[i] = 0 }
        req.alpha = 0.3
      }
      onmessage!({ data: req })
      await waitFor(() => dones(token).length === 1)
      return dones(token)[0].ticks
    }
    const cold = await run(21, false)
    const warm = await run(22, true)
    expect(warm).toBeGreaterThan(0)
    expect(warm).toBeLessThan(cold)
  })

  it('a non-finite re-heat alpha does not wedge the run: it re-heats to the ceiling and finishes', async () => {
    posted.length = 0
    onmessage!({ data: layoutRequest(31) })
    await waitFor(() => dones(31).length === 1)
    onmessage!({ data: paramsUpdate(31, NaN) })
    await waitFor(() => dones(31).length === 2)
    expect(dones(31)[1].ticks).toBeGreaterThan(0)
  })

  it('a params message for a superseded token is dropped without a reply', async () => {
    posted.length = 0
    onmessage!({ data: layoutRequest(2) })
    await waitFor(() => dones(2).length === 1)
    const n = posted.length
    onmessage!({ data: paramsUpdate(1) })
    await new Promise((r) => setTimeout(r, 60))
    expect(posted.length).toBe(n)
  })

  it('a params message mid-settle is absorbed by the run in flight — one run, one done', async () => {
    posted.length = 0
    onmessage!({ data: layoutRequest(3, 400) })
    await waitFor(() => posted.some((m) => m.token === 3)) // at least one snapshot: it is running
    expect(dones(3).length).toBe(0)
    onmessage!({ data: paramsUpdate(3) })
    await waitFor(() => dones(3).length === 1)
    await new Promise((r) => setTimeout(r, 60))
    expect(dones(3).length).toBe(1)
  })

  it('a params message when there is nothing to re-heat is acknowledged as done, so the UI never waits forever', async () => {
    posted.length = 0
    onmessage!({ data: layoutRequest(4, 0) })
    await waitFor(() => dones(4).length === 1)
    onmessage!({ data: paramsUpdate(4) })
    await waitFor(() => dones(4).length === 2)
    expect(dones(4)[1].pos.length).toBe(0)
  })
})
