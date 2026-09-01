import { describe, it, expect } from 'vitest'
import {
  supersedeKey, canonicalRelation, claimsAsOf, classifyMutability, halfLifeFor, freshness, retrievalScore,
  runVerdicts, unretire, markUseful, isPinned, HARD_PENALTY, FRESH_FLOOR,
  applySupersessionGuards, DEFAULT_SUPERSESSION_GUARDS, PROSE_SUPERSEDE_CONF, SUPERSEDE_MIN_CONFIDENCE,
  inferMultiValuedKeys, relationCardinalityEnabled,
  type Claim, type WorldState
} from './claim-metabolism'
import { ENTITY_CLUSTER_THRESHOLD, blockKeyOf } from './claim-entities'

const DAY = 86_400_000
const NOW = 1_000 * DAY

function claim(p: Partial<Claim> & Pick<Claim, 'id' | 'subject' | 'relation' | 'object'>): Claim {
  return {
    chunkId: `chunk-${p.id}`, notePath: `note-${p.id}.md`,
    validFrom: NOW - 30 * DAY, validTo: null, observedAt: NOW - 30 * DAY, supersededBy: null,
    mutability: classifyMutability(p.relation, p.operatorAuthored), justifications: [],
    verdict: 'current', verdictBy: null,
    ...p
  }
}
const emptyWorld = (): WorldState => ({ pastAnchors: new Set(), resolvedDecisions: new Set(), passedStreams: new Set() })

describe('claim-metabolism — primitives', () => {
  it('supersedeKey normalizes subject+relation', () => {
    expect(supersedeKey(' 北澜 ', 'Deadline')).toBe(supersedeKey('北澜', 'deadline'))
  })
  it('canonicalRelation folds paraphrased PROSE relations (order-insensitive, stopword-stripped)', () => {
    // "has deadline" / "deadline is" / "deadline" all coalesce so a contradiction is detected
    expect(canonicalRelation('has deadline')).toBe('deadline')
    expect(canonicalRelation('deadline is')).toBe('deadline')
    expect(canonicalRelation('the deadline')).toBe('deadline')
    expect(canonicalRelation('reports to')).toBe('reports')
    // distinct relations stay distinct (no over-collapse on shared function words)
    expect(canonicalRelation('owns')).not.toBe(canonicalRelation('blocks'))
  })
  it('canonicalRelation is a NO-OP on the structured vocabulary (durable-supersession safety)', () => {
    // structured relations are single hyphenated tokens: their key must be byte-identical so
    // relation folding never changes what durably retires
    for (const r of ['under-decision', 'stream-status', 'has-future', 'anchor-ref']) {
      expect(canonicalRelation(r)).toBe(r)
      expect(supersedeKey('x', r)).toBe(`x|${r}`)
    }
  })
  it('an all-stopword relation never collapses to empty', () => {
    expect(canonicalRelation('is')).toBe('is')
  })
  it('claimsAsOf returns only claims whose valid interval contains T (point-in-time bitemporal query)', () => {
    const a = claim({ id: 'a', subject: 's', relation: 'r', object: 'o1', validFrom: 100 * DAY, validTo: 200 * DAY }) // valid [100,200)
    const b = claim({ id: 'b', subject: 's', relation: 'r', object: 'o2', validFrom: 200 * DAY, validTo: null }) // valid [200, now)
    const future = claim({ id: 'f', subject: 's', relation: 'r', object: 'o3', validFrom: 500 * DAY, validTo: null }) // not yet
    const all = [a, b, future]
    expect(claimsAsOf(all, 150 * DAY).map((c) => c.id)).toEqual(['a']) // only a was true at T=150
    expect(claimsAsOf(all, 200 * DAY).map((c) => c.id)).toEqual(['b']) // a expired exactly at 200, b begins
    expect(claimsAsOf(all, 300 * DAY).map((c) => c.id)).toEqual(['b']) // future not yet valid
    expect(claimsAsOf(all, 600 * DAY).map((c) => c.id).sort()).toEqual(['b', 'f']) // both active
    expect(claimsAsOf(all, 50 * DAY)).toEqual([]) // before anything existed
  })
  it('halfLife: evergreen relations never decay, volatile decay in ~2 weeks', () => {
    expect(halfLifeFor('founded')).toBe(Number.POSITIVE_INFINITY)
    expect(halfLifeFor('current-status')).toBe(14 * DAY)
    expect(halfLifeFor('collaborates-with')).toBe(90 * DAY)
  })
  it('operator-authored judgment is evergreen (harmony: never stale a taught fact)', () => {
    expect(classifyMutability('current-plan', true)).toBe('evergreen')
    expect(classifyMutability('current-plan', false)).toBe('mutable')
  })
})

