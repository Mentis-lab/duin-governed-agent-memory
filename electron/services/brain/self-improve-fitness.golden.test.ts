// Golden + logic lock for the self-improvement fitness vector and keep-if-better gate.
// The vector is a projection of calibration().domains, so we pin readFitnessVector's
// numbers to the same independently-computed Wilson literals the calibration golden test
// uses (the honesty signal is load-bearing), and exhaustively exercise gateVector's
// keep/reject/inconclusive branches on synthetic vectors.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFitnessVector, gateVector, type EngineFitness } from './self-improve-fitness'

describe('self-improve-fitness — vector projection (golden)', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  const write = (name: string, rows: unknown[]): void =>
    writeFileSync(join(stateDir(), name), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
  const hit = (i: number) => ({ id: `h${i}`, kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: `2026-06-${(i % 28) + 1}` })
  const miss = (i: number) => ({ id: `m${i}`, kind: 'deadline', verdict: 'refuted', outcome: 'miss', resolved: `2026-05-${(i % 28) + 1}` })
  const rows = (u: number, w: number): unknown[] => [
    ...Array.from({ length: u }, (_, i) => hit(i)),
    ...Array.from({ length: w }, (_, i) => miss(i)),
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-rsifit-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('projects the risk engine wilson_lo, ungated at n>=20 (k=18,n=23 -> 0.581)', () => {
    write('risk-predictions.jsonl', rows(18, 5))
    const v = readFitnessVector(dir)
    const risk = v.find((e) => e.engine === 'risk')!
    expect(risk).toBeDefined()
    expect(risk.n).toBe(23)
    expect(risk.score).toBe(0.581) // exact Wilson lower bound, independently computed
    expect(risk.gated).toBe(false)
  })

  it('windows the held-out via `since` (only outcomes resolved on/after the cut)', () => {
    // hits resolve in June, misses in May. since=2026-06-01 keeps only the June hits.
    write('risk-predictions.jsonl', rows(22, 8))
    const full = readFitnessVector(dir).find((e) => e.engine === 'risk')!
    const windowed = readFitnessVector(dir, '2026-06-01').find((e) => e.engine === 'risk')!
    expect(full.n).toBe(30) // all resolved
    expect(windowed.n).toBe(22) // May misses excluded by the held-out cut
    expect(windowed.score!).toBeGreaterThan(full.score!) // dropping the misses raises the floor
  })

  it('gates the score below n=20 (k=2,n=3)', () => {
    write('risk-predictions.jsonl', rows(2, 1))
    const risk = readFitnessVector(dir).find((e) => e.engine === 'risk')!
    expect(risk.n).toBe(3)
    expect(risk.score).toBe(0.208)
    expect(risk.gated).toBe(true)
  })
})

describe('self-improve-fitness — gateVector (keep-if-better, multi-objective)', () => {
  const f = (engine: string, score: number | null, n: number, gated = n < 20): EngineFitness => ({ engine, score, n, gated })

  it('passes when no engine regresses', () => {
    const before = [f('risk', 0.70, 30), f('stream', 0.60, 25)]
    const after = [f('risk', 0.78, 34), f('stream', 0.60, 26)]
    const v = gateVector(before, after)
    expect(v.pass).toBe(true)
    expect(v.regressions).toHaveLength(0)
  })

  it('fails when any engine regresses beyond minDelta', () => {
    const before = [f('risk', 0.80, 40), f('stream', 0.60, 25)]
    const after = [f('risk', 0.80, 41), f('stream', 0.52, 26)] // stream drops 0.08
    const v = gateVector(before, after)
    expect(v.pass).toBe(false)
    expect(v.regressions.map((d) => d.engine)).toEqual(['stream'])
    expect(v.regressions[0].delta).toBe(-0.08)
  })

  it('respects minDelta noise floor (small drop tolerated)', () => {
    const before = [f('risk', 0.80, 40)]
    const after = [f('risk', 0.785, 41)] // -0.015
    expect(gateVector(before, after, 0.02).pass).toBe(true) // within floor
    expect(gateVector(before, after, 0.0).pass).toBe(false) // strict
  })

  it('gated-after with a baseline is INCONCLUSIVE, not a hard fail', () => {
    const before = [f('risk', 0.80, 40)]
    const after = [f('risk', null, 5, true)]
    const v = gateVector(before, after)
    expect(v.pass).toBe(true) // does not auto-reject
    expect(v.inconclusive.map((d) => d.engine)).toEqual(['risk'])
  })

  it('no trustworthy baseline = establishing, never blocks', () => {
    const before = [f('risk', null, 3, true)]
    const after = [f('risk', 0.70, 25)]
    const v = gateVector(before, after)
    expect(v.pass).toBe(true)
    expect(v.regressions).toHaveLength(0)
    expect(v.inconclusive).toHaveLength(0)
  })
})
