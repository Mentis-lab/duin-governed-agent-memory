// verifyPool — the abstain-on-total-drop guard.
//
// verifyPool hard-deletes candidates the verifier does not echo back VERBATIM, with no bi-temporal
// tombstone. That makes a malformed, truncated, or fully-paraphrased model reply capable of silently
// destroying the entire candidate pool on a real vault — including the input consolidation is about to
// fold into DEPENDS_ON provenance. These tests pin the guard AND prove it did not disable legitimate
// pruning (a guard that just turns the feature off would "pass" the safety tests trivially).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const chatOnce = vi.fn()
vi.mock('../providers/registry', () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...a),
  routeModel: () => ({ id: 'test-model', provider: 'test' }),
  routeDistinctModel: () => null,
  routeDistinctModels: () => []
}))

import { setOperatorModelPath, recordFacts, listByStatus, verifyPool, getEvictionLog, promoteFact, confirmFact, vetoFact, supersedeFact, reflect, getAllOperatorFacts, __resetOperatorModel } from './operator-model'
import { setActiveDenylist } from '../governance/confidential-firewall'
import { REALISTIC_CANDIDATES, HOSTILE_MODEL_REPLIES } from './__fixtures__/realistic-store'

// Every fixture below is a MACHINE-extracted candidate (`source: 'machine'`): since human authority landed
// (operator-model isOperatorStated), verifyPool never prunes a fact the operator stated, so a candidate that
// must be prunable has to say a model wrote it. recordFacts' default source is 'operator'.
const CANDS = [
  'Operator uses VSCode as editor',
  'Operator ships releases on Fridays',
  'Operator prefers concise confirmations'
]

const reply = (facts: string[]): { content: string } => ({ content: JSON.stringify(facts) })

describe('verifyPool — abstain-on-total-drop (data-loss guard)', () => {
  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    recordFacts(CANDS.map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    expect(listByStatus('candidate')).toHaveLength(3) // fixture guard
  })

  it('an UNPARSEABLE reply preserves the pool instead of deleting all of it', async () => {
    chatOnce.mockResolvedValue({ content: 'I could not process that request.' })
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate')).toHaveLength(3)
  })

  it('an EMPTY array reply is an abstention, not "every candidate is bad"', async () => {
    chatOnce.mockResolvedValue(reply([]))
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate')).toHaveLength(3)
  })

  it('a fully PARAPHRASED reply (echoes nothing verbatim) preserves the pool', async () => {
    // The realistic failure: the verifier approves everything but rewords it, so norm-matching
    // recognizes none of it and the original code would have dropped all three.
    chatOnce.mockResolvedValue(reply(['Uses VS Code', 'Ships on Friday', 'Likes short confirmations']))
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate')).toHaveLength(3)
  })

  it('a THROWN provider error leaves the pool intact', async () => {
    chatOnce.mockRejectedValue(new Error('network'))
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate')).toHaveLength(3)
  })

  // The guard must not become a blanket disable — a partial prune is the feature working as intended.
  it('STILL PRUNES a genuine partial rejection (guard is not a feature kill-switch)', async () => {
    chatOnce.mockResolvedValue(reply([CANDS[0], CANDS[2]]))
    const r = await verifyPool()
    expect(r.dropped).toBe(1)
    expect(r.kept).toBe(2)
    const left = listByStatus('candidate').map((f) => f.fact)
    expect(left).toHaveLength(2)
    expect(left).not.toContain(CANDS[1])
  })

  it('keeps the whole pool when the verifier approves everything verbatim', async () => {
    chatOnce.mockResolvedValue(reply([...CANDS]))
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate')).toHaveLength(3)
  })
})

