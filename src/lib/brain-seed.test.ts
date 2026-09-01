import { describe, it, expect } from 'vitest'
import { buildSeed } from './brain-seed'

describe('buildSeed', () => {
  it('returns an empty graph when no answers are given', () => {
    const g = buildSeed({ working: '', deciding: '', worried: '' })
    expect(g.nodes).toHaveLength(0)
    expect(g.edges).toHaveLength(0)
  })

  it('builds streams + a fork gate (with decide_by) + risks toward a focus anchor', () => {
    const g = buildSeed({
      working: 'Ship v1\nHire a designer',
      deciding: 'Open the public beta in March?',
      worried: 'Vendor SLA'
    })

    const focus = g.nodes.find((n) => n.id === 'seed:focus')
    expect(focus?.kind).toBe('anchor')

    const streams = g.nodes.filter((n) => n.kind === 'stream')
    expect(streams).toHaveLength(2)

    const gate = g.nodes.find((n) => n.kind === 'gate')
    expect(gate?.decide_by).toBeTruthy() // drives a decision-window risk
    expect(gate?.fork).toBeTruthy()

    expect(g.nodes.some((n) => n.kind === 'risk')).toBe(true)

    // work streams build toward the focus anchor
    expect(g.edges.some((e) => e.source === 'seed:work:0' && e.target === 'seed:focus')).toBe(true)
    // the risk threatens something
    expect(g.edges.some((e) => e.type === 'threatens')).toBe(true)
  })

  it('splits multi-item answers on newlines/commas/semicolons and caps the count', () => {
    const g = buildSeed({ working: 'a, b; c\nd', deciding: '', worried: '' })
    expect(g.nodes.filter((n) => n.kind === 'stream')).toHaveLength(4)
  })
})
