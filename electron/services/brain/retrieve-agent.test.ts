import { describe, it, expect } from 'vitest'
import {
  buildNoteCorpus,
  toGraphView,
  grep,
  glob,
  readNote,
  graphNeighbors,
  graphExpand,
  parseCitations,
  verifyCitations,
  verifyCitationsSupported,
  parsePlan,
  planRetrieval,
  retrieveContext,
  type NoteText,
  type GraphView,
  type Citation,
  type NliScoreFn,
  type TurnFn
} from './retrieve-agent'
import type { CausalGraph } from '../local-brain/graph-derive'

// ──────────────────── fixtures ────────────────────

// A mini-corpus mirroring the sample vault's structure (multi-hop graph shape).
const NOTES: NoteText[] = buildNoteCorpus([
  { file: 'beacon.md', text: '# Beacon dashboard\n\nBeacon is the customer-facing dashboard.\nBlocked until we hire a designer.\nDecide on the designer hire by July 10.' },
  { file: 'atlas notes.md', text: '# Atlas\n\nProject Atlas is the analytics rebuild.\nJordan Lee owns it.\nDecide Postgres by June 30.' },
  { file: 'people.md', text: 'Jordan Lee — engineering lead, runs Atlas.\nSam Rivera — PM, working on Beacon.' }
])

// A constructed-style graph: Beacon depends_on the designer-hire decision; Sam
// owns Beacon; Jordan owns Atlas. This is the multi-hop shape the retriever
// exploits.
const GRAPH: GraphView = {
  nodes: [
    { id: 'beacon.md', label: 'Beacon dashboard', kind: 'stream' },
    { id: 'atlas notes.md', label: 'Atlas', kind: 'stream' },
    { id: 'people.md', label: 'People', kind: 'stream' },
    { id: 'person:sam-rivera', label: 'Sam Rivera', kind: 'person' },
    { id: 'person:jordan-lee', label: 'Jordan Lee', kind: 'person' },
    { id: 'decision:designer-hire', label: 'Designer hire', kind: 'decision' }
  ],
  edges: [
    { source: 'person:sam-rivera', target: 'beacon.md', type: 'owns' },
    { source: 'beacon.md', target: 'decision:designer-hire', type: 'depends_on' },
    { source: 'decision:designer-hire', target: 'beacon.md', type: 'blocks' },
    { source: 'person:jordan-lee', target: 'atlas notes.md', type: 'owns' }
  ]
}

// ──────────────────── L3 synonym bridge traversal ────────────────────

describe('graphNeighbors / graphExpand — synonym alias bridge (L3)', () => {
  // "Project Atlas" and "Atlas project" are the SAME real entity but do NOT substring-match each
  // other, so resolveSeeds resolves a query to ONE of them only. A construction-emitted synonym edge
  // bridges the two ids so traversal hops across the surface-form mismatch.
  const SYN: GraphView = {
    nodes: [
      { id: 'project:atlas', label: 'Project Atlas', kind: 'project' },
      { id: 'project:atlas-alt', label: 'Atlas project', kind: 'project' },
      { id: 'decision:ship-x', label: 'Ship X', kind: 'decision' }
    ],
    edges: [
      { source: 'project:atlas', target: 'project:atlas-alt', type: 'synonym' },
      { source: 'project:atlas-alt', target: 'decision:ship-x', type: 'depends' }
    ]
  }
  // Same graph WITHOUT the synonym edge — the regression baseline (today's behavior).
  const NO_SYN: GraphView = { nodes: SYN.nodes, edges: [SYN.edges[1]] }

  it('graphNeighbors bridges a non-substring alias, BOTH directions', () => {
    const fwd = graphNeighbors(SYN, 'Project Atlas')
    expect(fwd.some((h) => h.id === 'project:atlas-alt' && h.via === 'synonym')).toBe(true)
    const rev = graphNeighbors(SYN, 'Atlas project')
    expect(rev.some((h) => h.id === 'project:atlas' && h.via === 'synonym')).toBe(true)
  })

  it('graphExpand reaches the aliased node (hop 1, via synonym) and the fact behind it (hop 2, via depends)', () => {
    const hits = graphExpand(SYN, 'Project Atlas', [], 2)
    const alias = hits.find((h) => h.id === 'project:atlas-alt')
    expect(alias).toMatchObject({ via: 'synonym', hop: 1 })
    const fact = hits.find((h) => h.id === 'decision:ship-x')
    expect(fact).toMatchObject({ via: 'depends', hop: 2 }) // reachable only THROUGH the bridge
  })

  it('synonym ranks in the affects/attends tier: below depends, above mentions', () => {
    const g: GraphView = {
      nodes: [
        { id: 's', label: 'Seed', kind: 'topic' },
        { id: 'syn', label: 'Alias', kind: 'topic' },
        { id: 'dep', label: 'Dep', kind: 'decision' },
        { id: 'men', label: 'Men', kind: 'topic' }
      ],
      edges: [
        { source: 's', target: 'syn', type: 'synonym' },
        { source: 's', target: 'dep', type: 'depends' },
        { source: 's', target: 'men', type: 'mentions' }
      ]
    }
    const hits = graphExpand(g, 's', [], 1)
    const order = hits.map((h) => h.id)
    expect(order.indexOf('dep')).toBeLessThan(order.indexOf('syn')) // depends outranks synonym
    expect(order.indexOf('syn')).toBeLessThan(order.indexOf('men')) // synonym outranks mentions
  })

  it('degrades gracefully: with NO synonym edge the alias is unreachable (today\'s behavior)', () => {
    expect(graphNeighbors(NO_SYN, 'Project Atlas').some((h) => h.id === 'project:atlas-alt')).toBe(false)
    expect(graphExpand(NO_SYN, 'Project Atlas', [], 2).some((h) => h.id === 'project:atlas-alt')).toBe(false)
  })
})

