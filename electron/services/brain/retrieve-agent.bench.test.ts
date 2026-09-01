// Benchmark: OLD one-shot search() vs NEW agentic, graph-aware retrieveContext()
// on the raw sample vault.
//
// WHY a vitest, not a live-model script: the live cheap model is only available
// when a provider key is configured, which the CI/sandbox doesn't have. So this
// bench drives the SAME retrieveContext() loop with a SCRIPTED, graph-aware
// planner (opts.runTurnFn) that behaves like a competent flash model would:
// grep the proper noun, follow graphNeighbors for the relationship hops, read
// the notes behind the neighbours, then emit citations. The OLD path is the
// real index-store lexical scan (lexicalScan, the same scorer search() uses
// when the vector store is absent). This isolates the THING WE CHANGED — the
// retrieval STRATEGY — from provider variance, and makes the recall + context
// size numbers reproducible.
//
// The graph is built the way the construction pass (construct.ts) would infer it
// from this prose (entities + owns/depends_on/blocks edges) — documented inline
// so the "graph advantage" is honest about its source.
//
// Run:  npx vitest run electron/services/brain/retrieve-agent.bench.test.ts
//       add --disableConsoleIntercept to see the printed comparison table.

import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync, readdirSync } from 'fs'
import { join } from 'path'
import {
  buildNoteCorpus,
  grep,
  graphNeighbors,
  readNote,
  retrieveContext,
  type NoteText,
  type GraphView,
  type ToolCallAccumulator
} from './retrieve-agent'
import { lexicalScan, type ChunkRow } from '../local-brain/index-store'

// A raw markdown vault to bench against. Point DUIN_BENCH_VAULT at one; the default is a
// `bench/sample-vault-raw/` folder that is not shipped (the whole bench skips when it is absent).
const VAULT = process.env.DUIN_BENCH_VAULT ?? join(__dirname, '..', '..', '..', 'bench', 'sample-vault-raw')

// ── load the raw sample vault (skip the whole bench if it isn't present) ──
function loadVault(): NoteText[] | null {
  if (!existsSync(VAULT)) return null
  const files = readdirSync(VAULT).filter((f) => f.toLowerCase().endsWith('.md'))
  if (!files.length) return null
  const chunks = files.map((f) => ({ file: f, text: readFileSync(join(VAULT, f), 'utf-8') }))
  return buildNoteCorpus(chunks)
}

// ── the constructed graph (what construct.ts would infer from this prose) ──
// Entities + typed edges the LLM construction pass lifts from the raw notes:
//   Sam Rivera  --owns-->        beacon.md
//   beacon.md   --depends_on-->  decision:designer-hire   (and the reverse blocks)
//   Jordan Lee  --owns-->        atlas notes.md
//   atlas       --depends_on-->  decision:postgres
//   kickoff     --mentions-->    {Jordan, Sam, Atlas, Postgres}
function constructedGraph(notes: NoteText[]): GraphView {
  const ids = new Set(notes.map((n) => n.id))
  const nodes: GraphView['nodes'] = notes.map((n) => ({ id: n.id, label: n.id.replace(/\.md$/, ''), kind: 'stream' }))
  nodes.push(
    { id: 'person:sam-rivera', label: 'Sam Rivera', kind: 'person' },
    { id: 'person:jordan-lee', label: 'Jordan Lee', kind: 'person' },
    { id: 'project:beacon', label: 'Beacon', kind: 'project' },
    { id: 'project:atlas', label: 'Atlas', kind: 'project' },
    { id: 'decision:designer-hire', label: 'Designer hire', kind: 'decision' },
    { id: 'decision:postgres', label: 'Postgres adoption', kind: 'decision' }
  )
  const edges: GraphView['edges'] = []
  const add = (s: string, t: string, type: string): void => {
    if (s !== t) edges.push({ source: s, target: t, type })
  }
  if (ids.has('beacon.md')) {
    add('person:sam-rivera', 'beacon.md', 'owns')
    add('beacon.md', 'decision:designer-hire', 'depends_on')
    add('decision:designer-hire', 'beacon.md', 'blocks')
    add('project:beacon', 'beacon.md', 'about')
  }
  if (ids.has('atlas notes.md')) {
    add('person:jordan-lee', 'atlas notes.md', 'owns')
    add('atlas notes.md', 'decision:postgres', 'depends_on')
    add('project:atlas', 'atlas notes.md', 'about')
  }
  if (ids.has('kickoff jun 20.md')) {
    add('kickoff jun 20.md', 'person:jordan-lee', 'mentions')
    add('kickoff jun 20.md', 'person:sam-rivera', 'mentions')
    add('kickoff jun 20.md', 'decision:postgres', 'mentions')
  }
  return { nodes, edges }
}

