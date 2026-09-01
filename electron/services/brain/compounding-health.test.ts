import { describe, it, expect } from 'vitest'
import {
  computeCompoundingHealth,
  scoreStability,
  scoreMetabolism,
  scoreCompounding,
  scoreGrounding,
  detectCompoundingRegression,
  meanStd,
  countClobbers,
  isGovernedPromotion,
  type CompoundingHealthDeps,
  type CompoundingFact,
  type StabilityDeps,
  type MetabolismDeps,
  type CompoundingLoopDeps,
  type GroundingConfigDeps
} from './compounding-health'

const BUILT_AT = '2026-07-17T00:00:00.000Z'

// ──────────────────── fixtures ────────────────────

/** A healthy stability series: near-constant entity counts, no clobber, current near peak. */
const stableSeries: StabilityDeps = {
  entityCountSeries: [100, 102, 101, 103, 100, 102, 104, 101, 102, 103],
  currentEntities: 103
}
/** A churning series with two >30% clobber drops and a low current-vs-peak. */
const churningSeries: StabilityDeps = {
  entityCountSeries: [106, 260, 44, 97, 144, 165, 113],
  currentEntities: 113
}

/** Fresh, resolving, diverse metabolism. */
const liveMetabolism: MetabolismDeps = {
  ledgerFreshnessHours: 1,
  claimTotal: 1000,
  claimResolved: 200,
  verdictTypes: ['temporal', 'supersession', 'jtms']
}
/** FROZEN ledger, barely-resolving, all-temporal (the live degenerate case). */
const frozenMetabolism: MetabolismDeps = {
  ledgerFreshnessHours: 61,
  claimTotal: 4821,
  claimResolved: 140,
  verdictTypes: ['temporal']
}

const govern = { juryModelId: 'x', juryProvider: 'y', crossModel: true, verdict: 'confirm', ts: 1 }

/** A compounding loop that is actually graduating: governed promotions, efficacy, survival, bindings. */
const earningLoop: CompoundingLoopDeps = {
  facts: [
    { status: 'promoted', provisionalAt: 1, govern, efficacy: { flipRate: 0.5 }, observedSessions: ['a', 'b'] },
    { status: 'promoted', provisionalAt: 1, govern, efficacy: { flipRate: 0.4 }, observedSessions: ['a', 'b', 'c'] },
    { status: 'provisional', provisionalAt: 1, observedSessions: ['a'], efficacy: { flipRate: 0.3 } },
    { status: 'provisional', provisionalAt: 1, observedSessions: ['a', 'b'], efficacy: { flipRate: 0.2 } }
  ],
  bindingCount: 8,
  correctionCount: 10
}
/** All-legacy-promoted (no govern), 0 efficacy, 0 survival — the live honesty baseline. */
const legacyLoop: CompoundingLoopDeps = {
  facts: [
    { status: 'promoted', provisionalAt: 1, observedSessions: ['a', 'b', 'c'] }, // legacy: no govern
    { status: 'promoted' },
    { status: 'provisional', provisionalAt: 1, observedSessions: [] },
    { status: 'provisional', provisionalAt: 1, observedSessions: [] },
    { status: 'vetoed' }
  ],
  bindingCount: 0,
  correctionCount: 52
}

/** Best validated grounding path + calibration wired into a gate. */
const bestGrounding: GroundingConfigDeps = {
  graphExpandGround: true,
  wholeNoteGround: true,
  calibrationMode: 'gate',
  citationVerifyActive: true,
  decisionWindowObs: 194
}
/** Default agentic path + advisory-only calibration (the live baseline). */
const defaultGrounding: GroundingConfigDeps = {
  graphExpandGround: false,
  wholeNoteGround: false,
  calibrationMode: 'advisory',
  citationVerifyActive: true,
  decisionWindowObs: 194
}

function deps(over: Partial<CompoundingHealthDeps> = {}): CompoundingHealthDeps {
  return {
    builtAt: BUILT_AT,
    stability: stableSeries,
    metabolism: liveMetabolism,
    compounding: earningLoop,
    grounding: bestGrounding,
    ...over
  }
}

// ──────────────────── pure helpers ────────────────────

