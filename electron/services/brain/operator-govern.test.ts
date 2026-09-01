import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { governDecision, runGovernPass, behavioralFlipFromEfficacy, backtestFact, DEFAULT_GOVERN_POLICY, type GovernJury } from './operator-govern'
import {
  recordFacts,
  promoteFact,
  noteSession,
  confirmFact,
  supersedeFact,
  setMaterializeHook,
  getOperatorFacts,
  getAllOperatorFacts,
  listByStatus,
  __resetOperatorModel
} from './operator-model'
import { setActiveDenylist } from '../governance/confidential-firewall'

beforeEach(() => {
  __resetOperatorModel()
  // W2 pin — this suite asserts the LEGACY govern semantics (tenure + jury). The
  // causal-credit earned bar has its own suite (causal-credit.test.ts); pinning it off
  // here keeps these assertions meaningful after the CAUSAL_CREDIT_EPOCH passes, when
  // freshly-promoted test facts would otherwise fall under the new requirement.
  process.env.DUIN_CAUSAL_CREDIT = '0'
})
afterEach(() => {
  delete process.env.DUIN_CAUSAL_CREDIT
})

describe('governDecision (asymmetric dual-verifier)', () => {
  const P = { minSessions: 2, minSessionsKeyless: 4 }

  it('AUTO-REVERTS on a failed jury regardless of survival (revoked fast)', () => {
    expect(governDecision({ sessionsObserved: 99, juryPass: false }, P)).toBe('revert')
  })

  it('confirms only on survival AND a passing jury (granted slowly)', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 1, juryPass: true }, P)).toBe('hold') // survived too little
  })

  it('keyless (jury null): the LONGER survival bar now ASKS (ratify), never silently confirms', () => {
    // Re-shaped 2026-08-21 (W3 posture): the pure decision names the ask — bar met with no
    // verifier is 'ratify', parked for the operator. The DUIN_CAUSAL_CREDIT=0 legacy mapping
    // lives in runGovernPass (see the keyless runGovernPass test below, which this suite's
    // env pin exercises), not here: purity means no env reads.
    expect(governDecision({ sessionsObserved: 4, juryPass: null }, P)).toBe('ratify')
    expect(governDecision({ sessionsObserved: 3, juryPass: null }, P)).toBe('hold')
  })
})

describe('governDecision — held-out behavioral oracle (item 14)', () => {
  const P = DEFAULT_GOVERN_POLICY
  it('a measured no-lift (behavioralFlip false) BLOCKS confirm → hold (never revert)', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true, behavioralFlip: false }, P)).toBe('hold')
    expect(governDecision({ sessionsObserved: 4, juryPass: null, behavioralFlip: false }, P)).toBe('hold')
  })
  it('a measured flip (true) confirms; unmeasured (null/undefined) abstains = old behavior', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true, behavioralFlip: true }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 2, juryPass: true, behavioralFlip: null }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 2, juryPass: true }, P)).toBe('confirm') // undefined abstains
  })
  it('a jury reject still reverts even with a flip (demotion unchanged)', () => {
    expect(governDecision({ sessionsObserved: 9, juryPass: false, behavioralFlip: true }, P)).toBe('revert')
  })
  it('behavioralFlipFromEfficacy maps verdicts keep→true / prune→false / else null', () => {
    const mk = (verdict?: 'keep' | 'prune-candidate' | 'inconclusive') => ({
      id: 'x',
      fact: 'f',
      kind: 'value',
      status: 'provisional' as const,
      ts: 0,
      efficacy: verdict ? { flipRate: 0, flips: 0, regressions: 0, trials: 4, verdict, measuredAt: 0 } : undefined
    })
    expect(behavioralFlipFromEfficacy(mk('keep'))).toBe(true)
    expect(behavioralFlipFromEfficacy(mk('prune-candidate'))).toBe(false)
    expect(behavioralFlipFromEfficacy(mk('inconclusive'))).toBeNull()
    expect(behavioralFlipFromEfficacy(mk(undefined))).toBeNull()
  })
})

describe('governDecision — Schema backtest verifier (epicycle-reject, item 4)', () => {
  const P = { minSessions: 2, minSessionsKeyless: 4 }
  it('an epicycle backtest (backtestPass false) BLOCKS confirm → hold (never revert)', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true, backtestPass: false }, P)).toBe('hold')
    expect(governDecision({ sessionsObserved: 4, juryPass: null, backtestPass: false }, P)).toBe('hold')
  })
  it('abstain (null/undefined) never blocks = old behavior; clear (true) confirms', () => {
    expect(governDecision({ sessionsObserved: 2, juryPass: true, backtestPass: null }, P)).toBe('confirm')
    expect(governDecision({ sessionsObserved: 2, juryPass: true }, P)).toBe('confirm') // undefined abstains
    expect(governDecision({ sessionsObserved: 2, juryPass: true, backtestPass: true }, P)).toBe('confirm')
  })
  it('a jury reject still reverts even when the backtest would block (demotion unchanged)', () => {
    expect(governDecision({ sessionsObserved: 9, juryPass: false, backtestPass: false }, P)).toBe('revert')
  })
})

