// PIN — the agentic retriever's citations must be RANKED by the four shared downstream stages, not
// bypass them.
//
// THE DEFECT THIS LOCKS DOWN. `server.ts` used to write `contextOverride` at the agentic dispatch
// site. Four stages are gated on `!contextOverride`:
//     1. 1-hop graph-neighbour merge   (mergeGraphNeighbors)
//     2. cross-encoder rerank          (rerankHits)
//     3. taste-rerank                  (tasteRerank)
//     4. claim-freshness demotion      (applyClaimFreshness)
// and the agentic pass is default-ON whenever a model is configured, so on a typical install that one
// assignment deleted all four from the hot path. It shipped on a code comment — "the agentic pass
// already ranks its own citations" — that had never been measured.
//
// IT WAS MEASURED (2026-07-25, ../brain/agentic-bypass.eval.ts: 25 probes × 6 replicates against the
// real index/graph/cross-encoder/claim-ledger, with the real retrieveContext loop driven by the real
// glm-4.5-airx). On the 65 probe-runs where the pass actually returned citations, letting them flow
// through the stages beat the bypass on every metric, paired:
//     recall@5  0.316 → 0.431     MRR 0.797 → 0.870     any-hit@5 0.815 → 0.938
//     26 probe-runs better, 7 worse, 32 tied; the win holds in all 6 replicates separately.
// The dominant term is stage 1: the pass emits a MEAN OF 1.8 notes, so the graph-neighbour merge is
// what makes the set answerable — you cannot reorder your way to recall@5 out of 1.8 notes.
//
// WHAT THIS FILE PINS, so the bypass cannot come back silently:
//   (a) the default predicate is opt-OUT (DUIN_AGENTIC_RANK_STAGES=0 restores the bypass);
//   (b) on the default path the agentic contextOverride write sits AFTER all four stage markers —
//       the ordering IS the property, since a write before them re-suppresses them;
//   (c) the pre-stage compile write is reachable ONLY on the kill-switch branch;
//   (d) the citations reach the stages as `hits` (otherwise the stages rank an empty list);
//   (e) the two pure helpers behave — functionally, not structurally.
// (a)-(d) are source assertions because the /agui chat handler is not unit-mountable as a unit (it is
// one long request handler); (e) is real execution. Same idiom as brain/graph-expand-adapt.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