describe('compounding-health — pure helpers', () => {
  it('meanStd computes population mean + stddev', () => {
    const { mean, std } = meanStd([2, 4, 6])
    expect(mean).toBe(4)
    expect(std).toBeCloseTo(Math.sqrt(8 / 3), 6)
  })
  it('countClobbers counts adjacent >30% drops only', () => {
    expect(countClobbers([100, 60, 90])).toBe(1) // 100→60 is -40%
    expect(countClobbers([100, 80, 90])).toBe(0) // 100→80 is -20%
    expect(countClobbers([260, 44, 165, 150])).toBe(1) // only 260→44 (-83%); 165→150 is -9%
  })
  it('isGovernedPromotion requires promoted + govern + provisionalAt (honesty)', () => {
    expect(isGovernedPromotion({ status: 'promoted', govern, provisionalAt: 1 })).toBe(true)
    expect(isGovernedPromotion({ status: 'promoted', provisionalAt: 1 })).toBe(false) // legacy: no govern
    expect(isGovernedPromotion({ status: 'promoted', govern })).toBe(false) // no probation
    expect(isGovernedPromotion({ status: 'provisional', govern, provisionalAt: 1 })).toBe(false)
  })
})

// ──────────────────── STABILITY ────────────────────

describe('scoreStability', () => {
  it('rewards a near-constant series (low cv, no clobber, current≈peak)', () => {
    const r = scoreStability(stableSeries)
    expect(r.metrics.clobberEvents).toBe(0)
    expect(r.metrics.entityCountCV).toBeLessThan(0.05)
    expect(r.score).toBeGreaterThan(90)
  })
  it('a churning series tanks Stability (high cv + clobbers + low current-vs-peak)', () => {
    const r = scoreStability(churningSeries)
    expect(r.metrics.clobberEvents).toBe(2) // 260→44 and 165→113
    expect(r.metrics.peakEntities).toBe(260)
    expect(r.metrics.currentVsPeak).toBeCloseTo(113 / 260, 2)
    expect(r.score).toBeLessThan(50)
    // and strictly worse than the stable series
    expect(r.score).toBeLessThan(scoreStability(stableSeries).score)
  })
  it('degrades gracefully with <2 builds (never throws)', () => {
    const r = scoreStability({ entityCountSeries: [], currentEntities: null })
    expect(r.metrics.builds).toBe(0)
    expect(Number.isFinite(r.score)).toBe(true)
  })
})

// ──────────────────── METABOLISM ────────────────────

describe('scoreMetabolism', () => {
  it('rewards a fresh, resolving, diverse ledger', () => {
    const r = scoreMetabolism(liveMetabolism)
    expect(r.score).toBeGreaterThan(85)
  })
  it('a FROZEN (extremely stale) ledger tanks Metabolism (catches the 2-day freeze)', () => {
    const r = scoreMetabolism(frozenMetabolism)
    expect(r.metrics.ledgerFreshnessHours).toBe(61)
    expect(r.metrics.frozenFactor).toBe(0.2) // stale past LEDGER_STALE_HOURS → floor
    expect(r.score).toBeLessThan(20)
    expect(r.notes).toContain('STALE')
  })
  it('all-temporal verdicts score verdict diversity low (degenerate engine)', () => {
    expect(scoreMetabolism(frozenMetabolism).metrics.verdictDiversity).toBeCloseTo(1 / 3, 3)
    expect(scoreMetabolism(liveMetabolism).metrics.verdictDiversity).toBe(1)
  })
  it('no claims ⇒ metabolism is AT REST (measured:false, neutral), never throws', () => {
    const r = scoreMetabolism({ ledgerFreshnessHours: null, claimTotal: 0, claimResolved: 0, verdictTypes: [] })
    expect(r.metrics.ledgerFreshnessHours).toBe(-1)
    expect(r.measured).toBe(false)
    expect(r.notes).toContain('AT REST')
    expect(Number.isFinite(r.score)).toBe(true)
  })
})

// ──────────────────── COMPOUNDING ────────────────────

describe('scoreCompounding', () => {
  it('rewards a genuinely graduating loop (governed promotions + efficacy + survival + bindings)', () => {
    const r = scoreCompounding(earningLoop)
    expect(r.metrics.governedPromotions).toBe(2)
    expect(r.score).toBeGreaterThan(50)
  })
  it('ALL-LEGACY promoted, UNGATED, scores Compounding 0 (honesty: 0 output ungated is a real failure)', () => {
    const r = scoreCompounding(legacyLoop) // no gate flags ⇒ ungated ⇒ no readiness credit
    expect(r.metrics.governedPromotions).toBe(0)
    expect(r.metrics.legacyPromoted).toBe(2)
    expect(r.metrics.promotionThroughput).toBe(0)
    expect(r.metrics.efficacyCoverage).toBe(0) // no efficacy fields
    expect(r.metrics.survivalProgress).toBe(0) // provisional facts have 0 observedSessions
    expect(r.metrics.bindingDrain).toBe(0) // absent binding ledger
    expect(r.metrics.readiness).toBe(0) // ungated + 0 output ⇒ no readiness
    expect(r.score).toBe(0)
  })
  it('bindingDrain is 0 when corrections is 0 (never divides by zero)', () => {
    const r = scoreCompounding({ facts: [], bindingCount: 5, correctionCount: 0 })
    expect(r.metrics.bindingDrain).toBe(0)
  })
})

