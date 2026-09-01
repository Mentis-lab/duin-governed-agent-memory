// The offline runner: drive the REAL retrieveContext() loop over a MultiHopInstance
// with a scripted, graph-aware planner (opts.runTurnFn) — no live model, no
// keychain — then score the three factors. Generalizes the single-query scripted
// planner in retrieve-agent.bench.test.ts into an instance-parameterized factory
// that also supports the turn ablation (recall climbs as maxTurns rises because
// bridge facts are only reachable on a later hop).

import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import {
  buildNoteCorpus,
  readNote,
  retrieveContext,
  type Citation,
  type NoteText,
  type ToolCallAccumulator,
  type TurnFn
} from '../retrieve-agent'
import {
  answerEM,
  answerF1,
  citationPrecisionStmts,
  citationRecallStmts,
  normalizeAnswer,
  supportingFactRecallAtK,
  supportSentenceRecallAtK,
  type CitedStatement,
  type SupportScorer
} from './metrics'
import { deriveHopGraph, type MultiHopInstance } from './fixtures'

// ──────────────────── injected reader (factor 2) ────────────────────
// retrieveContext returns citations, NOT a prose answer. To report EM/F1 without
// coupling retrieval to generation, the answer comes from an injected reader.

export type ReaderFn = (query: string, citations: Citation[], notes: NoteText[]) => Promise<string>

/** Deterministic mock reader: emits the gold answer IFF every gold support note
 *  was surfaced — so factor 2 reads "did retrieval surface enough to answer",
 *  cleanly, with no model. The attended run injects the real answer model here. */
export function mockReaderFor(inst: MultiHopInstance): ReaderFn {
  return async (_q, citations) => {
    const cited = new Set(citations.map((c) => c.note))
    return inst.goldNotes.every((g) => cited.has(g)) ? inst.answer : ''
  }
}

// ──────────────────── injected support scorer (factor 3) ────────────────────

/** A token-subset mock NLI head: a premise supports a claim iff every claim token
 *  appears in the premise (SQuAD-normalized). Deterministic, no model — the
 *  attended run swaps a MiniCheck-class cross-encoder behind the same type. */
export const tokenSubsetScorer: SupportScorer = (premise, claim) => {
  const c = normalizeAnswer(claim).split(' ').filter(Boolean)
  if (c.length === 0) return false
  const p = new Set(normalizeAnswer(premise).split(' ').filter(Boolean))
  return c.every((t) => p.has(t))
}

// ──────────────────── the scripted multi-hop planner ────────────────────

const mkToolCall = (name: string, args: object): ToolCallAccumulator => ({
  id: `${name}_${Math.random().toString(36).slice(2, 8)}`,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) }
})

/**
 * A graph-aware planner that stands in for a competent flash model. Per turn it
 * reads the accumulated tool RESULTS out of the message list, then:
 *   Turn 1  — probe: grep(keyTerm) ‖ graphNeighbors(keyTerm).
 *   Turn 2+ — expand each newly-discovered note: graphNeighbors(note) ‖ readNote(note),
 *             which follows the typed/hop edges to the BRIDGE note (the lever the
 *             ablation measures — it is only reachable on a later hop).
 *   Final   — when nothing new is left to expand, emit no tool calls.
 * It ALWAYS returns the citations discovered SO FAR in `content`, so if the loop
 * is cut off at a low maxTurns the best-so-far citations are what get scored —
 * making sp-recall monotonic in maxTurns.
 */
