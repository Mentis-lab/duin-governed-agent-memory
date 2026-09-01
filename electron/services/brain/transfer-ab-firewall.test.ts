// transfer-ab — the confidential-lane firewall on an AUTONOMOUS cloud send.
//
// main.ts starts startTransferAbTick at boot; it fires 120s later and every 24h, and makeTransferDeps
// routes through routeModel('extraction') which — by transfer-ab-tick's own header — "is NOT
// local-first ... resolves the operator's configured provider, usually cloud". Both of its payloads
// are the operator's own corpus: the grounded arm's system message carries the entire rendered
// <operator_profile> (every promoted/provisional/candidate fact verbatim) and the blind judge's
// carries the operator's own promote/veto rulings. It shipped both with NO filter, while the sibling
// A/B measurer over the identical corpus (judgment-measure-live's runMeasurePass) redacted it.
//
// That asymmetry is what made the leak invisible: every surface that REPORTS firewall activity — the
// govern jury, judgment-measure-live — filters these exact rows, so watching them showed the firewall
// working while this path had already sent the pre-release name in the clear.
//
// The abstain must ABORT THE PASS, not degrade to an empty grounding: '' is transfer-ab's "no
// accumulated brain" signal, so falling through to it would run the grounded arm cold and record a
// fabricated ~0 lift that self-improve-bench.resolveNamedSkillLift reads back as a real measurement.
//
// These tests pin the ACTIVE denylist explicitly. The shipped default is EMPTY by design (cold-start
// A3), so a test that leaned on the ambient list would "pass" against no firewall at all.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const chatOnce = vi.fn()
vi.mock('../providers/registry', () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...a),
  routeModel: () => 'test-model',
  routeDistinctModel: () => null,
  routeDistinctModels: () => []
}))

// Release M11: a pass runs only under backgroundAutonomy (transfer-ab-tick.transferAbPassAllowed).
// This suite is about what a RUNNING pass puts on the wire, so it runs with the switch ON; the
// gate itself is pinned in transfer-ab-bench-wiring.test.ts.
vi.mock('../settings-helper', () => ({
  readSettings: (): Record<string, unknown> => ({ backgroundAutonomy: true })
}))

const recordTransferRun = vi.fn()
vi.mock('./transfer-ab-store', () => ({
  recordTransferRun: (...a: unknown[]) => recordTransferRun(...a),
  latestTransferRun: () => null // nothing recorded ⇒ a pass is always due
}))

import { makeTransferDeps } from './transfer-ab'
import { transferAbTick } from './transfer-ab-tick'
import {
  setOperatorModelPath,
  recordFacts,
  listByStatus,
  promoteFact,
  confirmFact,
  vetoFact,
  __resetOperatorModel
} from './operator-model'
import { setActiveDenylist } from '../governance/confidential-firewall'

const SECRET = 'Ship Project Halcyon before the Q3 board'
const PROFILE_FACT = 'Operator answers partners in two sentences'
const VAULT = mkdtempSync(join(tmpdir(), 'duin-tabfw-vault-'))

/** Everything the pass actually put on the wire, across all calls. */
const wire = (): string =>
  chatOnce.mock.calls.flatMap((c) => (c[0] as { content: string }[]).map((m) => m.content)).join('\n')

/** Land a fact in the status the payload under test reads from.
 *  - 'probation' → provisional: renders into <operator_profile>, and selectHumanRubric ignores it
 *    (only promoted/vetoed count as rulings) — so it exercises the GROUNDING payload alone.
 *  - 'veto' → vetoed+human: never renders into grounding, only into the judge's rubric — so it
 *    exercises the JUDGE payload alone. */
const land = (fact: string, as: 'probation' | 'promote' | 'veto'): void => {
  recordFacts([{ fact, kind: 'context' }])
  const id = listByStatus('candidate').find((f) => f.fact === fact)!.id
  if (as === 'veto') {
    vetoFact(id)
    return
  }
  promoteFact(id) // → provisional, adjudicatedBy 'human'
  if (as === 'promote') confirmFact(id) // → promoted
}

describe('transfer-ab — confidential-lane firewall (autonomous cloud egress)', () => {
  beforeEach(() => {
    setOperatorModelPath(mkdtempSync(join(tmpdir(), 'duin-tabfw-')))
    __resetOperatorModel()
    chatOnce.mockReset()
    chatOnce.mockResolvedValue({ content: 'A' })
    recordTransferRun.mockReset()
    setActiveDenylist(['Halcyon'])
  })
  afterEach(() => setActiveDenylist(null))

  it('the daily tick sends NOTHING and records NOTHING when the profile carries a confidential term', async () => {
    land(SECRET, 'probation')
    land(PROFILE_FACT, 'probation')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await transferAbTick(() => VAULT, undefined, ['q1'])

    expect(wire()).not.toContain('Halcyon')
    expect(chatOnce).not.toHaveBeenCalled() // aborted before any model call — nothing sent, nothing billed
    // …and no history row. Recording a run here would be the trap: the abstain would masquerade as a
    // measured ~0 lift and the bench would read it as one.
    expect(recordTransferRun).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).toContain('abstained') // the abstain is visible, not silent
    warn.mockRestore()
  })

  it('a confidential VETOED ruling never reaches the blind judge', async () => {
    // The rubric is a SECOND payload with its own exposure: vetoed facts never render into grounding,
    // so this content can only leak through the judge. It is also the mid-pass window — the rubric is
    // rebuilt on EVERY judge call, so a ruling landing during a pass (~3 model calls per query) would
    // otherwise ride out after the pass-level gate had already passed.
    for (const n of ['e1', 'e2', 'e3']) land(`Operator endorses ${n}`, 'promote')
    for (const n of ['r1', 'r2']) land(`Operator rejects ${n}`, 'veto')
    land('Never discuss Project Halcyon outside the vault', 'veto') // 6 rulings ⇒ clears MIN_RUBRIC_FACTS

    const pref = await makeTransferDeps(null).judge('q1', 'answer A', 'answer B')

    expect(pref).toBe('inconclusive') // abstain — excluded from `decided`, so no lift is invented
    expect(chatOnce).not.toHaveBeenCalled()
    expect(wire()).not.toContain('Halcyon')
  })

  it('is a gate, not an off-switch — a clear corpus still measures and still records', async () => {
    land(PROFILE_FACT, 'probation')
    for (const n of ['e1', 'e2', 'e3', 'e4']) land(`Operator endorses ${n}`, 'promote')
    for (const n of ['r1', 'r2']) land(`Operator rejects ${n}`, 'veto')

    await transferAbTick(() => VAULT, undefined, ['q1'])

    expect(chatOnce).toHaveBeenCalled()
    expect(wire()).toContain(PROFILE_FACT) // the grounded arm really was handed the profile
    expect(recordTransferRun).toHaveBeenCalledTimes(1)
  })

  it('an EMPTY denylist — the shipped default — leaves the litmus byte-unchanged', async () => {
    // Cold-start A3: the compiled default blocks nothing, so a fresh install must be unaffected.
    setActiveDenylist([])
    land(SECRET, 'probation')

    await transferAbTick(() => VAULT, undefined, ['q1'])

    expect(chatOnce).toHaveBeenCalled()
    expect(recordTransferRun).toHaveBeenCalledTimes(1)
  })
})
