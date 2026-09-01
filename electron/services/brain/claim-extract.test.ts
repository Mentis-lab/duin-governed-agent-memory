import { describe, it, expect, vi, afterEach } from 'vitest'
import { mergeLedger, resolveClaimReview, constructionClaims, reconcileLedgerForPersist, WRITE_SKIP_TAG, supersessionApplyEnabled } from './claim-extract'
import { runVerdicts, isPinned, type Claim, type WorldState } from './claim-metabolism'
import type { ConstructedData } from './types'

// extractClaims/runShadowMetabolism read the live vault (listDecisions/loadFutures) so they're
// smoke-tested live via the route; here we test the pure pieces: the shape a decision claim takes
// (so the temporal rule can fire) and the strength-preserving merge.

const NOW = Date.UTC(2026, 6, 4)

// mirror of what decisionClaims() produces, to assert the temporal rule fires on it end-to-end
function decisionClaim(id: string, status = 'open'): Claim {
  return {
    id: `dec:${id}`, chunkId: `dec:${id}`, notePath: id,
    subject: `decision ${id}`, relation: 'under-decision', object: status,
    validFrom: NOW, validTo: null, observedAt: NOW, supersededBy: null,
    mutability: 'mutable', justifications: [id], verdict: 'current', verdictBy: null
  }
}

describe('claim-extract — extracted claims are judgeable end-to-end', () => {
  it('a decision claim goes STALE once its decision id is a resolved decision', () => {
    const c = decisionClaim('2026-06-09-adopt-adaptive-decision-loop')
    const world: WorldState = {
      pastAnchors: new Set(),
      resolvedDecisions: new Set(['2026-06-09-adopt-adaptive-decision-loop']),
      passedStreams: new Set()
    }
    const { corrections } = runVerdicts([c], world, NOW)
    expect(c.verdict).toBe('stale')
    expect(c.verdictBy).toBe('temporal')
    expect(corrections[0]).toMatchObject({ claimId: c.id, verdict: 'stale' })
  })

  it('an unresolved decision claim stays current', () => {
    const c = decisionClaim('open-decision')
    runVerdicts([c], { pastAnchors: new Set(), resolvedDecisions: new Set(), passedStreams: new Set() }, NOW)
    expect(c.verdict).toBe('current')
  })
})

describe('claim-extract — mergeLedger preserves earned state', () => {
  it('carries lastUsefulAt from the prior ledger; drops disappeared claims', () => {
    const prior = [{ ...decisionClaim('a'), lastUsefulAt: 12345 }]
    const fresh = [decisionClaim('a'), decisionClaim('b')]
    const merged = mergeLedger(prior, fresh)
    expect(merged.map((c) => c.id)).toEqual(['dec:a', 'dec:b'])
    expect(merged.find((c) => c.id === 'dec:a')?.lastUsefulAt).toBe(12345) // preserved
    expect(merged.find((c) => c.id === 'dec:b')?.lastUsefulAt).toBeUndefined() // new
  })
  it('a claim gone from the fresh extraction is dropped (its note is gone)', () => {
    const merged = mergeLedger([decisionClaim('old')], [decisionClaim('new')])
    expect(merged.map((c) => c.id)).toEqual(['dec:new'])
  })
})

