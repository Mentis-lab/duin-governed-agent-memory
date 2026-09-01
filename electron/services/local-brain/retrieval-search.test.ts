import { describe, expect, it } from 'vitest'

import type { RetrievedItem, RetrievalProbe, SearchFn } from './retrieval-probe'
import { aggregateProbes } from './retrieval-probe'
import {
  PROBE_FITNESS_MIN_N,
  SWEEP_ORDER,
  neighborsAlong,
  noiseFloor,
  probeRunToFitness,
  splitProbes,
  sweepRetrievalConfig,
  sweepWithHoldout
} from './retrieval-search'
import {
  RETRIEVAL_TUNABLE_BOUNDS,
  RETRIEVAL_TUNABLE_DEFAULTS,
  retrievalConfigFingerprint,
  type RetrievalTunables
} from './retrieval-tunables'

/**
 * A SYNTHETIC INDEX with a known optimum, so the sweep is tested on whether it FINDS something —
 * not merely on whether it runs. Probe i's gold note sits at rank (i % goldDepth) + 1, so:
 *
 *     recall@k  =  min(k, goldDepth) / goldDepth
 *
 * i.e. recall climbs with retrieval breadth and saturates at k = goldDepth. That is the real shape
 * of the recall/k curve, and it makes the optimum exactly known: the smallest k >= goldDepth.
 */
function makeIndex(goldDepth: number): { probes: RetrievalProbe[]; searchFn: SearchFn; seen: Set<string> } {
  const N = 40
  const probes: RetrievalProbe[] = Array.from({ length: N }, (_, i) => ({
    id: `p${i}`,
    query: `q${i}`,
    gold: [`gold-${i}.md`]
  }))
  const seen = new Set<string>()
  const searchFn: SearchFn = async (query, k, tuning) => {
    seen.add(retrievalConfigFingerprint(tuning))
    const i = Number(query.slice(1))
    const goldRank = (i % goldDepth) + 1 // 1-based
    const out: RetrievedItem[] = []
    for (let r = 1; r <= k; r++) {
      out.push({ file: r === goldRank ? `gold-${i}.md` : `filler-${r}.md`, score: 1 / r })
    }
    return out
  }
  return { probes, searchFn, seen }
}

describe('noiseFloor — the accept threshold must scale with evidence', () => {
  it('shrinks as the probe set grows', () => {
    expect(noiseFloor(25, 0.5)).toBeGreaterThan(noiseFloor(100, 0.5))
    expect(noiseFloor(100, 0.5)).toBeCloseTo(0.05, 5)
  })
  it('is maximal at p=0.5 and smaller at the extremes', () => {
    expect(noiseFloor(100, 0.5)).toBeGreaterThan(noiseFloor(100, 0.9))
  })
  it('more sigmas ⇒ a stricter bar', () => {
    expect(noiseFloor(100, 0.5, 2)).toBeCloseTo(2 * noiseFloor(100, 0.5, 1), 10)
  })
  it('no evidence ⇒ nothing can clear the bar', () => {
    expect(noiseFloor(0)).toBe(Infinity)
  })
})

describe('neighborsAlong — deterministic, bounded', () => {
  it('returns one step down and one step up', () => {
    const n = neighborsAlong(RETRIEVAL_TUNABLE_DEFAULTS, 'searchK')
    expect(n.map((c) => c.searchK)).toEqual([4, 8])
  })
  it('never proposes a value outside the bound', () => {
    const atMax: RetrievalTunables = {
      ...RETRIEVAL_TUNABLE_DEFAULTS,
      searchK: RETRIEVAL_TUNABLE_BOUNDS.searchK.max
    }
    for (const c of neighborsAlong(atMax, 'searchK')) {
      expect(c.searchK).toBeLessThanOrEqual(RETRIEVAL_TUNABLE_BOUNDS.searchK.max)
      expect(c.searchK).toBeGreaterThanOrEqual(RETRIEVAL_TUNABLE_BOUNDS.searchK.min)
    }
  })
  it('drops a neighbour that clamps back onto the incumbent', () => {
    const atMin: RetrievalTunables = { ...RETRIEVAL_TUNABLE_DEFAULTS, poolFloor: 10 }
    expect(neighborsAlong(atMin, 'poolFloor').map((c) => c.poolFloor)).toEqual([20])
  })
  it('is deterministic — same input, same candidate order', () => {
    expect(neighborsAlong(RETRIEVAL_TUNABLE_DEFAULTS, 'fuseWLex')).toEqual(
      neighborsAlong(RETRIEVAL_TUNABLE_DEFAULTS, 'fuseWLex')
    )
  })
})

