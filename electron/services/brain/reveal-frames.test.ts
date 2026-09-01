import { describe, it, expect } from 'vitest'
import { buildRevealFrames, runReveal, type GraphFrame } from './reveal-frames'
import type { ExtractionChat } from './construct-one-source'
import { edgeKey } from './edge-verdicts'
import type { ConstructedData } from './types'

const ROOT = { id: 'drop:pricing-strategy-memo.md', label: 'Pricing strategy memo', kind: 'note' }
const DATA: ConstructedData = {
  entities: [
    { id: 'topic:usage-based-pricing', kind: 'topic', label: 'usage-based pricing', note: ROOT.id },
    { id: 'person:jon-reyes', kind: 'person', label: 'Jon Reyes', note: ROOT.id }
  ],
  edges: [{ source: 'person:jon-reyes', target: 'topic:usage-based-pricing', type: 'mentions' }],
  classifications: [],
  triples: []
}

describe('buildRevealFrames (pure sequence)', () => {
  it('emits node-created first, then entities, then edges, then reveal-complete last', () => {
    const frames = buildRevealFrames(ROOT, DATA, [{ rawId: 'topic:usage-based', into: 'topic:usage-based-pricing' }])
    expect(frames[0]).toMatchObject({ op: 'node-created', id: ROOT.id })
    expect(frames[frames.length - 1]).toMatchObject({
      op: 'reveal-complete',
      counts: { entities: 2, edges: 1, merges: 1 }
    })
    const ops = frames.map((f) => f.op)
    expect(ops.indexOf('node-created')).toBeLessThan(ops.indexOf('entity-found'))
    expect(ops.lastIndexOf('entity-found')).toBeLessThan(ops.indexOf('link-formed'))
    expect(frames.filter((f) => f.op === 'entity-found')).toHaveLength(2)
    expect(frames.find((f) => f.op === 'entity-merged')).toMatchObject({ rawId: 'topic:usage-based', into: 'topic:usage-based-pricing' })
    expect(frames.find((f) => f.op === 'link-formed')).toMatchObject({ from: 'person:jon-reyes', to: 'topic:usage-based-pricing', edgeType: 'mentions', src: 'llm' })
  })
})

function fakeChat(json: unknown, finishReason: string | null = 'stop'): ExtractionChat {
  return async () => ({ text: JSON.stringify(json), finishReason })
}

describe('runReveal (live orchestration)', () => {
  it('emits the focal node BEFORE the extraction wave, then entities/edges, then reveal-complete', async () => {
    const frames: GraphFrame[] = []
    const r = await runReveal(
      { id: ROOT.id, text: 'usage-based pricing; Jon Reyes flagged the SLA.' },
      { emit: (f) => frames.push(f), chat: fakeChat(DATA), model: 'test-model', resolve: false, rootLabel: ROOT.label }
    )
    expect(r.status).toBe('built')
    const ops = frames.map((f) => f.op)
    expect(ops[0]).toBe('node-created')
    expect(ops.indexOf('node-created')).toBeLessThan(ops.indexOf('entity-found'))
    expect(ops[ops.length - 1]).toBe('reveal-complete')
    expect(frames.filter((f) => f.op === 'link-formed')).toHaveLength(1)
    expect(r.emitted).toBe(frames.length)
  })

  it('emits injected Wave-1 frames after the focal node and before the extraction wave', async () => {
    const frames: GraphFrame[] = []
    const wave1: GraphFrame[] = [{ type: 'graph', op: 'link-formed', from: ROOT.id, to: 'demo:note:pricing-research', edgeType: 'wiki', src: 'wiki' }]
    await runReveal(
      { id: ROOT.id, text: 'x' },
      { emit: (f) => frames.push(f), chat: fakeChat(DATA), model: 'test-model', resolve: false, wave1 }
    )
    const idxNode = frames.findIndex((f) => f.op === 'node-created')
    const idxWiki = frames.findIndex((f) => f.src === 'wiki')
    const idxEntity = frames.findIndex((f) => f.op === 'entity-found')
    expect(idxNode).toBeLessThan(idxWiki)
    expect(idxWiki).toBeLessThan(idxEntity)
  })

  it('still closes the reveal (focal node + reveal-complete) when extraction is key-gated off', async () => {
    const frames: GraphFrame[] = []
    const r = await runReveal({ id: ROOT.id, text: 'x' }, { emit: (f) => frames.push(f), model: null })
    expect(r.status).toBe('no-model')
    expect(frames.map((f) => f.op)).toEqual(['node-created', 'reveal-complete'])
  })

  it('does NOT re-propose an edge the operator already vetoed', async () => {
    const frames: GraphFrame[] = []
    const verdicts = new Map([[edgeKey('person:jon-reyes', 'topic:usage-based-pricing', 'mentions'), 'vetoed' as const]])
    await runReveal(
      { id: ROOT.id, text: 'x' },
      { emit: (f) => frames.push(f), chat: fakeChat(DATA), model: 'test-model', resolve: false, edgeVerdicts: verdicts }
    )
    expect(frames.filter((f) => f.op === 'link-formed')).toHaveLength(0)
    expect(frames.find((f) => f.op === 'reveal-complete')?.counts?.edges).toBe(0)
    // entities still surface — only the vetoed EDGE is suppressed
    expect(frames.filter((f) => f.op === 'entity-found')).toHaveLength(2)
  })
})