// ──────────────────── GROUNDING ────────────────────

describe('scoreGrounding', () => {
  it('the best validated path + gated calibration scores high', () => {
    const r = scoreGrounding(bestGrounding)
    expect(r.metrics.groundingPathScore).toBe(100) // both pp gains active
    expect(r.score).toBeGreaterThan(95)
  })
  it('the DEFAULT agentic path + advisory-only calibration scores low-ish', () => {
    const r = scoreGrounding(defaultGrounding)
    expect(r.metrics.groundingPathScore).toBe(40) // floor: default path only
    expect(r.score).toBeLessThan(55)
    expect(r.notes).toContain('advisory')
  })
  it('enabling a validated grounding flag RAISES Grounding (the P0 flip)', () => {
    const off = scoreGrounding(defaultGrounding)
    const on = scoreGrounding({ ...defaultGrounding, wholeNoteGround: true })
    expect(on.score).toBeGreaterThan(off.score)
    expect(on.metrics.groundingPathScore).toBeGreaterThan(off.metrics.groundingPathScore)
  })
  it('citation-verify off zeroes that sub-signal', () => {
    const r = scoreGrounding({ ...bestGrounding, citationVerifyActive: false })
    expect(r.metrics.citationVerifyActive).toBe(0)
    expect(r.score).toBeLessThan(scoreGrounding(bestGrounding).score)
  })
})

// ──────────────────── overall weighting + regression ────────────────────

describe('computeCompoundingHealth', () => {
  it('overall is the weighted mean of the 4 axes; weakestAxis is the min', () => {
    const healthy = computeCompoundingHealth(deps())
    expect(healthy.overall).toBeGreaterThan(80)
    expect(healthy.builtAt).toBe(BUILT_AT)

    // The live-shaped baseline: churn + frozen ledger + legacy-only + default path.
    const baseline = computeCompoundingHealth(
      deps({ stability: churningSeries, metabolism: frozenMetabolism, compounding: legacyLoop, grounding: defaultGrounding })
    )
    expect(baseline.overall).toBeLessThan(35)
    expect(baseline.weakestAxis).toBe('compounding') // 0 — the honest floor
  })
  it('weights override changes the overall', () => {
    const base = computeCompoundingHealth(deps({ compounding: legacyLoop }))
    const heavy = computeCompoundingHealth(deps({ compounding: legacyLoop, weights: { compounding: 0.9 } }))
    expect(heavy.overall).toBeLessThan(base.overall) // compounding=0 dominates → drags overall down
  })
})

describe('detectCompoundingRegression', () => {
  it('flags an axis DROP vs the prior report', () => {
    const prev = computeCompoundingHealth(deps()) // healthy
    const curr = computeCompoundingHealth(deps({ metabolism: frozenMetabolism })) // metabolism collapses
    const msgs = detectCompoundingRegression(prev, curr)
    expect(msgs.some((m) => m.includes('metabolism axis dropped'))).toBe(true)
  })
  it('flags absolute FLOOR breaches even with no prior (first run)', () => {
    const curr = computeCompoundingHealth(deps({ compounding: legacyLoop })) // compounding=0 < floor
    const msgs = detectCompoundingRegression(null, curr)
    expect(msgs.some((m) => m.startsWith('FLOOR: compounding'))).toBe(true)
  })
  it('flags a promotionThroughput drop (earn loop regressing)', () => {
    const prev = computeCompoundingHealth(deps()) // earning: throughput 1.0
    const curr = computeCompoundingHealth(deps({ compounding: legacyLoop })) // throughput 0
    const msgs = detectCompoundingRegression(prev, curr)
    expect(msgs.some((m) => m.includes('promotionThroughput dropped'))).toBe(true)
  })
  it('flags clobberEvents rising (construction clobber returning)', () => {
    const prev = computeCompoundingHealth(deps()) // stable: 0 clobbers
    const curr = computeCompoundingHealth(deps({ stability: churningSeries })) // 2 clobbers
    const msgs = detectCompoundingRegression(prev, curr)
    expect(msgs.some((m) => m.includes('clobberEvents rose'))).toBe(true)
  })
  it('no regressions when the report is unchanged', () => {
    const r = computeCompoundingHealth(deps())
    expect(detectCompoundingRegression(r, r)).toEqual([])
  })
})

