import { describe, it, expect, vi } from 'vitest'
import type { OperatorFact } from './operator-model'

// Proves item 4's core independence claim actually fires: when a genuinely distinct provider family
// is available, defaultGovernJury routes the jury to it and stamps crossModel:true (the jury-guard
// test hard-mocks routeDistinctModel→null, so it only ever exercises the same-model fallback).
const replyContent = '["Truth over comfort"]'
vi.mock('../providers/registry', () => ({
  routeModel: () => 'extractor-model',
  // One distinct family IS available. A one-model panel keeps the provenance string bare, so these
  // assertions read the same as they did before the jury became a panel.
  routeDistinctModels: () => ['distinct-jury-model'],
  getProviderForModel: (m: string) => (m === 'extractor-model' ? 'deepseek' : 'google'),
  chatOnce: async () => ({ content: replyContent })
}))

const { defaultGovernJury } = await import('./operator-govern')
const prov = (id: string, fact: string): OperatorFact => ({ id, fact, kind: 'value', status: 'provisional', ts: 0 })

describe('defaultGovernJury — cross-model independence (items 4/15)', () => {
  it('routes to a distinct family and stamps crossModel:true with provenance', async () => {
    const r = await defaultGovernJury([prov('a', 'Truth over comfort')])
    expect(r.juryModelId).toBe('distinct-jury-model')
    expect(r.juryProvider).toBe('google')
    expect(r.crossModel).toBe(true) // deepseek extractor vs google jury = genuinely independent
    expect(r.pass!.has('a')).toBe(true)
  })
})