// The toy fixtures above understate the risk. The live candidate pool is six sentences of 81-162 chars,
// which is what `verifyPool` asks a model to reproduce VERBATIM under exact normalized matching. These
// run the guard against that real shape and against every hostile reply shape a provider can emit.
describe('verifyPool — realistic pool shape (lengths derived from the live store)', () => {
  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp2-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    recordFacts(REALISTIC_CANDIDATES.map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    expect(listByStatus('candidate').length).toBe(REALISTIC_CANDIDATES.length)
  })

  it.each(HOSTILE_MODEL_REPLIES)('survives a $label reply without emptying the pool', async ({ content }) => {
    chatOnce.mockResolvedValue({ content })
    const before = listByStatus('candidate').length
    await verifyPool()
    expect(listByStatus('candidate').length).toBeGreaterThan(0) // never total loss
    expect(listByStatus('candidate').length).toBeLessThanOrEqual(before)
  })

  it('a verifier that TRUNCATES the last sentence keeps the rest — partial reply is not total loss', async () => {
    const kept = REALISTIC_CANDIDATES.slice(0, 5)
    chatOnce.mockResolvedValue({ content: JSON.stringify([...kept, REALISTIC_CANDIDATES[5].slice(0, 40)]) })
    await verifyPool()
    expect(listByStatus('candidate').length).toBe(5) // the truncated one is pruned; the other five survive
  })

  it('a reply that paraphrases EVERY long candidate preserves the whole pool', async () => {
    // The realistic failure at this length: the verifier approves all six but rewords them, so exact
    // matching recognizes none. Without the guard this is a six-fact deletion.
    chatOnce.mockResolvedValue({ content: JSON.stringify(REALISTIC_CANDIDATES.map((c) => c.replace('Operator ', 'The operator ').slice(0, 60))) })
    await verifyPool()
    expect(listByStatus('candidate').length).toBe(REALISTIC_CANDIDATES.length)
  })
})

// The fixtures above are 3 and 6 candidates — both UNDER parseOperatorFacts' default max=8, so nothing
// exercised the cap boundary. verifyPool inherited that default while its own semantics make omission
// from the keep-set mean HARD DELETE, so a pool larger than 8 lost everything past the 8th even on a
// PERFECT reply. The abstain-on-total-drop guard cannot catch it: exactly 8 always survive, so
// dropIds.size === cands.length is unreachable. Total failure was guarded; partial was not.
// (Twin of the already-fixed govern-jury cap, operator-govern.ts — verifyPool was the one call site
// still skipping the bound.) Pool sizes >8 are ordinary: recordFacts admits up to 8 LLM facts per turn
// plus keyless ones, and candidates only exit via human promotion/veto or cap eviction at MAX_FACTS=300.
const POOL_14 = Array.from({ length: 14 }, (_, i) => `Operator prefers deployment checklist step ${i + 1} to be reviewed before release`)

describe('verifyPool — pool larger than the parser default cap (partial-truncation data loss)', () => {
  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp3-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    recordFacts(POOL_14.map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    expect(listByStatus('candidate')).toHaveLength(14) // fixture guard: above the max=8 boundary
  })

  it('keeps ALL 14 when the verifier approves all 14 verbatim (was: silently deleted 6)', async () => {
    const pool = listByStatus('candidate').map((f) => f.fact)
    chatOnce.mockResolvedValue(reply(pool))
    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(r.kept).toBe(14)
    expect(listByStatus('candidate')).toHaveLength(14)
    // and specifically the ones past the 8th, which the cap used to truncate away
    const left = new Set(listByStatus('candidate').map((f) => f.fact))
    for (const fact of pool) expect(left.has(fact)).toBe(true)
  })

  it('still prunes a genuine partial rejection in an above-cap pool (not a kill-switch)', async () => {
    const pool = listByStatus('candidate').map((f) => f.fact)
    const approved = pool.filter((_, i) => i !== 3 && i !== 11) // reject two, including one past the cap
    chatOnce.mockResolvedValue(reply(approved))
    const r = await verifyPool()
    expect(r.dropped).toBe(2)
    expect(r.kept).toBe(12)
    const left = listByStatus('candidate').map((f) => f.fact)
    expect(left).not.toContain(pool[3])
    expect(left).not.toContain(pool[11])
  })

  it('TOMBSTONES every pruned fact into the eviction ledger, stamped verify-pool', async () => {
    const pool = listByStatus('candidate').map((f) => f.fact)
    chatOnce.mockResolvedValue(reply(pool.filter((_, i) => i !== 3)))
    await verifyPool()
    const log = getEvictionLog()
    const rec = log.find((e) => e.fact === pool[3])
    expect(rec).toBeDefined() // the drop is traceable, not a bare filter
    expect(rec?.at).toBe('verify-pool')
    expect(rec?.status).toBe('candidate')
    expect(rec?.evictedAt).toBeGreaterThan(0)
  })
})

