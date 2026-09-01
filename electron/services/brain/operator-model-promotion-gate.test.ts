import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Phase 1.2 of PLANNING/DUIN_GAP_BRIDGE_PLAN.md, pinned.
//
// On 2026-07-30 the earned-autonomy governor demoted `operator-fact-promotion` to
// `hold` on real evidence — 97 reverts against 48 ratifies — and nothing read that
// decision. `classify()` had no caller for the capability, so `autoPromoteCandidates`
// carried on promoting straight through the demotion.
//
// A governor that decides correctly into a void is worse than no governor: it
// looks like a safeguard. This pins that the unattended promoter now honours it.

const rung = vi.hoisted(() => ({ value: 'run' as 'run' | 'stage' | 'hold' }))

vi.mock('../ans/capability-ledger', () => ({
  classify: () => rung.value,
  OPERATOR_FACT_PROMOTION_CAP_ID: 'operator-fact-promotion'
}))


import {
  setOperatorModelPath,
  recordFacts,
  autoPromoteCandidates,
  promoteFact,
  listByStatus,
  setOperatorEventHook,
  __resetOperatorModel
} from './operator-model'

const emitted: { type: string; payload: Record<string, unknown> }[] = []

beforeEach(() => {
  __resetOperatorModel()
  setOperatorModelPath(mkdtempSync(join(tmpdir(), 'duin-promo-gate-')))
  rung.value = 'run'
  emitted.length = 0
  setOperatorEventHook((type, payload) => {
    emitted.push({ type, payload })
  })
})

function seedCandidates(n: number): void {
  recordFacts(
    Array.from({ length: n }, (_, i) => ({
      fact: `the operator prefers option number ${i} over the alternatives`,
      source: 'machine' as const
    }))
  )
  expect(listByStatus('candidate').length).toBe(n)
}

describe('autoPromoteCandidates respects the autonomy governor', () => {
  it('promotes when the capability is earned', () => {
    seedCandidates(3)
    expect(autoPromoteCandidates()).toBe(3)
    expect(listByStatus('provisional').length).toBe(3)
    expect(listByStatus('candidate').length).toBe(0)
  })

  it('promotes nothing when the governor has demoted it to hold', () => {
    seedCandidates(3)
    rung.value = 'hold'
    expect(autoPromoteCandidates()).toBe(0)
    // And leaves them as candidates rather than dropping them — they accumulate
    // until the capability is ratified back up.
    expect(listByStatus('candidate').length).toBe(3)
    expect(listByStatus('provisional').length).toBe(0)
  })

  it('still promotes at `stage`, which is the registration default', () => {
    // A deliberate choice, not an oversight: `stage` is what every capability
    // starts at, so blocking it would freeze the one arm of the Learn loop that
    // actually turns. `hold` is the state the governor reaches from evidence, and
    // that is the one worth honouring.
    seedCandidates(2)
    rung.value = 'stage'
    expect(autoPromoteCandidates()).toBe(2)
  })

  it('resumes once the capability is ratified back up', () => {
    seedCandidates(2)
    rung.value = 'hold'
    expect(autoPromoteCandidates()).toBe(0)
    rung.value = 'run'
    expect(autoPromoteCandidates()).toBe(2)
  })

  it('leaves the external quarantine intact regardless of rung', () => {
    // External (de-privileged channel) facts are human-gated by design and must
    // not become promotable just because the capability is earned.
    recordFacts([
      { fact: 'a claim arriving from a de-privileged channel source', source: 'external' }
    ])
    rung.value = 'run'
    expect(autoPromoteCandidates()).toBe(0)
    expect(listByStatus('candidate').length).toBe(1)
  })
})

// Phase 2.4 — the Remember loop could not report on itself. Of 34,807 rows in
// `events`, NOT ONE matched memory / fact / capture / promotion / correction, so
// every question about whether this loop was turning had to be answered by diffing
// file mtimes by hand. Property 7: a mechanism you cannot observe is one you cannot
// notice has stopped.
describe('the fact lifecycle emits events', () => {
  const find = (type: string) => emitted.find((e) => e.type === type)

  it('records a capture', () => {
    seedCandidates(2)
    expect(find('operator.fact.recorded')?.payload).toEqual({ count: 2 })
  })

  it('records an auto-promotion with its count', () => {
    seedCandidates(3)
    emitted.length = 0
    autoPromoteCandidates()
    expect(find('operator.fact.promoted')?.payload).toEqual({ count: 3, by: 'auto' })
  })

  it('records a HUMAN promotion too — promoteFact is the other half of this signal', () => {
    // Before the fix, promoteFact fired only the lifecycle (corrections.jsonl) hook and
    // never emitFactEvent, so every 'operator.fact.promoted' row in `events` could only
    // ever show `by: 'auto'` — a human clicking Promote in the LearningPanel was invisible
    // to the exact ledger this event family was added to make the loop observable in.
    seedCandidates(1)
    const id = listByStatus('candidate')[0].id
    emitted.length = 0
    expect(promoteFact(id)).toBe(true)
    expect(find('operator.fact.promoted')?.payload).toEqual({ id, by: 'human' })
  })

  it('records the governor holding promotion — the state that was invisible', () => {
    seedCandidates(2)
    rung.value = 'hold'
    emitted.length = 0
    autoPromoteCandidates()
    expect(find('operator.promotion.held')?.payload).toMatchObject({
      capability: 'operator-fact-promotion',
      candidates: 2
    })
  })

  it('never lets telemetry break the loop', () => {
    // recordEvent THROWS on an unregistered type, and this runs on capturing turns.
    setOperatorEventHook(() => {
      throw new Error('event log unavailable')
    })
    expect(() => seedCandidates(1)).not.toThrow()
    expect(autoPromoteCandidates()).toBe(1)
  })

  it('is inert with no hook installed', () => {
    setOperatorEventHook(null)
    expect(() => seedCandidates(1)).not.toThrow()
  })
})