// ──────────────────── buildNoteCorpus ────────────────────

describe('buildNoteCorpus', () => {
  it('reassembles chunks per file and splits into 1-based addressable lines', () => {
    const corpus = buildNoteCorpus([
      { file: 'a.md', text: 'line one\nline two' },
      { file: 'a.md', text: 'line three' },
      { file: 'b.md', text: 'only line' }
    ])
    const a = corpus.find((n) => n.id === 'a.md')!
    expect(a.lines[0]).toBe('line one')
    expect(a.lines[1]).toBe('line two')
    // chunks joined with '\n' (graph-derive parity)
    expect(a.lines[2]).toBe('line three')
    expect(corpus.find((n) => n.id === 'b.md')!.text).toBe('only line')
  })
})

// ──────────────────── grep ────────────────────

describe('grep', () => {
  it('returns note + 1-based line + text for case-insensitive matches', () => {
    const hits = grep(NOTES, 'designer')
    expect(hits.length).toBeGreaterThanOrEqual(1)
    const beacon = hits.find((h) => h.note === 'beacon.md')!
    expect(beacon).toBeTruthy()
    expect(beacon.text.toLowerCase()).toContain('designer')
    expect(beacon.line).toBeGreaterThanOrEqual(1)
  })

  it('matches case-insensitively', () => {
    expect(grep(NOTES, 'JORDAN').length).toBeGreaterThanOrEqual(1)
  })

  it('returns [] for empty/whitespace term', () => {
    expect(grep(NOTES, '')).toEqual([])
    expect(grep(NOTES, '   ')).toEqual([])
  })

  it('caps results', () => {
    expect(grep(NOTES, 'e', 2).length).toBeLessThanOrEqual(2)
  })

  it('supports true regex — alternation and anchors', () => {
    // A plain word still works (substring-equivalent)...
    const plain = grep(NOTES, 'designer')
    // ...and a real pattern compiles: alternation should match either branch.
    const alt = grep(NOTES, 'designer|jordan')
    expect(alt.length).toBeGreaterThanOrEqual(plain.length)
    // word-boundary regex is accepted (compiles, runs)
    expect(() => grep(NOTES, '\\bdesigner\\b')).not.toThrow()
  })

  it('an INVALID regex falls back to a literal match instead of throwing', () => {
    // Unbalanced paren is not a valid regex; must not throw, matches literally.
    expect(() => grep(NOTES, 'foo(')).not.toThrow()
    expect(grep(NOTES, 'foo(')).toEqual([]) // no note contains the literal "foo("
  })
})

// ──────────────────── glob ────────────────────

describe('glob', () => {
  it('matches a bare substring (no metachars) case-insensitively', () => {
    expect(glob(NOTES, 'atlas')).toContain('atlas notes.md')
  })

  it('matches a star pattern', () => {
    expect(glob(NOTES, '*.md').sort()).toEqual(['atlas notes.md', 'beacon.md', 'people.md'])
  })

  it('matches a prefix star', () => {
    expect(glob(NOTES, 'beacon*')).toEqual(['beacon.md'])
  })

  it('returns [] for empty pattern', () => {
    expect(glob(NOTES, '')).toEqual([])
  })

  it('does not throw on a weird pattern', () => {
    expect(() => glob(NOTES, '[')).not.toThrow()
  })
})

// ──────────────────── readNote ────────────────────

