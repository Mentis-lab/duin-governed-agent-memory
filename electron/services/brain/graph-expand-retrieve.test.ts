import { describe, it, expect } from 'vitest'
import { graphExpandRetrieve, type EntityGraph } from './graph-expand-retrieve'
import type { WNNote } from './wholenote-ground'

// ── Frontier/density cap fixture ──
// Gold G is reached via a rare `goldHops`-hop bridge chain off the BM25 seed S. A cluster of `D`
// distractors, interconnected through `kEnt` shared cluster-entities (each below the hub-DF cap),
// also seeds off S — so on a DENSE cluster the distractors mutually re-activate over hops and, when
// admissions are UNBOUNDED, flood the pool and demote gold. The density brake caps fresh admissions
// per hop, keeping gold's rank stable. A SPARSE cluster never trips the cap → byte-identical output.
function build(D: number): { notes: WNNote[]; graph: EntityGraph } {
  const notes: WNNote[] = []
  const nodes: { note: string; entities: string[] }[] = []
  const entityIndex: Record<string, string[]> = {}
  const addEnt = (e: string, n: string): void => {
    ;(entityIndex[e] ??= []).push(n)
  }
  const push = (id: string, text: string, ents: string[]): void => {
    notes.push({ id, text })
    nodes.push({ note: id, entities: ents })
    ents.forEach((e) => addEnt(e, id))
  }
  const kEnt = 6
  const goldHops = 3
  const perClusterEnt = 2
  push('S.md', 'alpha query seed', ['c0', 'r0'])
  let prev = 'r0'
  for (let h = 1; h < goldHops; h++) {
    push(`h${h}.md`, `chain ${h}`, [prev, `r${h}`])
    prev = `r${h}`
  }
  push('G.md', 'gold', [prev])
  for (let i = 0; i < D; i++) {
    const ents: string[] = []
    for (let j = 0; j < perClusterEnt; j++) ents.push(`c${(i + j) % kEnt}`)
    push(`d${i}.md`, `alpha distractor ${i}`, ents)
  }
  return { notes, graph: { nodes, entityIndex } }
}

const Q = 'alpha query'
const rankOfGold = (opts: Parameters<typeof graphExpandRetrieve>[3]): number => {
  const { notes, graph } = build(60)
  return graphExpandRetrieve(Q, notes, graph, opts).ranked.indexOf('G.md')
}

describe('graphExpandRetrieve — frontier/density cap', () => {
  it('DENSE: the default cap keeps gold rank stable — uncapped over-expansion demotes it', () => {
    const uncapped = rankOfGold({ maxFrontierPerHop: Infinity })
    const capped = rankOfGold({}) // default cap ON (16)
    // The cap must not demote gold, and on this dense graph it strictly RESCUES it from the flood.
    expect(capped).toBeLessThan(uncapped)
    expect(capped).toBeGreaterThanOrEqual(0) // gold is present in the ranking
  })

  it('SPARSE: default-capped ranking is byte-identical to uncapped (cap never fires)', () => {
    const { notes, graph } = build(3)
    const uncapped = graphExpandRetrieve(Q, notes, graph, { maxFrontierPerHop: Infinity }).ranked
    const capped = graphExpandRetrieve(Q, notes, graph, {}).ranked
    expect(capped).toEqual(uncapped)
  })

  it('a note-id ranking is always TOTAL (recall@k defined for every k) regardless of the cap', () => {
    const { notes, graph } = build(60)
    for (const cap of [Infinity, 16, 4]) {
      const { ranked } = graphExpandRetrieve(Q, notes, graph, { maxFrontierPerHop: cap })
      expect(new Set(ranked).size).toBe(notes.length)
    }
  })
})

describe('graphExpandRetrieve — multi-hop recovery vs BM25', () => {
  it('recovers a 2-hop bridge note the seed shares no vocabulary with', () => {
    // S matches the query; the answer note G shares NO query term and is reached only via the shared
    // rare entity `bridge` (a genuine 1-hop graph bridge BM25 alone cannot surface).
    const notes: WNNote[] = [
      { id: 'S.md', text: 'who owns the beacon project bridge' },
      { id: 'G.md', text: 'sam rivera is the responsible party bridge' },
      { id: 'X.md', text: 'entirely unrelated cake recipe' }
    ]
    const graph: EntityGraph = {
      nodes: [
        { note: 'S.md', entities: ['bridge'] },
        { note: 'G.md', entities: ['bridge'] },
        { note: 'X.md', entities: [] }
      ],
      entityIndex: { bridge: ['S.md', 'G.md'] }
    }
    const { ranked } = graphExpandRetrieve('who owns the beacon project', notes, graph, {})
    expect(ranked.slice(0, 2)).toContain('G.md') // the bridge note is surfaced high
    expect(ranked.indexOf('G.md')).toBeLessThan(ranked.indexOf('X.md'))
  })
})
