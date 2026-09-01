import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  scoreStalenessJudged,
  appendJudgeLabels,
  appendOperatorLabel,
  loadAdjudicatedLabels,
  outcomesFromScore,
  recordGroundingStalenessOutcomes,
  readGroundingStalenessOutcomes,
  groundingStalenessTrust,
  stalenessTrust,
  shouldFuseStaleness,
  STALENESS_TRUST_FLOOR,
  GROUNDING_STALENESS_DOMAIN,
  type JudgeDeps,
  type JudgeLabel,
  type JudgedFact,
  type LabelRow
} from './grounding-eval-live'

const dirs: string[] = []
function tmpVault(): string {
  const d = mkdtempSync(join(tmpdir(), 'grounding-eval-live-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

// A FAKE judge driven by a per-text lookup — the pure-scorer oracle (no model).
function fakeJudge(map: Record<string, JudgeLabel | null>): JudgeDeps {
  return { judgeStale: async (factText) => (factText in map ? map[factText] : null) }
}
// matchStale stand-in: flag any fact whose text contains 'FLAG'.
const matchFlag = (t: string): { label: string } | null => (t.includes('FLAG') ? { label: 'resolved-topic' } : null)

describe('scoreStalenessJudged (pure, injected judge)', () => {
  it('flagged+judged-valid => FALSE POSITIVE; flagged+judged-stale => true positive', async () => {
    const facts: JudgedFact[] = [
      { id: 'a', text: 'FLAG genuinely obsolete note' }, // flagged, judged stale → tp
      { id: 'b', text: 'FLAG buried valid preference' }, // flagged, judged valid → fp (buried)
      { id: 'c', text: 'clean valid preference' }, // unflagged, judged valid → tn
      { id: 'd', text: 'missed stale note' } // unflagged, judged stale → fn (signal missed it)
    ]
    const judge = fakeJudge({
      'FLAG genuinely obsolete note': 'stale',
      'FLAG buried valid preference': 'valid',
      'clean valid preference': 'valid',
      'missed stale note': 'stale'
    })
    const s = await scoreStalenessJudged(facts, matchFlag, judge, 111)
    expect(s).toMatchObject({ total: 4, flagged: 2, labeled: 4, tp: 1, fp: 1, fn: 1, tn: 1, abstained: 0 })
    expect(s.precision).toBe(0.5) // 1 stale of 2 flagged
    expect(s.recall).toBe(0.5) // 1 flagged of 2 genuinely stale
    expect(s.fpRate).toBe(0.5) // 1 wrongly-flagged of 2 valid — the buried-preference rate
    expect(s.flaggedValid).toEqual([{ id: 'b', text: 'FLAG buried valid preference', topic: 'resolved-topic' }])
    // only FLAGGED facts become adjudication rows
    expect(s.labels.map((r) => r.id).sort()).toEqual(['a', 'b'])
    expect(s.labels.every((r) => r.ts === 111 && r.matchedTopic === 'resolved-topic')).toBe(true)
  })

  it('KEYLESS-SAFE: a judge that abstains (null) on everything => labeled:0, no false precision', async () => {
    const facts: JudgedFact[] = [
      { id: 'a', text: 'FLAG something' },
      { id: 'b', text: 'plain something' }
    ]
    const s = await scoreStalenessJudged(facts, matchFlag, fakeJudge({}), 1)
    expect(s).toMatchObject({ total: 2, flagged: 1, labeled: 0, tp: 0, fp: 0, fn: 0, tn: 0, abstained: 2 })
    expect(s.precision).toBeNull()
    expect(s.recall).toBeNull()
    expect(s.fpRate).toBeNull()
    expect(s.labels).toEqual([]) // no fabricated label → nothing queued
    expect(outcomesFromScore(s)).toEqual([]) // and no calibration sample
  })

  it('fail-open: a THROWING judge abstains on that fact, never crashes', async () => {
    const throwing: JudgeDeps = { judgeStale: async () => { throw new Error('engine down') } }
    const s = await scoreStalenessJudged([{ id: 'a', text: 'FLAG x' }], matchFlag, throwing, 1)
    expect(s).toMatchObject({ labeled: 0, abstained: 1 })
  })
})

describe('operator-adjudication queue (grounding-eval-labels.jsonl)', () => {
  it('operatorLabel OVERRIDES judgeLabel on merge (operator is the higher authority)', () => {
    const vault = tmpVault()
    const rows: LabelRow[] = [
      { id: 'a', factText: 'FLAG buried preference', matchedTopic: 'topicX', judgeLabel: 'stale', ts: 1 },
      { id: 'b', factText: 'FLAG real obsolete', matchedTopic: 'topicY', judgeLabel: 'stale', ts: 1 }
    ]
    appendJudgeLabels(vault, rows)
    // operator disagrees with the judge on 'a' — it is actually a valid preference
    appendOperatorLabel(vault, 'a', 'valid', 2)
    const merged = loadAdjudicatedLabels(vault)
    expect(merged.get('a')!.judgeLabel).toBe('stale')
    expect(merged.get('a')!.operatorLabel).toBe('valid')
    expect(merged.get('a')!.label).toBe('valid') // operator OVERRIDES judge
    expect(merged.get('a')!.factText).toBe('FLAG buried preference') // fields carried from the judge row
    expect(merged.get('b')!.label).toBe('stale') // no operator verdict → judge stands
  })

  it('missing file => empty map; append round-trips', () => {
    const vault = tmpVault()
    expect(loadAdjudicatedLabels(vault).size).toBe(0)
    appendJudgeLabels(vault, [{ id: 'z', factText: 'FLAG z', matchedTopic: 't', judgeLabel: 'valid', ts: 5 }])
    const m = loadAdjudicatedLabels(vault)
    expect(m.size).toBe(1)
    expect(m.get('z')!.label).toBe('valid')
  })
})

describe('grounding-staleness calibration domain', () => {
  it('record/read round-trips; materialized-rate → precision + Wilson lower bound', () => {
    const vault = tmpVault()
    // 15 correct flags (materialized) + 5 false alarms (refuted) = 0.75 precision over 20 samples
    const outcomes = [
      ...Array(15).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'materialized' as const, id: `m${i}`, ts: 1 })),
      ...Array(5).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'refuted' as const, id: `r${i}`, ts: 1 }))
    ]
    expect(recordGroundingStalenessOutcomes(vault, outcomes)).toBe(20)
    expect(readGroundingStalenessOutcomes(vault)).toHaveLength(20)
    const trust = stalenessTrust(vault)!
    expect(trust.n).toBe(20)
    expect(trust.rate).toBeCloseTo(16 / 22, 5) // Beta(1,1)-smoothed 15/20
    expect(trust.wilson_lo).toBeGreaterThan(0)
    expect(trust.wilson_lo).toBeLessThan(0.75)
    expect(trust.gated).toBe(false) // n >= CAL_MIN_N (20)
  })

  it('gates below CAL_MIN_N; null when no samples', () => {
    const vault = tmpVault()
    expect(stalenessTrust(vault)).toBeNull() // no ledger yet
    expect(groundingStalenessTrust([])).toBeNull()
    const few = groundingStalenessTrust(
      Array(19).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'materialized' as const, id: `x${i}`, ts: 1 }))
    )!
    expect(few.gated).toBe(true)
  })

  it('outcomesFromScore maps flagged labels to verdicts (stale→materialized, valid→refuted)', async () => {
    const facts: JudgedFact[] = [
      { id: 'a', text: 'FLAG obsolete' },
      { id: 'b', text: 'FLAG buried' }
    ]
    const s = await scoreStalenessJudged(facts, matchFlag, fakeJudge({ 'FLAG obsolete': 'stale', 'FLAG buried': 'valid' }), 1)
    expect(outcomesFromScore(s)).toEqual([
      { kind: GROUNDING_STALENESS_DOMAIN, verdict: 'materialized', id: 'a', ts: 1 },
      { kind: GROUNDING_STALENESS_DOMAIN, verdict: 'refuted', id: 'b', ts: 1 }
    ])
  })

  it('an operator override flows into outcomesFromScore (operator-attended loop is load-bearing)', async () => {
    const vault = tmpVault()
    const facts: JudgedFact[] = [{ id: 'a', text: 'FLAG buried' }]
    // judge calls it stale → materialized (flag correct) without any adjudication
    const s = await scoreStalenessJudged(facts, matchFlag, fakeJudge({ 'FLAG buried': 'stale' }), 1)
    expect(outcomesFromScore(s)[0].verdict).toBe('materialized')
    // the operator adjudicates it VALID (a buried preference) → the RECORDED outcome flips to refuted
    appendJudgeLabels(vault, s.labels)
    appendOperatorLabel(vault, 'a', 'valid', 2)
    const outcomes = outcomesFromScore(s, loadAdjudicatedLabels(vault))
    expect(outcomes[0].verdict).toBe('refuted') // operator override reaches the measured precision signal
  })
})

