import { describe, it, expect } from 'vitest'
import { buildGenerativePrompt, parseGenerativeInsights } from './insights'
import type { Store } from './store'
import type { CausalNode, CausalEdge } from './types'

function makeStore(nodes: CausalNode[], edges: CausalEdge[], today = '2026-01-10'): Store {
  return {
    causalNodes: () => nodes.map((n) => ({ ...n })),
    causalEdges: () => edges.map((e) => ({ ...e })),
    today: () => today
  }
}

describe('parseGenerativeInsights', () => {
  it('parses a clean JSON object into generative-flagged insights', () => {
    const out = parseGenerativeInsights(
      '{"insights":[{"type":"opportunity","headline":"Bundle the two launches","why":"They share an audience.","confidence":0.8}]}'
    )
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('opportunity')
    expect(out[0].headline).toBe('Bundle the two launches')
    expect(out[0].generative).toBe(true)
    expect(out[0].confidence).toBeCloseTo(0.8)
  })

  it('tolerates a code fence and leading prose', () => {
    const out = parseGenerativeInsights(
      'Sure! Here you go:\n```json\n{"insights":[{"headline":"Sequence the hires","why":"One unblocks the other."}]}\n```'
    )
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('insight') // defaults to insight when type omitted
    expect(out[0].headline).toBe('Sequence the hires')
  })

  it('drops malformed items, clamps confidence, and caps at 3', () => {
    const out = parseGenerativeInsights(
      JSON.stringify({
        insights: [
          { type: 'insight', headline: 'A', why: 'ok', confidence: 5 }, // clamp → 1
          { type: 'insight', headline: 'B' }, // no why → dropped
          { type: 'insight', why: 'no headline' }, // no headline → dropped
          { type: 'opportunity', headline: 'C', why: 'ok' },
          { type: 'opportunity', headline: 'D', why: 'ok' },
          { type: 'opportunity', headline: 'E', why: 'ok' }
        ]
      })
    )
    expect(out.length).toBeLessThanOrEqual(3)
    expect(out[0].confidence).toBe(1)
    expect(out.every((i) => i.headline && i.why)).toBe(true)
  })

  it('returns [] on empty or non-JSON input', () => {
    expect(parseGenerativeInsights('')).toEqual([])
    expect(parseGenerativeInsights('no json here')).toEqual([])
    expect(parseGenerativeInsights('{"insights":"not-an-array"}')).toEqual([])
  })

  // Phase 0.3 — the SAME idea must keep its id across regenerations so a user dismiss
  // sticks. The old `gen::${i}::${headline}` id churned on index + reworded headline,
  // so a dismissed insight returned under a fresh id and reappeared. Content-hash ids fix it.
  it('gives the same idea a STABLE id regardless of array position (dismiss-persistence)', () => {
    const a = parseGenerativeInsights('{"insights":[{"headline":"Bundle launches","why":"shared audience"}]}')
    // same idea, now at index 1 behind a different insight
    const b = parseGenerativeInsights(
      '{"insights":[{"headline":"Hire a PM","why":"ops load"},{"headline":"Bundle launches","why":"shared audience"}]}'
    )
    const bundleA = a.find((i) => i.headline === 'Bundle launches')
    const bundleB = b.find((i) => i.headline === 'Bundle launches')
    expect(bundleA?.id).toBeTruthy()
    expect(bundleB?.id).toBe(bundleA?.id) // stable across position + reordering
  })

  it('normalizes case/whitespace so cosmetic rewordings keep the same id', () => {
    const a = parseGenerativeInsights('{"insights":[{"headline":"Ship the beta","why":"momentum"}]}')
    const b = parseGenerativeInsights('{"insights":[{"headline":"  ship   the beta ","why":"MOMENTUM"}]}')
    expect(b[0].id).toBe(a[0].id)
  })

  it('gives genuinely different ideas different ids', () => {
    const out = parseGenerativeInsights(
      '{"insights":[{"headline":"Bundle launches","why":"shared audience"},{"headline":"Hire a PM","why":"ops load"}]}'
    )
    expect(out[0].id).not.toBe(out[1].id)
  })
})

describe('buildGenerativePrompt', () => {
  it('grounds the prompt in analytical findings and tells the model not to repeat them', () => {
    const store = makeStore(
      [
        { id: 'a', kind: 'driver', label: 'A', track: 'x' },
        { id: 'b', kind: 'stream', label: 'B', track: 'x' },
        { id: 'hub', kind: 'anchor', label: 'Hub', track: 'x' }
      ],
      [
        { source: 'a', target: 'hub', type: 'feeds' },
        { source: 'b', target: 'hub', type: 'builds_toward' }
      ]
    )
    const analytical = [
      { id: 'conv::hub', type: 'tension' as const, headline: 'Hub is a convergence point', why: 'paths funnel in', sources: ['hub'], confidence: 0.7 }
    ]
    const prompt = buildGenerativePrompt(analytical, [{ label: 'Product', risks: 2, due_soon: 1 }], [{ title: 'X slips', due: '2026-08' }])
    expect(prompt).toContain('ANALYTICAL INSIGHTS (do not repeat)')
    expect(prompt).toContain('Hub is a convergence point')
    expect(prompt).toContain('JSON object')
  })
})
