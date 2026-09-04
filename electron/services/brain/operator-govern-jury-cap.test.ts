// The govern jury's parse cap — a LIVE data-loss defect, not a hypothetical.
//
// `defaultGovernJury` reads a keep-list over the probation pool, and omission from that list means
// REVERT. It reused `parseOperatorFacts`, whose default cap of 8 exists for the EXTRACTION prompt. The
// live store held 14 provisional facts, so a jury reply endorsing all 14 was silently cut to 8 and the
// other 6 were reverted — on a correct reply, every pass, with no error surfaced. Eight facts were found
// already reverted with `reverts: 1`, five of them the operator's own vault principles.
//
// Reverting is not a soft signal: it drops the fact from grounding, bumps `reverts`, blocks re-linking
// via recordBoundRule, and marks the row evictable churn for permanent deletion at MAX_FACTS.
import { describe, it, expect, vi } from 'vitest'

const chatOnce = vi.fn()
vi.mock('../providers/registry', () => ({
  chatOnce: (...a: unknown[]) => chatOnce(...a),
  routeModel: () => 'test-model',
  routeDistinctModel: () => null,
  routeDistinctModels: () => [],
  // P0 (W4): MIN_JURY_ANSWERS (2) — two jurors, both answered by the chatOnce double above, so
  // the reply-parsing assertions below measure the parser and not the quorum.
  resolveJury: () => [
    { task: 'jury', modelId: 'jury-a', provider: 'prov-a', chain: ['jury-a'], source: 'policy' },
    { task: 'jury', modelId: 'jury-b', provider: 'prov-b', chain: ['jury-b'], source: 'policy' }
  ],
  getProviderForModel: () => 'test-provider'
}))
vi.mock('./operator-model', async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, listByStatus: () => [] } // no confirmed-rule context needed
})

import { defaultGovernJury } from './operator-govern'
import { parseOperatorFacts } from './operator-model'
import type { OperatorFact } from './operator-model'

const pool = (n: number): OperatorFact[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `f${i}`,
    // Sentence-length, matching the live store's provisional rows rather than toy strings.
    fact: `Operator principle ${i} that governs how work is reviewed and reported across workstreams`,
    kind: 'context',
    status: 'provisional' as const,
    ts: 1
  }))

describe('parseOperatorFacts — the cap is opt-in, not implicit', () => {
  const fourteen = Array.from({ length: 14 }, (_, i) => `Durable operator fact number ${i} about the work`)

  it('still caps at 8 by default (the extraction prompt says "max 8")', () => {
    expect(parseOperatorFacts(JSON.stringify(fourteen))).toHaveLength(8)
  })

  it('honors an explicit higher bound — callers whose omission is destructive must raise it', () => {
    expect(parseOperatorFacts(JSON.stringify(fourteen), 14)).toHaveLength(14)
  })
})

describe('defaultGovernJury — a complete reply must not revert anyone', () => {
  it('THE LIVE BUG: 14 provisional, jury endorses ALL 14 — every fact must pass', async () => {
    const provisional = pool(14)
    chatOnce.mockResolvedValue({ content: JSON.stringify(provisional.map((f) => f.fact)) })
    const r = await defaultGovernJury(provisional)
    expect(r.pass).not.toBeNull()
    expect(r.pass!.size).toBe(14) // was 8 before the fix — the other 6 were reverted
  })

  it('a genuine MINORITY rejection still reverts (the guard is not a kill-switch)', async () => {
    const provisional = pool(10)
    // Jury endorses 7 of 10 — a real, plausible rejection that must pass through untouched.
    chatOnce.mockResolvedValue({ content: JSON.stringify(provisional.slice(0, 7).map((f) => f.fact)) })
    const r = await defaultGovernJury(provisional)
    expect(r.pass).not.toBeNull()
    expect(r.pass!.size).toBe(7)
  })

  it('MASS-REVERT GUARD: a reply endorsing only a small prefix abstains rather than reverting most', async () => {
    const provisional = pool(14)
    // Indistinguishable from a model that answered about the first 3 and stopped.
    chatOnce.mockResolvedValue({ content: JSON.stringify(provisional.slice(0, 3).map((f) => f.fact)) })
    const r = await defaultGovernJury(provisional)
    expect(r.pass).toBeNull() // abstain — survival-based confirmation continues, nothing is reverted
  })

  it('a PARAPHRASED reply abstains instead of reverting the whole pool', async () => {
    const provisional = pool(12)
    // juryNorm only lowercases and strips trailing punctuation, so rewording defeats matching entirely.
    chatOnce.mockResolvedValue({
      content: JSON.stringify(provisional.map((f) => f.fact.replace('Operator principle', 'The rule')))
    })
    expect((await defaultGovernJury(provisional)).pass).toBeNull()
  })

  it('an empty / unparseable reply still abstains (pre-existing guard intact)', async () => {
    chatOnce.mockResolvedValue({ content: 'I cannot evaluate these.' })
    expect((await defaultGovernJury(pool(5))).pass).toBeNull()
  })

  it('a single-fact pool can still be rejected — the guard does not apply below 2', async () => {
    chatOnce.mockResolvedValue({ content: '["something else entirely that matches nothing"]' })
    const r = await defaultGovernJury(pool(1))
    expect(r.pass).not.toBeNull()
    expect(r.pass!.size).toBe(0) // a lone bad fact is still revertable
  })
})
