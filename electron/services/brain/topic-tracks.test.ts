import { describe, expect, it } from 'vitest'

import {
  MIN_TRACK_SIZE,
  deriveTopicTracks,
  trackFile,
  type TrackEdge,
  type TrackNode
} from './topic-tracks'

// Two clean clusters (a/b/c and x/y/z) joined by ONE bridge edge c—x, plus a 2-node scrap.
const nodes: TrackNode[] = [
  { id: 'a', label: 'Alpha', note: 'proj/alpha.md' },
  { id: 'b', label: 'Beta', note: 'proj/beta.md' },
  { id: 'c', label: 'Gamma', note: 'proj/alpha.md' },
  { id: 'x', label: 'Xi', note: 'ops/xi.md' },
  { id: 'y', label: 'Psi', note: 'ops/psi.md' },
  { id: 'z', label: 'Zeta' },
  { id: 'p', label: 'Solo' },
  { id: 'q', label: 'Duo' }
]
const edges: TrackEdge[] = [
  { source: 'a', target: 'b' },
  { source: 'b', target: 'c' },
  { source: 'a', target: 'c' },
  { source: 'x', target: 'y' },
  { source: 'y', target: 'z' },
  { source: 'x', target: 'z' },
  { source: 'c', target: 'x' }, // the bridge
  { source: 'p', target: 'q' }
]
const comms = new Map<string, number>([
  ['a', 1], ['b', 1], ['c', 1],
  ['x', 2], ['y', 2], ['z', 2],
  ['p', 3], ['q', 3]
])
const lane = (n: TrackNode): string | undefined =>
  n.note?.startsWith('proj/') ? 'projects' : n.note?.startsWith('ops/') ? 'ops' : undefined

describe('deriveTopicTracks', () => {
  it('emits one track per community above the size floor', () => {
    const t = deriveTopicTracks(nodes, edges, comms, { laneOf: lane })
    expect(t).toHaveLength(2) // the 2-node community is dropped
    expect(t.map((x) => x.size)).toEqual([3, 3])
  })

  it('drops sub-threshold communities — a pair is not a topic', () => {
    const t = deriveTopicTracks(nodes, edges, comms, { laneOf: lane })
    expect(t.flatMap((x) => x.members)).not.toContain('p')
    expect(MIN_TRACK_SIZE).toBe(3)
  })

  it('carries FULL membership as provenance, not just the hubs', () => {
    const proj = deriveTopicTracks(nodes, edges, comms, { laneOf: lane }).find((x) => x.lane === 'projects')!
    expect(proj.members).toEqual(['a', 'b', 'c']) // sorted, complete
    expect(proj.notes).toEqual(['proj/alpha.md', 'proj/beta.md']) // deduped, sorted
  })

  it('names a track by its dominant lane and ranks hubs by degree', () => {
    const t = deriveTopicTracks(nodes, edges, comms, { laneOf: lane })
    const proj = t.find((x) => x.lane === 'projects')!
    expect(proj.label).toBe('projects')
    // c has degree 3 (a,b,x); a and b have 2 each
    expect(proj.hubs[0].id).toBe('c')
  })

  it('links tracks that share an edge', () => {
    const t = deriveTopicTracks(nodes, edges, comms, { laneOf: lane })
    const proj = t.find((x) => x.lane === 'projects')!
    const ops = t.find((x) => x.lane === 'ops')!
    expect(proj.neighbors).toEqual([ops.id])
    expect(ops.neighbors).toEqual([proj.id])
  })

  it('is deterministic — identical input yields byte-identical tracks', () => {
    const a = deriveTopicTracks(nodes, edges, comms, { laneOf: lane })
    const b = deriveTopicTracks([...nodes].reverse(), [...edges].reverse(), comms, { laneOf: lane })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('gives colliding labels distinct slugs instead of overwriting one file', () => {
    const n2: TrackNode[] = [...nodes, { id: 'm', label: 'M', note: 'proj/m.md' }, { id: 'n', label: 'N', note: 'proj/n.md' }, { id: 'o', label: 'O', note: 'proj/o.md' }]
    const e2: TrackEdge[] = [...edges, { source: 'm', target: 'n' }, { source: 'n', target: 'o' }]
    const c2 = new Map(comms); c2.set('m', 4); c2.set('n', 4); c2.set('o', 4)
    const t = deriveTopicTracks(n2, e2, c2, { laneOf: lane })
    const projSlugs = t.filter((x) => x.lane === 'projects').map((x) => x.id)
    expect(projSlugs).toHaveLength(2)
    expect(new Set(projSlugs).size).toBe(2) // no collision
  })

  it('ignores nodes with no community assignment rather than inventing one', () => {
    const t = deriveTopicTracks([...nodes, { id: 'orphan', label: 'Orphan' }], edges, comms, { laneOf: lane })
    expect(t.flatMap((x) => x.members)).not.toContain('orphan')
  })

  it('survives edges referencing unknown nodes', () => {
    const t = deriveTopicTracks(nodes, [...edges, { source: 'ghost', target: 'a' }], comms, { laneOf: lane })
    expect(t).toHaveLength(2)
  })
})

describe('trackFile', () => {
  it('renders machine-owned OKF frontmatter with the provenance links', () => {
    const proj = deriveTopicTracks(nodes, edges, comms, { laneOf: lane }).find((x) => x.lane === 'projects')!
    const { slug, md } = trackFile(proj)
    expect(slug).toBe('track-projects.md')
    expect(md).toContain('kind: topic-track')
    expect(md).toContain('type: learned')
    expect(md).toContain('machine-owned · do not hand-edit')
    expect(md).toContain('[[proj/alpha.md]]') // supporting-note link
    expect(md).toContain('Gamma (3 links)') // hub with degree
  })

  it('renders empty sections rather than emitting a malformed file', () => {
    const md = trackFile({
      id: 't', label: 'T', lane: '', size: 3, members: ['a','b','c'], notes: [], hubs: [], neighbors: []
    }).md
    expect(md).toContain('- (none)')
    expect(md.startsWith('---')).toBe(true)
  })
})
