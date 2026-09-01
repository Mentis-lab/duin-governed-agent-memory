import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { extractScoredForecasts, properScore, scoreResolvedLedger } from './calibration-scoring'

const near = (a: number | null, b: number, tol = 1e-9): void => {
  expect(a).not.toBeNull()
  expect(Math.abs((a as number) - b)).toBeLessThan(tol)
}

describe('calibration-scoring (A4 proper scoring)', () => {
  it('extractScoredForecasts maps hit→1 / miss+averted→0, drops signal / moot / open / no-confidence', () => {
    const rows = [
      { confidence: 0.8, verdict: 'materialized' }, // → {0.8, 1}
      { confidence: 0.3, resolution: 'miss' }, // → {0.3, 0}
      { confidence: 0.6, verdict: 'averted' }, // → {0.6, 0} — risk did NOT materialize
      { confidence: 0.9, verdict: 'unobserved' }, // dropped (open/moot)
      { confidence: 0.7, verdict: 'materialized', signal: true }, // dropped (signal-mode)
      { verdict: 'materialized' } // dropped (no confidence)
    ]
    expect(extractScoredForecasts(rows)).toEqual([
      { confidence: 0.8, outcome: 1 },
      { confidence: 0.3, outcome: 0 },
      { confidence: 0.6, outcome: 0 }
    ])
  })

  it('materialized + averted cohort is non-degenerate (the averted→0 fix)', () => {
    // A real risk ledger resolves as materialized (1) or averted (0), rarely refuted. Before the
    // fix, averted was dropped → every row outcome=1 → baseRate=1 → baselineBrier=0 → skillScore null.
    const rows = [
      ...Array.from({ length: 12 }, () => ({ confidence: 0.7, verdict: 'averted' })),
      ...Array.from({ length: 8 }, () => ({ confidence: 0.7, verdict: 'materialized' }))
    ]
    const s = properScore(extractScoredForecasts(rows), 20)
    expect(s.n).toBe(20)
    expect(s.baseRate).toBeCloseTo(0.4, 9) // 8/20 — NOT the degenerate 1
    expect(s.brier).not.toBeNull()
    expect(s.skillScore).not.toBeNull() // the degenerate-null is gone
  })

  // Phase 3 — the `averted` reconciliation. STRUCTURAL coupling kinds (driver/convergence) never
  // `materialize`; they resolve `averted` (held) or `refuted` (broke). The old uniform averted→0
  // mapped every such row to 0 → baseRate=0 → baselineBrier=0 → skillScore permanently null.
  it('structural coupling `averted` scores as outcome 1 (coupling held), fixing the degeneracy', () => {
    const rows = [
      ...Array.from({ length: 14 }, () => ({ confidence: 0.7, verdict: 'averted', kind: 'driver' })),
      ...Array.from({ length: 6 }, () => ({ confidence: 0.7, verdict: 'refuted', kind: 'convergence' }))
    ]
    const scored = extractScoredForecasts(rows)
    expect(scored.filter((f) => f.outcome === 1).length).toBe(14) // structural averted → held → 1
    expect(scored.filter((f) => f.outcome === 0).length).toBe(6) // refuted → broke → 0
    const s = properScore(scored, 20)
    expect(s.baseRate).toBeCloseTo(0.7, 9) // 14/20 — real variance, NOT the degenerate 0
    expect(s.skillScore).not.toBeNull() // skill can now fire for a structural-coupling ledger
  })

  it('cascade (a THREAT kind) `averted` scores as outcome 0 — the threat did NOT materialize', () => {
    // cascade is NOT structural coupling: averted = threat defused = the predicted event did not
    // happen. Scoring it 1 would call a cascade "right" precisely when its threat failed to occur.
    expect(extractScoredForecasts([{ confidence: 0.75, verdict: 'averted', kind: 'cascade' }])).toEqual([
      { confidence: 0.75, outcome: 0 }
    ])
  })

  it('a non-coupling (risk) `averted` still scores as outcome 0 (the event did not happen)', () => {
    expect(extractScoredForecasts([{ confidence: 0.6, verdict: 'averted', kind: 'risk-window' }])).toEqual([
      { confidence: 0.6, outcome: 0 }
    ])
  })

  it('computes a known Brier + log-loss exactly', () => {
    // [(0.8,1),(0.3,0),(0.9,1),(0.2,0)] → Brier = (0.04+0.09+0.01+0.04)/4 = 0.045
    const s = properScore([
      { confidence: 0.8, outcome: 1 },
      { confidence: 0.3, outcome: 0 },
      { confidence: 0.9, outcome: 1 },
      { confidence: 0.2, outcome: 0 }
    ], 1)
    near(s.brier, 0.045)
    near(s.baseRate, 0.5)
    near(s.baselineBrier, 0.25) // 0.5*0.5
    near(s.skillScore, 1 - 0.045 / 0.25) // 0.82 — beats base rate
    const expectedLL = -(Math.log(0.8) + Math.log(0.7) + Math.log(0.9) + Math.log(0.8)) / 4
    near(s.logLoss, expectedLL)
  })

  it('an overconfident-and-wrong forecaster scores worse than the base rate (negative skill)', () => {
    // always says 0.95 but is right only half the time
    const fc = Array.from({ length: 20 }, (_, i) => ({ confidence: 0.95, outcome: (i % 2) as 0 | 1 }))
    const s = properScore(fc, 20)
    expect(s.brier!).toBeGreaterThan(s.baselineBrier!) // worse than base rate
    expect(s.skillScore!).toBeLessThan(0)
  })

  it('a well-calibrated forecaster has low ECE', () => {
    // 10 at 0.9 with 9 hits, 10 at 0.1 with 1 hit → perfectly calibrated
    const fc = [
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.9, outcome: (i < 9 ? 1 : 0) as 0 | 1 })),
      ...Array.from({ length: 10 }, (_, i) => ({ confidence: 0.1, outcome: (i < 1 ? 1 : 0) as 0 | 1 }))
    ]
    const s = properScore(fc, 20)
    expect(s.ece!).toBeLessThan(1e-9)
    expect(s.reliability.length).toBe(2)
  })

  it('gates the skill-score claim below minN but still returns descriptive Brier', () => {
    const s = properScore([{ confidence: 0.8, outcome: 1 }, { confidence: 0.2, outcome: 0 }], 20)
    expect(s.skillScore).toBeNull() // n=2 < 20 → no "beats baseline" claim
    near(s.brier, ((0.2 ** 2) + (0.2 ** 2)) / 2) // but the raw Brier is still computed
  })

  it('empty ledger → all-null (honest "nothing resolved yet")', () => {
    const s = properScore([], 20)
    expect(s).toMatchObject({ n: 0, brier: null, skillScore: null, reliability: [] })
  })
})

