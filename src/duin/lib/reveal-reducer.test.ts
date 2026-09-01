import { describe, it, expect } from 'vitest'
import {
  initialRevealState,
  reduceFrame,
  applyEdgeVerdict,
  pendingEdgesFor,
  edgeKey,
  type GraphFrame,
  type RevealState
} from './reveal-reducer'

function feed(frames: GraphFrame[]): RevealState {
  let s = initialRevealState()
  let t = 0
  for (const f of frames) s = reduceFrame(s, f, (t += 100))
  return s
}

describe('reveal-reducer', () => {
  it('node-created sets the focal root; entity-found adds neighbours', () => {
    const s = feed([
      { type: 'graph', op: 'node-created', id: 'drop:x', label: 'Drop', kind: 'note' },
      { type: 'graph', op: 'entity-found', id: 'project:duin', label: 'DUIN', kind: 'project' }
    ])
    expect(s.rootId).toBe('drop:x')
    expect(s.nodes.get('drop:x')?.focal).toBe(true)
    expect(s.nodes.get('project:duin')?.focal).toBe(false)
    expect(s.nodes.get('drop:x')?.bornAt).toBeLessThan(s.nodes.get('project:duin')!.bornAt) // entrance order
  })

  it('link-formed adds a proposed edge carrying src/accept/confidence; dedups', () => {
    const s = feed([
      { type: 'graph', op: 'node-created', id: 'drop:x' },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'project:duin', edgeType: 'about', src: 'llm', accept: 'review', confidence: 0.6 },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'project:duin', edgeType: 'about', src: 'llm' } // dup
    ])
    expect(s.edges).toHaveLength(1)
    expect(s.edges[0]).toMatchObject({ state: 'proposed', src: 'llm', accept: 'review', confidence: 0.6 })
  })

  it('entity-merged drops the raw node and rewires its edges onto the canonical id', () => {
    const s = feed([
      { type: 'graph', op: 'node-created', id: 'drop:x' },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'concept:wdg', edgeType: 'mentions', src: 'llm' },
      { type: 'graph', op: 'entity-merged', rawId: 'concept:wdg', into: 'topic:walled-data-garden' }
    ])
    expect(s.nodes.has('concept:wdg')).toBe(false)
    expect(s.edges[0].to).toBe('topic:walled-data-garden')
  })

  it('reveal-complete flips complete + records counts', () => {
    const s = feed([{ type: 'graph', op: 'reveal-complete', counts: { entities: 3, edges: 2, merges: 1 } }])
    expect(s.complete).toBe(true)
    expect(s.counts).toEqual({ entities: 3, edges: 2, merges: 1 })
  })

  it('applyEdgeVerdict flips an edge to endorsed/vetoed (optimistic local update)', () => {
    let s = feed([
      { type: 'graph', op: 'node-created', id: 'drop:x' },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'a', edgeType: 'mentions', src: 'alias' }
    ])
    s = applyEdgeVerdict(s, 'drop:x', 'a', 'mentions', 'endorsed', 999)
    expect(s.edges[0].state).toBe('endorsed')
    expect(s.edges[0].stateAt).toBe(999)
  })

  it('pendingEdgesFor returns only proposed edges incident to the node', () => {
    let s = feed([
      { type: 'graph', op: 'node-created', id: 'drop:x' },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'a', edgeType: 'mentions', src: 'alias' },
      { type: 'graph', op: 'link-formed', from: 'drop:x', to: 'b', edgeType: 'about', src: 'llm' }
    ])
    s = applyEdgeVerdict(s, 'drop:x', 'a', 'mentions', 'endorsed', 1)
    const pend = pendingEdgesFor(s, 'drop:x')
    expect(pend).toHaveLength(1)
    expect(pend[0].to).toBe('b') // the endorsed one is no longer pending
  })

  it('edgeKey is direction-sensitive', () => {
    expect(edgeKey('a', 'b', 't')).not.toBe(edgeKey('b', 'a', 't'))
  })
})