describe('claim-metabolism — freshness (verdict-driven + use-refreshed, the sim correction)', () => {
  it('a retired claim collapses to HARD_PENALTY', () => {
    const c = claim({ id: 'a', subject: 'x', relation: 'status', object: 'old', validTo: NOW })
    expect(freshness(c, NOW)).toBe(HARD_PENALTY)
  })
  it('an evergreen claim never decays', () => {
    const c = claim({ id: 'b', subject: 'x', relation: 'founded', object: '2019', observedAt: NOW - 3650 * DAY })
    expect(freshness(c, NOW)).toBe(1.0)
  })
  it('a current mutable claim floors at FRESH_FLOOR (not buried) even when old', () => {
    const c = claim({ id: 'c', subject: 'x', relation: 'status', object: 'v', observedAt: NOW - 3650 * DAY })
    expect(freshness(c, NOW)).toBe(FRESH_FLOOR)
  })
  it('useful access resets the decay clock (spaced repetition)', () => {
    const c = claim({ id: 'd', subject: 'x', relation: 'status', object: 'v', observedAt: NOW - 60 * DAY })
    const before = freshness(c, NOW)
    markUseful(c, NOW)
    expect(freshness(c, NOW)).toBeGreaterThan(before)
    expect(freshness(c, NOW)).toBeCloseTo(1.0, 5)
  })
})

describe('claim-metabolism — verdicts', () => {
  it('supersession: newer value retires older same-key; SAME value is reinforced, not retired', () => {
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'n', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY })
    const dup = claim({ id: 'dup', subject: '北澜', relation: 'deadline', object: 'august', observedAt: NOW - 5 * DAY })
    const { corrections } = runVerdicts([older, newer, dup], emptyWorld(), NOW)
    expect(older.validTo).toBe(NOW)
    expect(older.verdict).toBe('contradicted')
    expect(older.supersededBy).toBe('n')
    expect(dup.validTo).toBeNull() // same object as winner → reinforce
    expect(newer.validTo).toBeNull()
    expect(corrections).toEqual([expect.objectContaining({ claimId: 'o', verdict: 'contradicted' })])
  })

  it('world-state temporal: a mutable claim on a resolved decision goes stale; evergreen exempt', () => {
    const mut = claim({ id: 'm', subject: 'deal-x', relation: 'status', object: 'pending', justifications: ['dec-1'] })
    const ever = claim({ id: 'e', subject: 'deal-x', relation: 'founded', object: '2020', justifications: ['dec-1'] })
    const world = emptyWorld(); world.resolvedDecisions.add('dec-1')
    runVerdicts([mut, ever], world, NOW)
    expect(mut.verdict).toBe('stale')
    expect(mut.verdictBy).toBe('temporal')
    expect(ever.validTo).toBeNull() // evergreen exempt
  })

  it('JTMS: a claim justified by a retired claim is orphaned, and it cascades', () => {
    const root = claim({ id: 'root', subject: 'p', relation: 'deadline', object: 'old', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'new', subject: 'p', relation: 'deadline', object: 'new', observedAt: NOW - 1 * DAY })
    const child = claim({ id: 'child', subject: 'q', relation: 'note', object: '...', justifications: ['root'] })
    const grand = claim({ id: 'grand', subject: 'r', relation: 'note', object: '...', justifications: ['child'] })
    runVerdicts([root, newer, child, grand], emptyWorld(), NOW)
    expect(root.verdict).toBe('contradicted') // superseded
    expect(child.verdict).toBe('orphaned')
    expect(grand.verdict).toBe('orphaned') // cascaded
  })

  it('reversibility: unretire restores a claim to current (retire-not-delete) and pins it', () => {
    const c = claim({ id: 'z', subject: 'x', relation: 'status', object: 'v', validTo: NOW, verdict: 'stale' })
    unretire(c)
    expect(c.validTo).toBeNull()
    expect(c.verdict).toBe('current')
    expect(c.reviewState).toBe('reverted') // human reversal is recorded → pinned
    expect(isPinned(c)).toBe(true)
    expect(freshness(c, NOW)).toBeGreaterThan(HARD_PENALTY)
  })
})

