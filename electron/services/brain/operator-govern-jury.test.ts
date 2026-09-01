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
  getProviderForModel: () => 'deepseek',
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
    expect(r.juryModelId).toBe('test-model') // item 15: provenance survives (mock: no distinct → fallback)
    expect(r.crossModel).toBe(false)
  })
})
