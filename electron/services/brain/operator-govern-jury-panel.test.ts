// operator-govern-jury-panel.test.ts — the jury is a PANEL, not one model's opinion.
//
// Verifier 2's verdict is BINDING in the destructive direction: `governDecision` returns 'revert'
// the moment `juryPass === false`, which drops the fact from grounding, bumps `reverts`, blocks
// re-linking via recordBoundRule, and marks it evictable churn. Running that on a single model's
// single call means one flaky reply spends the operator's facts.
//
// That is not hypothetical. On the live brain 89 of 197 facts sit reverted, and the campaign traced
// the verdicts behind them to essentially one flaky model — which is not a quorum, it is a single
// point of failure wearing the word "verifier".
//
// The panel polls independent families and reverts a fact only when a MAJORITY of RESPONDING jurors
// omit it. Ties keep the fact, because reverting is destructive and a wrongly-kept fact merely
// stays on probation for the next pass.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { OperatorFact } from './operator-model'

const h = vi.hoisted(() => ({
  panel: ['jury-a', 'jury-b', 'jury-c'] as string[],
  /** model id → the reply body that model returns. `null` throws (a dead provider). */
  reply: {} as Record<string, string | null>
}))

vi.mock('../providers/registry', () => ({
  routeModel: () => 'extractor-model',
  routeDistinctModels: () => h.panel,
  getProviderForModel: (m: string) => (m === 'extractor-model' ? 'zhipu' : `prov-${m}`),
  chatOnce: async (_msgs: unknown, model: string) => {
    const r = h.reply[model]
    if (r === null || r === undefined) throw new Error(`no reply configured for ${model}`)
    return { content: r }
  }
}))
vi.mock('./operator-model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./operator-model')>()
  return { ...actual, listByStatus: () => [] }
})
vi.mock('../governance/confidential-firewall', () => ({ firewallClear: () => true }))

const { defaultGovernJury } = await import('./operator-govern')

const prov = (id: string, fact: string): OperatorFact =>
  ({ id, fact, kind: 'value', status: 'provisional', ts: 0 }) as OperatorFact

// Four candidates, so the mass-revert guard (pass*2 < pool) never masks what these tests measure.
const POOL = [
  prov('a', 'Truth over comfort'),
  prov('b', 'Lead with the outcome'),
  prov('c', 'Verify before claiming'),
  prov('d', 'Say what was skipped')
]
const ALL = '["Truth over comfort","Lead with the outcome","Verify before claiming","Say what was skipped"]'
/** Endorses everything except `Truth over comfort` — an omission means revert. */
const DROPS_A = '["Lead with the outcome","Verify before claiming","Say what was skipped"]'

beforeEach(() => {
  h.panel = ['jury-a', 'jury-b', 'jury-c']
  h.reply = { 'jury-a': ALL, 'jury-b': ALL, 'jury-c': ALL }
})

describe('the jury panel — one flaky juror can no longer spend a fact', () => {
  it('keeps a fact the MINORITY omitted (2 keep, 1 drops)', async () => {
    h.reply['jury-c'] = DROPS_A

    const r = await defaultGovernJury(POOL)

    // The load-bearing assertion. Pre-panel, that single omission WAS the verdict, and 'a' reverted.
    expect(r.pass!.has('a')).toBe(true)
    expect(r.pass!.size).toBe(4)
  })

  it('reverts a fact the MAJORITY omitted (2 drop, 1 keeps)', async () => {
    h.reply['jury-b'] = DROPS_A
    h.reply['jury-c'] = DROPS_A

    const r = await defaultGovernJury(POOL)

    expect(r.pass!.has('a')).toBe(false) // a real majority rejection still lands
    expect(r.pass!.has('b')).toBe(true)
  })

  it('keeps a fact on a TIE, because reverting is the destructive direction', async () => {
    h.panel = ['jury-a', 'jury-b']
    h.reply = { 'jury-a': ALL, 'jury-b': DROPS_A }

    const r = await defaultGovernJury(POOL)

    expect(r.pass!.has('a')).toBe(true)
  })

  it('does not count an ABSTAINING juror as a vote to revert', async () => {
    h.reply['jury-b'] = 'not json at all' // parse-miss → abstain
    h.reply['jury-c'] = null // throws → abstain

    const r = await defaultGovernJury(POOL)

    // One responder that endorsed everything. Two dead jurors must not drag the pool down.
    expect(r.pass!.size).toBe(4)
  })

  it('abstains entirely when NO juror responds, rather than reverting the pool', async () => {
    h.reply = { 'jury-a': null, 'jury-b': null, 'jury-c': null }

    const r = await defaultGovernJury(POOL)

    // null = "could not verify", which routes to the keyless survival bar. Not a mass revert.
    expect(r.pass).toBeNull()
  })

  it('records the whole panel as provenance, and claims independence only when earned', async () => {
    const r = await defaultGovernJury(POOL)
    expect(r.juryModelId).toBe('jury-a+jury-b+jury-c')
    expect(r.juryProvider).toBe('prov-jury-a+prov-jury-b+prov-jury-c')
    expect(r.crossModel).toBe(true) // none of them is the zhipu extractor
  })

  it('falls back to the extractor on a single-provider install, and does NOT claim independence', async () => {
    h.panel = [] // no distinct family is keyed
    h.reply = { 'extractor-model': ALL }

    const r = await defaultGovernJury(POOL)

    expect(r.juryModelId).toBe('extractor-model')
    expect(r.crossModel).toBe(false) // one model wearing two hats — say so
    expect(r.pass!.size).toBe(4) // still functions, exactly as before the panel existed
  })
})