describe('claim-metabolism — human review pins survive the deterministic pass (moat reversibility)', () => {
  it('a REVERTED claim is never re-superseded, even by a newer contradicting value', () => {
    // human reverted the older claim; a newer contradicting value arrives next tick
    const reverted = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, reviewState: 'reverted' })
    const newer = claim({ id: 'n', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY })
    const { corrections } = runVerdicts([reverted, newer], emptyWorld(), NOW)
    expect(reverted.validTo).toBeNull() // pin held — NOT re-retired
    expect(reverted.verdict).toBe('current')
    expect(corrections).toEqual([]) // nothing auto-retired
  })

  it('a CONFIRMED mutable claim on a resolved decision is not auto-staled', () => {
    const confirmed = claim({ id: 'm', subject: 'deal-x', relation: 'status', object: 'pending', justifications: ['dec-1'], reviewState: 'confirmed' })
    const world = emptyWorld(); world.resolvedDecisions.add('dec-1')
    runVerdicts([confirmed], world, NOW)
    expect(confirmed.validTo).toBeNull() // pin held — temporal rule skipped it
    expect(confirmed.verdict).toBe('current')
  })

  it('a pinned-current claim is not orphaned when its justification is retired', () => {
    const root = claim({ id: 'root', subject: 'p', relation: 'deadline', object: 'old', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'new', subject: 'p', relation: 'deadline', object: 'new', observedAt: NOW - 1 * DAY })
    const pinnedChild = claim({ id: 'child', subject: 'q', relation: 'note', object: '...', justifications: ['root'], reviewState: 'confirmed' })
    runVerdicts([root, newer, pinnedChild], emptyWorld(), NOW)
    expect(root.verdict).toBe('contradicted') // still superseded (not pinned)
    expect(pinnedChild.validTo).toBeNull() // pin held — JTMS skipped it
    expect(pinnedChild.verdict).toBe('current')
  })
})

