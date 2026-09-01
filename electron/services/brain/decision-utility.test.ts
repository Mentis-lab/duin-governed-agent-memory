import { describe, it, expect } from 'vitest'
import { preCommitCatchRate, decisionUtility, type DecisionRow } from './decision-utility'

const preds = [
  { created: '2026-06-10', track: '北澜' },
  { created: '2026-06-20', track: 'orbis' }
]
const LEDGER_START = '2026-06-10'

const dec = (id: string, over: Partial<DecisionRow> = {}): DecisionRow => ({
  id,
  date: '2026-07-01',
  reversibility: 'reversible',
  tags: ['decision', '北澜'],
  ...over
})

describe('preCommitCatchRate (M3)', () => {
  it('counts a decision as caught when a prior signal shared its workstream', () => {
    const r = preCommitCatchRate(preds, [dec('a')], LEDGER_START)
    expect(r.value).toBe(1)
    expect(r.status).toBe('measured')
  })

  it('a signal created AFTER the decision does not count — foresight must precede the commit', () => {
    const late = [{ created: '2026-07-05', track: '北澜' }]
    expect(preCommitCatchRate(late, [dec('a')], LEDGER_START).value).toBe(0)
  })

  it('a signal in a DIFFERENT workstream does not count', () => {
    expect(preCommitCatchRate(preds, [dec('a', { tags: ['decision', 'AIT'] })], LEDGER_START).value).toBe(0)
  })

  it('EXCLUDES decisions predating the ledger instead of scoring them as misses', () => {
    const old = dec('old', { date: '2026-04-01' })
    const r = preCommitCatchRate(preds, [old, dec('new')], LEDGER_START)
    expect(r.decisionsExcludedPreLedger).toBe(1)
    expect(r.decisionsInWindow).toBe(1)
    expect(r.value).toBe(1) // the excluded one did not drag it to 0.5
  })

  it('scores one-way decisions separately — the case where a miss matters most', () => {
    const r = preCommitCatchRate(
      preds,
      [dec('rev'), dec('oneway', { reversibility: 'one-way', tags: ['decision', 'AIT'] })],
      LEDGER_START
    )
    expect(r.value).toBe(0.5)
    expect(r.oneWayValue).toBe(0) // the irreversible one was uncaught
  })

  it('reports no-eligible-decisions rather than a rate when nothing is in window', () => {
    const r = preCommitCatchRate(preds, [dec('old', { date: '2026-01-01' })], LEDGER_START)
    expect(r.status).toBe('no-eligible-decisions')
    expect(r.value).toBeNull()
  })

  it('undated decisions are dropped from the denominator', () => {
    const r = preCommitCatchRate(preds, [dec('a'), { id: 'undated' }], LEDGER_START)
    expect(r.decisionsTotal).toBe(1)
  })
})

describe('decisionUtility — M1/M2 honesty', () => {
  it('reports awaiting-data with a null value, never a fake zero', () => {
    const r = decisionUtility(null, [dec('a')])
    for (const m of [r.M1_policyRankingAgreement, r.M2_downstreamUtilityLift]) {
      expect(m.value).toBeNull()
      expect(m.status).toBe('awaiting-data')
      expect(m.loggedRollouts).toBe(0)
      expect(m.reason).toMatch(/rollout/i)
    }
  })
})