describe('readNote', () => {
  it('returns numbered lines for the whole note by default', () => {
    const text = readNote(NOTES, 'people.md')
    expect(text).toContain('1: Jordan Lee')
    expect(text).toContain('2: Sam Rivera')
  })

  it('honors an inclusive 1-based line range', () => {
    const text = readNote(NOTES, 'beacon.md', [3, 4])
    expect(text).toContain('3: ')
    expect(text).toContain('4: ')
    expect(text).not.toContain('1: # Beacon')
  })

  it('clamps an out-of-range request and tolerates reversed bounds', () => {
    const forward = readNote(NOTES, 'people.md', [1, 999])
    const reversed = readNote(NOTES, 'people.md', [999, 1])
    expect(forward).toBe(reversed) // reversed bounds normalized
    expect(forward).toContain('2: Sam Rivera')
  })

  it('returns "" for an unknown note id', () => {
    expect(readNote(NOTES, 'nope.md')).toBe('')
  })

  it('clamps a fully-out-of-range request to the last line (non-empty, distinct from unknown-id "")', () => {
    // A 2-line note; [50,60] is entirely past the end. Both ends must clamp to
    // [1, lines.length] so we return the last line — NOT '' (which is the
    // "unknown note id" sentinel and would lie to the model).
    const short = buildNoteCorpus([{ file: 's.md', text: 'first line\nsecond line' }])
    const out = readNote(short, 's.md', [50, 60])
    expect(out).not.toBe('') // distinct from the unknown-id sentinel
    expect(out).toBe('2: second line') // clamped to the last line
    // Sanity: the unknown-id path still returns ''.
    expect(readNote(short, 'missing.md', [50, 60])).toBe('')
  })
})

// ──────────────────── graphNeighbors (the differentiator) ────────────────────

describe('graphNeighbors', () => {
  it('resolves a term by label and returns BOTH-direction edges with type + dir', () => {
    const nbs = graphNeighbors(GRAPH, 'Beacon')
    const ids = nbs.map((n) => `${n.via}:${n.dir}:${n.id}`)
    // outgoing: beacon depends_on designer-hire
    expect(ids).toContain('depends_on:out:decision:designer-hire')
    // incoming: Sam owns beacon; designer-hire blocks beacon
    expect(ids).toContain('owns:in:person:sam-rivera')
    expect(ids).toContain('blocks:in:decision:designer-hire')
  })

  it('enables multi-hop: who blocks Beacon -> read designer-hire -> follow back', () => {
    // hop 1: Beacon's blocker
    const hop1 = graphNeighbors(GRAPH, 'beacon.md')
    const blocker = hop1.find((n) => n.via === 'depends_on' || n.id.includes('designer'))
    expect(blocker).toBeTruthy()
    // hop 2: from designer-hire we can reach beacon again (blocks)
    const hop2 = graphNeighbors(GRAPH, 'decision:designer-hire')
    expect(hop2.some((n) => n.id === 'beacon.md')).toBe(true)
  })

  it('resolves an exact id', () => {
    const nbs = graphNeighbors(GRAPH, 'atlas notes.md')
    expect(nbs.some((n) => n.id === 'person:jordan-lee' && n.via === 'owns' && n.dir === 'in')).toBe(true)
  })

  it('returns [] for an unresolvable term', () => {
    expect(graphNeighbors(GRAPH, 'nonexistent-xyz')).toEqual([])
    expect(graphNeighbors(GRAPH, '')).toEqual([])
  })

  it('does not list the matched node as its own neighbour', () => {
    const nbs = graphNeighbors(GRAPH, 'beacon.md')
    expect(nbs.some((n) => n.id === 'beacon.md')).toBe(false)
  })
})

// ──────────────────── graphNeighbors — inline source-note snippet (L4) ────────────────────

describe('graphNeighbors — inline source-note snippet (L4)', () => {
  it('attaches a snippet from a FILE neighbour’s own note (id == relpath)', () => {
    // Sam owns beacon.md → the beacon.md neighbour resolves its snippet from beacon.md.
    const nbs = graphNeighbors(GRAPH, 'person:sam-rivera', NOTES)
    const beacon = nbs.find((n) => n.id === 'beacon.md')!
    expect(beacon).toBeTruthy()
    expect(beacon.snippet).toBeTruthy()
    expect(beacon.snippet!.toLowerCase()).toContain('customer-facing dashboard')
    expect(beacon.snippet!.length).toBeLessThanOrEqual(201) // SNIPPET_MAX + ellipsis
  })

  it('omits snippet entirely when no corpus is supplied (backward-compatible)', () => {
    const nbs = graphNeighbors(GRAPH, 'person:sam-rivera')
    expect(nbs.length).toBeGreaterThanOrEqual(1)
    for (const n of nbs) expect(n.snippet).toBeUndefined()
  })

  it('resolves a CONSTRUCTED entity’s snippet via node.note, not its slug id (note ?? id)', () => {
    const g: GraphView = {
      nodes: [
        { id: 'beacon.md', label: 'Beacon', kind: 'stream' },
        { id: 'person:sam-rivera', label: 'Sam', kind: 'person', note: 'people.md' }
      ],
      edges: [{ source: 'beacon.md', target: 'person:sam-rivera', type: 'mentions' }]
    }
    const sam = graphNeighbors(g, 'beacon.md', NOTES).find((n) => n.id === 'person:sam-rivera')!
    expect(sam.snippet).toContain('Sam Rivera') // from people.md (node.note), NOT its slug id
  })

  it('degrades to no snippet when the neighbour’s note is absent from the corpus', () => {
    // GRAPH’s constructed nodes carry no `note` and their slug ids aren’t in NOTES.
    const decision = graphNeighbors(GRAPH, 'beacon.md', NOTES).find((n) => n.id === 'decision:designer-hire')!
    expect(decision).toBeTruthy()
    expect(decision.snippet).toBeUndefined()
  })
})