describe('sweepRetrievalConfig — does it actually find the optimum', () => {
  it('climbs searchK to the known optimum and reports the gain', async () => {
    // gold sits within the top 8 ⇒ optimum is searchK=8; baseline searchK=6 recalls 6/8 = 0.75.
    const { probes, searchFn } = makeIndex(8)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS)

    expect(res.baseline.recallAtK).toBeCloseTo(0.75, 5)
    expect(res.bestConfig.searchK).toBe(8)
    expect(res.best.recallAtK).toBeCloseTo(1, 5)
    expect(res.improved).toBe(true)
    expect(res.gain).toBeCloseTo(0.25, 4)
    expect(res.steps[0].decision).toBe('baseline')
    expect(res.steps.some((s) => s.decision === 'accept' && s.dim === 'searchK')).toBe(true)
  })

  it('stops by CONVERGENCE once a full pass buys nothing, not by exhausting budget', async () => {
    const { probes, searchFn } = makeIndex(8)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS, {
      maxEvals: 500
    })
    expect(res.converged).toBe(true)
    expect(res.evaluated).toBeLessThan(500)
  })

  it('never pays for the same config twice', async () => {
    const { probes, searchFn, seen } = makeIndex(8)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS)
    // distinct configs actually handed to search == probe runs actually charged
    expect(seen.size).toBe(res.evaluated)
    const fps = res.steps.map((s) => s.fingerprint)
    expect(new Set(fps).size).toBe(fps.length)
  })

  it('respects the eval budget', async () => {
    const { probes, searchFn } = makeIndex(8)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS, {
      maxEvals: 3
    })
    expect(res.evaluated).toBeLessThanOrEqual(3)
    expect(res.converged).toBe(false)
  })

  it('rejects an improvement that does not clear the noise floor', async () => {
    // Flat objective: every config scores identically, so every delta is 0.
    const { probes } = makeIndex(8)
    const flat: SearchFn = async (query) => {
      const i = Number(query.slice(1))
      return i < 20 ? [{ file: `gold-${i}.md`, score: 1 }] : [{ file: 'nope.md', score: 1 }]
    }
    const res = await sweepRetrievalConfig(probes, flat, RETRIEVAL_TUNABLE_DEFAULTS)
    expect(res.improved).toBe(false)
    expect(res.gain).toBe(0)
    expect(res.steps.filter((s) => s.decision === 'accept')).toHaveLength(0)
    // and it must hand back the baseline, not the last thing it tried
    expect(res.bestConfig).toEqual(RETRIEVAL_TUNABLE_DEFAULTS)
  })

  it('never returns a config worse than the baseline, even when candidates regress', async () => {
    // Objective that gets WORSE with breadth (distractors crowd the gold out).
    const { probes } = makeIndex(8)
    const regressing: SearchFn = async (query, k) => {
      const i = Number(query.slice(1))
      return k <= 6 ? [{ file: `gold-${i}.md`, score: 1 }] : [{ file: 'distractor.md', score: 1 }]
    }
    const res = await sweepRetrievalConfig(probes, regressing, RETRIEVAL_TUNABLE_DEFAULTS)
    expect(res.improved).toBe(false)
    expect(res.best.recallAtK).toBeGreaterThanOrEqual(res.baseline.recallAtK)
    expect(res.bestConfig.searchK).toBe(RETRIEVAL_TUNABLE_DEFAULTS.searchK)
  })

  it('starts from the CURRENT config, not the shipped default', async () => {
    const { probes, searchFn } = makeIndex(8)
    const current: RetrievalTunables = { ...RETRIEVAL_TUNABLE_DEFAULTS, searchK: 8, fuseWLex: 1.5 }
    const res = await sweepRetrievalConfig(probes, searchFn, current)
    expect(res.steps[0].config).toEqual(current)
    expect(res.baseline.recallAtK).toBeCloseTo(1, 5) // already optimal ⇒ nothing to gain
    expect(res.improved).toBe(false)
  })

  it('can improve a non-searchK dimension too', async () => {
    const { probes } = makeIndex(8)
    // Gold is only retrieved when the lexical weight is pushed above the default 2.0.
    const lexSensitive: SearchFn = async (query, _k, tuning) => {
      const i = Number(query.slice(1))
      return tuning.fuseWLex > 2.0
        ? [{ file: `gold-${i}.md`, score: 1 }]
        : [{ file: 'wrong.md', score: 1 }]
    }
    const res = await sweepRetrievalConfig(probes, lexSensitive, RETRIEVAL_TUNABLE_DEFAULTS)
    expect(res.improved).toBe(true)
    expect(res.bestConfig.fuseWLex).toBeGreaterThan(2.0)
    expect(res.best.recallAtK).toBeCloseTo(1, 5)
  })

  it('every dimension is reachable by the sweep', () => {
    expect(new Set(SWEEP_ORDER).size).toBe(Object.keys(RETRIEVAL_TUNABLE_DEFAULTS).length)
  })

  it('walks an improving direction to exhaustion instead of one step per pass', async () => {
    // gold within top 12 ⇒ searchK must climb 6→8→10→12. Those four measurements must be
    // CONSECUTIVE (a line search), not spread across three full passes with all seven other
    // dimensions re-measured between them — that difference was 40 probe runs versus 20.
    const { probes, searchFn } = makeIndex(12)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS, {
      maxEvals: 100
    })
    expect(res.bestConfig.searchK).toBe(12)
    expect(res.best.recallAtK).toBeCloseTo(1, 5)
    expect(res.converged).toBe(true)

    const accepted = res.steps.filter((s) => s.decision === 'accept')
    expect(accepted.map((s) => s.dim)).toEqual(['searchK', 'searchK', 'searchK'])
    // all accepts land in the FIRST pass — proof the walk happened rather than pass-per-step
    expect(accepted.every((s) => s.round === 1)).toBe(true)
    // one pass over 8 dimensions plus a 4-step walk; a pass-per-step sweep costs roughly double
    expect(res.evaluated).toBeLessThanOrEqual(24)
  })

  it('float dimensions never drift — the archive depends on stable fingerprints', async () => {
    const down = neighborsAlong(RETRIEVAL_TUNABLE_DEFAULTS, 'recencyMaxBoost')[0]
    // 0.15 - 0.05 is 0.09999999999999999 in IEEE754; it must land on exactly 0.1 or the archive
    // treats it as an unmeasured cell forever.
    expect(down.recencyMaxBoost).toBe(0.1)
    expect(retrievalConfigFingerprint(down)).toContain('recencyMaxBoost=0.1')

    const { probes, searchFn } = makeIndex(8)
    const res = await sweepRetrievalConfig(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS)
    for (const s of res.steps) {
      expect(s.fingerprint).not.toMatch(/\d\.\d{6,}/)
    }
  })
})

