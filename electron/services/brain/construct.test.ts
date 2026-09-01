import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  parseConstruction,
  applyConstruction,
  synonymEdges,
  getConstruction,
  getResolvedConstruction,
  setConstructPaths,
  __resetConstructionForTest
} from './construct'
import type { CausalGraph, ConstructedData, ConstructedEntity } from './types'

/** Mirror construct.ts's private dirKey() so the test can stamp a cache file
 *  with the key the module will compute for a given notes dir. */
function dirKeyFor(dir: string): string {
  return createHash('sha1').update(dir).digest('hex').slice(0, 16)
}

describe('parseConstruction', () => {
  it('parses a clean JSON object', () => {
    const c = parseConstruction(
      JSON.stringify({
        entities: [
          { id: 'person:jordan-lee', kind: 'person', label: 'Jordan Lee', note: 'a.md' },
          { id: 'topic:atlas', kind: 'topic', label: 'Atlas', note: 'a.md' }
        ],
        edges: [{ source: 'person:jordan-lee', target: 'topic:atlas', type: 'owns' }],
        classifications: [{ note: 'a.md', type: 'meeting' }]
      })
    )
    expect(c.entities).toHaveLength(2)
    expect(c.entities[0].kind).toBe('person')
    expect(c.edges[0].type).toBe('owns')
    expect(c.classifications[0].type).toBe('meeting')
  })

  it('parses OPEN-VOCABULARY triples (any relation phrase) and drops incomplete ones', () => {
    const c = parseConstruction(
      JSON.stringify({
        entities: [],
        edges: [],
        classifications: [],
        triples: [
          { subject: '北澜', relation: 'has deadline', object: 'August 2026', note: 'moon.md' },
          { subject: 'Theo', relation: 'prefers', object: 'Neovim', note: 'prefs.md' },
          { subject: 'x', relation: '', object: 'y', note: 'z.md' }, // empty relation → dropped
          { subject: 'a', object: 'b', note: 'c.md' } // missing relation → dropped
        ]
      })
    )
    expect(c.triples).toHaveLength(2)
    expect(c.triples![0]).toMatchObject({ subject: '北澜', relation: 'has deadline', object: 'August 2026', note: 'moon.md' })
    expect(c.triples![1].relation).toBe('prefers') // arbitrary relation, not the fixed edge vocab
  })

  it('parses LLM-extracted per-fact temporal validity (validFrom/validUntil), guarding junk dates', () => {
    const c = parseConstruction(
      JSON.stringify({
        triples: [
          { subject: 'deal', relation: 'status', object: 'active', note: 'd.md', validFrom: '2026-01-01', validUntil: '2026-05-29' },
          { subject: 'x', relation: 'is', object: 'y', note: 'n.md', validFrom: 'someday', validUntil: null }
        ]
      })
    )
    expect(c.triples![0].validFrom).toBe('2026-01-01')
    expect(c.triples![0].validUntil).toBe('2026-05-29')
    expect(c.triples![1].validFrom).toBeNull() // junk "someday" → null
    expect(c.triples![1].validUntil).toBeNull()
  })

  it('tolerates a code fence + leading prose', () => {
    const c = parseConstruction(
      'Sure!\n```json\n{"entities":[{"id":"person:sam","kind":"person","label":"Sam","note":"n.md"}],"edges":[],"classifications":[]}\n```'
    )
    expect(c.entities).toHaveLength(1)
    expect(c.entities[0].label).toBe('Sam')
  })

  it('drops malformed items (bad kind/type, missing fields) but keeps the rest', () => {
    const c = parseConstruction(
      JSON.stringify({
        entities: [
          { id: 'person:ok', kind: 'person', label: 'OK', note: 'n.md' },
          { id: 'x:bad', kind: 'alien', label: 'Bad kind', note: 'n.md' }, // bad kind → dropped
          { id: '', kind: 'person', label: 'No id', note: 'n.md' }, // empty id → dropped
          { id: 'person:nolabel', kind: 'person', label: '', note: 'n.md' } // empty label → dropped
        ],
        edges: [
          { source: 'person:ok', target: 'topic:p', type: 'depends_on' },
          { source: 'a', target: 'b', type: 'frobnicate' }, // bad relation → dropped
          { source: 'a', type: 'owns' } // missing target → dropped
        ],
        classifications: [
          { note: 'n.md', type: 'output' },
          { note: 'n.md', type: 'wat' }, // bad type → dropped
          { type: 'note' } // missing note → dropped
        ]
      })
    )
    expect(c.entities).toHaveLength(1)
    expect(c.entities[0].id).toBe('person:ok')
    expect(c.edges).toHaveLength(1)
    expect(c.edges[0].type).toBe('depends_on')
    expect(c.classifications).toHaveLength(1)
    expect(c.classifications[0].type).toBe('output')
  })

  it('returns empty on garbage', () => {
    expect(parseConstruction('not json at all')).toEqual({
      entities: [],
      edges: [],
      classifications: []
    })
    expect(parseConstruction('')).toEqual({ entities: [], edges: [], classifications: [] })
  })
})

