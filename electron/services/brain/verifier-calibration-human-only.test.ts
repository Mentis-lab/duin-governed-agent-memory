// verifierCalibration measures ONE thing: when the NLI verifier claimed a fold's premises entailed
// its rule, did a HUMAN subsequently endorse that rule or refuse it? That measured precision sets the
// width of the Stage-5 interval, which ranks facts for scarce grounding slots. So an inflated
// precision is not cosmetic — it narrows bounds the grounding decision leans on.
//
// THE DEFECT this pins: the question was asked of `status`, and `provisional` has THREE writers —
// promoteFact (the human gate), seedFacts (vault principles seeded by machine) and applyBoundRule (a
// binding lifting a fact). A machine-seeded fact that acquired a verified edge through
// recordDerivedFact's text dedup therefore read as a human success nobody ever gave: the verifier was
// being scored against its own side of the ledger. Isolating the human path needs an origin marker the
// store did not carry.
//
// The marker is `adjudicatedBy: 'human'`, set only on promoteFact and vetoFact — the two gates that
// fire lifecycleHook. confirmFact is documented as "a machine transition — no human hook" and
// deliberately does not set it.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  recordFacts,
  recordDerivedFact,
  seedFacts,
  promoteFact,
  vetoFact,
  confirmFact,
  getAllOperatorFacts,
  verifierCalibration,
  setOperatorModelPath,
  __resetOperatorModel
} from './operator-model'

beforeEach(() => __resetOperatorModel())

const ENTAILS = { label: 'entails' as const, score: 0.9, rationale: 'follows', verifier: 'judge-1' }
const idOf = (re: RegExp): string => getAllOperatorFacts().find((f) => re.test(f.fact))!.id

/** A fold whose edge carries a POSITIVE verifier claim — the only kind that is evidence at all. */
function verifiedFold(rule: string, premise: string): string {
  recordFacts([{ fact: premise }])
  return recordDerivedFact(rule, 'context', [idOf(new RegExp(premise))], ENTAILS)!
}

describe('verifierCalibration counts only HUMAN adjudications', () => {
  it('THE DEFECT: a machine-SEEDED provisional fold is not evidence the verifier was right', () => {
    // The seed arrives provisional without any person ruling on it...
    seedFacts([{ fact: 'Prefer reversible actions where the cost is comparable.', status: 'provisional' }])
    // ...and then a fold mints the SAME text, so text-dedup attaches a verified edge to that very row.
    recordFacts([{ fact: 'reversibility premise for the seeded rule' }])
    recordDerivedFact(
      'Prefer reversible actions where the cost is comparable.',
      'principle',
      [idOf(/reversibility premise/)],
      ENTAILS
    )

    const seeded = getAllOperatorFacts().find((f) => /Prefer reversible actions/.test(f.fact))!
    expect(seeded.status).toBe('provisional') // it really is in the counted status...
    expect(seeded.dependsOn?.length).toBeGreaterThan(0) // ...with a verified edge...
    expect(seeded.adjudicatedBy).toBeUndefined() // ...and no human ever ruled.

    expect(verifierCalibration()).toEqual({ correct: 0, observed: 0 })
  })

  it('a HUMAN promote IS evidence the verifier was right', () => {
    const id = verifiedFold('Attribute every claim to a source.', 'cite the source of each claim')
    promoteFact(id)

    expect(getAllOperatorFacts().find((f) => f.id === id)!.adjudicatedBy).toBe('human')
    expect(verifierCalibration()).toEqual({ correct: 1, observed: 1 })
  })

  it('a HUMAN veto is counted as an observation, but not as a success', () => {
    const id = verifiedFold('Never ask before deleting.', 'a premise the fold overreached from')
    vetoFact(id)

    expect(verifierCalibration()).toEqual({ correct: 0, observed: 1 })
  })

  it('the MACHINE confirm transition does not manufacture a human ruling', () => {
    const id = verifiedFold('Summarise before escalating.', 'summarise premise')
    promoteFact(id) // human: candidate → provisional
    confirmFact(id) // machine: provisional → promoted, no human hook

    // Still exactly ONE human ruling — the promote. The confirm must not double-count.
    expect(verifierCalibration()).toEqual({ correct: 1, observed: 1 })
  })

  // Guard-strength: the filter must not be doing all the work by suppressing everything, and the
  // pre-existing verdict/verifier requirement must still bind.
  it('an ABSTAINED (unverified) edge is not evidence even when a human promoted it', () => {
    recordFacts([{ fact: 'premise behind an unverified fold' }])
    const id = recordDerivedFact('Unverified derived rule.', 'context', [idOf(/unverified fold/)], null)!
    promoteFact(id)

    expect(getAllOperatorFacts().find((f) => f.id === id)!.adjudicatedBy).toBe('human')
    expect(verifierCalibration()).toEqual({ correct: 0, observed: 0 }) // the verifier asserted nothing
  })
})

describe('the marker survives a reload — the store whitelists fields on load', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'opmodel-adjudicated-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  })

  it('re-reads adjudicatedBy from disk, so a human ruling is not lost on restart', () => {
    setOperatorModelPath(dir)
    const id = verifiedFold('Attribute every claim to a source.', 'cite the source of each claim')
    promoteFact(id)
    expect(verifierCalibration()).toEqual({ correct: 1, observed: 1 })

    // setOperatorModelPath re-reads the persisted file into a fresh store — the restart path.
    // The loader maps a FIXED set of fields; anything omitted there is silently dropped, which would
    // quietly restore the very miscount this closes (and would not fail any assertion above).
    __resetOperatorModel()
    setOperatorModelPath(dir)

    const reloaded = getAllOperatorFacts().find((f) => /Attribute every claim/.test(f.fact))!
    expect(reloaded.adjudicatedBy).toBe('human')
    expect(verifierCalibration()).toEqual({ correct: 1, observed: 1 })
  })
})
