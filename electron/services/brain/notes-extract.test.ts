import { describe, it, expect } from 'vitest'
import { parseExtraction, applyExtraction } from './notes-extract'
import type { CausalGraph } from './types'

describe('parseExtraction', () => {
  it('parses a clean JSON object', () => {
    const ex = parseExtraction(
      JSON.stringify({
        commitments: [{ note: 'a.md', date: '2026-07-01' }],
        decisions: [{ note: 'b.md', decide_by: '2026-06-30', cleared: 'go', blocked: 'hold' }],
        risks: [{ id: 'risk:x', label: 'Vendor', severity: 'red', about: 'a.md' }]
      })
    )
    expect(ex.commitments).toHaveLength(1)
    expect(ex.decisions[0].cleared).toBe('go')
    expect(ex.risks[0].severity).toBe('red')
  })

  it('tolerates a code fence + leading prose', () => {
    const ex = parseExtraction('Here you go:\n```json\n{"commitments":[{"note":"a.md","date":"2026-07-01"}],"decisions":[],"risks":[]}\n```')
    expect(ex.commitments).toHaveLength(1)
  })

  it('drops malformed items (bad date, missing fields) but keeps the rest', () => {
    const ex = parseExtraction(
      JSON.stringify({
        commitments: [{ note: 'a.md', date: 'soon' }, { note: 'b.md', date: '2026-07-02' }],
        decisions: [{ decide_by: '2026-07-01' }], // no note → dropped
        risks: [{ label: 'no id' }] // no id → dropped
      })
    )
    expect(ex.commitments).toHaveLength(1)
    expect(ex.commitments[0].note).toBe('b.md')
    expect(ex.decisions).toHaveLength(0)
    expect(ex.risks).toHaveLength(0)
  })

  it('returns empty on garbage', () => {
    expect(parseExtraction('not json at all')).toEqual({ commitments: [], decisions: [], risks: [] })
    expect(parseExtraction('')).toEqual({ commitments: [], decisions: [], risks: [] })
  })
})

describe('applyExtraction', () => {
  const base: CausalGraph = {
    nodes: [
      { id: 'a.md', kind: 'stream', label: 'Launch', track: 'work' },
      { id: 'b.md', kind: 'stream', label: 'Beta decision', track: 'work' }
    ],
    edges: []
  }

  it('enriches nodes with dates, decide-by + fork, and adds risk nodes/edges', () => {
    const g = applyExtraction(base, {
      commitments: [{ note: 'a.md', date: '2026-07-01' }],
      decisions: [{ note: 'b.md', decide_by: '2026-06-30', cleared: 'go', blocked: 'hold' }],
      risks: [{ id: 'risk:v', label: 'Vendor SLA', severity: 'red', about: 'a.md' }]
    })
    const a = g.nodes.find((n) => n.id === 'a.md')!
    expect(a.date).toBe('2026-07-01')
    const b = g.nodes.find((n) => n.id === 'b.md')!
    expect(b.decide_by).toBe('2026-06-30')
    expect(b.kind).toBe('gate') // stream → gate when it carries a decision
    expect(b.fork).toEqual({ cleared: 'go', blocked: 'hold' })
    const risk = g.nodes.find((n) => n.id === 'risk:v')!
    expect(risk.kind).toBe('risk')
    expect(g.edges.some((e) => e.source === 'risk:v' && e.target === 'a.md' && e.type === 'threatens')).toBe(true)
  })

  it('skips a risk whose id collides with a real node, and adds an orphan risk with no edge', () => {
    const g = applyExtraction(base, {
      commitments: [],
      decisions: [],
      risks: [
        { id: 'a.md', label: 'collision', severity: 'amber' }, // collides → skipped
        { id: 'risk:orphan', label: 'Floating', about: 'missing.md' } // unknown target → node, no edge
      ]
    })
    expect(g.nodes.filter((n) => n.id === 'a.md')).toHaveLength(1) // not duplicated/clobbered
    expect(g.nodes.some((n) => n.id === 'risk:orphan')).toBe(true)
    expect(g.edges.some((e) => e.source === 'risk:orphan')).toBe(false)
  })
})
