import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// G1 + G2 — the answer-path evidence gate on the DEFAULT (agentic citation) path.
//
// THE DEFECT, in two halves that only bite together:
//
//   G1  server.ts:citationsToHits returns { file, snippet, score } with no `rawScore`, on the
//       stated grounds that "a model citation has no absolute relevance scale". True about
//       INVENTING a number, wrong as a conclusion: the cited note is a real file in the vector
//       index and the index can be asked what this query's best chunk cosine against it is. With
//       no rawScore, assessEvidence returns 'no-absolute-signal' and fails open — inert.
//
//   G2  buildGroundedMessages ran the gate only when `!contextOverride`. The default-ON agentic
//       pass writes contextOverride whenever it returns citations (server.ts, after the four
//       ranking stages), so on a default install the gate NEVER saw the citation branch. Off-corpus
//       answers decorated with noise citations sailed through ungated — the exact calibrated
//       failure class the gate was built for.
//
// Fixing G2 alone is a no-op (no rawScore ⇒ still fails open); fixing G1 alone is unreachable
// (the gate is skipped). These tests drive the REAL buildGroundedMessages on a citation-shaped
// turn and assert the caveat actually reaches the prompt.

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-agui-grounding-evidence-test',
    getName: () => 'duin',
    getAppPath: () => process.cwd(),
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: () => {}, on: () => {} },
  shell: {},
  dialog: {}
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

/** Per-file best chunk cosine the fake vector index will report for the probe query. */
const VECTOR_INDEX: Record<string, number> = {}
const searchCalls: { query: string; k: number }[] = []

vi.mock('./index-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./index-store')>()
  return {
    ...actual,
    // The gate is EMBEDDER-SPECIFIC: assessEvidence goes inert unless this matches the id the
    // floor was calibrated against, so it must be pinned rather than left to the environment.
    resolveEmbedderId: () => 'multilingual-e5-small',
    embedForRecall: async () => [],
    search: async (query: string, k = 6) => {
      searchCalls.push({ query, k })
      return Object.entries(VECTOR_INDEX).map(([file, rawScore]) => ({
        file,
        snippet: `chunk of ${file}`,
        score: 1,
        rawScore
      }))
    }
  }
})

const QUERY = 'what did we decide about the launch window'
const HISTORY = [{ role: 'user' as const, content: QUERY }]

/** The shape server.ts hands over on the default agentic path: citationsToHits output (no
 *  rawScore, descending rank proxy) plus the citation-rendered contextOverride built FROM those
 *  same hits by citationsToContext(orderCitationsByHits(...)). */
const CITATION_HITS = [
  { file: 'notes/alpha.md', snippet: 'alpha body', score: 1 },
  { file: 'notes/beta.md', snippet: 'beta body', score: 0.5 }
]
const CITATION_CONTEXT =
  '[1] (notes/alpha.md:3-9)\nalpha body\nwhy: mentions the launch\n\n' +
  '[2] (notes/beta.md)\nbeta body\nwhy: adjacent'

const allText = (msgs: { content?: unknown }[]): string =>
  msgs.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n')

async function build(
  hits: { file: string; snippet: string; score: number; rawScore?: number }[],
  contextOverride?: string,
  describedByHits?: boolean
): Promise<string> {
  const { buildGroundedMessages } = await import('./agui-grounding')
  return allText(
    await buildGroundedMessages(
      HISTORY,
      QUERY,
      hits,
      contextOverride,
      null,
      'thread-evidence',
      undefined,
      undefined,
      undefined,
      undefined,
      describedByHits
    )
  )
}

const THIN_MARKER = 'only weakly related to this question'
const NO_HITS_MARKER = 'Retrieval returned nothing from the local index'

const ENV_KEYS = ['DUIN_EVIDENCE_GATE', 'DUIN_EVIDENCE_BACKFILL', 'DUIN_RECALL_ESCALATE'] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  // The raw-escalation pass reads note files off disk; irrelevant here and default-ON.
  process.env.DUIN_RECALL_ESCALATE = '0'
  delete process.env.DUIN_EVIDENCE_GATE
  delete process.env.DUIN_EVIDENCE_BACKFILL
  for (const k of Object.keys(VECTOR_INDEX)) delete VECTOR_INDEX[k]
  searchCalls.length = 0
})
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k] as string
  }
})