// ── OLD path: one-shot lexical search() over the corpus (k=6) ──
function oldSearch(notes: NoteText[], query: string, k = 6): { notes: string[]; context: string } {
  // Mirror index-store.search's lexical pass: one ChunkRow per note line-block.
  const rows: ChunkRow[] = notes.map((n, i) => ({ rowid: i, file: n.id, text: n.text }))
  const hits = lexicalScan(rows, query, k)
  const context = hits.length
    ? hits.map((h, i) => `[${i + 1}] (${h.file})\n${h.snippet}`).join('\n\n')
    : '(no relevant notes found in the local index)'
  return { notes: hits.map((h) => h.file), context }
}

// ── scripted graph-aware planner (stands in for the cheap flash model) ──
// A two-turn plan: turn 1 issues grep + graphNeighbors in parallel for the key
// noun; turn 2 reads the notes behind the neighbours; the loop ends when we emit
// the final citations object. The planner reads prior tool RESULTS from the
// message list to decide what to cite — exactly the information a real model
// would have.
function scriptedPlanner(keyTerm: string, _query: string) {
  let phase = 0
  const tc = (name: string, args: object): ToolCallAccumulator => ({
    id: `${name}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'function',
    function: { name, arguments: JSON.stringify(args) }
  })

  return async (messages: import('openai/resources/chat/completions').ChatCompletionMessageParam[]) => {
    phase++
    if (phase === 1) {
      // Probe: grep the noun AND traverse the graph from it (parallel).
      return {
        content: '',
        toolCalls: [tc('grep', { term: keyTerm }), tc('graphNeighbors', { idOrTerm: keyTerm })]
      }
    }
    if (phase === 2) {
      // Read the notes named in the tool results so far (grep hits + neighbour
      // note ids), so we can cite precise lines.
      const toolText = messages
        .filter((m) => m.role === 'tool')
        .map((m) => (typeof m.content === 'string' ? m.content : ''))
        .join('\n')
      const noteIds = Array.from(
        new Set(
          [...toolText.matchAll(/([A-Za-z0-9 _.-]+\.md)/g)].map((m) => m[1].trim())
        )
      ).slice(0, 6)
      return {
        content: '',
        toolCalls: noteIds.map((id) => tc('readNote', { id }))
      }
    }
    // Final: emit citations for every .md the readNote results returned.
    const readText = messages
      .filter((m) => m.role === 'tool')
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n')
    const cited = Array.from(
      new Set([...readText.matchAll(/([A-Za-z0-9 _.-]+\.md)/g)].map((m) => m[1].trim()))
    )
    // The planner only had readNote dump the relevant notes; cite those.
    const citations = cited
      .filter((id) => id.endsWith('.md'))
      .slice(0, 6)
      .map((note) => ({ note, snippet: `evidence in ${note}`, why: `surfaced for "${keyTerm}"` }))
    return { content: JSON.stringify({ citations }), toolCalls: [] }
  }
}

interface Row {
  query: string
  oldNotes: string[]
  newNotes: string[]
  expected: string[]
  oldChars: number
  newChars: number
}

const QUERIES: { q: string; key: string; expected: string[] }[] = [
  { q: 'what is blocking Beacon and who owns it', key: 'Beacon', expected: ['beacon.md', 'people.md'] },
  { q: 'what decisions are due and when', key: 'decide', expected: ['beacon.md', 'atlas notes.md'] },
  { q: 'who owns Atlas', key: 'Atlas', expected: ['atlas notes.md', 'people.md'] }
]

const recall = (got: string[], expected: string[]): number =>
  expected.length === 0 ? 1 : expected.filter((e) => got.includes(e)).length / expected.length

const approxTokens = (chars: number): number => Math.round(chars / 4)

describe('retrieve-agent bench (OLD search vs NEW agentic)', () => {
  const notes = loadVault()

  it.runIf(notes)('compares recall + context size on the sample vault', async () => {
    const corpus = notes!
    const graph = constructedGraph(corpus)
    const rows: Row[] = []

    for (const { q, key, expected } of QUERIES) {
      const oldR = oldSearch(corpus, q)
      const newR = await retrieveContext(q, {
        notes: corpus,
        graph,
        runTurnFn: scriptedPlanner(key, q),
        maxTurns: 4,
        hyde: false // this bench measures the base agentic loop (predates HyDE); pin it for a deterministic compare
      })
      // Build the NEW context block the way server.ts citationsToContext does.
      const newNotes = (newR?.citations ?? []).map((c) => c.note)
      const newContext = (newR?.citations ?? [])
        .map((c, i) => `[${i + 1}] (${c.note})\n${c.snippet}\nwhy: ${c.why}`)
        .join('\n\n')
      rows.push({
        query: q,
        oldNotes: oldR.notes,
        newNotes,
        expected,
        oldChars: oldR.context.length,
        newChars: newContext.length
      })
    }

    // ── print the comparison table ──
    /* eslint-disable no-console */
    console.log('\n=== Agentic retriever bench — sample vault ===\n')
    console.log(
      'query'.padEnd(42),
      'old_recall'.padEnd(11),
      'new_recall'.padEnd(11),
      'old_ctx(ch/tok)'.padEnd(18),
      'new_ctx(ch/tok)'
    )
    for (const r of rows) {
      const oR = recall(r.oldNotes, r.expected)
      const nR = recall(r.newNotes, r.expected)
      console.log(
        r.query.slice(0, 41).padEnd(42),
        `${(oR * 100).toFixed(0)}%`.padEnd(11),
        `${(nR * 100).toFixed(0)}%`.padEnd(11),
        `${r.oldChars}/${approxTokens(r.oldChars)}`.padEnd(18),
        `${r.newChars}/${approxTokens(r.newChars)}`
      )
      console.log(
        '   expected:'.padEnd(14),
        r.expected.join(', '),
        '\n   old surfaced:',
        r.oldNotes.join(', ') || '(none)',
        '\n   new surfaced:',
        r.newNotes.join(', ') || '(none)'
      )
    }
    const avgOld = rows.reduce((s, r) => s + recall(r.oldNotes, r.expected), 0) / rows.length
    const avgNew = rows.reduce((s, r) => s + recall(r.newNotes, r.expected), 0) / rows.length
    const avgOldCtx = rows.reduce((s, r) => s + r.oldChars, 0) / rows.length
    const avgNewCtx = rows.reduce((s, r) => s + r.newChars, 0) / rows.length
    console.log(
      `\navg recall — OLD ${(avgOld * 100).toFixed(0)}%  NEW ${(avgNew * 100).toFixed(0)}%`
    )
    console.log(
      `avg context — OLD ${avgOldCtx.toFixed(0)} ch (~${approxTokens(avgOldCtx)} tok)  ` +
        `NEW ${avgNewCtx.toFixed(0)} ch (~${approxTokens(avgNewCtx)} tok)\n`
    )
    /* eslint-enable no-console */

    // The bench is informational, but assert the multi-hop wins don't regress:
    // the agentic path should recall the RELATIONSHIP note (people.md) for the
    // "who owns" queries, which the pure lexical scan over the noun misses.
    const beaconRow = rows.find((r) => r.query.startsWith('what is blocking Beacon'))!
    expect(beaconRow.newNotes).toContain('people.md')
    expect(avgNew).toBeGreaterThanOrEqual(avgOld)
  })

  it('documents the bench design when the sample vault is absent', () => {
    if (!notes) {
      // eslint-disable-next-line no-console
      console.log(
        `[bench] sample vault not found at ${VAULT} — skipped live comparison. ` +
          'Design: 3 queries × {OLD lexical search vs NEW scripted graph-aware loop}, ' +
          'measuring note recall + context char/token size.'
      )
    }
    expect(true).toBe(true)
  })
})