// ──────────────────── graphExpand — deterministic bounded k-hop (L2) ────────────────────

describe('graphExpand — deterministic bounded k-hop expansion (L2)', () => {
  const mk = (nodes: GraphView['nodes'], edges: GraphView['edges']): GraphView => ({ nodes, edges })

  it('BFS reach + hop distance; hops=1 excludes hop-2; seed never appears', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'd.md', label: 'D', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'b.md', type: 'depends' },
        { source: 'b.md', target: 'd.md', type: 'mentions' }
      ]
    )
    const two = new Map(graphExpand(graph, 'a.md').map((h) => [h.id, h]))
    expect(two.get('b.md')?.hop).toBe(1)
    expect(two.get('d.md')?.hop).toBe(2)
    expect(two.has('a.md')).toBe(false) // seed excluded from output
    const one = graphExpand(graph, 'a.md', [], 1)
    expect(one.some((h) => h.id === 'b.md')).toBe(true)
    expect(one.some((h) => h.id === 'd.md')).toBe(false) // hops=1 stops before hop-2
  })

  it('first-discovery wins: a node reachable at hop 1 AND hop 2 keeps the hop-1 via/from', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'x.md', label: 'X', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'x.md', type: 'owns' }, // hop-1 path to x
        { source: 'a.md', target: 'b.md', type: 'mentions' },
        { source: 'b.md', target: 'x.md', type: 'mentions' } // hop-2 path to x
      ]
    )
    const x = graphExpand(graph, 'a.md').find((h) => h.id === 'x.md')!
    expect(x.hop).toBe(1)
    expect(x.via).toBe('owns')
    expect(x.from).toBe('a.md')
  })

  it('strongest-edge-wins: a node reachable by a weak AND a strong edge at the same hop is tagged with the STRONGER relation', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 't.md', label: 'T', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 't.md', type: 'mentions' }, // weak, scanned first
        { source: 'a.md', target: 't.md', type: 'depends' } // strong, same hop → must win the tag
      ]
    )
    const t = graphExpand(graph, 'a.md').find((h) => h.id === 't.md')!
    expect(t.hop).toBe(1)
    expect(t.via).toBe('depends') // not the first-seen 'mentions'
  })

  it('bidirectional: an incoming edge yields dir "in", an outgoing edge "out"', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'p', label: 'P', kind: 'person' },
        { id: 'q', label: 'Q', kind: 'person' }
      ],
      [
        { source: 'p', target: 'a.md', type: 'owns' }, // incoming to the seed
        { source: 'a.md', target: 'q', type: 'mentions' } // outgoing from the seed
      ]
    )
    const hits = graphExpand(graph, 'a.md')
    expect(hits.find((h) => h.id === 'p')?.dir).toBe('in')
    expect(hits.find((h) => h.id === 'q')?.dir).toBe('out')
  })

  it('edge-type ranking: at equal degree, a `depends` neighbour outranks a `mentions` one', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'c.md', label: 'C', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'b.md', type: 'depends' },
        { source: 'a.md', target: 'c.md', type: 'mentions' }
      ]
    )
    const hits = graphExpand(graph, 'a.md')
    expect(hits[0].id).toBe('b.md')
    expect(hits[1].id).toBe('c.md')
  })

  it('degree ranking: at equal edge type + hop, the higher-degree hub ranks first', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'c.md', label: 'C', kind: 'stream' },
        { id: 'e.md', label: 'E', kind: 'stream' },
        { id: 'f.md', label: 'F', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'b.md', type: 'mentions' },
        { source: 'a.md', target: 'c.md', type: 'mentions' },
        { source: 'c.md', target: 'e.md', type: 'mentions' }, // bump c's degree
        { source: 'c.md', target: 'f.md', type: 'mentions' }
      ]
    )
    const hits = graphExpand(graph, 'a.md')
    expect(hits.findIndex((h) => h.id === 'c.md')).toBeLessThan(hits.findIndex((h) => h.id === 'b.md'))
  })

  it('hop penalty keeps hop-1 ahead of hop-2 at equal type; topN caps the output', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'd.md', label: 'D', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'b.md', type: 'mentions' },
        { source: 'b.md', target: 'd.md', type: 'mentions' }
      ]
    )
    const hits = graphExpand(graph, 'a.md', [], 2, 1)
    expect(hits).toHaveLength(1) // topN = 1
    expect(hits[0].id).toBe('b.md') // hop-1 outranks hop-2 d.md
  })

  it('snippet: entity resolves via node.note, file via id, concept/unknown → ""', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'beacon.md', label: 'Beacon', kind: 'stream' }, // file node → snippet via id
        { id: 'person:sam', label: 'Sam', kind: 'person', note: 'people.md' }, // entity → via note
        { id: 'concept:x', label: 'X', kind: 'topic' } // no backing note → ''
      ],
      [
        { source: 'a.md', target: 'beacon.md', type: 'mentions' },
        { source: 'a.md', target: 'person:sam', type: 'mentions' },
        { source: 'a.md', target: 'concept:x', type: 'mentions' }
      ]
    )
    const byId = new Map(graphExpand(graph, 'a.md', NOTES).map((h) => [h.id, h]))
    expect(byId.get('beacon.md')!.snippet.toLowerCase()).toContain('customer-facing dashboard')
    expect(byId.get('person:sam')!.snippet).toContain('Sam Rivera')
    expect(byId.get('concept:x')!.snippet).toBe('')
    for (const h of byId.values()) expect(h.snippet.length).toBeLessThanOrEqual(201)
  })

  it('degenerate: empty/unresolved term → []; hops clamp to [1,2] (0→1, 5→2, NaN→1)', () => {
    const graph = mk(
      [
        { id: 'a.md', label: 'A', kind: 'stream' },
        { id: 'b.md', label: 'B', kind: 'stream' },
        { id: 'd.md', label: 'D', kind: 'stream' }
      ],
      [
        { source: 'a.md', target: 'b.md', type: 'depends' },
        { source: 'b.md', target: 'd.md', type: 'mentions' }
      ]
    )
    expect(graphExpand(graph, '')).toEqual([])
    expect(graphExpand(graph, 'nonexistent-xyz')).toEqual([])
    expect(graphExpand(graph, 'a.md', [], 0).some((h) => h.id === 'd.md')).toBe(false) // 0 → 1
    expect(graphExpand(graph, 'a.md', [], 5).some((h) => h.id === 'd.md')).toBe(true) // 5 → 2
    expect(graphExpand(graph, 'a.md', [], NaN).some((h) => h.id === 'd.md')).toBe(false) // NaN → 1
  })
})