describe('evidence gate — default agentic citation path (G1 + G2)', () => {
  it('FIRES on a citation-path turn whose cited notes are all below the measured floor', async () => {
    // Off-corpus shape: every cited note's true best cosine sits in the off-corpus band
    // (< EVIDENCE_FLOOR 0.432), so the answer is being built on noise citations.
    VECTOR_INDEX['notes/alpha.md'] = 0.414
    VECTOR_INDEX['notes/beta.md'] = 0.398

    const prompt = await build(CITATION_HITS, CITATION_CONTEXT)

    expect(prompt).toContain(CITATION_CONTEXT) // the citation context is still what is grounded
    expect(prompt).toContain(THIN_MARKER) // …and the gate judged it
    // The gate had to have been given a real number: it cannot reach 'thin' from 'no signal'.
    expect(searchCalls.length).toBe(1)
    expect(searchCalls[0].query).toBe(QUERY)
  })

  it('stays SILENT on a citation-path turn whose cited notes are on-corpus', async () => {
    VECTOR_INDEX['notes/alpha.md'] = 0.538 // on-corpus median
    VECTOR_INDEX['notes/beta.md'] = 0.44
    const prompt = await build(CITATION_HITS, CITATION_CONTEXT)
    expect(prompt).not.toContain(THIN_MARKER)
    expect(prompt).not.toContain(NO_HITS_MARKER)
  })

  it('fails OPEN when the vector index can score none of the cited notes', async () => {
    // No vector rows for either file (cold index / lexical-only match). Abstention must be
    // EARNED by seeing low relevance, never triggered by the absence of information.
    const prompt = await build(CITATION_HITS, CITATION_CONTEXT)
    expect(prompt).not.toContain(THIN_MARKER)
    expect(searchCalls.length).toBe(1) // it did try
  })

  it('does NOT probe when the hits already carry rawScore (self-disarming)', async () => {
    // This is the shape server.ts would hand over if citationsToHits attached rawScore itself —
    // the free version of G1. The in-lane probe must then cost nothing.
    VECTOR_INDEX['notes/alpha.md'] = 0.9 // would contradict the supplied score if consulted
    const prompt = await build(
      [
        { ...CITATION_HITS[0], rawScore: 0.4 },
        { ...CITATION_HITS[1], rawScore: 0.39 }
      ],
      CITATION_CONTEXT
    )
    expect(searchCalls.length).toBe(0)
    expect(prompt).toContain(THIN_MARKER) // judged on the supplied numbers, not the probe's
  })

  it('DUIN_EVIDENCE_BACKFILL=0 skips the probe and leaves the gate fail-open', async () => {
    process.env.DUIN_EVIDENCE_BACKFILL = '0'
    VECTOR_INDEX['notes/alpha.md'] = 0.414
    VECTOR_INDEX['notes/beta.md'] = 0.398
    const prompt = await build(CITATION_HITS, CITATION_CONTEXT)
    expect(searchCalls.length).toBe(0)
    expect(prompt).not.toContain(THIN_MARKER)
  })

  it('DUIN_EVIDENCE_GATE=0 still turns the whole thing off', async () => {
    process.env.DUIN_EVIDENCE_GATE = '0'
    VECTOR_INDEX['notes/alpha.md'] = 0.414
    VECTOR_INDEX['notes/beta.md'] = 0.398
    const prompt = await build(CITATION_HITS, CITATION_CONTEXT)
    expect(prompt).not.toContain(THIN_MARKER)
    expect(searchCalls.length).toBe(0)
  })
})

describe('evidence gate — the paths whose context is NOT described by `hits`', () => {
  // graph-expand and whole-note grounding build `contextOverride` from a DIFFERENT note set than
  // the RRF `hits`. Judging those hits there would be judging the wrong evidence, which is what
  // the original blunt `!contextOverride` skip was protecting — that part must survive G2.
  const FOREIGN_CONTEXT =
    'notes/gamma.md\n\nthe whole body of an unrelated note the graph walk pulled in'

  it('is SKIPPED when the override came from another grounding path', async () => {
    VECTOR_INDEX['notes/alpha.md'] = 0.1 // would trip the gate hard if it were consulted
    VECTOR_INDEX['notes/beta.md'] = 0.1
    const prompt = await build(CITATION_HITS, FOREIGN_CONTEXT)
    expect(prompt).toContain(FOREIGN_CONTEXT)
    expect(prompt).not.toContain(THIN_MARKER)
    expect(searchCalls.length).toBe(0)
  })

  it('an explicit contextDescribedByHits=false wins over the derivation', async () => {
    // The seam server.ts should fill at its three context writes. Passing false must suppress the
    // gate even when the context does happen to name every hit file.
    VECTOR_INDEX['notes/alpha.md'] = 0.1
    VECTOR_INDEX['notes/beta.md'] = 0.1
    const prompt = await build(CITATION_HITS, CITATION_CONTEXT, false)
    expect(prompt).not.toContain(THIN_MARKER)
    expect(searchCalls.length).toBe(0)
  })

  it('an explicit contextDescribedByHits=true opens the gate on a context it does not name', async () => {
    VECTOR_INDEX['notes/alpha.md'] = 0.1
    VECTOR_INDEX['notes/beta.md'] = 0.1
    const prompt = await build(CITATION_HITS, FOREIGN_CONTEXT, true)
    expect(prompt).toContain(THIN_MARKER)
  })
})