// verifyPool snapshots the candidate pool BEFORE a seconds-long `await chatOnce`, then deletes by that
// stale snapshot. learnFromTurn fires it as `void verifyPool()` on every capturing turn, so the await
// window overlaps live UI: the operator can promote or veto in the govern panel while it is open
// (ipcMain.handle('operator:promote'/'operator:veto') → promoteFact/vetoFact, same event loop). Those
// mutate the row IN PLACE, so its id still sits in dropIds and the hard-delete used to destroy a verdict
// a human had just given. Deleting a VETO is the sharp edge: veto memory lives only in `store` (the
// tombstone goes to `evictions`, which recordFacts' dedup never consults), so the rejected fact could be
// re-captured and re-grounded on the next turn. Nothing single-threaded can catch this — the tests below
// hold the model reply open and act inside the window.
describe('verifyPool — a human verdict landing DURING the model await is not clobbered', () => {
  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp4-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    recordFacts(CANDS.map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    expect(listByStatus('candidate')).toHaveLength(3) // fixture guard
  })

  /** Suspend verifyPool at its `await chatOnce`, run `during` (the human's click), then let the
   *  verifier answer. verifyPool runs synchronously up to the chatOnce call, so by the time this
   *  returns the stale snapshot is already taken and the function is parked on the await. */
  const raceAgainstVerifier = async (during: () => void, keep: string[]): Promise<void> => {
    let release!: (v: { content: string }) => void
    chatOnce.mockImplementation(() => new Promise((res) => { release = res }))
    const pending = verifyPool()
    during()
    release(reply(keep))
    await pending
  }

  it('a VETO during the await survives — the fact is not hard-deleted and veto memory is kept', async () => {
    const vetoed = listByStatus('candidate').find((f) => f.fact === CANDS[1])!
    // Verifier keeps only CANDS[0], so both CANDS[1] (just vetoed) and CANDS[2] are in dropIds.
    await raceAgainstVerifier(() => vetoFact(vetoed.id), [CANDS[0]])

    const vetoes = listByStatus('vetoed')
    expect(vetoes).toHaveLength(1) // was 0: the row was deleted out from under the human
    expect(vetoes[0].fact).toBe(CANDS[1])
    // and the veto is still in `store`, which is the ONLY place recordFacts' dedup looks — so the
    // rejected fact cannot be silently re-learned on the next turn.
    expect(vetoes[0].id).toBe(vetoed.id)
  })

  it('a PROMOTE during the await survives — the endorsed fact stays on probation', async () => {
    const promoted = listByStatus('candidate').find((f) => f.fact === CANDS[1])!
    await raceAgainstVerifier(() => promoteFact(promoted.id), [CANDS[0]])

    const prov = listByStatus('provisional')
    expect(prov).toHaveLength(1) // was 0: the human's endorsement was deleted
    expect(prov[0].fact).toBe(CANDS[1])
  })

  it('still prunes the untouched candidate, and reports what it ACTUALLY removed', async () => {
    // The race guard must not become a blanket disable: CANDS[2] was never touched by the human and
    // the verifier rejected it, so it must still go — and {kept,dropped} must count the real deletion
    // (1), not the two ids the stale snapshot nominated.
    const vetoed = listByStatus('candidate').find((f) => f.fact === CANDS[1])!
    let release!: (v: { content: string }) => void
    chatOnce.mockImplementation(() => new Promise((res) => { release = res }))
    const pending = verifyPool()
    vetoFact(vetoed.id)
    release(reply([CANDS[0]]))
    const r = await pending

    expect(r.dropped).toBe(1)
    expect(r.kept).toBe(2)
    const left = listByStatus('candidate').map((f) => f.fact)
    expect(left).toEqual([CANDS[0]])
    // the genuine prune is still traceable
    expect(getEvictionLog().find((e) => e.fact === CANDS[2])?.at).toBe('verify-pool')
    // and the vetoed fact was NOT tombstoned — it was never removed at all
    expect(getEvictionLog().find((e) => e.fact === CANDS[1])).toBeUndefined()
  })
})

