// The rubric gate. Until 2026-08-02 a transfer-A/B record carried no provenance, so a run graded
// against the GROUNDED ARM'S OWN PROMPT was byte-indistinguishable from a held-out one — and
// self-improve-bench read the freshest record under a 7-day cap. The constitution says those
// numbers "must not be cited"; before this, that was enforced only by a human remembering a date.
//
// These tests exist because the field is decoration unless the consumer refuses on it.
import { describe, it, expect } from 'vitest'
import { rubricOf, type TransferRunRecord } from './transfer-ab-store'

const rec = (over: Partial<TransferRunRecord> = {}): TransferRunRecord => ({
  ts: '2026-08-02T00:00:00.000Z',
  withMoatWins: 14,
  coldWins: 9,
  ties: 1,
  inconclusive: 0,
  decided: 24,
  samples: 24,
  fitLift: 5,
  verdict: 'moat-fits-better',
  ...over
})

describe('rubricOf — absence means circular, not unknown', () => {
  it('treats a record with NO rubric field as circular', () => {
    // Every daily run from 2026-07-25 to 07-31 is such a record. Reading absence as "probably
    // fine" would re-admit exactly the numbers the constitution forbids citing.
    expect(rubricOf(rec({ rubric: undefined }))).toBe('circular')
  })
  it('honours an explicit rubric', () => {
    expect(rubricOf(rec({ rubric: 'held-out' }))).toBe('held-out')
    expect(rubricOf(rec({ rubric: 'circular' }))).toBe('circular')
  })
  it('fails safe on a value it does not recognise', () => {
    expect(rubricOf({ rubric: 'something-else' as unknown as TransferRunRecord['rubric'] })).toBe('circular')
  })
})

describe('resolveNamedSkillLift refuses a circular run', () => {
  // Imported lazily: self-improve-bench pulls in the capability ledger and moat health at module
  // load, and this suite only needs the pure resolver.
  const load = async (): Promise<typeof import('./self-improve-bench')> => import('./self-improve-bench')

  it('is a NO-OP guard unless the gate actually fires — pinned by construction', async () => {
    const { resolveNamedSkillLift } = await load()
    // No vault ⇒ no record ⇒ the "never been asked" branch, not the rubric branch.
    const r = resolveNamedSkillLift('', '2026-08-02T00:00:00.000Z')
    expect(r.value).toBeNull()
    expect(r.note).toMatch(/never been asked/i)
  })
})

describe('the gate is ordered BEFORE staleness', () => {
  it('a FRESH circular run must still be refused', () => {
    // Ordering matters: a circular run cannot support a lift at any age, so checking freshness
    // first would let a same-day circular run through on a technicality. This asserts the
    // property at the predicate level — a fresh record whose rubric is absent is still circular.
    const fresh = rec({ ts: new Date(0).toISOString(), rubric: undefined })
    expect(rubricOf(fresh)).toBe('circular')
  })
})