describe('claim-metabolism — prose triples supersede only as PROPOSALS (false-triple containment)', () => {
  it('a PROSE winner retiring a structured claim marks it verdictBy=model (proposal, not persisted)', () => {
    const structured = claim({ id: 's', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const prose = claim({ id: 'p', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose' })
    runVerdicts([structured, prose], emptyWorld(), NOW)
    expect(structured.verdict).toBe('contradicted')
    expect(structured.verdictBy).toBe('model') // ← proposal-only; metabolize un-applies before persist
  })
  it('a STRUCTURED winner still supersedes deterministically (verdictBy=supersession)', () => {
    const older = claim({ id: 'o', subject: 'x', relation: 'status', object: 'a', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'n', subject: 'x', relation: 'status', object: 'b', observedAt: NOW - 1 * DAY }) // structured by default
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('supersession')
  })
  it("a supersession ends the loser's VALID interval at the winner's validFrom (accurate as-of reads)", () => {
    const older = claim({ id: 'o', subject: 'x', relation: 'status', object: 'a', validFrom: 100 * DAY, observedAt: 100 * DAY })
    const newer = claim({ id: 'n', subject: 'x', relation: 'status', object: 'b', validFrom: 300 * DAY, observedAt: 300 * DAY })
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.validTo).toBe(300 * DAY) // valid-time end = when 'b' took effect, NOT wall-clock NOW
    // point-in-time: at T=200 the OLD fact was still true; at T=400 the new one is
    expect(claimsAsOf([older, newer], 200 * DAY).map((c) => c.id)).toEqual(['o'])
    expect(claimsAsOf([older, newer], 400 * DAY).map((c) => c.id)).toEqual(['n'])
  })

  it('relation canonicalization lets PARAPHRASED prose relations coalesce so a contradiction is DETECTED', () => {
    // Pre-canonicalization these two keyed differently ("has deadline" vs "deadline is") and the
    // contradiction was invisible. Now they share a key → surfaced as a proposal (still proposal-only).
    const older = claim({ id: 'o', subject: '北澜', relation: 'has deadline', object: 'June', observedAt: NOW - 10 * DAY, source: 'prose' })
    const newer = claim({ id: 'n', subject: '北澜', relation: 'deadline is', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose' })
    const { corrections } = runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdict).toBe('contradicted') // detected despite the relation paraphrase
    expect(older.verdictBy).toBe('model') // still proposal-only (prose) — containment intact
    expect(corrections.some((c) => c.claimId === 'o')).toBe(true)
  })

  it('a prose-superseded (proposal) claim does NOT cascade a durable JTMS orphan onto a real claim', () => {
    const root = claim({ id: 'root', subject: 'x', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const prose = claim({ id: 'pw', subject: 'x', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose' })
    const child = claim({ id: 'child', subject: 'q', relation: 'note', object: '...', justifications: ['root'] }) // derives from root by claim id
    runVerdicts([root, prose, child], emptyWorld(), NOW)
    expect(root.verdictBy).toBe('model') // prose supersession is a proposal (un-applied before persist)
    expect(child.validTo).toBeNull() // NOT orphaned — a proposal must not cascade a durable jtms retirement
    expect(child.verdict).toBe('current')
  })
})

describe('claim-metabolism — applySupersessionGuards (P7: guarded dynamic supersession)', () => {
  it('APPLIES a high-confidence prose supersession (retire-not-delete → durable verdictBy supersession)', () => {
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const prose = claim({ id: 'p', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose' })
    runVerdicts([older, prose], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('model') // proposal from runVerdicts
    expect(older.supersedeConfidence).toBe(PROSE_SUPERSEDE_CONF) // 0.9 ≥ 0.85 default → passes

    const res = applySupersessionGuards([older, prose])
    expect(res.applied).toBe(1)
    expect(older.validTo).toBe(NOW) // RETIRE-NOT-DELETE: the row is kept, just interval-closed
    expect(older.verdict).toBe('contradicted')
    expect(older.verdictBy).toBe('supersession') // now first-class + counts in verdict diversity
    expect(older.supersededBy).toBe('p')
    expect(prose.validTo).toBeNull() // winner untouched
  })

  it('BLOCKS a low-confidence cross-alias supersession — knowledge preserved (disjoint/ambiguous guard)', () => {
    // different RAW subjects coalesced by a WEAK cluster (entityKeyConfidence 0.5) → the exact case an
    // embedding over-merge produces; it must never durably bury a real claim. Winner is PROSE so it
    // clears the DEFECT-2 cross-alias-structured gate and this test isolates the DEFECT-1 CONFIDENCE
    // gate: entity membership 0.5 < minConfidence (0.92) → blocked.
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, entityKey: 'moon', entityKeyConfidence: 0.5 })
    const newer = claim({ id: 'n', subject: '《北澜》', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose', entityKey: 'moon', entityKeyConfidence: 0.5 })
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('model')
    expect(older.supersedeConfidence).toBeLessThan(DEFAULT_SUPERSESSION_GUARDS.minConfidence)

    const res = applySupersessionGuards([older, newer])
    expect(res.applied).toBe(0)
    expect(res.blockedConfidence).toBe(1)
    expect(older.validTo).toBeNull() // PRESERVED
    expect(older.verdict).toBe('current')
    expect(older.verdictBy).toBeNull()
    expect(older.supersededBy).toBeNull()
  })

  it('NEVER applies a supersession to a human-PINNED claim (belt-and-suspenders on the guard itself)', () => {
    // runVerdicts already skips pins, so a pinned claim is never a model loser; if one ever reaches the
    // guard, it must still be refused. Hand-construct that state to prove the guard-level pin check.
    const pinned = claim({
      id: 'o', subject: '北澜', relation: 'deadline', object: 'June',
      validTo: NOW, verdict: 'contradicted', verdictBy: 'model', supersededBy: 'n',
      supersedeConfidence: 1, reviewState: 'confirmed'
    })
    const res = applySupersessionGuards([pinned])
    expect(res.applied).toBe(0)
    expect(pinned.validTo).toBeNull() // reverted → the human ruling wins, knowledge preserved
    expect(pinned.verdict).toBe('current')
    expect(pinned.reviewState).toBe('confirmed') // pin intact
  })

  it('the over-retirement TRIPWIRE refuses a runaway pass that would gut an entity', () => {
    // one prose winner + many older values, all one subject → applying would retire MOST of the
    // entity. The tripwire reverts the whole entity's model retirements rather than gutting it.
    const winner = claim({ id: 'w', subject: 'E', relation: 'status', object: 'final', observedAt: NOW - 1 * DAY, source: 'prose' })
    const losers = Array.from({ length: 6 }, (_, i) =>
      claim({ id: `l${i}`, subject: 'E', relation: 'status', object: `v${i}`, observedAt: NOW - (10 + i) * DAY, source: 'prose' })
    )
    const all = [winner, ...losers]
    runVerdicts(all, emptyWorld(), NOW)
    for (const l of losers) {
      expect(l.verdictBy).toBe('model')
      expect(l.supersedeConfidence).toBe(PROSE_SUPERSEDE_CONF) // clears CONFIDENCE, so only the tripwire can stop it
    }
    const res = applySupersessionGuards(all)
    expect(res.applied).toBe(0)
    expect(res.blockedTripwire).toBe(6)
    for (const l of losers) {
      expect(l.validTo).toBeNull() // ALL preserved
      expect(l.verdict).toBe('current')
    }
  })

  it('a smaller, legitimate supersession within an entity is NOT tripped (guard is bounded, not blanket)', () => {
    // 1 winner + 1 loser on a small entity: fraction 1/2 with only 2 in play (< fractionFloor 4) → applied
    const winner = claim({ id: 'w', subject: 'E', relation: 'status', object: 'final', observedAt: NOW - 1 * DAY, source: 'prose' })
    const loser = claim({ id: 'l', subject: 'E', relation: 'status', object: 'old', observedAt: NOW - 5 * DAY, source: 'prose' })
    runVerdicts([winner, loser], emptyWorld(), NOW)
    const res = applySupersessionGuards([winner, loser])
    expect(res.applied).toBe(1)
    expect(loser.verdictBy).toBe('supersession')
  })

  it('the kill-switch (enabled=false) reverts ALL model supersessions (DUIN_CLAIM_SUPERSESSION=0 behavior)', () => {
    const older = claim({ id: 'o', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const prose = claim({ id: 'p', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose' })
    runVerdicts([older, prose], emptyWorld(), NOW)
    const res = applySupersessionGuards([older, prose], DEFAULT_SUPERSESSION_GUARDS, false)
    expect(res.applied).toBe(0)
    expect(older.validTo).toBeNull() // proposal-only, byte-for-byte the prior behavior
    expect(older.verdictBy).toBeNull()
  })

  it('leaves DETERMINISTIC verdicts (temporal, structured supersession, jtms) untouched', () => {
    const mut = claim({ id: 'm', subject: 'deal', relation: 'status', object: 'pending', justifications: ['dec-1'] }) // → temporal
    const so = claim({ id: 'so', subject: 'x', relation: 'status', object: 'a', observedAt: NOW - 10 * DAY })
    const sn = claim({ id: 'sn', subject: 'x', relation: 'status', object: 'b', observedAt: NOW - 1 * DAY }) // structured → supersession
    const root = claim({ id: 'root', subject: 'p', relation: 'deadline', object: 'old', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'new', subject: 'p', relation: 'deadline', object: 'new', observedAt: NOW - 1 * DAY })
    const child = claim({ id: 'child', subject: 'q', relation: 'note', object: '...', justifications: ['root'] }) // → jtms
    const world = emptyWorld(); world.resolvedDecisions.add('dec-1')
    const all = [mut, so, sn, root, newer, child]
    runVerdicts(all, world, NOW)
    expect(mut.verdictBy).toBe('temporal')
    expect(so.verdictBy).toBe('supersession')
    expect(child.verdictBy).toBe('jtms')

    applySupersessionGuards(all)
    expect(mut.verdictBy).toBe('temporal'); expect(mut.validTo).not.toBeNull()
    expect(so.verdictBy).toBe('supersession'); expect(so.validTo).not.toBeNull()
    expect(child.verdictBy).toBe('jtms'); expect(child.validTo).not.toBeNull()
  })
})

describe('claim-metabolism — P7 adversarial-review fixes (DEFECT 1/2/3)', () => {
  // ── DEFECT 1: confidence gate must sit strictly ABOVE the clustering threshold ──────────────────
  it('INVARIANT: the confidence bar strictly exceeds the entity-clustering threshold (fails if lowered)', () => {
    // This is the compile-of-record for "the two can never silently cross". If a future edit drops
    // SUPERSEDE_MIN_CONFIDENCE to/below the merge bar (reviving DEFECT 1 — a gate that can never fire on
    // a direct two-member cluster), THIS test fails (and the module-load assert throws before it).
    expect(SUPERSEDE_MIN_CONFIDENCE).toBeGreaterThan(ENTITY_CLUSTER_THRESHOLD)
    expect(DEFAULT_SUPERSESSION_GUARDS.minConfidence).toBe(SUPERSEDE_MIN_CONFIDENCE)
    expect(DEFAULT_SUPERSESSION_GUARDS.minConfidence).toBeGreaterThan(ENTITY_CLUSTER_THRESHOLD)
    expect(SUPERSEDE_MIN_CONFIDENCE).toBeCloseTo(0.92, 10)
  })

  it('two DISTINCT entities that share a block-key and merge at a BARE-threshold cosine do NOT durably supersede', () => {
    // The exact refuted scenario: 腾讯视频 vs 腾讯音乐 collide on blockKeyOf and embed just over the
    // 0.86 merge bar (say 0.88) — under the OLD gate (0.85) this membership PASSED and wrongly retired a
    // real claim. The bare-threshold cosine is now BELOW the raised bar, so it can't authorize a durable
    // retirement. (Winner is PROSE to isolate the confidence gate from the DEFECT-2 provenance branch.)
    expect(blockKeyOf('腾讯视频')).toBe(blockKeyOf('腾讯音乐')) // same block → they get compared/merged
    const bareCosine = 0.88 // in the 0.86–0.91 band: clears the merge bar, must NOT clear the apply bar
    expect(bareCosine).toBeGreaterThan(ENTITY_CLUSTER_THRESHOLD)
    expect(bareCosine).toBeLessThan(SUPERSEDE_MIN_CONFIDENCE)
    const older = claim({ id: 'o', subject: '腾讯视频', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, entityKey: '腾讯', entityKeyConfidence: bareCosine })
    const newer = claim({ id: 'n', subject: '腾讯音乐', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose', entityKey: '腾讯', entityKeyConfidence: bareCosine })
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('model') // detected as a proposal
    const res = applySupersessionGuards([older, newer])
    expect(res.applied).toBe(0)
    expect(res.blockedConfidence).toBe(1)
    expect(older.validTo).toBeNull() // the real claim is PRESERVED
    expect(older.verdict).toBe('current')
  })

  // ── DEFECT 2: cross-alias STRUCTURED↔STRUCTURED must stay a proposal, never durably retire ──────
  it('a cross-alias STRUCTURED↔STRUCTURED supersession is NOT applied (proposal-only) even at HIGH confidence', () => {
    // Two distinct real entities that collided in a block, BOTH structured, with STRONG membership
    // (0.95 ≥ the confidence bar) — confidence alone would let it through, but a structured cross-alias
    // block merge is the main false-loss vector, so it must remain a proposal surfaced for review.
    const older = claim({ id: 'o', subject: '腾讯视频', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, entityKey: '腾讯', entityKeyConfidence: 0.95 })
    const newer = claim({ id: 'n', subject: '腾讯音乐', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, entityKey: '腾讯', entityKeyConfidence: 0.95 }) // structured (default)
    const { corrections } = runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('model')
    expect(older.supersedeConfidence).toBeGreaterThan(DEFAULT_SUPERSESSION_GUARDS.minConfidence) // clears CONFIDENCE

    const res = applySupersessionGuards([older, newer])
    expect(res.applied).toBe(0)
    expect(res.blockedCrossAliasStructured).toBe(1) // refused by the DEFECT-2 provenance branch, not confidence
    expect(res.blockedConfidence).toBe(0)
    expect(older.validTo).toBeNull() // PRESERVED (durable retirement refused)
    expect(older.verdict).toBe('current')
    expect(corrections.some((c) => c.claimId === 'o')).toBe(true) // still SURFACED as a proposal for human review
  })

  it('a PROSE-winner cross-alias supersession still APPLIES durably when membership is strong', () => {
    // Same block collision, but the winner is PROSE (already confidence-bounded) and membership is
    // strong (0.95 ≥ bar) → this IS allowed to retire durably (the confidence-bounded path).
    const older = claim({ id: 'o', subject: 'Atlas project', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY, entityKey: 'Atlas', entityKeyConfidence: 0.95 })
    const newer = claim({ id: 'n', subject: 'Project Atlas', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY, source: 'prose', entityKey: 'Atlas', entityKeyConfidence: 0.95 })
    runVerdicts([older, newer], emptyWorld(), NOW)
    const res = applySupersessionGuards([older, newer])
    expect(res.applied).toBe(1)
    expect(older.verdictBy).toBe('supersession') // durable
    expect(older.validTo).toBe(NOW)
    expect(older.modelRetired).toBe(true)
  })

  it('an EXACT-same-subject STRUCTURED supersession still applies durably (unaffected by the cross-alias rules)', () => {
    // same-subject structured is deterministic (verdictBy 'supersession' straight from runVerdicts) — it
    // never becomes a model proposal, so the cross-alias guards don't touch it. Proves same-subject is
    // unaffected by DEFECT-2's cross-alias branch.
    const older = claim({ id: 'o', subject: '北澜', relation: 'status', object: 'a', observedAt: NOW - 10 * DAY })
    const newer = claim({ id: 'n', subject: '北澜', relation: 'status', object: 'b', observedAt: NOW - 1 * DAY }) // structured
    runVerdicts([older, newer], emptyWorld(), NOW)
    expect(older.verdictBy).toBe('supersession') // durable, deterministic
    const res = applySupersessionGuards([older, newer])
    expect(res.blockedCrossAliasStructured).toBe(0) // it was never a model proposal
    expect(older.validTo).not.toBeNull() // stays retired (durable)
    expect(older.verdictBy).toBe('supersession')
  })

  // ── DEFECT 3: cumulative per-entity retirement bound across ticks (slow-motion gutting) ──────────
  it('CUMULATIVE bound trips the slow 1-of-2-per-tick gutting a per-pass-only tripwire would miss', () => {
    // Each tick one differing PROSE value supersedes the current head — same subject, so every pass is
    // exactly 1 retire of 2 in-play. A per-pass-only tripwire computes 1/2 with inPlay 2 (< fractionFloor
    // 4) FOREVER and never trips → the entity is silently gutted over time. Counting prior model
    // retirements cumulatively catches it once the budget is exhausted.
    const claims: Claim[] = [claim({ id: 'c0', subject: 'E', relation: 'status', object: 'v0', observedAt: NOW - 100 * DAY, source: 'prose' })]
    const tick = (k: number) => {
      claims.push(claim({ id: `c${k}`, subject: 'E', relation: 'status', object: `v${k}`, observedAt: NOW - (100 - k) * DAY, source: 'prose' }))
      runVerdicts(claims, emptyWorld(), NOW)
      return applySupersessionGuards(claims)
    }
    const r1 = tick(1) // in-play 2, cumulative 1/2 → applies
    expect(r1.applied).toBe(1)
    const r2 = tick(2) // active 1 + prior-model-retired 1 + would 1 = 3 (< floor 4) → still applies
    expect(r2.applied).toBe(1)
    const r3 = tick(3) // active 1 + prior 2 + would 1 = 4 (≥ floor); cumulative 3/4 = 0.75 > 0.5 → TRIP
    expect(r3.applied).toBe(0)
    expect(r3.blockedTripwire).toBe(1)
    const c2 = claims.find((c) => c.id === 'c2')!
    expect(c2.validTo).toBeNull() // the would-be victim is PRESERVED (reverted to active)
    // count how many of E's claims are model-retired — bounded, NOT gutted
    const modelRetired = claims.filter((c) => c.modelRetired).length
    expect(modelRetired).toBe(2) // c0, c1 only — the cumulative cap held the line at tick 3
  })

  it('unretire frees an entity\'s cumulative model-retirement budget (reversibility)', () => {
    // A human un-retirement must give the budget back — otherwise a reversal wouldn't let new legitimate
    // supersessions through. Retire two, unretire one, and the cleared modelRetired flag is no longer counted.
    const c0 = claim({ id: 'c0', subject: 'E', relation: 'status', object: 'v0', observedAt: NOW - 100 * DAY, source: 'prose' })
    const c1 = claim({ id: 'c1', subject: 'E', relation: 'status', object: 'v1', observedAt: NOW - 99 * DAY, source: 'prose' })
    const all = [c0, c1]
    runVerdicts(all, emptyWorld(), NOW)
    applySupersessionGuards(all)
    expect(c0.modelRetired).toBe(true)
    unretire(c0)
    expect(c0.modelRetired).toBeUndefined() // budget freed
    expect(c0.validTo).toBeNull()
  })
})

describe('claim-metabolism — the "called by mistake" fix (mirrors metabolism_sim.py)', () => {
  it('a STALE claim with HIGHER similarity still scores below a CURRENT claim after verdicts', () => {
    // the false-positive trap: the stale claim is MORE embedding-similar to the query
    const stale = claim({ id: 'stale', subject: '北澜', relation: 'deadline', object: 'June', observedAt: NOW - 10 * DAY })
    const current = claim({ id: 'cur', subject: '北澜', relation: 'deadline', object: 'August', observedAt: NOW - 1 * DAY })
    runVerdicts([stale, current], emptyWorld(), NOW)
    const staleScore = retrievalScore(0.92, stale, NOW) // high similarity
    const currentScore = retrievalScore(0.70, current, NOW) // lower similarity
    expect(staleScore).toBeLessThan(currentScore) // similarity alone would rank stale first; the verdict flips it
  })
})

describe('claim-metabolism — relation cardinality (DEFECT 4)', () => {
  const active = (cs: Claim[]) => cs.filter((c) => c.validTo === null).map((c) => c.id).sort()

  it('a single note asserting TWO objects for one (subject,relation) retires neither', () => {
    // The live case this is built for: `TQ decided` carried 40 different objects, all true at once.
    const a = claim({ id: 'a', subject: 'TQ', relation: 'decided', object: 'adopt hot cache', notePath: 'daily/2026-08-01.md', observedAt: NOW - 3 * DAY })
    const b = claim({ id: 'b', subject: 'TQ', relation: 'decided', object: 'defer min-cut build', notePath: 'daily/2026-08-01.md', observedAt: NOW - 1 * DAY })
    runVerdicts([a, b], emptyWorld(), NOW)
    expect(active([a, b])).toEqual(['a', 'b'])
    expect(a.verdict).toBe('current')
  })

  it('the SAME pairing across different notes still coexists once one note has co-asserted it', () => {
    // Generalisation: one document proved `TQ decided` is multi-valued, so the whole group is spared —
    // otherwise 38 of the 40 live claims retire on the strength of arriving from separate files.
    const a = claim({ id: 'a', subject: 'TQ', relation: 'decided', object: 'x', notePath: 'n1.md', observedAt: NOW - 5 * DAY })
    const b = claim({ id: 'b', subject: 'TQ', relation: 'decided', object: 'y', notePath: 'n1.md', observedAt: NOW - 4 * DAY })
    const c = claim({ id: 'c', subject: 'TQ', relation: 'decided', object: 'z', notePath: 'n2.md', observedAt: NOW - 1 * DAY })
    runVerdicts([a, b, c], emptyWorld(), NOW)
    expect(active([a, b, c])).toEqual(['a', 'b', 'c'])
  })

  it('a FUNCTIONAL relation still supersedes — degree is not the discriminator', () => {
    // `status` accumulates many values over time precisely BECAUSE each replaces the last. No single
    // note co-asserts two, so nothing marks it multi-valued and the newest must still win.
    const s1 = claim({ id: 's1', subject: 'proj', relation: 'status', object: 'planned', notePath: 'a.md', observedAt: NOW - 9 * DAY })
    const s2 = claim({ id: 's2', subject: 'proj', relation: 'status', object: 'building', notePath: 'b.md', observedAt: NOW - 5 * DAY })
    const s3 = claim({ id: 's3', subject: 'proj', relation: 'status', object: 'shipped', notePath: 'c.md', observedAt: NOW - 1 * DAY })
    runVerdicts([s1, s2, s3], emptyWorld(), NOW)
    expect(active([s1, s2, s3])).toEqual(['s3'])
    expect(s1.verdict).toBe('contradicted')
    expect(s2.verdict).toBe('contradicted')
  })

  it('evidence survives the verdict — a RETIRED co-assertion still marks the pairing multi-valued', () => {
    // Non-circularity guard. If the scan read only ACTIVE claims, pass 1 would retire the co-asserted
    // pair, the evidence would vanish with it, and pass 2 would retire everything else.
    const dead = claim({ id: 'dead', subject: 'TQ', relation: 'decided', object: 'old-1', notePath: 'n1.md', validTo: NOW - 2 * DAY, verdict: 'contradicted' })
    const dead2 = claim({ id: 'dead2', subject: 'TQ', relation: 'decided', object: 'old-2', notePath: 'n1.md', validTo: NOW - 2 * DAY, verdict: 'contradicted' })
    const a = claim({ id: 'a', subject: 'TQ', relation: 'decided', object: 'new-1', notePath: 'n2.md', observedAt: NOW - 2 * DAY })
    const b = claim({ id: 'b', subject: 'TQ', relation: 'decided', object: 'new-2', notePath: 'n3.md', observedAt: NOW - 1 * DAY })
    expect(inferMultiValuedKeys([dead, dead2, a, b]).has(supersedeKey('TQ', 'decided'))).toBe(true)
    runVerdicts([dead, dead2, a, b], emptyWorld(), NOW)
    expect(active([dead, dead2, a, b])).toEqual(['a', 'b'])
  })

  it('inferMultiValuedKeys needs TWO DIFFERENT objects in ONE note, not merely two claims', () => {
    const same = [
      claim({ id: 'a', subject: 'S', relation: 'r', object: 'v', notePath: 'n.md' }),
      claim({ id: 'b', subject: 'S', relation: 'r', object: 'V', notePath: 'n.md' }) // same object, case-folded
    ]
    expect(inferMultiValuedKeys(same).size).toBe(0)
    const spread = [
      claim({ id: 'a', subject: 'S', relation: 'r', object: 'v1', notePath: 'n1.md' }),
      claim({ id: 'b', subject: 'S', relation: 'r', object: 'v2', notePath: 'n2.md' }) // different notes
    ]
    expect(inferMultiValuedKeys(spread).size).toBe(0)
  })

  it('DUIN_CLAIM_RELATION_CARDINALITY=0 restores the prior behaviour exactly', () => {
    const prev = process.env.DUIN_CLAIM_RELATION_CARDINALITY
    process.env.DUIN_CLAIM_RELATION_CARDINALITY = '0'
    try {
      expect(relationCardinalityEnabled()).toBe(false)
      const a = claim({ id: 'a', subject: 'TQ', relation: 'decided', object: 'x', notePath: 'n1.md', observedAt: NOW - 2 * DAY })
      const b = claim({ id: 'b', subject: 'TQ', relation: 'decided', object: 'y', notePath: 'n1.md', observedAt: NOW - 1 * DAY })
      runVerdicts([a, b], emptyWorld(), NOW)
      expect(active([a, b])).toEqual(['b'])
      expect(a.verdict).toBe('contradicted')
    } finally {
      if (prev === undefined) delete process.env.DUIN_CLAIM_RELATION_CARDINALITY
      else process.env.DUIN_CLAIM_RELATION_CARDINALITY = prev
    }
  })
})