describe('claim-extract — mergeLedger durability (retirements + human reversals survive rebuilds)', () => {
  it('carries forward a metabolism retirement so it does not silently resurrect on rebuild', () => {
    const retired: Claim = { ...decisionClaim('a'), validTo: NOW, verdict: 'contradicted', verdictBy: 'supersession', supersededBy: 'dec:b' }
    const [merged] = mergeLedger([retired], [decisionClaim('a')]) // fresh extraction is always "current"
    expect(merged.validTo).toBe(NOW) // NOT reset to null
    expect(merged.verdict).toBe('contradicted')
    expect(merged.verdictBy).toBe('supersession')
    expect(merged.supersededBy).toBe('dec:b')
  })

  it('carries forward a human reviewState pin (the moat-reversibility guarantee)', () => {
    const reverted: Claim = { ...decisionClaim('a'), reviewState: 'reverted' }
    const [merged] = mergeLedger([reverted], [decisionClaim('a')])
    expect(merged.reviewState).toBe('reverted')
  })

  it('a freshly born-retired TEMPORAL wins over a prior current (a lapsed validUntil fires on rebuild)', () => {
    // Last build the fact was current (validUntil still in the future). This build its extracted
    // validUntil has lapsed → constructionClaims births it retired ('stale'/'temporal'). The prior
    // 'current' carry-forward must NOT resurrect it.
    const priorCurrent: Claim = { ...decisionClaim('a'), validTo: null, verdict: 'current', verdictBy: null }
    const freshRetired: Claim = { ...decisionClaim('a'), validTo: NOW, verdict: 'stale', verdictBy: 'temporal' }
    const [merged] = mergeLedger([priorCurrent], [freshRetired])
    expect(merged.validTo).toBe(NOW) // NOT clobbered back to null
    expect(merged.verdict).toBe('stale')
    expect(merged.verdictBy).toBe('temporal')
  })

  it('a human PIN still wins over a freshly born-retired temporal (operator ruling never reset)', () => {
    const priorPinned: Claim = { ...decisionClaim('a'), validTo: null, verdict: 'current', verdictBy: null, reviewState: 'confirmed' }
    const freshRetired: Claim = { ...decisionClaim('a'), validTo: NOW, verdict: 'stale', verdictBy: 'temporal' }
    const [merged] = mergeLedger([priorPinned], [freshRetired])
    expect(merged.validTo).toBeNull() // pin held — the human said this is current
    expect(merged.reviewState).toBe('confirmed')
  })

  it('RE-JUDGES from current when the object changed and the claim is NOT pinned', () => {
    // prior claim was retired at object 'open'; the decision reopened → fresh object 'active'
    const retired: Claim = { ...decisionClaim('a', 'open'), validTo: NOW, verdict: 'stale', verdictBy: 'temporal' }
    const [merged] = mergeLedger([retired], [decisionClaim('a', 'active')])
    expect(merged.object).toBe('active')
    expect(merged.validTo).toBeNull() // reset → runVerdicts re-judges from scratch
    expect(merged.verdict).toBe('current')
  })

  it('a PINNED claim keeps its state even across an object change (human decision is never auto-reset)', () => {
    const pinned: Claim = { ...decisionClaim('a', 'open'), validTo: NOW, verdict: 'stale', verdictBy: 'temporal', reviewState: 'confirmed' }
    const [merged] = mergeLedger([pinned], [decisionClaim('a', 'active')])
    expect(merged.validTo).toBe(NOW) // pin held despite object change
    expect(merged.reviewState).toBe('confirmed')
  })
})

describe('claim-extract — reconcileLedgerForPersist (persist-time durability guards)', () => {
  it('re-injects a human-pinned prior claim that vanished from the fresh extraction', () => {
    const pinned: Claim = { ...decisionClaim('a'), reviewState: 'confirmed' }
    const other = decisionClaim('b')
    const prior = [pinned, other]
    // Fresh tick dropped the pinned claim (transient extraction miss) but kept 'b'.
    const toPersist = [other]
    const write = reconcileLedgerForPersist(prior, toPersist)
    expect(write).not.toBeNull()
    const ids = write!.map((c) => c.id)
    expect(ids).toContain('dec:a') // pin rescued
    expect(ids).toContain('dec:b')
    expect(write!.find((c) => c.id === 'dec:a')?.reviewState).toBe('confirmed') // verbatim
  })

  it('does NOT re-inject an unpinned prior claim that legitimately disappeared', () => {
    const prior = [decisionClaim('gone'), decisionClaim('keep')]
    const toPersist = [decisionClaim('keep')]
    const write = reconcileLedgerForPersist(prior, toPersist)
    // No pins to rescue; not a catastrophic shrink (1 of 2 = 50%, not < 50%) → write as-is.
    expect(write).not.toBeNull()
    expect(write!.map((c) => c.id)).toEqual(['dec:keep'])
  })

  it('refuses a catastrophic >50% shrink even for a SMALL ledger (no >=20 gate)', () => {
    const prior = [decisionClaim('a'), decisionClaim('b'), decisionClaim('c')]
    const toPersist: Claim[] = [] // transient-empty extraction wiped everything
    expect(reconcileLedgerForPersist(prior, toPersist)).toBeNull() // keep prior
  })

  it('a rescued pin can lift the write back above the shrink floor', () => {
    const pinned: Claim = { ...decisionClaim('a'), reviewState: 'reverted' }
    const prior = [pinned, decisionClaim('b')]
    const toPersist: Claim[] = [] // both dropped this tick
    const write = reconcileLedgerForPersist(prior, toPersist)
    // withPins = [pinned] → a non-empty extraction, prior is tiny → not a wipe → persist with the pin.
    expect(write).not.toBeNull()
    expect(write!.map((c) => c.id)).toEqual(['dec:a'])
  })
})

