import { describe, expect, it } from 'vitest'
import { ramp, simParams, denseClusters, GPU_SIM_DECAY, CLUSTER_PULL, START_ALPHA, SETTLE_MAX_MS, settleShouldStop } from './graph-gpu-layout'

describe('ramp: 50 is exactly the mid anchor, ends are clamped, monotonic', () => {
  it('lands on the anchors', () => {
    expect(ramp(0, 1, 2, 4)).toBe(1)
    expect(ramp(50, 1, 2, 4)).toBe(2)
    expect(ramp(100, 1, 2, 4)).toBe(4)
  })
  it('clamps outside 0..100', () => {
    expect(ramp(-20, 1, 2, 4)).toBe(1)
    expect(ramp(140, 1, 2, 4)).toBe(4)
  })
  it('never inverts', () => {
    let prev = -Infinity
    for (let v = 0; v <= 100; v += 5) { const r = ramp(v, 0.35, 1, 3); expect(r).toBeGreaterThanOrEqual(prev); prev = r }
  })
})

describe('simParams: the shipped look is cosmos\'s own defaults', () => {
  const mid = { nodeSpacing: 50, linkLength: 50, linkForce: 50, centerForce: 50 }
  it('50 on every slider = cosmos defaults, decay fixed, no cluster pull unless asked', () => {
    const p = simParams(mid, false)
    expect(p.simulationRepulsion).toBe(1)
    expect(p.simulationLinkDistance).toBe(10)
    expect(p.simulationLinkSpring).toBe(1)
    expect(p.simulationGravity).toBe(0.25)
    expect(p.simulationDecay).toBe(GPU_SIM_DECAY)
    expect(p.simulationCluster).toBe(0)
  })
  it('Clusters on turns the cluster force on, and only that', () => {
    const a = simParams(mid, false), b = simParams(mid, true)
    expect(b.simulationCluster).toBe(CLUSTER_PULL)
    expect({ ...b, simulationCluster: 0 }).toEqual(a)
  })
  it('each slider moves its own coefficient the right way', () => {
    expect(simParams({ ...mid, nodeSpacing: 100 }, false).simulationRepulsion).toBeGreaterThan(1)
    expect(simParams({ ...mid, linkLength: 0 }, false).simulationLinkDistance).toBeLessThan(10)
    expect(simParams({ ...mid, linkForce: 100 }, false).simulationLinkSpring).toBeGreaterThan(1)
    expect(simParams({ ...mid, centerForce: 100 }, false).simulationGravity).toBeGreaterThan(0.25)
  })
})

describe('denseClusters: sparse community ids → dense cosmos cluster indices', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
  it('renumbers densely in first-seen order, isolated (-1) and unknown become undefined', () => {
    const m = new Map([['a', 7], ['b', -1], ['c', 7], ['d', 42]])
    expect(denseClusters(nodes, m)).toEqual([0, undefined, 0, 1])
  })
  it('returns null when there is nothing to cluster', () => {
    expect(denseClusters(nodes, null)).toBeNull()
    expect(denseClusters(nodes, new Map())).toBeNull()
    expect(denseClusters(nodes, new Map([['a', -1], ['zz', 3]]))).toBeNull()
  })
})

describe('START_ALPHA', () => {
  it('orders the energies: initial > structural > reheat', () => {
    expect(START_ALPHA.initial).toBeGreaterThan(START_ALPHA.structural)
    expect(START_ALPHA.structural).toBeGreaterThan(START_ALPHA.reheat)
  })
})

describe('settleShouldStop: the wall-clock cap on a settle', () => {
  it('stops at the cap, not before, and never for a settle that has not started', () => {
    expect(settleShouldStop(1000, 1000 + SETTLE_MAX_MS - 1)).toBe(false)
    expect(settleShouldStop(1000, 1000 + SETTLE_MAX_MS)).toBe(true)
    expect(settleShouldStop(1000, 1000)).toBe(false)
  })
  it('the cap is long enough for a desktop settle and short enough not to read as a hang', () => {
    expect(SETTLE_MAX_MS).toBeGreaterThanOrEqual(GPU_SIM_DECAY / 60 * 1000)
    expect(SETTLE_MAX_MS).toBeLessThanOrEqual(20_000)
  })
})