describe('applyConstruction', () => {
  const base: CausalGraph = {
    nodes: [
      { id: 'a.md', kind: 'stream', label: 'Kickoff', track: 'work' },
      { id: 'b.md', kind: 'stream', label: 'Design doc', track: 'work' }
    ],
    edges: []
  }

  it('adds entity nodes (with track from their note), maps edges, and stamps classification', () => {
    const g = applyConstruction(base, {
      entities: [
        { id: 'person:jordan-lee', kind: 'person', label: 'Jordan Lee', note: 'a.md' },
        { id: 'topic:atlas', kind: 'topic', label: 'Atlas', note: 'a.md' }
      ],
      edges: [
        { source: 'person:jordan-lee', target: 'topic:atlas', type: 'owns' },
        { source: 'person:jordan-lee', target: 'a.md', type: 'attends' } // entity → note
      ],
      classifications: [{ note: 'a.md', type: 'meeting' }]
    })
    const jordan = g.nodes.find((n) => n.id === 'person:jordan-lee')!
    expect(jordan.kind).toBe('person')
    expect(jordan.track).toBe('work') // inherited from a.md
    expect(g.nodes.some((n) => n.id === 'topic:atlas')).toBe(true)

    // owns → 'owns' edge; attends → 'attends' edge; both endpoints known.
    expect(
      g.edges.some((e) => e.source === 'person:jordan-lee' && e.target === 'topic:atlas' && e.type === 'owns')
    ).toBe(true)
    expect(
      g.edges.some((e) => e.source === 'person:jordan-lee' && e.target === 'a.md' && e.type === 'attends')
    ).toBe(true)

    // classification stamped on the note node.
    expect(g.nodes.find((n) => n.id === 'a.md')!.classification).toBe('meeting')
  })

  it('dedups entities by id and never clobbers an existing node', () => {
    const g = applyConstruction(base, {
      entities: [
        { id: 'a.md', kind: 'topic', label: 'Should NOT clobber', note: 'a.md' }, // collides w/ real node
        { id: 'person:sam', kind: 'person', label: 'Sam', note: 'b.md' },
        { id: 'person:sam', kind: 'person', label: 'Sam (dupe)', note: 'a.md' } // duplicate id → dropped
      ],
      edges: [],
      classifications: []
    })
    const a = g.nodes.filter((n) => n.id === 'a.md')
    expect(a).toHaveLength(1)
    expect(a[0].kind).toBe('stream') // original kind preserved, not 'topic'
    expect(a[0].label).toBe('Kickoff') // original label preserved
    const sam = g.nodes.filter((n) => n.id === 'person:sam')
    expect(sam).toHaveLength(1)
    expect(sam[0].label).toBe('Sam') // first one wins
  })

  it('skips an edge to an unknown id, but keeps one whose unknown id is a NEW entity', () => {
    const g = applyConstruction(base, {
      entities: [{ id: 'org:acme', kind: 'org', label: 'Acme', note: 'a.md' }],
      edges: [
        { source: 'a.md', target: 'org:acme', type: 'mentions' }, // org:acme is a new entity → kept
        { source: 'a.md', target: 'ghost:missing', type: 'mentions' } // unknown → skipped
      ],
      classifications: []
    })
    expect(g.edges.some((e) => e.target === 'org:acme' && e.type === 'mentions')).toBe(true)
    expect(g.edges.some((e) => e.target === 'ghost:missing')).toBe(false)
  })

  it('dedups edges and drops self-edges; relation maps to edge type', () => {
    const g = applyConstruction(base, {
      entities: [],
      edges: [
        { source: 'a.md', target: 'b.md', type: 'depends_on' },
        { source: 'a.md', target: 'b.md', type: 'depends_on' }, // exact dup → one edge
        { source: 'a.md', target: 'a.md', type: 'blocks' } // self-edge → dropped
      ],
      classifications: []
    })
    const dep = g.edges.filter((e) => e.source === 'a.md' && e.target === 'b.md')
    expect(dep).toHaveLength(1)
    expect(dep[0].type).toBe('depends') // depends_on → 'depends'
    expect(g.edges.some((e) => e.source === e.target)).toBe(false)
  })

  it('does not mutate the base graph', () => {
    const g = applyConstruction(base, {
      entities: [{ id: 'topic:x', kind: 'topic', label: 'X', note: 'a.md' }],
      edges: [],
      classifications: [{ note: 'a.md', type: 'note' }]
    })
    expect(g).not.toBe(base)
    expect(base.nodes).toHaveLength(2) // unchanged
    expect(base.nodes.find((n) => n.id === 'a.md')!.classification).toBeUndefined()
  })
})

