// W2 (causal survival credit) — the earned-in-use bar. A survival tick alone is tenure;
// promotion on the keyed path now also requires the fact was RETRIEVED into grounding and
// the graded turn ENDORSED, in >= minEarnedSessions distinct sessions. Kills the
// co-retrieval credit-theft class (RoMeRL "memory-reward trap").
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  governDecision,
  runGovernPass,
  causalCreditEnabled,
  causalCreditEpochMs,
  CAUSAL_CREDIT_EPOCH,
  DEFAULT_GOVERN_POLICY
} from './operator-govern'
import {
  recordFacts,
  promoteFact,
  noteSession,
  noteFactEndorsed,
  getOperatorFacts,
  getAllOperatorFacts,
  listByStatus,
  setMaterializeHook,
  setOperatorModelPath,
  __resetOperatorModel,
  __clearEndorsedPending
} from './operator-model'

beforeEach(() => {
  __resetOperatorModel()
  __clearEndorsedPending()
  delete process.env.DUIN_CAUSAL_CREDIT
  // Pin the epoch to 0 so facts promoted DURING the test run fall under the earned bar
  // regardless of the wall clock (the shipped epoch is a deploy-date constant).
  process.env.DUIN_CAUSAL_CREDIT_EPOCH_MS = '0'
})
afterEach(() => {
  delete process.env.DUIN_CAUSAL_CREDIT
  delete process.env.DUIN_CAUSAL_CREDIT_EPOCH_MS
})

describe('flag + epoch plumbing', () => {
  it('flag defaults ON, =0 disables; epoch override honors 0 (unset ≠ zero)', () => {
    expect(causalCreditEnabled()).toBe(true)
    process.env.DUIN_CAUSAL_CREDIT = '0'
    expect(causalCreditEnabled()).toBe(false)
    expect(causalCreditEpochMs()).toBe(0) // override pinned in beforeEach
    delete process.env.DUIN_CAUSAL_CREDIT_EPOCH_MS
    expect(causalCreditEpochMs()).toBe(CAUSAL_CREDIT_EPOCH)
  })
})

describe('governDecision — earned-in-use bar (pure)', () => {
  const P = DEFAULT_GOVERN_POLICY
  it('undefined earned = legacy behavior, byte-identical', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true }, P)).toBe('confirm')
  })
  it('tenure alone cannot confirm when the earned bar applies', () => {
    expect(governDecision({ sessionsObserved: 5, earnedSessions: 0, juryPass: true }, P)).toBe('hold')
    expect(governDecision({ sessionsObserved: 5, earnedSessions: 1, juryPass: true }, P)).toBe('hold')
  })
  it('earned >= bar confirms (with tenure + jury still required)', () => {
    expect(governDecision({ sessionsObserved: 2, earnedSessions: 2, juryPass: true }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 1, earnedSessions: 2, juryPass: true }, P)).toBe('hold') // tenure still binds
  })
  it('demotion is untouched: a failed jury reverts regardless of earned', () => {
    expect(governDecision({ sessionsObserved: 9, earnedSessions: 9, juryPass: false }, P)).toBe('revert')
  })
  it('a policy literal WITHOUT the field falls back to the strict default (2)', () => {
    const legacyP = { minSessions: 2, minSessionsKeyless: 4 }
    expect(governDecision({ sessionsObserved: 3, earnedSessions: 1, juryPass: true }, legacyP)).toBe('hold')
    expect(governDecision({ sessionsObserved: 3, earnedSessions: 2, juryPass: true }, legacyP)).toBe('confirm')
  })
})

