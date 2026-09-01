// Regression: seedFacts must NOT evict with a status-blind slice().
//
// DEFECT: seedFacts trimmed the store with `store = store.slice(0, MAX_FACTS)` while its two
// siblings in the same file (recordFacts, recordDerivedFact) used a status-aware sort that keeps
// promoted/provisional/vetoed and evicts only churn. New facts are UNSHIFTED, so the blind slice
// dropped the OLDEST rows — exactly where human-earned `promoted` and veto-memory `vetoed` live —
// and persist() fired immediately after. Unrecoverable: seedFacts never seeds `promoted` ("that
// stays earned"), and a lost `vetoed` row removes the dedup entry that stops a human-rejected fact
// from being re-added and re-grounded.
//
// REACHABLE: POST /state/cold-start-seed (brain-native-routes-2.ts) → seedFromVault → seedFacts,
// with no per-vault marker gate (the marker check lives only on the main.ts boot path).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  recordFacts,
  seedFacts,
  promoteFact,
  vetoFact,
  getAllOperatorFacts,
  getEvictionLog,
  __resetOperatorModel
} from './operator-model'

const MAX_FACTS = 300

beforeEach(() => __resetOperatorModel())

/** Fill to the cap, then give the OLDEST rows human-earned status (the tail the blind slice cut). */
function fillToCapWithProtectedTail(): { promotedIds: string[]; vetoedIds: string[] } {
  recordFacts(
    Array.from({ length: MAX_FACTS }, (_, i) => ({ fact: `Operator fact number ${i} about work`, kind: 'context' }))
  )
  expect(getAllOperatorFacts().length).toBe(MAX_FACTS)
  const all = getAllOperatorFacts()
  const tail = all.slice(-4) // oldest 4 rows (facts are unshifted → oldest are last)
  const promotedIds = [tail[0].id, tail[1].id]
  const vetoedIds = [tail[2].id, tail[3].id]
  for (const id of promotedIds) expect(promoteFact(id)).toBe(true)
  for (const id of vetoedIds) expect(vetoFact(id, 'never do this')).toBe(true)
  return { promotedIds, vetoedIds }
}

describe('seedFacts eviction at MAX_FACTS', () => {
  it('never evicts human-touched rows (provisional/vetoed) when seeding at the cap', () => {
    const { promotedIds, vetoedIds } = fillToCapWithProtectedTail()

    const r = seedFacts(
      Array.from({ length: 5 }, (_, i) => ({ fact: `Seeded vault principle ${i} from DUIN Rules`, kind: 'principle' }))
    )
    expect(r.added).toBe(5)
    expect(getAllOperatorFacts().length).toBe(MAX_FACTS)

    const surviving = new Set(getAllOperatorFacts().map((f) => f.id))
    for (const id of promotedIds) expect(surviving.has(id)).toBe(true) // human-earned rule
    for (const id of vetoedIds) expect(surviving.has(id)).toBe(true) // veto-memory / dedup guard
  })

  it('matches recordFacts (the sibling control) at the identical cap', () => {
    const { promotedIds, vetoedIds } = fillToCapWithProtectedTail()
    recordFacts(
      Array.from({ length: 5 }, (_, i) => ({ fact: `Control fact ${i} recorded at the cap`, kind: 'context' }))
    )
    const surviving = new Set(getAllOperatorFacts().map((f) => f.id))
    for (const id of [...promotedIds, ...vetoedIds]) expect(surviving.has(id)).toBe(true)
  })

  it('veto-memory survives a seed at the cap, so a vetoed fact stays un-re-addable', () => {
    recordFacts([{ fact: 'Deploy straight to production on Fridays' }])
    const vetoed = getAllOperatorFacts()[0]
    expect(vetoFact(vetoed.id, 'rejected')).toBe(true)
    recordFacts(
      Array.from({ length: MAX_FACTS - 1 }, (_, i) => ({ fact: `Filler operator fact ${i} for the cap` }))
    )
    expect(getAllOperatorFacts().length).toBe(MAX_FACTS)

    seedFacts(Array.from({ length: 10 }, (_, i) => ({ fact: `Vault principle ${i} seeded from Rules` })))

    // The vetoed row is still present → the dedup set still blocks re-adding it.
    expect(getAllOperatorFacts().some((f) => f.id === vetoed.id)).toBe(true)
    expect(recordFacts([{ fact: 'Deploy straight to production on Fridays' }])).toBe(0)
  })

  it('tombstones what the cap dropped instead of deleting it silently', () => {
    recordFacts(Array.from({ length: MAX_FACTS }, (_, i) => ({ fact: `Churn fact ${i} about the project` })))
    expect(getEvictionLog().length).toBe(0)

    seedFacts([{ fact: 'A brand new vault principle worth seeding' }])

    const log = getEvictionLog()
    expect(log.length).toBe(1)
    expect(log[0].at).toBe('seed')
    expect(log[0].status).toBe('candidate') // only churn was evictable
    expect(log[0].fact).toContain('Churn fact')
    expect(typeof log[0].evictedAt).toBe('number')
  })
})