// ──────────────────── L3 synonym bridge (PURE, injected vectors — no model) ────────────────────

describe('synonymEdges — embedding-clustered alias bridge edges', () => {
  const ent = (id: string, label: string): ConstructedEntity => ({
    id,
    kind: 'project',
    label,
    note: 'a.md'
  })
  // 2-D unit vectors: alias vectors point the ~same way, distinct entities orthogonal.
  const moon1 = [1, 0] // 北澜
  const moon2 = [0.99, 0.14] // 《北澜》 — cos ≈ 0.99 with moon1
  const atlas = [0, 1] // orthogonal — a distinct entity

  it('emits ONE synonym edge between same-cluster entities of different ids; leaves distinct entities apart', () => {
    const entities = [
      ent('topic:beilan', '北澜'),
      ent('project:beilan', '《北澜》'),
      ent('project:atlas', 'Project Atlas')
    ]
    const edges = synonymEdges(entities, [moon1, moon2, atlas], 0.86)
    expect(edges).toHaveLength(1)
    expect(edges[0].type).toBe('synonym')
    // one directed edge per unordered pair, deterministic source<target ordering
    const pair = new Set([edges[0].source, edges[0].target])
    expect(pair).toEqual(new Set(['topic:beilan', 'project:beilan']))
    expect(edges[0].source < edges[0].target).toBe(true)
    // the orthogonal entity is bridged to nothing
    expect(edges.some((e) => e.source === 'project:atlas' || e.target === 'project:atlas')).toBe(false)
  })

  it('a 3-alias cluster emits the COMPLETE graph (all C(3,2)=3 cross-id pairs)', () => {
    const entities = [ent('a:1', '北澜'), ent('a:2', '《北澜》'), ent('a:3', '北澜 (2026)')]
    const edges = synonymEdges(entities, [moon1, moon2, [0.98, 0.2]], 0.86)
    expect(edges).toHaveLength(3)
    const pairs = new Set(edges.map((e) => `${e.source}|${e.target}`))
    expect(pairs.size).toBe(3) // no duplicate unordered pairs
    expect(edges.every((e) => e.type === 'synonym')).toBe(true)
  })

  it('same label / DIFFERENT id still coalesces into a bridge edge', () => {
    const edges = synonymEdges([ent('x:1', '北澜'), ent('x:2', '北澜')], [moon1, moon1], 0.86)
    expect(edges).toHaveLength(1)
  })

  it('degrades to [] when the embedder is unavailable (vector-count mismatch)', () => {
    const entities = [ent('a:1', '北澜'), ent('a:2', '《北澜》')]
    expect(synonymEdges(entities, [], 0.86)).toEqual([]) // no vectors
    expect(synonymEdges(entities, [moon1], 0.86)).toEqual([]) // partial → mismatch
  })

  it('degrades to [] for fewer than 2 entities', () => {
    expect(synonymEdges([ent('a:1', '北澜')], [moon1], 0.86)).toEqual([])
    expect(synonymEdges([], [], 0.86)).toEqual([])
  })

  it('respects the cosine threshold boundary (just-below does NOT bridge, just-above does)', () => {
    const base = [1, 0]
    // cosine with [1,0] equals the x-component of a unit vector.
    const below = [0.85, Math.sqrt(1 - 0.85 * 0.85)] // cos = 0.85 < 0.86
    const above = [0.87, Math.sqrt(1 - 0.87 * 0.87)] // cos = 0.87 > 0.86
    const entities = [ent('a:1', 'L1'), ent('a:2', 'L2')]
    expect(synonymEdges(entities, [base, below], 0.86)).toHaveLength(0)
    expect(synonymEdges(entities, [base, above], 0.86)).toHaveLength(1)
  })
})