// ──────────────────── toGraphView ────────────────────

describe('toGraphView', () => {
  it('flattens a CausalGraph to {nodes,edges} with id/label/kind + source/target/type', () => {
    const g: CausalGraph = {
      nodes: [{ id: 'a.md', kind: 'stream', label: 'A', track: 'work', in_degree: 1 }],
      edges: [{ source: 'a.md', target: 'b.md', type: 'wikilink', confidence: 0.7 }]
    }
    const v = toGraphView(g)
    expect(v.nodes[0]).toEqual({ id: 'a.md', label: 'A', kind: 'stream' })
    expect(v.edges[0]).toEqual({ source: 'a.md', target: 'b.md', type: 'wikilink' })
  })
})

// ──────────────────── parseCitations ────────────────────

describe('parseCitations', () => {
  it('parses a clean {citations:[...]} object', () => {
    const c = parseCitations(
      JSON.stringify({
        citations: [
          { note: 'beacon.md', lines: [3, 4], snippet: 'blocked until designer', why: 'states the blocker' },
          { note: 'people.md', lines: [2, 2], snippet: 'Sam Rivera — PM on Beacon', why: 'owner' }
        ]
      })
    )
    expect(c).toHaveLength(2)
    expect(c[0].note).toBe('beacon.md')
    expect(c[0].lines).toEqual([3, 4])
    expect(c[0].why).toContain('blocker')
  })

  it('parses a bare array', () => {
    const c = parseCitations('[{"note":"a.md","snippet":"x","why":"y"}]')
    expect(c).toHaveLength(1)
    expect(c[0].note).toBe('a.md')
    expect(c[0].lines).toBeUndefined()
  })

  it('tolerates a code fence + leading prose', () => {
    const c = parseCitations(
      'Here you go:\n```json\n{"citations":[{"note":"n.md","lines":[1,2],"snippet":"s","why":"w"}]}\n```'
    )
    expect(c).toHaveLength(1)
    expect(c[0].note).toBe('n.md')
  })

  it('coerces lines from a single number and an "a-b" string', () => {
    const c = parseCitations(
      JSON.stringify({
        citations: [
          { note: 'a.md', lines: 5, snippet: 's', why: 'w' },
          { note: 'b.md', lines: '7-9', snippet: 's', why: 'w' },
          { note: 'c.md', lines: '12', snippet: 's', why: 'w' }
        ]
      })
    )
    expect(c[0].lines).toEqual([5, 5])
    expect(c[1].lines).toEqual([7, 9])
    expect(c[2].lines).toEqual([12, 12])
  })

  it('normalizes reversed line bounds', () => {
    const c = parseCitations('[{"note":"a.md","lines":[9,3],"snippet":"s","why":"w"}]')
    expect(c[0].lines).toEqual([3, 9])
  })

  it('drops items with no note but keeps the rest', () => {
    const c = parseCitations(
      JSON.stringify({
        citations: [
          { note: 'ok.md', snippet: 's', why: 'w' },
          { snippet: 'no note', why: 'w' },
          { note: '', snippet: 'empty note', why: 'w' }
        ]
      })
    )
    expect(c).toHaveLength(1)
    expect(c[0].note).toBe('ok.md')
  })

  it('dedups by note + line range', () => {
    const c = parseCitations(
      JSON.stringify({
        citations: [
          { note: 'a.md', lines: [1, 2], snippet: 's', why: 'w' },
          { note: 'a.md', lines: [1, 2], snippet: 'dupe', why: 'w' },
          { note: 'a.md', lines: [5, 6], snippet: 'different range', why: 'w' }
        ]
      })
    )
    expect(c).toHaveLength(2)
  })

  it('returns [] on garbage / empty', () => {
    expect(parseCitations('not json at all')).toEqual([])
    expect(parseCitations('')).toEqual([])
    expect(parseCitations('{"something":"else"}')).toEqual([])
  })
})