describe('evidence gate — the fallback path is untouched', () => {
  it('still gates when there is no contextOverride at all', async () => {
    const prompt = await build([{ file: 'notes/alpha.md', snippet: 'a', score: 1, rawScore: 0.4 }])
    expect(prompt).toContain(THIN_MARKER)
    expect(searchCalls.length).toBe(0) // rawScore present ⇒ no probe
  })

  it('still emits the no-hits caveat on an empty fallback retrieval', async () => {
    const prompt = await build([])
    expect(prompt).toContain(NO_HITS_MARKER)
  })
})

describe('contextRenderedFromHits — the derivation, in isolation', () => {
  it('is true when there is no override (the context IS the hits)', async () => {
    const { contextRenderedFromHits } = await import('./agui-grounding')
    expect(contextRenderedFromHits(undefined, [])).toBe(true)
    expect(contextRenderedFromHits(undefined, [{ file: 'a.md' }])).toBe(true)
  })

  it('is true when the override names every hit file (citationsToContext always does)', async () => {
    const { contextRenderedFromHits } = await import('./agui-grounding')
    expect(contextRenderedFromHits(CITATION_CONTEXT, CITATION_HITS)).toBe(true)
  })

  it('is false when the override names a different note set', async () => {
    const { contextRenderedFromHits } = await import('./agui-grounding')
    expect(contextRenderedFromHits('[1] (notes/gamma.md)\nbody', CITATION_HITS)).toBe(false)
    // partial coverage is not coverage
    expect(contextRenderedFromHits('[1] (notes/alpha.md)\nbody', CITATION_HITS)).toBe(false)
  })

  it('is false for an override with no hits behind it at all', async () => {
    const { contextRenderedFromHits } = await import('./agui-grounding')
    expect(contextRenderedFromHits('some context', [])).toBe(false)
  })
})

// The fixture above is hand-written to LOOK like the citation path. This closes that gap: build the
// context with the REAL production renderer and assert the derivation still says "yes". Without
// this, a change to citationsToContext's format (dropping the note path, say) would silently make
// the gate stop firing on the default path again and every test above would stay green.
describe('contextRenderedFromHits ← citationsToContext (real producer)', () => {
  it('says true for the exact block server.ts writes on the default agentic path', async () => {
    const { citationsToContext, orderCitationsByHits, citationsToHits } = await import('./server')
    const { contextRenderedFromHits } = await import('./agui-grounding')

    const citations = [
      { note: 'notes/alpha.md', lines: [3, 9] as [number, number], snippet: 'A', why: 'wA' },
      { note: 'notes/beta.md', snippet: 'B', why: 'wB' }
    ]
    // Exactly server.ts's default path: citations → hits → (stages reorder) → render.
    const hits = citationsToHits(citations)
    // Simulate a stage promoting beta over alpha, plus stage 1 adding a graph neighbour with no
    // citation behind it — orderCitationsByHits synthesizes one, so it must still be named.
    const staged = [hits[1], hits[0], { file: 'notes/linked.md', snippet: '(linked) n', score: 0.25 }]
    const context = citationsToContext(orderCitationsByHits(citations, staged))

    expect(contextRenderedFromHits(context, staged)).toBe(true)
    // …and the negative: the same hits against a block rendered from a different note set.
    const foreign = citationsToContext([{ note: 'notes/gamma.md', snippet: 'G', why: 'wG' }])
    expect(contextRenderedFromHits(foreign, staged)).toBe(false)
  })
})

describe('attachAbsoluteScores — pure', () => {
  it('attaches only where the file has vector rows and the hit has no score yet', async () => {
    const { attachAbsoluteScores } = await import('./agui-grounding')
    const out = attachAbsoluteScores(
      [
        { file: 'a.md' },
        { file: 'b.md', rawScore: 0.7 },
        { file: 'c.md' } // no vector rows
      ],
      new Map([
        ['a.md', 0.41],
        ['b.md', 0.99]
      ])
    )
    expect(out[0].rawScore).toBe(0.41)
    expect(out[1].rawScore).toBe(0.7) // an existing measurement is never overwritten
    expect(out[2].rawScore).toBeUndefined() // absent stays absent — fail-open, never 0
  })

  it('returns the SAME array when there is nothing to attach (allocation-free common case)', async () => {
    const { attachAbsoluteScores } = await import('./agui-grounding')
    const hits = [{ file: 'a.md', rawScore: 0.5 }]
    expect(attachAbsoluteScores(hits, new Map([['a.md', 0.9]]))).toBe(hits)
    expect(attachAbsoluteScores(hits, new Map())).toBe(hits)
    const unscored = [{ file: 'zzz.md' }]
    expect(attachAbsoluteScores(unscored, new Map([['a.md', 0.9]]))).toBe(unscored)
  })
})