// The FROZEN-LEDGER fix: the old `withPins.length < prior.length * 0.5` ratio-floor deadlocked the
// live ledger after a moat-restore re-inflated `prior` to an older/larger construction generation
// (4821), so a healthy ~263-claim extraction returned null every tick and never wrote. The reworked
// guard refuses only the transient-WIPE signature (a current extraction that collapsed to nothing),
// so a legitimately-smaller-but-HEALTHY extraction re-baselines and UNFREEZES the ledger.
describe('claim-extract — reconcileLedgerForPersist (re-baseline unfreeze + wipe protection)', () => {
  const many = (n: number, prefix: string): Claim[] => Array.from({ length: n }, (_, i) => decisionClaim(`${prefix}-${i}`))

  it('UNFREEZES: a legitimately-smaller extraction from a HEALTHY construction now PERSISTS where the old >50% floor refused it', () => {
    const prior = many(4821, 'stale') // restore-inflated older generation
    const fresh = many(263, 'live') // healthy current extraction — far more than half smaller
    // old floor: 263 < 4821·0.5 (2410) ⇒ would have returned null (the deadlock). New guard: a
    // non-degenerate extraction is a re-baseline ⇒ writes.
    const write = reconcileLedgerForPersist(prior, fresh)
    expect(write).not.toBeNull()
    expect(write!).toHaveLength(263)
    expect(write!.map((c) => c.id)).toEqual(fresh.map((c) => c.id)) // the LIVE 263 win over the stale 4821
  })

  it('STILL REFUSES a total-collapse extraction of a large ledger (the original wipe protection is intact)', () => {
    const prior = many(4821, 'stale')
    expect(reconcileLedgerForPersist(prior, [])).toBeNull() // 0 claims left ⇒ failed read ⇒ keep prior
  })

  it('STILL REFUSES a near-empty collapse of a substantial ledger (wipe signature, not a re-baseline)', () => {
    const prior = many(50, 'stale')
    const write = reconcileLedgerForPersist(prior, [decisionClaim('lone')]) // 1 claim left, prior ≥ 20
    expect(write).toBeNull()
  })

  it('does NOT refuse a small vault that genuinely shrank to a couple of claims (no large prior to protect)', () => {
    const prior = many(5, 'small') // below WIPE_BIG_PRIOR ⇒ near-empty rule does not apply
    const write = reconcileLedgerForPersist(prior, [decisionClaim('lone')])
    expect(write).not.toBeNull()
    expect(write!.map((c) => c.id)).toEqual(['dec:lone'])
  })

  it('emits the WRITE_SKIP_TAG alert when it refuses a wipe (the freeze was silent before)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reconcileLedgerForPersist(many(4821, 'stale'), []) // refused
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0][0]).toContain(WRITE_SKIP_TAG)
      expect(warn.mock.calls[0][0]).toContain('prior=4821')
    } finally {
      warn.mockRestore()
    }
  })

  it('does NOT alert on a healthy re-baseline write (only real wipes are noisy)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      reconcileLedgerForPersist(many(4821, 'stale'), many(263, 'live'))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('claim-extract — constructionClaims (prose triple bridge)', () => {
  const construction: ConstructedData = {
    entities: [
      { id: 'person:jordan', kind: 'person', label: 'Jordan Lee', note: 'people.md' },
      { id: 'project:atlas', kind: 'project', label: 'Project Atlas', note: 'atlas.md' }
    ],
    edges: [
      { source: 'person:jordan', target: 'project:atlas', type: 'owns' },
      { source: 'project:atlas', target: 'project:atlas', type: 'about' } // self-loop → skipped
    ],
    classifications: [],
    triples: [
      { subject: '北澜', relation: 'has deadline', object: 'August', note: 'moon.md' },
      { subject: 'x', relation: '', object: 'y', note: 'z.md' } // empty relation → skipped
    ]
  }

  it('LLM-extracted validUntil in the PAST → the prose claim is born already-retired (temporal)', () => {
    const c = constructionClaims(
      {
        entities: [],
        edges: [],
        classifications: [],
        triples: [
          { subject: 'Xiaopeng deal', relation: 'status', object: 'active', note: 'd.md', validFrom: '2026-01-01', validUntil: '2026-05-29' }
        ]
      },
      NOW // NOW = 2026-07-04, so validUntil 2026-05-29 is in the past
    )
    expect(c).toHaveLength(1)
    expect(c[0].validTo).not.toBeNull() // born retired
    expect(c[0].verdict).toBe('stale')
    expect(c[0].verdictBy).toBe('temporal') // deterministic → persists (LLM temporal invalidation)
    expect(c[0].validFrom).toBe(Date.UTC(2026, 0, 1))
  })

  it('a triple with no dates (or a future validUntil) is current', () => {
    const c = constructionClaims(
      { entities: [], edges: [], classifications: [], triples: [{ subject: 'a', relation: 'is', object: 'b', note: 'n.md', validUntil: '2027-01-01' }] },
      NOW
    )
    expect(c[0].validTo).toBeNull()
    expect(c[0].verdict).toBe('current')
  })

  it('maps a typed edge to a prose S-R-O claim with entity labels + provenance', () => {
    const claims = constructionClaims(construction, NOW)
    const edgeClaim = claims.find((c) => c.id.startsWith('prose:person:jordan'))!
    expect(edgeClaim.subject).toBe('Jordan Lee')
    expect(edgeClaim.relation).toBe('owns')
    expect(edgeClaim.object).toBe('Project Atlas')
    expect(edgeClaim.notePath).toBe('people.md') // source entity's note
    expect(edgeClaim.source).toBe('prose')
    expect(edgeClaim.id).toBe('prose:person:jordan|owns|project:atlas')
  })

  it('bridges OPEN-VOCABULARY triples with an arbitrary relation phrase (Graphiti-style facts)', () => {
    const claims = constructionClaims(construction, NOW)
    const triple = claims.find((c) => c.id.startsWith('prose:t:'))!
    expect(triple.subject).toBe('北澜')
    expect(triple.relation).toBe('has deadline') // NOT in the fixed 7-type vocab
    expect(triple.object).toBe('August')
    expect(triple.source).toBe('prose')
    expect(triple.notePath).toBe('moon.md')
    // the empty-relation triple was skipped; total = 1 edge + 1 triple
    expect(claims.filter((c) => c.source === 'prose')).toHaveLength(2)
  })

  it('null / empty construction → no claims', () => {
    expect(constructionClaims(null, NOW)).toEqual([])
    expect(constructionClaims({ entities: [], edges: [], classifications: [] }, NOW)).toEqual([])
  })

  it('an edge to an unknown entity id falls back to the raw id as the label', () => {
    const c = constructionClaims(
      { entities: [], edges: [{ source: 'a', target: 'b', type: 'mentions' }], classifications: [] },
      NOW
    )
    expect(c[0].subject).toBe('a')
    expect(c[0].object).toBe('b')
  })
})