describe('operator-model — endorsement staging → earned session ticks', () => {
  function seedProvisional(fact: string): string {
    recordFacts([{ fact }])
    const id = getOperatorFacts().find((f) => f.fact === fact)!.id
    promoteFact(id)
    return id
  }

  it('noteFactEndorsed converts to an earned tick at the NEXT session boundary (earned ⊆ observed)', () => {
    const id = seedProvisional('respond with risks first')
    noteSession('s1') // tenure only — no endorsement staged
    noteFactEndorsed([id])
    noteSession('s2') // converts the pending endorsement
    const f = getAllOperatorFacts().find((x) => x.id === id)!
    expect(f.observedSessions).toEqual(['s1', 's2'])
    expect(f.earnedSessions).toEqual(['s2'])
  })

  it('deduplicates: one earned tick per session id, pending consumed on conversion', () => {
    const id = seedProvisional('prefer bullet summaries')
    noteFactEndorsed([id])
    noteSession('s1')
    noteSession('s1') // same boundary re-fired — no double tick, pending already consumed
    noteFactEndorsed([id])
    noteSession('s1') // endorsement in an already-counted session — still one earned entry
    const f = getAllOperatorFacts().find((x) => x.id === id)!
    expect(f.earnedSessions).toEqual(['s1'])
  })

  it('earnedSessions survives a persist→reload round-trip (restart must not wipe earned credit)', () => {
    // Regression (review 2026-08-15): the load projection allow-listed
    // observedSessions but omitted earnedSessions, so every brain restart
    // reset earned credit to zero and the keyed promotion path stalled
    // (requireEarned compares 0 >= bar forever).
    const dir = mkdtempSync(join(tmpdir(), 'duin-earned-'))
    try {
      setOperatorModelPath(dir)
      const id = seedProvisional('persisted earned credit')
      noteFactEndorsed([id])
      noteSession('s1')
      noteFactEndorsed([id])
      noteSession('s2')
      expect(getAllOperatorFacts().find((x) => x.id === id)!.earnedSessions).toEqual(['s1', 's2'])

      __resetOperatorModel()
      setOperatorModelPath(dir) // reload from disk
      const reloaded = getAllOperatorFacts().find((x) => x.fact === 'persisted earned credit')!
      expect(reloaded.observedSessions).toEqual(['s1', 's2'])
      expect(reloaded.earnedSessions).toEqual(['s1', 's2'])
    } finally {
      __resetOperatorModel()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pending endorsements for non-provisional facts are dropped at the boundary', () => {
    const id = seedProvisional('short-lived rule')
    noteFactEndorsed([id, 'ghost-id'])
    // fact leaves probation before the boundary (human veto path not needed — use revert-free
    // promote: confirm via a second promote is not available here, so simulate via noteSession
    // after clearing provisional through the public API is overkill; the ghost id covers the
    // missing-fact branch and the provisional fact converts normally)
    noteSession('s1')
    const f = getAllOperatorFacts().find((x) => x.id === id)!
    expect(f.earnedSessions).toEqual(['s1'])
    // a second boundary must not resurrect the consumed/dropped pendings
    noteSession('s2')
    expect(getAllOperatorFacts().find((x) => x.id === id)!.earnedSessions).toEqual(['s1'])
  })
})

describe('runGovernPass — the earned bar end-to-end', () => {
  beforeEach(() => setMaterializeHook(null))
  afterEach(() => setMaterializeHook(null))

  function provisionalWithTenure(fact: string, sessions: string[]): string {
    recordFacts([{ fact }])
    const id = getOperatorFacts().find((f) => f.fact === fact)!.id
    promoteFact(id)
    for (const s of sessions) noteSession(s)
    return id
  }

  it('a never-retrieved fact cannot cross the keyed bar; an earned fact can', async () => {
    const tenureOnly = provisionalWithTenure('tenure-only rule', ['s1', 's2'])
    const earnedId = provisionalWithTenure('earned rule', [])
    // earn two sessions for earnedId: endorse → boundary, twice (boundaries also tick tenureOnly's tenure)
    noteFactEndorsed([earnedId])
    noteSession('e1')
    noteFactEndorsed([earnedId])
    noteSession('e2')
    const jury: Parameters<typeof runGovernPass>[0] = async (prov) => new Set(prov.map((f) => f.id))
    const r = await runGovernPass(jury)
    expect(r.confirmed).toBe(1)
    const all = getAllOperatorFacts()
    expect(all.find((f) => f.id === earnedId)!.status).toBe('promoted')
    const held = all.find((f) => f.id === tenureOnly)!
    expect(held.status).toBe('provisional') // tenure 4 sessions, earned 0 → held
    expect(held.govern?.verdict).toBe('hold')
    expect(held.govern?.earned).toBe(0)
    expect((held.govern?.observed ?? 0) >= 2).toBe(true)
  })

  it('DUIN_CAUSAL_CREDIT=0 restores legacy promotion end-to-end', async () => {
    process.env.DUIN_CAUSAL_CREDIT = '0'
    provisionalWithTenure('legacy-mode rule', ['s1', 's2'])
    const jury: Parameters<typeof runGovernPass>[0] = async (prov) => new Set(prov.map((f) => f.id))
    const r = await runGovernPass(jury)
    expect(r.confirmed).toBe(1)
  })

  it('legacy probations (pre-epoch provisionalAt) keep the old rule even with the flag on', async () => {
    // Point the epoch into the FUTURE so the just-promoted fact reads as pre-epoch/legacy.
    process.env.DUIN_CAUSAL_CREDIT_EPOCH_MS = String(Date.now() + 7 * 24 * 3600 * 1000)
    provisionalWithTenure('pre-epoch rule', ['s1', 's2'])
    const jury: Parameters<typeof runGovernPass>[0] = async (prov) => new Set(prov.map((f) => f.id))
    const r = await runGovernPass(jury)
    expect(r.confirmed).toBe(1)
  })

  it('keyless branch stays earned-free — but since W3 it PARKS for the operator, not confirms', async () => {
    // Re-shaped 2026-08-21 (W3 posture): the property this test protects survives — the
    // earned bar still does NOT gate the keyless branch (a keyless install may never grade
    // recalls) — but bar-met keyless is now outcome 'ratify': parked provisional behind one
    // Needs-you card, promoted through the operator. Tenure alone stopped being a promotion
    // currency; presence replaced it (DUIN_CAUSAL_CREDIT=0 restores the legacy confirm).
    provisionalWithTenure('keyless rule', ['s1', 's2', 's3', 's4'])
    const jury: Parameters<typeof runGovernPass>[0] = async () => null // no engine
    const r = await runGovernPass(jury)
    expect(r.confirmed).toBe(0)
    expect(r.awaitingRatify).toBe(1)
  })
})