describe('applyConstruction — carries a synonym edge through to the render graph', () => {
  const base: CausalGraph = {
    nodes: [{ id: 'a.md', kind: 'stream', label: 'Notes', track: 'work' }],
    edges: []
  }
  it('a type:"synonym" ConstructedEdge maps to a synonym CausalEdge (not undefined)', () => {
    const g = applyConstruction(base, {
      entities: [
        { id: 'topic:beilan', kind: 'topic', label: '北澜', note: 'a.md' },
        { id: 'project:beilan', kind: 'project', label: '《北澜》', note: 'a.md' }
      ],
      edges: [{ source: 'topic:beilan', target: 'project:beilan', type: 'synonym' }],
      classifications: []
    })
    const syn = g.edges.filter((e) => e.type === 'synonym')
    expect(syn).toHaveLength(1)
    expect(syn[0]).toMatchObject({ source: 'topic:beilan', target: 'project:beilan', type: 'synonym' })
    expect(g.edges.some((e) => e.type === undefined)).toBe(false)
  })
})

describe('getConstruction — notes-dir staleness guard', () => {
  let userData = ''
  afterEach(() => {
    __resetConstructionForTest()
    if (userData) {
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
      userData = ''
    }
  })

  it('does not return dir A\'s construction after the notes dir is re-pointed to B', () => {
    userData = mkdtempSync(join(tmpdir(), 'construct-stale-'))
    const dirA = '/vault/A'
    const dirB = '/vault/B'

    // Cache file for dir A (legacy path — neither vault has a `.brain/` root).
    const aData: ConstructedData = {
      entities: [{ id: 'person:a-only', kind: 'person', label: 'A Only', note: 'a.md' }],
      edges: [],
      classifications: []
    }
    writeFileSync(
      join(userData, 'brain-construction.json'),
      JSON.stringify({ key: dirKeyFor(dirA), builtAt: new Date().toISOString(), data: aData }),
      'utf-8'
    )

    // Point at A → hydrates A's construction into the module's in-memory copy.
    let notesDir = dirA
    setConstructPaths(userData, () => notesDir)
    const a = getConstruction()
    expect(a?.entities.map((e) => e.id)).toEqual(['person:a-only'])

    // Re-point to B mid-session. The cached file is keyed to A, so B has no
    // matching cache → getConstruction() must NOT bleed A's data through the
    // stale in-memory copy. (Pre-fix it returned A unconditionally.)
    notesDir = dirB
    expect(getConstruction()).toBeNull()
  })
})