describe('backtestFact (pure epicycle matcher)', () => {
  it('flags a fact that high-overlaps a REFUTED (miss) prediction as an epicycle', () => {
    const resolved = [{ predicted: 'the alpha launch will slip past the deadline', resolution: 'miss' }]
    const r = backtestFact('alpha launch will slip past the deadline', resolved)
    expect(r.verdict).toBe('epicycle')
    expect(r.conflictsWith).toContain('alpha launch')
  })
  it('abstains when there are no resolved rows, or no high-overlap miss', () => {
    expect(backtestFact('anything', []).verdict).toBe('abstain')
    expect(backtestFact('totally unrelated words here', [{ predicted: 'the alpha launch slips', resolution: 'miss' }]).verdict).toBe('abstain')
    // a HIT prediction (reality bore it out) never triggers an epicycle reject
    expect(backtestFact('the alpha launch will slip past the deadline', [{ predicted: 'the alpha launch will slip past the deadline', resolution: 'hit' }]).verdict).toBe('abstain')
  })
})

describe('runGovernPass', () => {
  function provisionalFact(fact: string, sessions: string[]): string {
    recordFacts([{ fact }])
    const id = getOperatorFacts().find((f) => f.fact === fact)!.id
    promoteFact(id) // → provisional (probation)
    for (const s of sessions) noteSession(s)
    return id
  }

  it('confirms survived+passed, auto-reverts jury-failed, holds too-young', async () => {
    provisionalFact('good rule survived', ['s1', 's2'])
    provisionalFact('bad rule', ['s1', 's2'])
    provisionalFact('too young', ['s1'])
    // Jury passes everything except the bad rule.
    const jury: GovernJury = async (prov) => new Set(prov.filter((f) => f.fact !== 'bad rule').map((f) => f.id))

    const r = await runGovernPass(jury, DEFAULT_GOVERN_POLICY)
    expect(r).toEqual({ confirmed: 1, reverted: 1, held: 1, awaitingRatify: 0 })
    expect(listByStatus('promoted').map((f) => f.fact)).toContain('good rule survived')
    expect(listByStatus('reverted').map((f) => f.fact)).toContain('bad rule')
    expect(listByStatus('provisional').map((f) => f.fact)).toContain('too young')
    // Revert is remembered (asymmetry memory).
    expect(getOperatorFacts().find((f) => f.fact === 'bad rule')!.reverts).toBe(1)
  })

  it('keyless (jury null): confirms long survivors, holds recent ones', async () => {
    provisionalFact('old survivor', ['s1', 's2', 's3', 's4'])
    provisionalFact('recent', ['s1', 's2'])
    const r = await runGovernPass(async () => null, DEFAULT_GOVERN_POLICY)
    expect(r.confirmed).toBe(1)
    expect(listByStatus('promoted').map((f) => f.fact)).toContain('old survivor')
    expect(listByStatus('provisional').map((f) => f.fact)).toContain('recent')
  })

  it('no provisional facts → no-op', async () => {
    expect(await runGovernPass(async () => new Set())).toEqual({ confirmed: 0, reverted: 0, held: 0, awaitingRatify: 0 })
  })

  it('confidential-firewall: a confidential fact is never sent to the jury and ABSTAINS (not reverted)', async () => {
    // Cold-start A3 emptied the compiled-in denylist (it shipped the author's real confidential
    // terms to every user) and moved it to per-vault state. Pin the ACTIVE list here so the test
    // states its own confidential lane instead of depending on whatever vault the host machine
    // happens to have configured.
    setActiveDenylist(['acme-secret'])
    try {
      await confidentialFirewallCase()
    } finally {
      setActiveDenylist(null)
    }
  })

  async function confidentialFirewallCase(): Promise<void> {
    provisionalFact('public rule survived', ['s1', 's2', 's3', 's4'])
    provisionalFact('the acme-secret numbers rule', ['s1', 's2', 's3', 's4']) // confidential lane
    let juryReceived: string[] = []
    const jury: GovernJury = async (prov) => {
      juryReceived = prov.map((f) => f.fact)
      return new Set() // jury passes NOTHING
    }
    const r = await runGovernPass(jury, DEFAULT_GOVERN_POLICY)
    // the confidential fact never left for the external jury
    expect(juryReceived).toEqual(['public rule survived'])
    // public: jury ran + failed it → reverted (asymmetric, revoked fast)
    expect(listByStatus('reverted').map((f) => f.fact)).toContain('public rule survived')
    // confidential: abstained (juryPass=null) → keyless survival (4≥4) confirms; NEVER reverted
    expect(listByStatus('promoted').map((f) => f.fact)).toContain('the acme-secret numbers rule')
    expect(listByStatus('reverted').map((f) => f.fact)).not.toContain('the acme-secret numbers rule')
    expect(r.confirmed).toBe(1)
    expect(r.reverted).toBe(1)
  }

  it('a jury that throws is treated as unavailable (falls back to keyless survival)', async () => {
    provisionalFact('survivor', ['s1', 's2', 's3', 's4'])
    const r = await runGovernPass(async () => {
      throw new Error('jury down')
    }, DEFAULT_GOVERN_POLICY)
    expect(r.confirmed).toBe(1) // keyless path via survival
  })
})