// ──────────────────── retrieveContext (loop guards, no live model) ────────────────────

describe('verifyCitations — deterministic honest reflection', () => {
  const corpus: NoteText[] = buildNoteCorpus([
    { file: 'beacon.md', text: 'line one\nline two\nline three' } // 3 lines
  ])
  const cite = (p: Partial<Citation> & { note: string }): Citation => ({ snippet: 's', why: 'w', ...p })

  it('drops a citation whose note id is provably absent (a hallucinated id)', () => {
    const out = verifyCitations([cite({ note: 'ghost.md', lines: [1, 2] }), cite({ note: 'beacon.md', lines: [1, 1] })], corpus)
    expect(out.map((c) => c.note)).toEqual(['beacon.md'])
  })

  it('CLAMPS an out-of-range line span to the note bounds (never drops for lines)', () => {
    const out = verifyCitations([cite({ note: 'beacon.md', lines: [50, 60] })], corpus)
    expect(out).toHaveLength(1)
    expect(out[0].lines).toEqual([3, 3]) // both clamped to the 3-line note's last line
  })

  it('clamps only the over-long end and normalizes an inverted range', () => {
    expect(verifyCitations([cite({ note: 'beacon.md', lines: [2, 99] })], corpus)[0].lines).toEqual([2, 3])
    expect(verifyCitations([cite({ note: 'beacon.md', lines: [3, 1] })], corpus)[0].lines).toEqual([1, 3]) // inverted → [lo,hi]
  })

  it('keeps a line-less citation to a real note untouched, and preserves order', () => {
    const out = verifyCitations([cite({ note: 'beacon.md' }), cite({ note: 'beacon.md', lines: [1, 2] })], corpus)
    expect(out).toHaveLength(2)
    expect(out[0].lines).toBeUndefined()
    expect(out[1].lines).toEqual([1, 2])
  })

  it('empty in → empty out; all-hallucinated → empty', () => {
    expect(verifyCitations([], corpus)).toEqual([])
    expect(verifyCitations([cite({ note: 'nope.md' })], corpus)).toEqual([])
  })
})

// ──────────────────── NLI citation-SUPPORT gate (L1) ────────────────────