describe('getResolvedConstruction — identity-spine P6 shared accessor', () => {
  let userData = ''
  const prevFlag = process.env.DUIN_ENTITY_RESOLVER
  afterEach(() => {
    __resetConstructionForTest()
    if (prevFlag === undefined) delete process.env.DUIN_ENTITY_RESOLVER
    else process.env.DUIN_ENTITY_RESOLVER = prevFlag
    if (userData) {
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
      userData = ''
    }
  })

  // Cache a construction carrying a WHITELISTED duplicate fragment: label 'aurora' with the
  // churning slug id 'topic:aurora' → canonical 'topic:曙光'. Since cold-start A1 the
  // whitelist is per-vault (`.duin/_state/entity-aliases.json`) rather than compiled in, so the
  // vault dir must be a real directory the accessor can read the whitelist from.
  const seedFragmentCache = (withWhitelist = true): void => {
    userData = mkdtempSync(join(tmpdir(), 'construct-p6-'))
    const dir = userData
    const data: ConstructedData = {
      entities: [
        { id: 'topic:aurora', kind: 'topic', label: 'aurora', note: 'a.md' },
        { id: 'topic:other', kind: 'topic', label: 'Other', note: 'a.md' }
      ],
      edges: [{ source: 'topic:aurora', target: 'topic:other', type: 'about' }],
      classifications: []
    }
    writeFileSync(
      join(userData, 'brain-construction.json'),
      JSON.stringify({ key: dirKeyFor(dir), builtAt: new Date().toISOString(), data }),
      'utf-8'
    )
    if (withWhitelist) {
      mkdirSync(join(dir, '.duin', '_state'), { recursive: true })
      writeFileSync(
        join(dir, '.duin', '_state', 'entity-aliases.json'),
        JSON.stringify([{ canonicalId: 'topic:曙光', canonical: '曙光', aliases: ['曙光', 'aurora'] }]),
        'utf-8'
      )
    }
    setConstructPaths(userData, () => dir)
  }

  it('default-on: collapses a whitelisted fragment id (+ its edge endpoint) onto the canonical id', () => {
    delete process.env.DUIN_ENTITY_RESOLVER
    seedFragmentCache()
    // Raw read still carries the churning fragment id.
    expect(getConstruction()?.entities.map((e) => e.id)).toContain('topic:aurora')
    // Resolved read collapses it onto the stable canonical id.
    const resolved = getResolvedConstruction()
    const ids = resolved?.entities.map((e) => e.id)
    expect(ids).toContain('topic:曙光')
    expect(ids).not.toContain('topic:aurora')
    expect(resolved?.edges[0].source).toBe('topic:曙光') // edge endpoint rewired too
  })

  it('no per-vault whitelist (the cold-start default): nothing merges', () => {
    delete process.env.DUIN_ENTITY_RESOLVER
    seedFragmentCache(false)
    expect(getResolvedConstruction()?.entities.map((e) => e.id)).toContain('topic:aurora')
  })

  it('kill-switch (DUIN_ENTITY_RESOLVER=0): byte-identical raw passthrough (SAME reference)', () => {
    process.env.DUIN_ENTITY_RESOLVER = '0'
    seedFragmentCache()
    const raw = getConstruction()
    const resolved = getResolvedConstruction()
    expect(resolved).toBe(raw) // no resolve, no clone — the raw cache object itself
    expect(resolved?.entities.map((e) => e.id)).toContain('topic:aurora')
  })

  it('memoized: repeated calls in one construction generation return the SAME resolved object', () => {
    delete process.env.DUIN_ENTITY_RESOLVER
    seedFragmentCache()
    const a = getResolvedConstruction()
    const b = getResolvedConstruction()
    expect(a).toBe(b) // memo reuse — the pure resolver is not recomputed each call
  })
})