describe('claim-extract — supersessionApplyEnabled flag (P7 kill-switch)', () => {
  const ENV = 'DUIN_CLAIM_SUPERSESSION'
  afterEach(() => delete process.env[ENV])
  it('defaults ON, and only "0" disables (mirrors the other metabolism flags)', () => {
    delete process.env[ENV]
    expect(supersessionApplyEnabled()).toBe(true) // default-ON: guarded + reversible
    process.env[ENV] = '1'
    expect(supersessionApplyEnabled()).toBe(true)
    process.env[ENV] = '0'
    expect(supersessionApplyEnabled()).toBe(false) // instant conservative kill-switch
  })
})

describe('claim-extract — resolveClaimReview (the reversibility surface)', () => {
  it("'revert' un-retires a claim and pins it 'reverted'", () => {
    const retired: Claim = { ...decisionClaim('a'), validTo: NOW, verdict: 'stale', verdictBy: 'temporal', supersededBy: 'x' }
    const r = resolveClaimReview([retired], 'dec:a', 'revert')
    expect(r.ok).toBe(true)
    expect(r.claim?.validTo).toBeNull()
    expect(r.claim?.verdict).toBe('current')
    expect(r.claim?.reviewState).toBe('reverted')
    expect(isPinned(r.claim!)).toBe(true)
  })
  it("'confirm' pins a claim in place without changing its verdict", () => {
    const retired: Claim = { ...decisionClaim('a'), validTo: NOW, verdict: 'contradicted', verdictBy: 'supersession' }
    const r = resolveClaimReview([retired], 'dec:a', 'confirm')
    expect(r.ok).toBe(true)
    expect(r.claim?.validTo).toBe(NOW) // unchanged
    expect(r.claim?.verdict).toBe('contradicted') // unchanged
    expect(r.claim?.reviewState).toBe('confirmed')
  })
  it('an unknown claimId is a safe no-op', () => {
    const r = resolveClaimReview([decisionClaim('a')], 'dec:missing', 'revert')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('claim not found')
  })
})