describe('shouldFuseStaleness — the live-path fusion gate (grounding-staleness precision is load-bearing)', () => {
  const mkTrust = (rate: number, wilson_lo: number, n: number, gated: boolean) => ({ rate, wilson_lo, n, gated })

  it('NEVER fuses on an absent (null) signal — cold start grounds with the full operator block', () => {
    expect(shouldFuseStaleness(null)).toBe(false)
  })

  it('NEVER fuses while the signal is under-sampled (gated), even at perfect precision', () => {
    expect(shouldFuseStaleness(mkTrust(1, 0.95, 5, true))).toBe(false)
  })

  it('fuses only once a well-sampled signal clears the trust floor', () => {
    expect(shouldFuseStaleness(mkTrust(0.95, STALENESS_TRUST_FLOOR + 0.05, 40, false))).toBe(true)
    // a well-sampled but low-precision signal does NOT fuse (fail-safe: valid facts not buried)
    expect(shouldFuseStaleness(mkTrust(0.6, STALENESS_TRUST_FLOOR - 0.1, 40, false))).toBe(false)
  })

  it('is wired to the REAL calibration: a precise, well-sampled ledger yields fusion; a noisy one does not', () => {
    // 20/20 materialized flags (high precision, n≥CAL_MIN_N) → Wilson-lo clears the floor → fuse
    const precise = groundingStalenessTrust(
      Array(20).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'materialized' as const, id: `m${i}`, ts: 1 }))
    )
    expect(shouldFuseStaleness(precise)).toBe(true)
    // 12/20 materialized (0.6 precision) → Wilson-lo below floor → no fusion
    const noisy = groundingStalenessTrust([
      ...Array(12).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'materialized' as const, id: `m${i}`, ts: 1 })),
      ...Array(8).fill(0).map((_, i) => ({ kind: GROUNDING_STALENESS_DOMAIN, verdict: 'refuted' as const, id: `r${i}`, ts: 1 }))
    ])
    expect(shouldFuseStaleness(noisy)).toBe(false)
  })
})
