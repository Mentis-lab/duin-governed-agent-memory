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
  // P0 (W4): a verdict needs MIN_JURY_ANSWERS (2) answering jurors; seat two distinct families.
  resolveJury: () => [
    { task: 'jury', modelId: 'distinct-jury-model', provider: 'google', chain: ['distinct-jury-model'], source: 'policy' },
    { task: 'jury', modelId: 'distinct-jury-model-2', provider: 'xai', chain: ['distinct-jury-model-2'], source: 'policy' }
  ],
  getProviderForModel: (m: string) => (m === 'extractor-model' ? 'deepseek' : m === 'distinct-jury-model' ? 'google' : 'xai'),
  chatOnce: async () => ({ content: replyContent })
}))

const { defaultGovernJury } = await import('./operator-govern')
const prov = (id: string, fact: string): OperatorFact => ({ id, fact, kind: 'value', status: 'provisional', ts: 0 })

describe('defaultGovernJury — cross-model independence (items 4/15)', () => {
  it('routes to a distinct family and stamps crossModel:true with provenance', async () => {
    const r = await defaultGovernJury([prov('a', 'Truth over comfort')])
    expect(r.juryModelId).toBe('distinct-jury-model+distinct-jury-model-2')
    expect(r.juryProvider).toBe('google+xai')
    expect(r.crossModel).toBe(true) // deepseek extractor vs google/xai jury = genuinely independent
    expect(r.jury).toBe(2)
    expect(r.pass!.has('a')).toBe(true)
  })
})
