import { describe, it, expect } from 'vitest'
import {
  renderTasteBlock,
  renderFailureBlock,
  renderCalibrationBlock, renderOwedForecastsBlock } from './personalization-blocks'
import type { Taste } from '../brain/learn-native'
import type { FailureLedgerRecord } from '../failure-ledger'
import type { KindRate } from '../brain/calibration-weight'

const taste = (over: Partial<Taste> = {}): Taste => ({
  values: [],
  frameworks: [],
  correction_rules: [],
  ...over
})

describe('renderTasteBlock', () => {
  it('is empty for null / no data (byte-identical prompt)', () => {
    expect(renderTasteBlock(null)).toBe('')
    expect(renderTasteBlock(taste())).toBe('')
  })

  it('renders correction rules with why', () => {
    const out = renderTasteBlock(
      taste({
        correction_rules: [
          { candidate_rule: 'lead with the outcome', why: 'TQ rereads otherwise', status: 'new', ts: '2026-01-01' }
        ]
      })
    )
    expect(out).toContain('OPERATOR TASTE')
    expect(out).toContain('- lead with the outcome (why: TQ rereads otherwise)')
  })

  it('ranks bound/confirmed rules ahead of new, then by recency', () => {
    const out = renderTasteBlock(
      taste({
        correction_rules: [
          { correction: 'new-rule', status: 'new', ts: '2026-05-01' },
          { correction: 'bound-rule', status: 'bound', ts: '2026-01-01' },
          { correction: 'newer-rule', status: 'new', ts: '2026-06-01' }
        ]
      })
    )
    const iBound = out.indexOf('bound-rule')
    const iNewer = out.indexOf('newer-rule')
    const iNew = out.indexOf('new-rule')
    expect(iBound).toBeGreaterThanOrEqual(0)
    expect(iBound).toBeLessThan(iNewer) // bound first
    expect(iNewer).toBeLessThan(iNew) // then most recent among 'new'
  })

  it('caps to 12 rules', () => {
    const rules = Array.from({ length: 30 }, (_, i) => ({ correction: `rule-${i}`, status: 'new', ts: `2026-01-${i}` }))
    const out = renderTasteBlock(taste({ correction_rules: rules }))
    expect((out.match(/^- /gm) || []).length).toBe(12)
  })

  it('renders values/frameworks even with no correction rules', () => {
    const out = renderTasteBlock(taste({ values: ['rigor', 'local-first'], frameworks: ['MECE'] }))
    expect(out).toContain('Values: rigor · local-first')
    expect(out).toContain('Frameworks: MECE')
  })

  it('tolerates non-string values/rules without throwing', () => {
    const out = renderTasteBlock(
      taste({ values: [{ x: 1 } as unknown], correction_rules: [{ candidate_rule: 'ok', status: 'new', ts: '' }] })
    )
    expect(out).toContain('- ok')
  })

  // Phase 0.1 — veto-leak guard. A veto is forwarded as a correction-polarity row whose
  // `correction` field carries the REJECTED inference (empty candidate_rule). It must NOT
  // be rendered under "Corrections to honor" — that would flip "stop inferring X" into "do X".
  it('does NOT surface a vetoed inference as a rule to honor', () => {
    const out = renderTasteBlock(
      taste({
        correction_rules: [
          { correction: 'operator wants emoji in every reply', candidate_rule: '', polarity: 'correction', status: 'new', ts: '2026-06-01' },
          { candidate_rule: 'lead with the outcome', polarity: 'positive', status: 'new', ts: '2026-06-02' }
        ]
      })
    )
    expect(out).not.toContain('emoji in every reply') // the rejected inference is suppressed
    expect(out).toContain('- lead with the outcome') // genuine distilled guidance still renders
  })

  it('still renders a correction-polarity row when it carries a distilled candidate_rule', () => {
    const out = renderTasteBlock(
      taste({ correction_rules: [{ correction: 'was too verbose', candidate_rule: 'be terse', polarity: 'correction', status: 'new', ts: '2026-06-01' }] })
    )
    expect(out).toContain('- be terse') // the rule is honored; only the raw "what was wrong" text is withheld
    expect(out).not.toContain('was too verbose')
  })

  // Phase 1b — a bound rule grounds via the operator block; drop its taste duplicate.
  it('drops a rule already grounded as an operator fact (excludeRules)', () => {
    const out = renderTasteBlock(
      taste({
        correction_rules: [
          { candidate_rule: 'Lead with the outcome', polarity: 'positive', status: 'new', ts: '2026-06-01' },
          { candidate_rule: 'Cite sources', polarity: 'positive', status: 'new', ts: '2026-06-02' }
        ]
      }),
      new Set(['lead with the outcome'])
    )
    expect(out).not.toContain('Lead with the outcome')
    expect(out).toContain('Cite sources')
  })
})