describe('sweepWithHoldout — the check EvolveMem skips', () => {
  it('splits by stride so both halves stay distributionally identical', () => {
    const probes: RetrievalProbe[] = Array.from({ length: 9 }, (_, i) => ({
      id: `p${i}`,
      query: `q${i}`,
      gold: []
    }))
    const { train, test } = splitProbes(probes, 3)
    expect(test.map((p) => p.id)).toEqual(['p2', 'p5', 'p8'])
    expect(train).toHaveLength(6)
    // deterministic — no RNG, so a sweep is reproducible and auditable
    expect(splitProbes(probes, 3).test).toEqual(test)
  })

  it('confirms a REAL gain on probes the sweep never saw', async () => {
    const { probes, searchFn } = makeIndex(12) // genuine recall/k curve — generalizes
    const res = await sweepWithHoldout(probes, searchFn, RETRIEVAL_TUNABLE_DEFAULTS, {
      maxEvals: 100
    })
    expect(res.bestConfig.searchK).toBe(12)
    expect(res.heldout.confirmed).toBe(true)
    expect(res.heldout.heldoutGain).toBeGreaterThan(0)
    // a real effect transfers, so almost nothing is lost between train and held-out
    expect(Math.abs(res.heldout.overfitGap)).toBeLessThan(0.2)
  })

  it('exposes a gain that exists ONLY on the training probes as unconfirmed', async () => {
    // Adversarial objective: a config change helps exactly the probes the sweep trains on
    // (indices not divisible by 3) and does nothing for the held-out ones. A loop without a
    // split would report a large win here.
    const { probes } = makeIndex(8)
    const memorizing: SearchFn = async (query, _k, tuning) => {
      const i = Number(query.slice(1))
      const isTest = (i + 1) % 3 === 0
      const helped = tuning.searchK > RETRIEVAL_TUNABLE_DEFAULTS.searchK && !isTest
      return helped ? [{ file: `gold-${i}.md`, score: 1 }] : [{ file: 'wrong.md', score: 1 }]
    }
    const res = await sweepWithHoldout(probes, memorizing, RETRIEVAL_TUNABLE_DEFAULTS, {
      maxEvals: 100
    })
    expect(res.improved).toBe(true) // training says it won...
    expect(res.heldout.confirmed).toBe(false) // ...held-out says it did not
    expect(res.heldout.heldoutGain).toBeLessThanOrEqual(0)
    expect(res.heldout.overfitGap).toBeGreaterThan(0.2) // and names how much was memorization
  })
})

describe('probeRunToFitness — the seam into the existing keep-if-better gate', () => {
  const mkRun = (n: number, recall: number): ReturnType<typeof aggregateProbes> =>
    aggregateProbes(
      Array.from({ length: n }, (_, i) => ({
        id: `p${i}`,
        query: 'q',
        gold: ['g.md'],
        retrieved: [],
        recallAtK: recall,
        hitAtK: recall > 0,
        reciprocalRank: recall,
        missed: []
      })),
      RETRIEVAL_TUNABLE_DEFAULTS,
      6
    )

  it('projects into the EngineFitness shape gateVector already consumes', () => {
    const f = probeRunToFitness(mkRun(40, 0.8))
    expect(f).toEqual({ engine: 'retrieval-probe:recall', score: 0.8, n: 40, gated: false })
  })

  it('a probe set at or above the maturity floor is UNgated — this is the starvation fix', () => {
    // The live recall-efficacy engines have 17 observations all-time and can never clear n>=20,
    // so every adjudication returns 'maturing'. A labelled probe set clears it in one run.
    expect(probeRunToFitness(mkRun(PROBE_FITNESS_MIN_N, 0.5)).gated).toBe(false)
    expect(probeRunToFitness(mkRun(17, 0.5)).gated).toBe(true)
  })

  it('an empty run scores null rather than a fake 0', () => {
    expect(probeRunToFitness(mkRun(0, 0)).score).toBeNull()
  })
})