// verifyPool is an AUTONOMOUS background send: learnFromTurn fires it on every capturing turn, and an
// inbound channel message reaches the same path (server.ts calls learnFromTurn on a de-privileged turn),
// so a third party can trigger it. That is exactly the class confidential-firewall.ts declares a HARD
// block for — "content on a confidential lane must NEVER reach an external model ... any cloud call the
// operator didn't explicitly drive". It shipped every promoted rule and every candidate fact verbatim to
// routeModel('extraction') with no filter, while its sibling over the SAME two lists (operator-govern's
// runGovernPass + defaultGovernJury) redacted them. That asymmetry is what made the leak invisible:
// every surface that REPORTS firewall activity — the govern jury, judgment-measure-live — filtered the
// same rows, so the firewall looked like it was working.
//
// The withheld half must ABSTAIN, not merely drop out of the payload: omission from this keep-list means
// HARD DELETE, so filtering the text alone would have deleted every confidential candidate on pass one.
describe('verifyPool — confidential-lane firewall (autonomous egress)', () => {
  const CLEAR = ['Operator uses VSCode as editor', 'Operator ships releases on Fridays']
  const SECRET_CAND = 'Operator tracks the acme-secret rollout on a private board'
  const SECRET_RULE = 'Never mention acme-secret outside the vault'
  const CLEAR_RULE = 'Operator prefers concise confirmations'
  /** Everything verifyPool actually put on the wire. */
  const sentText = (): string =>
    (chatOnce.mock.calls[0]?.[0] as { content: string }[]).map((m) => m.content).join('\n')

  const promotedRule = (fact: string): void => {
    recordFacts([{ fact, kind: 'value', source: 'machine' }])
    const id = listByStatus('candidate').find((f) => f.fact === fact)!.id
    promoteFact(id) // → provisional
    confirmFact(id) // → promoted (the govern loop's CONFIRM)
  }

  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp5-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    // Pin the ACTIVE lane rather than depending on whatever vault the host machine has configured —
    // the shipped default denylist is deliberately EMPTY (cold-start A3).
    setActiveDenylist(['acme-secret'])
  })
  afterEach(() => setActiveDenylist(null))

  it('never puts a confidential rule or candidate on the wire', async () => {
    promotedRule(CLEAR_RULE)
    promotedRule(SECRET_RULE)
    recordFacts([...CLEAR, SECRET_CAND].map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    chatOnce.mockResolvedValue(reply(CLEAR))

    await verifyPool()
    const wire = sentText()
    expect(wire).not.toContain('acme-secret') // neither half leaked
    expect(wire).toContain(CLEAR_RULE) // and the clear corpus still went, so this is a filter, not an off-switch
    expect(wire).toContain(CLEAR[0])
    expect(wire).toContain(CLEAR[1])
  })

  it('a withheld candidate ABSTAINS — absent from the keep-list is not a verdict against it', async () => {
    recordFacts([...CLEAR, SECRET_CAND].map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    chatOnce.mockResolvedValue(reply(CLEAR)) // the verifier can only echo what it was shown

    const r = await verifyPool()
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate').map((f) => f.fact)).toContain(SECRET_CAND)
    expect(getEvictionLog().find((e) => e.fact === SECRET_CAND)).toBeUndefined()
  })

  it('still prunes a genuinely rejected CLEAR candidate (the firewall is not a kill-switch)', async () => {
    recordFacts([...CLEAR, SECRET_CAND].map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    chatOnce.mockResolvedValue(reply([CLEAR[0]]))

    const r = await verifyPool()
    expect(r.dropped).toBe(1)
    expect(r.kept).toBe(2) // the survivor plus the withheld one
    const left = listByStatus('candidate').map((f) => f.fact)
    expect(left).not.toContain(CLEAR[1])
    expect(left).toContain(SECRET_CAND)
    expect(getEvictionLog().find((e) => e.fact === CLEAR[1])?.at).toBe('verify-pool')
  })

  it('an entirely confidential pool opens no external call at all', async () => {
    promotedRule(SECRET_RULE)
    recordFacts([{ fact: SECRET_CAND, kind: 'context', source: 'machine' }])

    const r = await verifyPool()
    expect(chatOnce).not.toHaveBeenCalled() // not even the rules go out alone
    expect(r).toEqual({ kept: 1, dropped: 0 })
    expect(listByStatus('candidate')).toHaveLength(1)
  })
})

// verifyPool built BOTH halves of its payload with `listByStatus`, which filters on status alone — but
// every semantic retirement here (supersedeFact, reflect, cascadeInvalidateDerived) is a SOFT delete that
// stamps `invalidatedAt` and leaves `status` untouched. So a bitemporally-retired row stayed in the
// payload forever, and the promoted half shipped it under the literal header `RULES (confirmed)`.
// VERIFY_SYSTEM tells the model to drop candidates that "do NOT contradict a confirmed rule", and
// supersedeFact mints the operator's REPLACEMENT as a candidate — so the correction that retired the rule
// was the exact thing the dead rule got the verifier to reject, and omission from this keep-list means
// HARD DELETE. What made it invisible: a retired row disappears from grounding and from the review queue
// the instant it is retired (buildOperatorBlock's `active` helper applies the missing predicate), so on
// every surface an operator can watch, the correction looks like it landed.
describe('verifyPool — bitemporally-retired rows are not part of the corpus', () => {
  const OLD_EDITOR = 'Operator uses VSCode as editor'
  const NEW_EDITOR = 'Operator uses Neovim as editor'
  const BYSTANDER = 'Operator ships releases on Fridays'

  const sentText = (): string =>
    (chatOnce.mock.calls[0]?.[0] as { content: string }[]).map((m) => m.content).join('\n')

  const promotedRule = (fact: string): string => {
    recordFacts([{ fact, kind: 'value', source: 'machine' }])
    const id = listByStatus('candidate').find((f) => f.fact === fact)!.id
    promoteFact(id) // → provisional
    confirmFact(id) // → promoted (the govern loop's CONFIRM)
    return id
  }

  /** A verifier that actually OBEYS VERIFY_SYSTEM: it echoes back every candidate it was shown, minus
   *  any that contradicts a rule in the `RULES (confirmed)` block it was handed. */
  const obedientVerifier = (): void => {
    chatOnce.mockImplementation((msgs: { role: string; content: string }[]) => {
      const [rulesBlock, candBlock] = msgs.find((m) => m.role === 'user')!.content.split('\n\nCANDIDATES:\n')
      const shown = candBlock.split('\n').filter(Boolean)
      const kept = rulesBlock.includes('VSCode') ? shown.filter((c) => !c.includes('Neovim')) : shown
      return Promise.resolve({ content: JSON.stringify(kept) })
    })
  }

  beforeEach(() => {
    setOperatorModelPath(join(mkdtempSync(join(tmpdir(), 'duin-vp6-')), 'operator-model.json'))
    __resetOperatorModel()
    chatOnce.mockReset()
    setActiveDenylist([]) // pin the lane: this suite is about liveness, not the firewall
  })
  afterEach(() => setActiveDenylist(null))

  it('a superseded PROMOTED rule is not shipped as a confirmed rule', async () => {
    const oldId = promotedRule(OLD_EDITOR)
    recordFacts([{ fact: BYSTANDER, kind: 'context', source: 'machine' }])
    expect(supersedeFact(oldId, NEW_EDITOR).superseded).toBe(true)
    chatOnce.mockResolvedValue(reply([NEW_EDITOR, BYSTANDER]))

    await verifyPool()
    // The row still exists for audit, and still carries status 'promoted' — which is exactly why the
    // status-only read kept believing it.
    const retired = getAllOperatorFacts().find((f) => f.fact === OLD_EDITOR)!
    expect(retired.status).toBe('promoted')
    expect(retired.invalidatedAt).toBeGreaterThan(0)
    expect(sentText()).not.toContain('VSCode') // ...but the verifier is never told it is confirmed
    expect(sentText()).toContain(NEW_EDITOR) // and the live corpus still goes: a filter, not an off-switch
  })

  it('the operator CORRECTION that retired the rule is not deleted by the rule it retired', async () => {
    const oldId = promotedRule(OLD_EDITOR)
    recordFacts([{ fact: BYSTANDER, kind: 'context', source: 'machine' }])
    expect(supersedeFact(oldId, NEW_EDITOR).superseded).toBe(true)
    obedientVerifier()

    const r = await verifyPool()
    // Was: the dead "uses VSCode" rule went out as confirmed, the verifier dropped the contradicting
    // Neovim candidate, BYSTANDER's survival kept the abstain-on-total-drop guard from firing, and the
    // replacement was hard-deleted — leaving DUIN knowing nothing at all about the operator's editor.
    expect(listByStatus('candidate').map((f) => f.fact)).toContain(NEW_EDITOR)
    expect(getEvictionLog().find((e) => e.fact === NEW_EDITOR)).toBeUndefined()
    expect(r.dropped).toBe(0)
  })

  it('a reflect()-merged candidate is neither shipped nor counted toward the abstain guard', async () => {
    // reflect() retires the subsumed row the same soft way: invalidatedAt set, status still 'candidate'.
    const MERGED = 'Operator reviews PRs'
    const RICHER = 'Operator reviews PRs from Ana only'
    recordFacts([MERGED, RICHER, BYSTANDER].map((fact) => ({ fact, kind: 'context', source: 'machine' as const })))
    expect(reflect()).toBe(1)
    const merged = getAllOperatorFacts().find((f) => f.fact === MERGED)!
    expect(merged.status).toBe('candidate') // soft-deleted: status untouched, which is the whole trap
    expect(merged.invalidatedAt).toBeGreaterThan(0)

    // The verifier keeps ONLY the retired row and rejects 100% of the LIVE pool. That has to abstain —
    // but the retired row inflated `sendable.length` while being un-deletable (`doomed` re-checks
    // liveness), so `dropIds.size === sendable.length` was unreachable and both live candidates were
    // hard-deleted instead.
    chatOnce.mockResolvedValue(reply([MERGED]))
    const r = await verifyPool()

    const shown = sentText().split('\n\nCANDIDATES:\n')[1].split('\n').filter(Boolean)
    expect(shown).not.toContain(MERGED) // the retired row never went on the wire...
    expect(shown.sort()).toEqual([RICHER, BYSTANDER].sort()) // ...and the live pool still did
    expect(r.dropped).toBe(0)
    expect(listByStatus('candidate').filter((f) => f.invalidatedAt == null).map((f) => f.fact).sort())
      .toEqual([RICHER, BYSTANDER].sort())
  })
})
