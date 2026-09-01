// GOLDEN-NUMBER parity lock for the calibration port.
//
// The existing calibration-native.test.ts checks Wilson bounds only by INEQUALITY
// (lo < rate < hi). That cannot catch a silent numeric drift — an off-by-one in the
// Wilson formula, a wrong z, or a miss→wrong misclassification — which is exactly
// the failure mode that would corrupt the moat's honesty signal without any test
// going red (the code comments show these bugs were hit once already).
//
// This file pins EXACT useful_rate / smoothed_rate / wilson_lo / wilson_hi / gated
// for known fixtures. The expected literals were computed by an INDEPENDENT Wilson
// implementation (not the one under test) with z=1.96 and Python round-half-even to
// 3 decimals — so this asserts the numbers, not just their ordering. If the read-
// route lane (or anyone) re-touches the calibration math, these must stay green.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { calibration } from './calibration-native'

describe('calibration-native — golden numbers (exact Wilson / rate parity)', () => {
  let dir: string
  const stateDir = (): string => join(dir, '.duin', '_state')
  const write = (name: string, rows: unknown[]): void =>
    writeFileSync(join(stateDir(), name), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')

  // useful (hit) and wrong (miss) risk-domain rows, matching the shapes the existing
  // suite proves map to useful/wrong.
  const hit = (i: number) => ({ id: `h${i}`, kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: `2026-06-${(i % 28) + 1}` })
  const miss = (i: number) => ({ id: `m${i}`, kind: 'deadline', verdict: 'refuted', outcome: 'miss', resolved: `2026-05-${(i % 28) + 1}` })
  const rows = (nUseful: number, nWrong: number): unknown[] => [
    ...Array.from({ length: nUseful }, (_, i) => hit(i)),
    ...Array.from({ length: nWrong }, (_, i) => miss(i))
  ]

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-calgold-'))
    mkdirSync(stateDir(), { recursive: true })
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('k=2, n=3 (gated, small sample): exact rate/smoothed/Wilson', () => {
    write('risk-predictions.jsonl', rows(2, 1))
    const d = calibration(dir).domains['risk']
    expect(d.observed).toBe(3)
    expect(d.useful).toBe(2)
    expect(d.wrong).toBe(1)
    expect(d.useful_rate).toBe(0.667)
    expect(d.smoothed_rate).toBe(0.6)
    expect(d.wilson_lo).toBe(0.208)
    expect(d.wilson_hi).toBe(0.939)
    expect(d.gated).toBe(true) // 3 < min_n(20)
  })

  it('k=18, n=23 (ungated): exact rate/smoothed/Wilson', () => {
    write('risk-predictions.jsonl', rows(18, 5))
    const d = calibration(dir).domains['risk']
    expect(d.observed).toBe(23)
    expect(d.useful_rate).toBe(0.783)
    expect(d.smoothed_rate).toBe(0.76)
    expect(d.wilson_lo).toBe(0.581)
    expect(d.wilson_hi).toBe(0.903)
    expect(d.gated).toBe(false) // 23 >= min_n(20)
  })

  it('k=20, n=20 (perfect, at the gate): rate=1, Wilson upper clamps to 1', () => {
    write('risk-predictions.jsonl', rows(20, 0))
    const d = calibration(dir).domains['risk']
    expect(d.observed).toBe(20)
    expect(d.useful_rate).toBe(1)
    expect(d.smoothed_rate).toBe(0.955)
    expect(d.wilson_lo).toBe(0.839)
    expect(d.wilson_hi).toBe(1)
    expect(d.gated).toBe(false)
  })

  it('n=0 (no observed outcomes): rate null, Wilson [null, null]', () => {
    write('risk-predictions.jsonl', [{ id: 'open1', kind: 'deadline', verdict: null, outcome: null, resolved: '' }])
    const d = calibration(dir).domains['risk']
    expect(d.observed).toBe(0)
    expect(d.useful_rate).toBeNull()
    expect(d.smoothed_rate).toBeNull()
    expect(d.wilson_lo).toBeNull()
    expect(d.wilson_hi).toBeNull()
  })
})