// ──────────────────── the "sufficiency, not appetite" rework ────────────────────
// Standing/uncontested claims are the HEALTHY majority; a mind at rest is not sick; the pathology is
// APPETITE (accumulation outpacing integration), not idleness. These lock in that behavior.

describe('sufficiency, not appetite — rework invariants', () => {
  it('a high standing (uncontested) fraction is NOT penalized', () => {
    // 300 claims, only 15 with a verdict → 95% standing. Full diversity + reconciling ⇒ still healthy.
    const r = scoreMetabolism({ ledgerFreshnessHours: 1, claimTotal: 300, claimResolved: 15, verdictTypes: ['temporal', 'supersession', 'jtms'] })
    expect(r.metrics.standingFraction).toBeCloseTo(0.95, 2)
    expect(r.score).toBe(100) // standing majority does not lower the score
    expect(r.notes).toContain('standing')
  })
  it('growing the claim count with all-standing claims does NOT lower Metabolism', () => {
    const small = scoreMetabolism({ ledgerFreshnessHours: 1, claimTotal: 100, claimResolved: 10, verdictTypes: ['temporal', 'supersession'] })
    const big = scoreMetabolism({ ledgerFreshnessHours: 1, claimTotal: 1000, claimResolved: 10, verdictTypes: ['temporal', 'supersession'] })
    expect(big.score).toBe(small.score) // volume-neutral: a bigger ledger is not sicker
  })
  it('freshness earns NO bonus (writing ≠ health): two fresh-enough ledgers score identically', () => {
    const base = { claimTotal: 100, claimResolved: 20, verdictTypes: ['temporal', 'supersession'] as string[] }
    const fresh = scoreMetabolism({ ...base, ledgerFreshnessHours: 0.1 })
    const older = scoreMetabolism({ ...base, ledgerFreshnessHours: 5 }) // still ≤ LEDGER_FRESH_HOURS
    expect(fresh.score).toBe(older.score)
    expect(fresh.metrics.frozenFactor).toBe(1)
  })
  it('AT REST: no claims + no facts ⇒ those axes are EXCLUDED from overall, not scored 0', () => {
    const atRest = computeCompoundingHealth(
      deps({
        metabolism: { ledgerFreshnessHours: 999, claimTotal: 0, claimResolved: 0, verdictTypes: [] },
        compounding: { facts: [], bindingCount: 0, correctionCount: 0 }
      })
    )
    expect(atRest.axes.metabolism.measured).toBe(false)
    expect(atRest.axes.compounding.measured).toBe(false)
    expect(atRest.unmeasuredAxes.sort()).toEqual(['compounding', 'metabolism'])
    // overall comes from stability + grounding only → high, NOT dragged toward 0 by idle loops
    expect(atRest.overall).toBeGreaterThan(80)
    // and an unmeasured axis never trips the absolute floor
    expect(detectCompoundingRegression(null, atRest).some((m) => m.includes('metabolism'))).toBe(false)
  })
  it('APPETITE: the fact store growing while graduation stays flat trips the warn', () => {
    const mk = (nProvisional: number): CompoundingHealthDeps =>
      deps({
        compounding: {
          facts: [
            { status: 'promoted', provisionalAt: 1, govern },
            ...Array.from({ length: nProvisional }, () => ({ status: 'provisional', provisionalAt: 1, observedSessions: [] as string[] }))
          ],
          bindingCount: 0,
          correctionCount: 10
        }
      })
    const prev = computeCompoundingHealth(mk(5))
    const curr = computeCompoundingHealth(mk(60)) // +55 facts, governed graduations flat → throughput falls
    const msgs = detectCompoundingRegression(prev, curr)
    expect(msgs.some((m) => m.startsWith('APPETITE:') && m.includes('growing without earning'))).toBe(true)
  })
  it('APPETITE does NOT fire on healthy standing-claim growth', () => {
    // claims triple (mostly standing), graduation healthy + unchanged ⇒ no appetite warn.
    const stable = deps({
      metabolism: { ledgerFreshnessHours: 1, claimTotal: 100, claimResolved: 10, verdictTypes: ['temporal', 'supersession', 'jtms'] },
      compounding: earningLoop
    })
    const grown = deps({
      metabolism: { ledgerFreshnessHours: 1, claimTotal: 300, claimResolved: 15, verdictTypes: ['temporal', 'supersession', 'jtms'] },
      compounding: earningLoop
    })
    const msgs = detectCompoundingRegression(computeCompoundingHealth(stable), computeCompoundingHealth(grown))
    expect(msgs.some((m) => m.startsWith('APPETITE:'))).toBe(false)
  })
  it('GATED but NOTHING ripe: readiness is 0, not a free 100 (the participation-trophy fix)', () => {
    // legacyLoop's provisional facts have 0 observed sessions ⇒ none clear the ≥2-session promote bar.
    // Gating must NOT hand out readiness for mere existence — nothing would fire if ungated.
    const gated = scoreCompounding({ ...legacyLoop, promotionGated: true, bindingGated: true })
    expect(gated.metrics.promotionGated).toBe(1)
    expect(gated.metrics.promotionReadyCount).toBe(0)
    expect(gated.metrics.readiness).toBe(0)
    // gating changes NOTHING when nothing is ripe — the low score is honest cold-start, not the gate
    expect(gated.score).toBe(scoreCompounding(legacyLoop).score)
  })
  it('GATED and RIPE: readiness credits ONLY the fraction that would fire if ungated', () => {
    // 4 provisional: 2 have survived ≥2 sessions (promotion-ready), 2 have none ⇒ readyFraction 0.5.
    const facts: CompoundingFact[] = [
      { status: 'provisional', provisionalAt: 1, observedSessions: ['a', 'b'] },
      { status: 'provisional', provisionalAt: 1, observedSessions: ['a', 'b', 'c'] },
      { status: 'provisional', provisionalAt: 1, observedSessions: [] },
      { status: 'provisional', provisionalAt: 1, observedSessions: [] }
    ]
    const r = scoreCompounding({ facts, bindingCount: 0, correctionCount: 20, promotionGated: true, bindingGated: true })
    expect(r.metrics.promotionReadyCount).toBe(2)
    expect(r.metrics.promotionReadyFraction).toBeCloseTo(0.5, 3)
    expect(r.metrics.readiness).toBe(50)
    // readiness can't be high without realized survival too — the two are coupled, so no fake credit
    expect(r.metrics.survivalProgress).toBeGreaterThan(0)
  })
  it('readiness does NOT hide a realization regression (governed-throughput drop still trips)', () => {
    const mk = (governed: number): CompoundingHealthDeps =>
      deps({
        compounding: {
          facts: [
            ...Array.from({ length: governed }, () => ({ status: 'promoted', provisionalAt: 1, govern })),
            { status: 'provisional', provisionalAt: 1, observedSessions: ['s'] },
            { status: 'provisional', provisionalAt: 1, observedSessions: [] }
          ],
          bindingCount: 0,
          correctionCount: 10,
          promotionGated: true,
          bindingGated: true
        }
      })
    const prev = computeCompoundingHealth(mk(2)) // governed throughput 2/2 = 1.0
    const curr = computeCompoundingHealth(mk(0)) // governed throughput 0/2 = 0 (regressed)
    const msgs = detectCompoundingRegression(prev, curr)
    expect(msgs.some((m) => m.includes('promotionThroughput dropped'))).toBe(true)
  })
  it('consolidation: a 0-clobber declining series is not penalized for being below peak', () => {
    const consolidating: StabilityDeps = {
      entityCountSeries: [200, 190, 180, 170, 160, 150, 140, 130, 120, 110], // monotone, no >30% drop
      currentEntities: 110
    }
    const r = scoreStability(consolidating)
    expect(r.metrics.clobberEvents).toBe(0)
    expect(r.metrics.currentVsPeakApplied).toBe(0) // below-peak NOT scored when there are no clobbers
    // same shape but with one destructive drop → currentVsPeak DOES apply and it scores worse
    const withClobber = scoreStability({ entityCountSeries: [200, 190, 180, 90, 160, 150, 140, 130, 120, 110], currentEntities: 110 })
    expect(withClobber.metrics.currentVsPeakApplied).toBe(1)
    expect(withClobber.score).toBeLessThan(r.score)
  })
})
