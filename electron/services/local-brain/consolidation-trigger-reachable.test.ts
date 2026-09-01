// The consolidation trigger has to be REACHABLE, and until 2026-07-20 it was not.
//
// `shiftThreshold` was 0.5 and the live embedder (multilingual-e5-small) never produces a
// cosine that low: measured across three real topics from this vault, UNRELATED turns scored
// 0.72–0.85 and related ones 0.765–0.875. So the shift branch never fired; the only other exit
// was `maxBatch: 15`, which needs fifteen turns inside ONE process lifetime (the batch is
// in-memory and resets on restart). Neither happened, so consolidation never ran and the store
// carried zero `dependsOn` edges for the entire life of the reasoning-trace line — while every
// stage built on top of it was correct and simply never invoked.
//
// These tests pin REACHABILITY as a property, not a constant. The point is not that maxBatch is
// 6; it is that a plausible conversation MUST close a topic, and that the shift threshold must
// stay outside the measured overlap band so it can never fold unrelated turns together.

import { describe, it, expect } from 'vitest'
import {
  ConsolidationTracker,
  DEFAULT_CONSOLIDATION_POLICY,
  shouldConsolidate
} from './consolidation-trigger'

/** A unit vector at `deg` degrees in the first two dims — lets a test dial an exact cosine. */
function vecAt(deg: number, dim = 8): number[] {
  const r = (deg * Math.PI) / 180
  const v = new Array(dim).fill(0)
  v[0] = Math.cos(r)
  v[1] = Math.sin(r)
  return v
}

/** Cosines observed on the live embedder, 2026-07-20. The calibration this policy rests on. */
const MEASURED = {
  sameTopicMin: 0.765,
  diffTopicMax: 0.852,
  diffTopicMin: 0.72
}

describe('the consolidation trigger must be REACHABLE by a real conversation', () => {
  it('closes a topic within a plausible conversation length, with no topic shift at all', () => {
    const t = new ConsolidationTracker()
    // Every turn near-identical — i.e. the shift branch can never fire. This is the regime the
    // live embedder actually puts us in, so the cap is the ONLY exit that matters.
    let closed = false
    let turns = 0
    for (let i = 0; i < 12 && !closed; i++) {
      turns++
      closed = t.push(vecAt(0)).closed
    }
    expect(closed).toBe(true)
    // The regression that mattered: at maxBatch 15 this took 15 turns in one process lifetime
    // and therefore never happened. Keep it inside a conversation a person actually has.
    expect(turns).toBeLessThanOrEqual(8)
  })

  it('the closed batch actually qualifies for consolidation — reaching the cap is not enough', () => {
    const t = new ConsolidationTracker()
    let ev = t.push(vecAt(0))
    for (let i = 0; i < 10 && !ev.closed; i++) ev = t.push(vecAt(0))
    expect(ev.closed).toBe(true)
    expect(ev.consolidate).toBe(true) // size within [minBatch, maxBatch] AND coherent
    expect(ev.batchSize).toBeGreaterThanOrEqual(DEFAULT_CONSOLIDATION_POLICY.minBatch)
  })

  it('a cap-closed batch passes shouldConsolidate at exactly the cap size', () => {
    const batch = Array.from({ length: DEFAULT_CONSOLIDATION_POLICY.maxBatch }, () => vecAt(0))
    expect(shouldConsolidate(batch)).toBe(true)
  })
})

describe('the shift threshold must stay OUTSIDE the measured overlap band', () => {
  // Same-topic and different-topic cosines overlap on this embedder (0.765 vs 0.852), so the
  // threshold cannot be set to separate them. It is kept only as a rare early-close hint, below
  // everything observed — a missed close is harmless (the cap catches it), a false close is not
  // (it folds unrelated claims into one rule).
  it('never fires on a turn as similar as the CLOSEST measured unrelated pair', () => {
    expect(DEFAULT_CONSOLIDATION_POLICY.shiftThreshold).toBeLessThan(MEASURED.diffTopicMin)
  })

  it('is nowhere near the overlap band, so it cannot fold unrelated turns together', () => {
    expect(DEFAULT_CONSOLIDATION_POLICY.shiftThreshold).toBeLessThan(MEASURED.sameTopicMin)
    expect(DEFAULT_CONSOLIDATION_POLICY.shiftThreshold).toBeLessThan(MEASURED.diffTopicMax)
  })

  it('still closes on a genuinely distant turn (the hint is live, not dead code)', () => {
    const t = new ConsolidationTracker()
    t.push(vecAt(0))
    t.push(vecAt(0))
    // 80° apart ⇒ cosine ≈ 0.17, far below anything the embedder produces for real text.
    const ev = t.push(vecAt(80))
    expect(ev.closed).toBe(true)
    expect(ev.batchSize).toBe(2)
  })
})
