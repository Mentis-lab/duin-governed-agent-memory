import { describe, it, expect, vi } from 'vitest'
import type { OperatorFact } from './operator-model'

// The mass-revert bug fix: defaultGovernJury must ABSTAIN (null) on a malformed/unparseable reply,
// never return an empty Set — an empty Set makes every provisional fact juryPass=false → all revert.
// parseOperatorFacts is JSON-array-based, so a reply with no valid array parses to [].

let replyContent = ''
vi.mock('../providers/registry', () => ({
  routeModel: () => 'test-model',
  routeDistinctModel: () => null,
  routeDistinctModels: () => [],
  // P0 model plane (W4): the panel is seated by resolveJury from distinct HEALTHY providers and
  // needs MIN_JURY_ANSWERS (2) answers to stand. Two jurors, both returning the same reply, so
  // these parse-guard assertions measure the reply handling and not the quorum.
  resolveJury: () => [
    { task: 'jury', modelId: 'jury-a', provider: 'openai', chain: ['jury-a'], source: 'policy' },
    { task: 'jury', modelId: 'jury-b', provider: 'google', chain: ['jury-b'], source: 'policy' }
  ],
  getProviderForModel: (m: string) => (m === 'test-model' ? 'deepseek' : m === 'jury-a' ? 'openai' : 'google'),
  chatOnce: async () => ({ content: replyContent })
}))

const { defaultGovernJury } = await import('./operator-govern')

const prov = (id: string, fact: string): OperatorFact => ({ id, fact, kind: 'value', status: 'provisional', ts: 0 })

describe('defaultGovernJury — parse-miss guard (mass-revert bug)', () => {
  const pool = [prov('a', 'Truth over comfort'), prov('b', 'Compound not polish')]

  it('a malformed reply (no JSON array) → null (abstain), NOT an empty set', async () => {
    replyContent = 'Sorry, I cannot help with that request.'
    expect((await defaultGovernJury(pool)).pass).toBeNull()
  })

  it('a broken-JSON reply → null', async () => {
    replyContent = 'here you go: [ "Truth over comfort", ' // truncated / invalid
    expect((await defaultGovernJury(pool)).pass).toBeNull()
  })

  it('an explicit empty array (jury passes none) → null (holds, does not mass-revert)', async () => {
    replyContent = '[]'
    expect((await defaultGovernJury(pool)).pass).toBeNull()
  })

  it('a VALID reply still passes the named facts (revert still works per-fact)', async () => {
    replyContent = '["Truth over comfort"]' // b omitted → b will revert, a passes
    const r = await defaultGovernJury(pool)
    expect(r.pass).not.toBeNull()
    expect(r.pass!.has('a')).toBe(true)
    expect(r.pass!.has('b')).toBe(false)
    expect(r.juryModelId).toBe('jury-a+jury-b') // item 15: provenance survives — the seated panel
    expect(r.crossModel).toBe(true) // neither juror is the deepseek extractor
    expect(r.jury).toBe(2) // W4: the count of jurors that ANSWERED, never the roster
  })
})