export function scriptedMultiHopPlanner(inst: MultiHopInstance): TurnFn {
  const discovered: string[] = []
  const discoveredSet = new Set<string>()
  const greppedLines = new Map<string, number[]>()
  const expanded = new Set<string>()
  let probed = false

  const addNote = (id: string): void => {
    if (id.endsWith('.md') && !discoveredSet.has(id)) {
      discoveredSet.add(id)
      discovered.push(id)
    }
  }

  const ingestResults = (messages: ChatCompletionMessageParam[]): void => {
    for (const m of messages) {
      if (m.role !== 'tool') continue
      const text = typeof m.content === 'string' ? m.content : ''
      for (const line of text.split('\n')) {
        // grep hit: "note.md:LINE: text"
        const g = line.match(/^(.+?\.md):(\d+):/)
        if (g) {
          const note = g[1].trim()
          addNote(note)
          const arr = greppedLines.get(note) ?? []
          arr.push(Number(g[2]))
          greppedLines.set(note, arr)
        }
        // any .md id (grep note, graphNeighbors `from`/`id`)
        for (const mm of line.matchAll(/([^\s()]+\.md)/g)) addNote(mm[1].trim())
      }
    }
  }

  const citationsSoFar = (): Citation[] =>
    discovered.map((note) => {
      const lines = greppedLines.get(note)
      const range: [number, number] | undefined =
        lines && lines.length ? [Math.min(...lines), Math.max(...lines)] : undefined
      return {
        note,
        ...(range ? { lines: range } : {}),
        snippet: `cited evidence in ${note}`,
        why: inst.answer
      }
    })

  return async (messages) => {
    ingestResults(messages)
    const content = JSON.stringify({ citations: citationsSoFar() })

    if (!probed) {
      probed = true
      return {
        content,
        toolCalls: [mkToolCall('grep', { term: inst.keyTerm }), mkToolCall('graphNeighbors', { idOrTerm: inst.keyTerm })]
      }
    }

    // Expand notes discovered but not yet hop-expanded (cap for safety).
    const toExpand = discovered.filter((n) => !expanded.has(n)).slice(0, 4)
    if (toExpand.length === 0) return { content, toolCalls: [] }
    const toolCalls: ToolCallAccumulator[] = []
    for (const n of toExpand) {
      expanded.add(n)
      toolCalls.push(mkToolCall('graphNeighbors', { idOrTerm: n }), mkToolCall('readNote', { id: n }))
    }
    return { content, toolCalls }
  }
}

// ──────────────────── the per-instance runner ────────────────────

export interface FactorScores {
  id: string
  /** sp-recall@k at k ∈ {gold.length, 5, 10}. */
  supportNoteRecall: { atGold: number; at5: number; at10: number }
  supportSentenceRecall: number
  answerEM: number
  answerF1: number
  citationRecall: number
  citationPrecision: number
  /** raw counts for the printed table. */
  citedNotes: string[]
  goldNotes: string[]
}

export interface RunOpts {
  reader?: ReaderFn
  scorer?: SupportScorer
  maxTurns?: number
  /** Claim source for ALCE (default: the instance answer — measures "does the
   *  cited span support the ANSWER"). Swap in a reader's sentence in the attended run. */
  statementOf?: (inst: MultiHopInstance) => string
}

export async function runInstance(inst: MultiHopInstance, opts: RunOpts = {}): Promise<FactorScores> {
  const notes = buildNoteCorpus(inst.corpus)
  // ALWAYS inject a graph — a missing one would make retrieveContext fall back to
  // liveGraph() (the real DB). Derive a hop-graph from the reasoning path if the
  // instance carries no explicit typed graph.
  const graph = inst.graph ?? deriveHopGraph(inst.corpus, inst.reasoningPath ?? inst.goldNotes)
  const res = await retrieveContext(inst.question, {
    notes,
    graph,
    runTurnFn: scriptedMultiHopPlanner(inst),
    maxTurns: opts.maxTurns ?? 4,
    hyde: false // pin determinism + skip the extra planRetrieval turn (bench does this too)
  })
  const citations = res?.citations ?? []
  const ranked = citations.map((c) => c.note)

  // factor 1
  const supportNoteRecall = {
    atGold: supportingFactRecallAtK(ranked, inst.goldNotes, Math.max(1, inst.goldNotes.length)),
    at5: supportingFactRecallAtK(ranked, inst.goldNotes, 5),
    at10: supportingFactRecallAtK(ranked, inst.goldNotes, 10)
  }
  const supportSentenceRecall = supportSentenceRecallAtK(citations, inst.goldSentences ?? [], 10)

  // factor 2
  const golds = [inst.answer, ...(inst.answerAliases ?? [])]
  const pred = opts.reader ? await opts.reader(inst.question, citations, notes) : ''
  const emF1Pred = pred // '' when no reader → EM/F1 degrade to 0, never blocking factors 1/3

  // factor 3 (ALCE): group ALL citations under one answer-statement so the union
  // supports the answer (recall) and the redundant-citation branch is exercised
  // (precision). Premise text is the cited span, resolved via readNote.
  const scorer = opts.scorer ?? tokenSubsetScorer
  const statement = (opts.statementOf ?? ((i) => i.answer))(inst)
  const grouped: CitedStatement[] = [
    {
      statement,
      premises: citations.map((c) => ({ note: c.note, text: readNote(notes, c.note, c.lines) }))
    }
  ]

  return {
    id: inst.id,
    supportNoteRecall,
    supportSentenceRecall,
    answerEM: answerEM(emF1Pred, golds),
    answerF1: answerF1(emF1Pred, golds),
    citationRecall: citations.length ? citationRecallStmts(grouped, scorer) : 0,
    citationPrecision: citations.length ? citationPrecisionStmts(grouped, scorer) : 0,
    citedNotes: ranked,
    goldNotes: inst.goldNotes
  }
}