describe('verifyCitationsSupported — NLI SUPPORT gate (honest, injectable, degrade-graceful)', () => {
  const corpus: NoteText[] = buildNoteCorpus([
    { file: 'beacon.md', text: 'line one\nBeacon is blocked until we hire a designer\nline three' }
  ])
  const cite = (p: Partial<Citation> & { note: string }): Citation => ({ snippet: 's', why: 'w', ...p })

  it('marks a supported citation (score >= threshold) with support + supported=true, keeping it', async () => {
    const scorer: NliScoreFn = async (pairs) => pairs.map(() => 0.9)
    const out = await verifyCitationsSupported(
      [cite({ note: 'beacon.md', lines: [2, 2], why: 'what blocks Beacon' })],
      corpus,
      scorer,
      { threshold: 0.5 }
    )
    expect(out).toHaveLength(1)
    expect(out[0].support).toBeCloseTo(0.9)
    expect(out[0].supported).toBe(true)
    // Honest: it never mutates the evidence fields.
    expect(out[0].note).toBe('beacon.md')
    expect(out[0].snippet).toBe('s')
  })

  it('marks an unsupported citation supported=false but KEEPS it in mark mode (default)', async () => {
    const scorer: NliScoreFn = async (pairs) => pairs.map(() => 0.2)
    const out = await verifyCitationsSupported([cite({ note: 'beacon.md', lines: [2, 2] })], corpus, scorer, {
      threshold: 0.5
    })
    expect(out).toHaveLength(1)
    expect(out[0].supported).toBe(false)
    expect(out[0].support).toBeCloseTo(0.2)
  })

  it('DROPS an unsupported citation in drop mode, keeping only the supported ones', async () => {
    const scorer: NliScoreFn = async (pairs) =>
      pairs.map((p) => (p.premise.includes('designer') ? 0.9 : 0.1))
    const out = await verifyCitationsSupported(
      [cite({ note: 'beacon.md', lines: [2, 2] }), cite({ note: 'beacon.md', lines: [1, 1] })],
      corpus,
      scorer,
      { threshold: 0.5, drop: true }
    )
    // line 2 mentions the designer (supported) → kept; line 1 ("line one") → dropped.
    expect(out).toHaveLength(1)
    expect(out[0].lines).toEqual([2, 2])
    expect(out[0].supported).toBe(true)
  })

  it('passes the CLAMPED span text as the premise and the claim (why) as the hypothesis', async () => {
    let seen: { premise: string; hypothesis: string }[] = []
    const scorer: NliScoreFn = async (pairs) => {
      seen = pairs
      return pairs.map(() => 0.9)
    }
    await verifyCitationsSupported(
      [cite({ note: 'beacon.md', lines: [2, 2], why: 'what blocks Beacon' })],
      corpus,
      scorer
    )
    expect(seen[0].premise).toBe('Beacon is blocked until we hire a designer')
    expect(seen[0].hypothesis).toBe('what blocks Beacon')
  })

  it('model-unavailable (scorer returns null) → citations returned UNCHANGED (no support fields)', async () => {
    const scorer: NliScoreFn = async () => null
    const input = [cite({ note: 'beacon.md', lines: [2, 2] })]
    const out = await verifyCitationsSupported(input, corpus, scorer)
    expect(out).toBe(input) // same reference — a true no-op
    expect(out[0].supported).toBeUndefined()
    expect(out[0].support).toBeUndefined()
  })

  it('a THROWING scorer leaves citations unchanged (degrade-gracefully)', async () => {
    const scorer: NliScoreFn = async () => {
      throw new Error('worker died')
    }
    const input = [cite({ note: 'beacon.md', lines: [2, 2] })]
    const out = await verifyCitationsSupported(input, corpus, scorer)
    expect(out).toBe(input)
    expect(out[0].supported).toBeUndefined()
  })

  it('a length-mismatched score array is rejected → citations unchanged', async () => {
    const scorer: NliScoreFn = async () => [0.9] // only one score for two citations
    const input = [cite({ note: 'beacon.md', lines: [1, 1] }), cite({ note: 'beacon.md', lines: [2, 2] })]
    const out = await verifyCitationsSupported(input, corpus, scorer)
    expect(out).toBe(input)
  })

  it('a non-finite score keeps that citation untouched (never mislabels or drops on garbage)', async () => {
    const scorer: NliScoreFn = async () => [NaN]
    const out = await verifyCitationsSupported([cite({ note: 'beacon.md', lines: [2, 2] })], corpus, scorer, {
      drop: true
    })
    expect(out).toHaveLength(1) // not dropped despite drop mode — score was garbage
    expect(out[0].supported).toBeUndefined()
  })

  it('empty citations short-circuits without calling the scorer', async () => {
    let called = false
    const scorer: NliScoreFn = async () => {
      called = true
      return []
    }
    expect(await verifyCitationsSupported([], corpus, scorer)).toEqual([])
    expect(called).toBe(false)
  })

  it('never fabricates: output note ids are always a subset of the input note ids', async () => {
    const scorer: NliScoreFn = async (pairs) => pairs.map(() => 0.9)
    const input = [cite({ note: 'beacon.md', lines: [2, 2] })]
    const out = await verifyCitationsSupported(input, corpus, scorer, { drop: true })
    const inIds = new Set(input.map((c) => c.note))
    for (const c of out) expect(inIds.has(c.note)).toBe(true)
  })
})

describe('retrieveContext — SUPPORT gate wiring (opt-in, injectable)', () => {
  const driverCiting: TurnFn = async () => ({
    content:
      '{"citations":[{"note":"beacon.md","lines":[4,4],"snippet":"Blocked until we hire a designer","why":"answers what blocks Beacon"}]}',
    toolCalls: []
  })

  it('with support ON + an injected scorer, citations carry the support fields', async () => {
    const scorer: NliScoreFn = async (pairs) => pairs.map(() => 0.9)
    const r = await retrieveContext('what blocks Beacon', {
      notes: NOTES,
      graph: GRAPH,
      runTurnFn: driverCiting,
      hyde: false,
      support: true,
      nliScore: scorer
    })
    expect(r?.citations).toHaveLength(1)
    expect(r?.citations[0].supported).toBe(true)
    expect(r?.citations[0].support).toBeCloseTo(0.9)
  })

  it('with support OFF (default), no support fields are added (byte-identical to today)', async () => {
    let scorerCalled = false
    const scorer: NliScoreFn = async (pairs) => {
      scorerCalled = true
      return pairs.map(() => 0.9)
    }
    const r = await retrieveContext('what blocks Beacon', {
      notes: NOTES,
      graph: GRAPH,
      runTurnFn: driverCiting,
      hyde: false,
      support: false,
      nliScore: scorer
    })
    expect(scorerCalled).toBe(false)
    expect(r?.citations[0].supported).toBeUndefined()
    expect(r?.citations[0].support).toBeUndefined()
  })

  it('with support ON but the model unavailable (scorer → null), grounding is unchanged', async () => {
    const scorer: NliScoreFn = async () => null
    const r = await retrieveContext('what blocks Beacon', {
      notes: NOTES,
      graph: GRAPH,
      runTurnFn: driverCiting,
      hyde: false,
      support: true,
      nliScore: scorer
    })
    expect(r?.citations).toHaveLength(1)
    expect(r?.citations[0].supported).toBeUndefined()
  })
})