const fail = (over: Partial<FailureLedgerRecord>): FailureLedgerRecord => ({
  id: 'f',
  fingerprint: 'fp',
  kind: 'command_failed',
  message: 'something broke',
  count: 1,
  replaySeed: {},
  firstSeenAt: 1,
  lastSeenAt: 1,
  createdAt: 1,
  updatedAt: 1,
  ...over
})

describe('renderFailureBlock', () => {
  it('is empty for null / empty', () => {
    expect(renderFailureBlock(null)).toBe('')
    expect(renderFailureBlock([])).toBe('')
  })

  it('renders and sorts by count desc, caps at 6', () => {
    const failures = Array.from({ length: 10 }, (_, i) =>
      fail({ id: `f${i}`, message: `m${i}`, count: i, kind: 'runtime_failed', lastSeenAt: i })
    )
    const out = renderFailureBlock(failures)
    expect(out).toContain('KNOWN FAILURE MODES')
    expect((out.match(/^- /gm) || []).length).toBe(6)
    // highest count (9) appears before a lower one (4)
    expect(out.indexOf('m9')).toBeLessThan(out.indexOf('m4'))
  })

  it('includes kind, count marker, and truncated command', () => {
    const out = renderFailureBlock([fail({ kind: 'proof_failed', count: 3, message: 'gate', command: 'npm test' })])
    expect(out).toContain('(proof_failed×3) gate [npm test]')
  })
})

describe('renderCalibrationBlock', () => {
  it('is empty for null / empty', () => {
    expect(renderCalibrationBlock(null)).toBe('')
    expect(renderCalibrationBlock(new Map())).toBe('')
  })

  it('skips gated (min-N) and null-rate kinds', () => {
    const m = new Map<string, KindRate>([
      ['gated_kind', { rate: 0.9, observed: 2, gated: true }],
      ['null_kind', { rate: null, observed: 50, gated: false }]
    ])
    expect(renderCalibrationBlock(m)).toBe('')
  })

  it('splits reliable (>=0.6) and unreliable (<0.4)', () => {
    const m = new Map<string, KindRate>([
      ['chain_slip', { rate: 0.8, observed: 40, gated: false }],
      ['vibes', { rate: 0.2, observed: 40, gated: false }],
      ['midd', { rate: 0.5, observed: 40, gated: false }]
    ])
    const out = renderCalibrationBlock(m)
    expect(out).toContain('OPERATOR CALIBRATION')
    expect(out).toContain('reliable (weight up): chain_slip (80%)')
    expect(out).toContain('unreliable (caveat / weight down): vibes (20%)')
    expect(out).not.toContain('midd') // 0.5 is neither strong nor weak
  })
})

// The forecast backlog used to be a NOTIFICATION ("2 forecasts are past their review
// date"). That was the wrong instrument: a forecast review is a question whose entire
// value is the ANSWER, and a toast cannot collect one — so it was dismissed and the loop
// stayed open. It is now an invitation to ask, injected into the turn.
describe('renderOwedForecastsBlock', () => {
  const owed = [
    { id: 'f1', predicted: 'TapTap confirms the 二测 slot', days_overdue: 6 },
    { id: 'f2', predicted: '4399 comes back on the CPS terms', eval_by: '2026-07-30' }
  ]

  it('is empty when nothing is owed, so the prompt is byte-identical', () => {
    expect(renderOwedForecastsBlock([])).toBe('')
    expect(renderOwedForecastsBlock(null)).toBe('')
    expect(renderOwedForecastsBlock(undefined)).toBe('')
  })

  it('names each open loop, with how overdue it is', () => {
    const out = renderOwedForecastsBlock(owed)
    expect(out).toContain('TapTap confirms the 二测 slot')
    expect(out).toContain('6d ago')
    expect(out).toContain('4399 comes back on the CPS terms')
    expect(out).toContain('2026-07-30')
  })

  // The restraint is the feature. A second brain that opens every turn with "by the way…"
  // is worse than one that never asks, so the instructions have to outrank the asking.
  it('tells the model to ask ONE, at the end, and never to interrupt the task', () => {
    const out = renderOwedForecastsBlock(owed)
    expect(out).toMatch(/ONE per reply/i)
    expect(out).toMatch(/never interrupt the actual task/i)
    expect(out).toMatch(/END of your reply/i)
    expect(out).toMatch(/already asked .* do not ask again/i)
    expect(out).toMatch(/stay quiet/i)
  })

  it('caps the list — this is a passing question, not a status report', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, predicted: `thing ${i}` }))
    const out = renderOwedForecastsBlock(many)
    expect(out).toContain('thing 0')
    expect(out).not.toContain('thing 5')
  })

  it('skips rows with no prediction text rather than emitting a bare bullet', () => {
    expect(renderOwedForecastsBlock([{ id: 'x' }, { id: 'y', predicted: '   ' }])).toBe('')
  })
})
