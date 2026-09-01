import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  applyReinforcement,
  reinforceTick,
  stageReinforcementCandidates,
  enqueueReinforcement,
  drainReinforcement,
  claimReinforceEnabled,
  __resetClaimReinforce
} from './claim-reinforce'
import type { Claim } from './claim-metabolism'

const claim = (id: string, validTo: number | null = null): Claim => ({ id, validTo }) as Claim
// A fake endorsement classifier: the reaction is 'positive' iff it looks like praise.
const classify = (_prior: string, next: string): 'positive' | 'negative' | null =>
  /perfect|thanks|exactly|great/i.test(next) ? 'positive' : /wrong|no,/i.test(next) ? 'negative' : null

beforeEach(() => __resetClaimReinforce())
afterEach(() => {
  delete process.env.DUIN_CLAIM_REINFORCE
})

describe('claimReinforceEnabled', () => {
  it('is opt-in (off unless =1)', () => {
    expect(claimReinforceEnabled()).toBe(false)
    process.env.DUIN_CLAIM_REINFORCE = '1'
    expect(claimReinforceEnabled()).toBe(true)
  })
})

describe('applyReinforcement (the markUseful caller)', () => {
  it('markUseful (advances lastUsefulAt) each ACTIVE queued claim; skips retired + unqueued', () => {
    const a = claim('a')
    const b = claim('b')
    const r = claim('r', 999) // retired
    const n = applyReinforcement([a, b, r], new Set(['a', 'r']), 5000)
    expect(n).toBe(1) // only active 'a' (r is retired, b not queued)
    expect(a.lastUsefulAt).toBe(5000)
    expect(b.lastUsefulAt).toBeUndefined()
    expect(r.lastUsefulAt).toBeUndefined() // never reinforce a retired claim
  })
  it('empty ids is a no-op', () => {
    const a = claim('a')
    expect(applyReinforcement([a], new Set(), 1)).toBe(0)
    expect(a.lastUsefulAt).toBeUndefined()
  })
})

describe('enqueue / drain', () => {
  it('drain returns the queued ids and clears (drain-once)', () => {
    enqueueReinforcement(['x', 'y', 'x'])
    expect([...drainReinforcement()].sort()).toEqual(['x', 'y'])
    expect([...drainReinforcement()]).toEqual([]) // cleared
  })
})

describe('reinforceTick (N→N+1 endorsement + cited-in-answer filter)', () => {
  it('enqueues ONLY the prior-turn staged claims that were CITED in an endorsed answer', () => {
    // Turn N grounding: two claims staged; notes note-a.md + note-b.md.
    stageReinforcementCandidates('t1', [
      { id: 'a', base: 'note-a.md' },
      { id: 'b', base: 'note-b.md' }
    ])
    // End of turn N: roll forward with turn N's answer (which cites only note-a.md). No prior yet ⇒ nothing enqueued.
    expect(reinforceTick('t1', 'the question', 'per note-a.md, here is the answer', classify)).toBe(0)
    expect([...drainReinforcement()]).toEqual([])
    // Turn N+1: the user endorses ("perfect"). Prior = turn N (answer cites note-a.md only).
    expect(reinforceTick('t1', 'perfect, thanks', 'the next answer', classify)).toBe(1)
    expect([...drainReinforcement()]).toEqual(['a']) // 'a' cited+endorsed; 'b' not cited
  })

  it('does NOT enqueue when the reaction is not an endorsement', () => {
    stageReinforcementCandidates('t2', [{ id: 'a', base: 'note-a.md' }])
    reinforceTick('t2', 'q', 'answer per note-a.md', classify) // roll turn N forward
    expect(reinforceTick('t2', 'no, that is wrong', 'next', classify)).toBe(0) // negative reaction
    expect([...drainReinforcement()]).toEqual([])
  })

  it('endorsement of an answer that cited NOTHING staged enqueues nothing', () => {
    stageReinforcementCandidates('t3', [{ id: 'a', base: 'note-a.md' }])
    reinforceTick('t3', 'q', 'a generic answer with no note reference', classify) // roll forward
    expect(reinforceTick('t3', 'perfect', 'next', classify)).toBe(0) // endorsed, but note-a.md not cited
    expect([...drainReinforcement()]).toEqual([])
  })

  it('threads are isolated', () => {
    stageReinforcementCandidates('tA', [{ id: 'a', base: 'na.md' }])
    stageReinforcementCandidates('tB', [{ id: 'b', base: 'nb.md' }])
    reinforceTick('tA', 'q', 'cites na.md', classify)
    reinforceTick('tB', 'q', 'cites nb.md', classify)
    reinforceTick('tA', 'perfect', 'x', classify) // only tA endorsed
    expect([...drainReinforcement()]).toEqual(['a'])
  })
})