describe('parsePlan — HyDE + decomposition (tolerant)', () => {
  it('parses subQueries + hypotheticalDoc, always keeping the original query first', () => {
    const p = parsePlan('{"subQueries":["designer hire","Beacon owner"],"hypotheticalDoc":"Beacon is blocked."}', 'what blocks Beacon')
    expect(p.subQueries[0]).toBe('what blocks Beacon')
    expect(p.subQueries).toContain('designer hire')
    expect(p.hypotheticalDoc).toBe('Beacon is blocked.')
  })
  it('handles a fenced ```json block', () => {
    const p = parsePlan('```json\n{"subQueries":["x"],"hypotheticalDoc":"y"}\n```', 'q')
    expect(p.hypotheticalDoc).toBe('y')
    expect(p.subQueries).toEqual(['q', 'x'])
  })
  it('garbage / missing fields → safe fallback {[query], ""}', () => {
    expect(parsePlan('not json at all', 'q')).toEqual({ subQueries: ['q'], hypotheticalDoc: '' })
    expect(parsePlan('{"subQueries":"nope"}', 'q')).toEqual({ subQueries: ['q'], hypotheticalDoc: '' })
    expect(parsePlan('', 'q')).toEqual({ subQueries: ['q'], hypotheticalDoc: '' })
  })
  it('dedups and caps the fan-out at 5', () => {
    const p = parsePlan('{"subQueries":["a","a","b","c","d","e","f"]}', 'q')
    expect(p.subQueries).toEqual(['q', 'a', 'b', 'c', 'd']) // q + 4, deduped, capped at 5
  })
})

describe('planRetrieval — never throws', () => {
  it('a throwing driver resolves to the safe fallback', async () => {
    const boom: TurnFn = async () => { throw new Error('provider down') }
    expect(await planRetrieval('q', boom)).toEqual({ subQueries: ['q'], hypotheticalDoc: '' })
  })
})

describe('retrieveContext', () => {
  it('returns null when no model is configured (caller falls back to search())', async () => {
    const r = await retrieveContext('what blocks Beacon', { model: null, notes: NOTES, graph: GRAPH })
    expect(r).toBeNull()
  })

  it('returns null for an empty query', async () => {
    const r = await retrieveContext('   ', { notes: NOTES, graph: GRAPH })
    expect(r).toBeNull()
  })

  it('HyDE pre-loop plans, seeds grepped evidence into the loop, and still returns citations', async () => {
    let loopSawSeed = false
    const driver: TurnFn = async (msgs) => {
      const sys = String(msgs[0]?.content ?? '')
      if (sys.includes('PLANNING step')) {
        // plan: decompose + a hypothetical answer
        return { content: '{"subQueries":["designer"],"hypotheticalDoc":"Beacon is blocked until a designer is hired."}', toolCalls: [] }
      }
      // loop turn: the seed evidence (grep of "designer" over the corpus) must be present
      loopSawSeed = msgs.some((m) => String(m.content ?? '').includes('Pre-fetched seed evidence'))
      return { content: '{"citations":[{"note":"beacon.md","lines":[4,4],"snippet":"Blocked until we hire a designer","why":"answers what blocks Beacon"}]}', toolCalls: [] }
    }
    const r = await retrieveContext('what blocks Beacon', { notes: NOTES, graph: GRAPH, runTurnFn: driver, hyde: true })
    expect(loopSawSeed).toBe(true) // deterministic grep seed was injected
    expect(r?.citations.map((c) => c.note)).toEqual(['beacon.md'])
  })

  it('with hyde OFF, no planning call is made (byte-identical one-shot)', async () => {
    let sawPlan = false
    const driver: TurnFn = async (msgs) => {
      if (String(msgs[0]?.content ?? '').includes('PLANNING step')) sawPlan = true
      return { content: '{"citations":[]}', toolCalls: [] }
    }
    await retrieveContext('q', { notes: NOTES, graph: GRAPH, runTurnFn: driver, hyde: false })
    expect(sawPlan).toBe(false)
  })
})