describe('scoreResolvedLedger (A4 wiring)', () => {
  it('loads the ledger, scores probabilistic resolutions, excludes signal/open rows', () => {
    const vault = mkdtempSync(join(tmpdir(), 'duin-cs-'))
    try {
      const state = join(vault, '.duin', '_state')
      mkdirSync(state, { recursive: true })
      const rows = [
        { kind: 'convergence', confidence: 0.8, verdict: 'materialized' }, // scored → 1
        { kind: 'driver', confidence: 0.2, verdict: 'refuted' }, // scored → 0
        { kind: 'decision-window', confidence: 0.9, verdict: 'materialized' }, // signal-mode → excluded
        { kind: 'cascade', confidence: 0.5, verdict: null } // open → excluded
      ]
      writeFileSync(join(state, 'risk-predictions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
      const s = scoreResolvedLedger(vault, 1)
      expect(s.n).toBe(2) // only the 2 probabilistic resolved rows
      expect(s.brier).toBeCloseTo(((0.8 - 1) ** 2 + (0.2 - 0) ** 2) / 2, 9) // 0.04
    } finally {
      rmSync(vault, { recursive: true, force: true })
    }
  })

  it('missing ledger / null vault → empty score (honest null)', () => {
    expect(scoreResolvedLedger(null).n).toBe(0)
    expect(scoreResolvedLedger('/no/such/vault').brier).toBeNull()
  })
})
