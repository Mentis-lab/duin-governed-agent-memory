import { describe, it, expect } from 'vitest'
import { graphSignature, hashString } from './graph-signature'

const node = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'n1',
  kind: 'card',
  label: 'Alpha',
  layer: 'vault',
  group: '02 Cards',
  tags: ['a', 'b'],
  declared: 1,
  date: '2026-08-19',
  mtime: 1_700_000_000,
  ...over
})

const g = (nodes: Record<string, unknown>[], links: Record<string, unknown>[] = []) => ({ nodes, links })

describe('graphSignature — every field that drives a repaint', () => {
  it('is stable for an identical graph', () => {
    expect(graphSignature(g([node()]))).toBe(graphSignature(g([node()])))
  })

  // One case per field. Each of these changes NOTHING about the node or link COUNT,
  // which is the only thing the original id-only signature could see.
  const fields: [string, Record<string, unknown>][] = [
    ['label', { label: 'Beta' }],
    ['kind', { kind: 'goal' }],
    ['layer', { layer: 'product' }],
    ['group', { group: '03 Projects' }],
    // Regression guard: `tags` IS on the served payload (brain-graph-native emits up to
    // 16 per node) even though state.ts's BrainNode type omits it. A pass that read the
    // type instead of the payload dropped this term and silently un-fixed tag edits.
    ['tags', { tags: ['a', 'c'] }],
    // `declared` decides the canvas fill; an inferred node becoming declared has to repaint.
    ['declared', { declared: 0 }],
    ['date', { date: '2026-08-20' }],
    ['mtime', { mtime: 1_700_000_001 }],
    ['id', { id: 'n2' }]
  ]
  for (const [name, over] of fields) {
    it(`changes when ${name} changes`, () => {
      expect(graphSignature(g([node(over)]))).not.toBe(graphSignature(g([node()])))
    })
  }

  it('changes when a link is added, retyped, or repointed', () => {
    const base = graphSignature(g([node()], [{ source: 'a', target: 'b', type: 'ref' }]))
    expect(graphSignature(g([node()], []))).not.toBe(base)
    expect(graphSignature(g([node()], [{ source: 'a', target: 'b', type: 'tag' }]))).not.toBe(base)
    expect(graphSignature(g([node()], [{ source: 'a', target: 'c', type: 'ref' }]))).not.toBe(base)
  })

  it('does not depend on node order — the route makes no ordering promise', () => {
    const a = node({ id: 'a' })
    const b = node({ id: 'b' })
    expect(graphSignature(g([a, b]))).toBe(graphSignature(g([b, a])))
  })

  it('tolerates a missing/empty graph and absent optional fields', () => {
    expect(graphSignature(null)).toBe('')
    expect(graphSignature(undefined)).toBe('')
    expect(graphSignature(g([]))).toBe('0.0.0.0')
    expect(() => graphSignature(g([{ id: 'bare' }]))).not.toThrow()
  })

  it('the two lanes are independent — lane b is not a scaled copy of lane a', () => {
    // The previous fold was `b += imul(h, K)`, and multiplication distributes over
    // addition mod 2^32, so b === imul(a, K) for EVERY input: the second lane carried
    // no information and the signature was 32 bits, not 64. Assert the relationship
    // does not hold, rather than asserting a specific mixing function.
    const K = 2654435761
    const sigs = [node({ id: 'x' }), node({ id: 'y' }), node({ id: 'z' })].map((n) =>
      graphSignature(g([n])).split('.')
    )
    const scaled = sigs.filter(([, , a, b]) => (Math.imul(Number(a), K) >>> 0) === Number(b))
    expect(scaled).toHaveLength(0)
  })
})

describe('hashString', () => {
  it('is deterministic and unsigned 32-bit', () => {
    const h = hashString('hello')
    expect(h).toBe(hashString('hello'))
    expect(h).toBeGreaterThanOrEqual(0)
    expect(h).toBeLessThanOrEqual(0xffffffff)
    expect(Number.isInteger(h)).toBe(true)
  })

  it('separates similar inputs', () => {
    expect(hashString('a|b')).not.toBe(hashString('a|c'))
  })
})