vi.mock('electron', () => ({
  app: {
    getPath: () => '.tmp-agentic-rank-stages-test',
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

const src = readFileSync(join(__dirname, 'server.ts'), 'utf-8')

/** The four stages, each identified by a call only IT makes, in pipeline order. */
const STAGE_MARKERS = [
  'mergeGraphNeighbors(',
  'await rerankHits(',
  'await tasteRerank(',
  'applyClaimFreshness('
]

describe('agentic citations flow through the four ranking stages (measured default)', () => {
  // (a) The predicate is opt-OUT: unset ⇒ ranked. An `=== '1'` polarity here would silently restore
  // the measured-worse bypass for every operator who never sets the variable — i.e. all of them.
  it('DUIN_AGENTIC_RANK_STAGES has opt-OUT polarity (unset ⇒ stages run)', () => {
    expect(src).toMatch(
      /function agenticRankStagesEnabled\(\)\s*:\s*boolean\s*\{\s*return\s+process\.env\.DUIN_AGENTIC_RANK_STAGES\s*!==\s*'0'/
    )
  })

  // (b) THE core invariant. The agentic render is a contextOverride write like any other; what makes
  // it harmless is that it happens LAST. If someone hoists it back to the dispatch site — the exact
  // shape of the original defect — every one of these comparisons flips.
  it('the default-path agentic contextOverride write sits AFTER all four stages', () => {
    const renderIdx = src.indexOf('contextOverride = citationsToContext(orderCitationsByHits(')
    expect(renderIdx, 'the post-stage agentic render is gone').toBeGreaterThan(-1)
    for (const marker of STAGE_MARKERS) {
      const at = src.indexOf(marker)
      expect(at, `stage marker not found: ${marker}`).toBeGreaterThan(-1)
      expect(renderIdx, `agentic render must run after ${marker}`).toBeGreaterThan(at)
    }
  })

  // …and it is still guarded, so a turn with no agentic citations leaves contextOverride unset and
  // agui-grounding's `contextOverride ?? hitsToContext(hits)` falls back to the fused hits.
  it('the post-stage render only fires when the agentic pass produced citations', () => {
    expect(src).toMatch(/if\s*\(agenticCitations\)\s*\{\s*\n\s*contextOverride = citationsToContext\(/)
  })

  // (c) The old suppressing write must not be reachable on the default path.
  it('the pre-stage compileContext write is reachable only behind the kill-switch', () => {
    const compileWrite = src.indexOf('contextOverride = compiled.context')
    expect(compileWrite).toBeGreaterThan(-1)
    // It lives in the `else` of `if (agenticRankStagesEnabled())`, so the enabling check is the
    // nearest preceding branch on that predicate and there is an `else` between them.
    const gate = src.lastIndexOf('if (agenticRankStagesEnabled())', compileWrite)
    expect(gate, 'the compile write is no longer behind agenticRankStagesEnabled()').toBeGreaterThan(-1)
    expect(src.slice(gate, compileWrite)).toContain('} else {')
    // …and it is BEFORE the stages, which is precisely why it may only run on the kill-switch.
    expect(compileWrite).toBeLessThan(src.indexOf(STAGE_MARKERS[0]))
  })

  // (d) The stages need something to rank. Without this the branch would "run" the stages over the
  // untouched RRF hits and then render citations that no stage ever saw.
  it('the citations are handed to the stages as `hits`', () => {
    expect(src).toContain('hits = citationsToHits(retrieved.citations)')
    expect(src.indexOf('hits = citationsToHits(retrieved.citations)')).toBeLessThan(
      src.indexOf(STAGE_MARKERS[0])
    )
  })
})

// (e) FUNCTIONAL — the two pure helpers actually execute. Source assertions above prove the wiring;
// these prove the transport preserves what the bypass was there to protect (line loci, `why`).
describe('citationsToHits / orderCitationsByHits', () => {
  it('citationsToHits dedupes by note, keeps emission order, and scores strictly descending', async () => {
    const { citationsToHits } = await import('./server')
    const hits = citationsToHits([
      { note: 'a.md', snippet: 'first', why: 'w1' },
      { note: 'b.md', snippet: 'second', why: 'w2' },
      { note: 'a.md', snippet: 'dup — dropped', why: 'w3' },
      { note: '', snippet: 'blank note — dropped', why: 'w4' }
    ])
    expect(hits.map((h) => h.file)).toEqual(['a.md', 'b.md'])
    expect(hits[0].snippet).toBe('first')
    expect(hits[0].score).toBeGreaterThan(hits[1].score)
  })

  it('orderCitationsByHits re-orders to the stage ranking and KEEPS lines/why', async () => {
    const { orderCitationsByHits } = await import('./server')
    const citations = [
      { note: 'a.md', lines: [1, 4] as [number, number], snippet: 'A', why: 'because A' },
      { note: 'b.md', lines: [7, 9] as [number, number], snippet: 'B', why: 'because B' }
    ]
    // The stages promoted b.md over a.md.
    const out = orderCitationsByHits(citations, [
      { file: 'b.md', snippet: 'ignored' },
      { file: 'a.md', snippet: 'ignored' }
    ])
    expect(out.map((c) => c.note)).toEqual(['b.md', 'a.md'])
    expect(out[0].lines).toEqual([7, 9]) // the precise locus survives the round trip
    expect(out[0].why).toBe('because B')
  })

  it('a hit with no citation (added by the graph-neighbour merge) is carried through, not dropped', async () => {
    const { orderCitationsByHits } = await import('./server')
    const out = orderCitationsByHits([{ note: 'a.md', snippet: 'A', why: 'because A' }], [
      { file: 'a.md', snippet: 'A' },
      { file: 'linked.md', snippet: '(linked) neighbour text' }
    ])
    expect(out.map((c) => c.note)).toEqual(['a.md', 'linked.md'])
    expect(out[1].snippet).toBe('(linked) neighbour text')
    expect(out[1].why).toMatch(/linked via the knowledge graph/)
  })

  it('a citation the stages somehow dropped is appended rather than lost', async () => {
    const { orderCitationsByHits } = await import('./server')
    const out = orderCitationsByHits(
      [
        { note: 'a.md', snippet: 'A', why: 'because A' },
        { note: 'gone.md', snippet: 'G', why: 'because G' }
      ],
      [{ file: 'a.md', snippet: 'A' }]
    )
    expect(out.map((c) => c.note)).toEqual(['a.md', 'gone.md'])
  })

  it('the rendered block keeps the stage order and the note:line loci', async () => {
    const { orderCitationsByHits, citationsToContext } = await import('./server')
    const block = citationsToContext(
      orderCitationsByHits(
        [
          { note: 'a.md', lines: [1, 2] as [number, number], snippet: 'A', why: 'wA' },
          { note: 'b.md', lines: [5, 6] as [number, number], snippet: 'B', why: 'wB' }
        ],
        [{ file: 'b.md', snippet: '' }, { file: 'a.md', snippet: '' }]
      )
    )
    expect(block.indexOf('b.md:5-6')).toBeLessThan(block.indexOf('a.md:1-2'))
    expect(block).toContain('why: wB')
  })
})