// BITEMPORAL LIVENESS. supersedeFact soft-deletes — it stamps `invalidatedAt` and deliberately
// LEAVES `status` alone so the audit can still walk why a rule fell — so a corrected-away rule
// stays in listByStatus('provisional') forever. runGovernPass read status alone, re-adjudicated
// the dead row on the next 30-minute governTick, and confirmFact's 'promote' seam re-wrote the
// concept file that supersedeFact had just retired into `.brain/_retired/`: DUIN resumed asserting
// the rule the operator had corrected, unattended. Invisible because retirement removes the row
// from every surface an operator can SEE (grounding, the memory lane) without touching `status`.
describe('runGovernPass — a bitemporally-retired fact is never re-confirmed', () => {
  const seam: { fact: string; action: 'promote' | 'retire' }[] = []

  beforeEach(() => {
    seam.length = 0
    setMaterializeHook((f, action) => { seam.push({ fact: f.fact, action }) })
  })
  // __resetOperatorModel does NOT clear the seam hook — unhook explicitly or it leaks into siblings.
  afterEach(() => setMaterializeHook(null))

  const OLD = 'I deploy on Fridays'
  const NEW = 'I deploy on Mondays'

  /** The operator teaches a rule, it banks past the KEYLESS survival bar (minSessionsKeyless 4),
   *  then the operator corrects it. Returns the retired fact's id. */
  function taughtThenCorrected(): string {
    recordFacts([{ fact: OLD }])
    const id = getOperatorFacts().find((f) => f.fact === OLD)!.id
    promoteFact(id) // → provisional (probation)
    for (const s of ['s1', 's2', 's3', 's4']) noteSession(s)
    expect(supersedeFact(id, NEW).superseded).toBe(true)
    // The trap this test guards: retired, yet still status 'provisional'.
    expect(listByStatus('provisional').some((f) => f.id === id)).toBe(true)
    expect(getAllOperatorFacts().find((f) => f.id === id)!.invalidatedAt).toEqual(expect.any(Number))
    expect(seam).toEqual([{ fact: OLD, action: 'retire' }])
    return id
  }

  it('keyless survival does not resurrect a superseded provisional fact', async () => {
    const id = taughtThenCorrected()
    const r = await runGovernPass(async () => null, DEFAULT_GOVERN_POLICY)
    // Not adjudicated at all — not confirmed, not reverted, not even held.
    expect(r).toEqual({ confirmed: 0, reverted: 0, held: 0, awaitingRatify: 0 })
    expect(getAllOperatorFacts().find((f) => f.id === id)!.status).toBe('provisional')
    expect(listByStatus('promoted').map((f) => f.fact)).not.toContain(OLD)
    // The seam is the real blast radius: a second 'promote' would re-write
    // `<vault>/.brain/memory/concept-<id>.md` back into the grounding lane.
    expect(seam).toEqual([{ fact: OLD, action: 'retire' }])
  })

  it('the retired fact is not even shown to the jury (it cannot vote a dead rule back)', async () => {
    taughtThenCorrected()
    const juryCalls: string[][] = []
    const jury: GovernJury = async (prov) => {
      juryCalls.push(prov.map((f) => f.fact))
      return new Set(prov.map((f) => f.id)) // a jury that passes everything it is given
    }
    const r = await runGovernPass(jury, DEFAULT_GOVERN_POLICY)
    expect(juryCalls).toEqual([]) // pool empty → the jury is never called
    expect(r.confirmed).toBe(0)
    expect(listByStatus('promoted').map((f) => f.fact)).not.toContain(OLD)
  })

  // Belt-and-braces at the mutator: confirmFact is what fires the 'promote' seam, so the flip
  // itself must refuse a retired row — not merely the one caller that happened to reach it.
  it('confirmFact refuses the flip directly, so no future caller can resurrect the concept', () => {
    const id = taughtThenCorrected()
    confirmFact(id)
    expect(getAllOperatorFacts().find((f) => f.id === id)!.status).toBe('provisional')
    // Pre-fix this array was [retire, promote] on the SAME fact: the concept file was moved to
    // `.brain/_retired/` by the correction, then written straight back into the grounding lane.
    expect(seam).toEqual([{ fact: OLD, action: 'retire' }])
  })
})
