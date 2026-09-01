import { describe, it, expect, afterEach } from 'vitest'
import { computeCompoundingHealthLive } from './compounding-health-live'

// The live gatherer must read the REAL app predicate (graphExpandGroundEnabled()) for
// graphExpandGround, never a hand-copied env literal — the polarity has flipped twice and a
// duplicated literal desyncs from what the app actually runs. That invariant is what these tests
// pin; the DEFAULT they assert is whatever the predicate currently is.
//
// 2026-07-25: graph-expand is opt-IN again (`=== '1'`, default OFF) — the default-ON arm measured
// −9.0pp recall@5 / −10.3pp MRR against the RRF fusion it replaces on the real vault index, so the
// "+8pp" it was defaulted on for does not reproduce (see brain/graph-expand-adapt.ts). Unset ⇒ the
// grounding-path score sits at its floor, which is the HONEST reading: no extra-credit grounding
// path is enabled on a default install.
//
// whole-note also stays opt-in (default-OFF, `=== '1'`) — the operator's deliberate P1 privacy decision.

describe('computeCompoundingHealthLive — graphExpandGround honors the real (opt-in) predicate', () => {
  const savedGE = process.env.DUIN_GRAPH_EXPAND_GROUND
  const savedWN = process.env.DUIN_WHOLENOTE_GROUND

  afterEach(() => {
    if (savedGE === undefined) delete process.env.DUIN_GRAPH_EXPAND_GROUND
    else process.env.DUIN_GRAPH_EXPAND_GROUND = savedGE
    if (savedWN === undefined) delete process.env.DUIN_WHOLENOTE_GROUND
    else process.env.DUIN_WHOLENOTE_GROUND = savedWN
  })

  it('DUIN_GRAPH_EXPAND_GROUND UNSET ⇒ graphExpandGround false (default OFF); path score at the 40 floor', () => {
    delete process.env.DUIN_GRAPH_EXPAND_GROUND
    delete process.env.DUIN_WHOLENOTE_GROUND // whole-note stays opt-in → OFF
    const g = computeCompoundingHealthLive(null).axes.grounding
    expect(g.metrics.graphExpandGround).toBe(0)
    expect(g.metrics.wholeNoteGround).toBe(0)
    // No opt-in grounding path active ⇒ activePp 0 ⇒ groundingPathScore pinned at the 40 floor.
    expect(g.metrics.groundingPathScore).toBe(40)
  })

  it('DUIN_GRAPH_EXPAND_GROUND=1 (explicit opt-in) ⇒ graphExpandGround true; path score lifts off the floor', () => {
    process.env.DUIN_GRAPH_EXPAND_GROUND = '1'
    delete process.env.DUIN_WHOLENOTE_GROUND
    const g = computeCompoundingHealthLive(null).axes.grounding
    expect(g.metrics.graphExpandGround).toBe(1)
    // The benchmark still credits the historical +8 constant (NOT rescaled here — see the caveat on
    // scoreGrounding in compounding-health.ts): 40 + 60·(8/22) ≈ 61.8. Read it as "the operator
    // explicitly opted in", not as "grounding is measurably better".
    expect(g.metrics.groundingPathScore).toBeCloseTo(61.8, 1)
  })

  it('DUIN_GRAPH_EXPAND_GROUND=0 ⇒ still false (the old kill-switch value must not enable it)', () => {
    process.env.DUIN_GRAPH_EXPAND_GROUND = '0'
    delete process.env.DUIN_WHOLENOTE_GROUND
    const g = computeCompoundingHealthLive(null).axes.grounding
    expect(g.metrics.graphExpandGround).toBe(0)
    expect(g.metrics.groundingPathScore).toBe(40)
  })

  it('the grounding axis rises when graph-expand is explicitly opted IN vs the (default) OFF', () => {
    delete process.env.DUIN_WHOLENOTE_GROUND

    process.env.DUIN_GRAPH_EXPAND_GROUND = '1'
    const on = computeCompoundingHealthLive(null).axes.grounding.score

    delete process.env.DUIN_GRAPH_EXPAND_GROUND
    const off = computeCompoundingHealthLive(null).axes.grounding.score

    expect(on).toBeGreaterThan(off)
  })
})
