// Multi-hop eval fixtures + dataset converters.
//
// `MultiHopInstance` is the ONE normalized shape the harness runs on. Two paths
// produce it:
//   1. Hand-authored SYNTHETIC_INSTANCES (below) — self-contained, no download,
//      so the bench is green offline (mirrors the bench's Beacon/Atlas idiom).
//   2. Converters from real MuSiQue / 2WikiMultiHopQA JSONL — the attended full
//      run. Both ship gold supporting facts + a reasoning path; we map paragraphs
//      → corpus, supporting facts → goldNotes/goldSentences, decomposition →
//      reasoningPath, and DERIVE a hop-graph so the scripted planner can traverse.
//
// The converter is the only thing that "knows" a dataset's schema; swapping
// MuSiQue for 2Wiki changes the loader, not the metric or the loop.

import { existsSync, readFileSync } from 'fs'
import { buildNoteCorpus, type GraphView, type NoteText } from '../retrieve-agent'
import type { SupportFact } from './metrics'

export interface MultiHopInstance {
  id: string
  question: string
  answer: string
  /** Accepted-answer surface forms for EM/F1. */
  answerAliases?: string[]
  /** Note ids that MUST be surfaced (factor 1, paragraph-level). */
  goldNotes: string[]
  /** {note,line} gold for sentence-level recall (2Wiki has it; MuSiQue does not). */
  goldSentences?: SupportFact[]
  /** Ordered hop note ids — drives the scripted planner + the turn ablation. */
  reasoningPath?: string[]
  /** The self-contained mini-vault → buildNoteCorpus(). */
  corpus: { file: string; text: string }[]
  /** Optional typed graph; when absent the harness derives a hop-graph from reasoningPath. */
  graph?: GraphView
  /** The seed proper-noun the planner greps first. */
  keyTerm: string
}

// ──────────────────── the converter (dataset instance → retrieval inputs) ────────────────────

/** The minimal retrieval inputs a scorer needs: corpus + gold + answer.
 *  This is the `dataset instance → {corpus, goldNotes, answer}` converter. */
export interface RetrievalInputs {
  corpus: NoteText[]
  goldNotes: string[]
  answer: string
  answerAliases: string[]
  goldSentences: SupportFact[]
}

export function toRetrievalInputs(inst: MultiHopInstance): RetrievalInputs {
  return {
    corpus: buildNoteCorpus(inst.corpus),
    goldNotes: inst.goldNotes,
    answer: inst.answer,
    answerAliases: inst.answerAliases ?? [],
    goldSentences: inst.goldSentences ?? []
  }
}

/** title → stable note-id slug. */
export function slug(title: string): string {
  return (title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-')
}

/** Proper-noun seed term for grep: capitalized words in the question joined as a
 *  regex alternation (grep compiles `term` as a case-insensitive RegExp). Falls
 *  back to the whole question when no capitals are present. */
export function extractKeyTerm(question: string): string {
  const caps = Array.from(question.matchAll(/\b([A-Z][a-zA-Z]{2,})\b/g))
    .map((m) => m[1])
    .filter((w) => !['Who', 'What', 'When', 'Where', 'Which', 'Whom', 'Whose', 'How', 'The'].includes(w))
  return caps.length ? Array.from(new Set(caps)).join('|') : question.trim()
}

/** Link consecutive reasoningPath notes with a typed 'hop' edge so graphNeighbors
 *  can traverse from an earlier hop's note to the next — the bridge-fact recovery
 *  the turn ablation measures. Nodes = every corpus note. */
export function deriveHopGraph(corpus: { file: string }[], reasoningPath: string[]): GraphView {
  const nodes = corpus.map((c) => ({ id: c.file, label: c.file.replace(/\.md$/, ''), kind: 'note' }))
  const edges: GraphView['edges'] = []
  for (let i = 0; i + 1 < reasoningPath.length; i++) {
    if (reasoningPath[i] !== reasoningPath[i + 1]) {
      edges.push({ source: reasoningPath[i], target: reasoningPath[i + 1], type: 'hop' })
    }
  }
  return { nodes, edges }
}

// ──────────────────── MuSiQue converter ────────────────────
// One JSON object per line. Gold is PARAGRAPH-level (is_supporting / the set of
// question_decomposition[].paragraph_support_idx). No sentence granularity.

interface MuSiQueRaw {
  id: string
  question: string
  answer: string
  answer_aliases?: string[]
  answerable?: boolean
  paragraphs: { idx: number; title: string; paragraph_text: string; is_supporting: boolean }[]
  question_decomposition?: { id: number; question: string; answer: string; paragraph_support_idx: number | null }[]
}

export function musiqueToInstance(raw: MuSiQueRaw): MultiHopInstance {
  // MuSiQue titles can repeat → prefix idx for a unique note id.
  const fileOf = (p: { idx: number; title: string }): string => `p${p.idx}-${slug(p.title)}.md`
  const byIdx = new Map(raw.paragraphs.map((p) => [p.idx, p]))
  const corpus = raw.paragraphs.map((p) => ({ file: fileOf(p), text: `# ${p.title}\n${p.paragraph_text}` }))
  const goldNotes = raw.paragraphs.filter((p) => p.is_supporting).map(fileOf)
  const reasoningPath = (raw.question_decomposition ?? [])
    .map((d) => (d.paragraph_support_idx != null ? byIdx.get(d.paragraph_support_idx) : undefined))
    .filter((p): p is NonNullable<typeof p> => p != null)
    .map(fileOf)
  return {
    id: raw.id,
    question: raw.question,
    answer: raw.answer,
    answerAliases: raw.answer_aliases ?? [],
    goldNotes,
    reasoningPath,
    corpus,
    graph: deriveHopGraph(corpus, reasoningPath),
    keyTerm: extractKeyTerm(raw.question)
  }
}

// ──────────────────── 2WikiMultiHopQA converter ────────────────────
// Gold is SENTENCE-level ([title, sent_id]); context is [title, sentences[]].

interface TwoWikiRaw {
  id: string
  question: string
  answer: string
  answer_aliases?: string[]
  type?: string
  context: [string, string[]][]
  supporting_facts: [string, number][]
}

export function twoWikiToInstance(raw: TwoWikiRaw): MultiHopInstance {
  const fileOf = (title: string): string => `${slug(title)}.md`
  // One sentence per line → sent_id (0-based) maps to line sent_id+1.
  const corpus = raw.context.map(([title, sents]) => ({ file: fileOf(title), text: sents.join('\n') }))
  const goldSentences: SupportFact[] = raw.supporting_facts.map(([title, sid]) => ({ note: fileOf(title), line: sid + 1 }))
  const goldNotes = Array.from(new Set(raw.supporting_facts.map(([title]) => fileOf(title))))
  return {
    id: raw.id,
    question: raw.question,
    answer: raw.answer,
    answerAliases: raw.answer_aliases ?? [],
    goldNotes,
    goldSentences,
    reasoningPath: goldNotes,
    corpus,
    graph: deriveHopGraph(corpus, goldNotes),
    keyTerm: extractKeyTerm(raw.question)
  }
}

// ──────────────────── JSONL loaders ────────────────────

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T)
}

/** Load + convert a MuSiQue-schema JSONL (guarded so an absent full dataset skips). */
export function loadMuSiQue(path: string, limit = Infinity): MultiHopInstance[] {
  if (!existsSync(path)) return []
  return readJsonl<MuSiQueRaw>(path).slice(0, limit).map(musiqueToInstance)
}

/** Load + convert a 2WikiMultiHopQA-schema JSONL. */
export function load2Wiki(path: string, limit = Infinity): MultiHopInstance[] {
  if (!existsSync(path)) return []
  return readJsonl<TwoWikiRaw>(path).slice(0, limit).map(twoWikiToInstance)
}

// ──────────────────── hand-authored SYNTHETIC fixtures (offline, no download) ────────────────────
// Authored in the Beacon/Atlas idiom already proven in retrieve-agent.bench.test.ts.
// Each is a GENUINE 2-hop with a distractor note so recall@k discriminates a real
// multi-hop planner from a lexical one.

const beaconBridge: MultiHopInstance = {
  id: 'syn-bridge-beacon',
  question: 'Who owns the project that the pending designer hire decision is blocking?',
  answer: 'Sam Rivera',
  answerAliases: ['Sam'],
  keyTerm: 'designer hire',
  goldNotes: ['p0-beacon.md', 'p1-people.md'],
  goldSentences: [
    { note: 'p0-beacon.md', line: 2 },
    { note: 'p1-people.md', line: 1 }
  ],
  reasoningPath: ['p0-beacon.md', 'p1-people.md'],
  corpus: [
    { file: 'p0-beacon.md', text: 'Beacon is the analytics rollout project.\nBeacon is blocked by the pending designer hire decision.' },
    { file: 'p1-people.md', text: 'Sam Rivera owns the Beacon project.\nJordan Lee owns the Atlas project.' },
    { file: 'p2-atlas.md', text: 'Atlas is the data-platform project.\nAtlas depends on the Postgres adoption decision.' }
  ],
  // Typed graph the construction pass would infer: the designer-hire decision
  // BLOCKS Beacon; the people note OWNS Beacon. p1-people is reachable ONLY via a
  // second hop off Beacon — the bridge fact the ablation measures.
  graph: {
    nodes: [
      { id: 'p0-beacon.md', label: 'beacon', kind: 'note' },
      { id: 'p1-people.md', label: 'people', kind: 'note' },
      { id: 'p2-atlas.md', label: 'atlas', kind: 'note' },
      { id: 'decision:designer-hire', label: 'designer hire', kind: 'decision' }
    ],
    edges: [
      { source: 'decision:designer-hire', target: 'p0-beacon.md', type: 'blocks' },
      { source: 'p1-people.md', target: 'p0-beacon.md', type: 'owns' }
    ]
  }
}

const lovelaceComparison: MultiHopInstance = {
  id: 'syn-cmp-lovelace',
  question: 'Who was born first, Ada Lovelace or Alan Turing?',
  answer: 'Ada Lovelace',
  answerAliases: ['Lovelace', 'Ada'],
  keyTerm: 'Lovelace|Turing',
  goldNotes: ['ada-lovelace.md', 'alan-turing.md'],
  goldSentences: [
    { note: 'ada-lovelace.md', line: 2 },
    { note: 'alan-turing.md', line: 2 }
  ],
  reasoningPath: ['ada-lovelace.md', 'alan-turing.md'],
  corpus: [
    { file: 'ada-lovelace.md', text: 'Ada Lovelace was an English mathematician.\nAda Lovelace was born in 1815.\nShe worked on the Analytical Engine.' },
    { file: 'alan-turing.md', text: 'Alan Turing was an English mathematician.\nAlan Turing was born in 1912.\nHe formalized computation.' },
    { file: 'charles-babbage.md', text: 'Charles Babbage designed the Analytical Engine.\nCharles Babbage was born in 1791.' }
  ]
}

const atlasBridge: MultiHopInstance = {
  id: 'syn-bridge-atlas',
  question: 'Which decision does the project that Jordan Lee owns depend on?',
  answer: 'Postgres adoption',
  answerAliases: ['Postgres', 'the Postgres adoption decision'],
  keyTerm: 'Jordan Lee',
  goldNotes: ['p1-people.md', 'p2-atlas.md'],
  goldSentences: [
    { note: 'p1-people.md', line: 2 },
    { note: 'p2-atlas.md', line: 2 }
  ],
  reasoningPath: ['p1-people.md', 'p2-atlas.md'],
  corpus: [
    { file: 'p0-beacon.md', text: 'Beacon is the analytics rollout project.\nBeacon is blocked by the pending designer hire decision.' },
    { file: 'p1-people.md', text: 'Sam Rivera owns the Beacon project.\nJordan Lee owns the Atlas project.' },
    { file: 'p2-atlas.md', text: 'Atlas is the data-platform project.\nAtlas depends on the Postgres adoption decision.' }
  ],
  graph: {
    nodes: [
      { id: 'p0-beacon.md', label: 'beacon', kind: 'note' },
      { id: 'p1-people.md', label: 'people', kind: 'note' },
      { id: 'p2-atlas.md', label: 'atlas', kind: 'note' },
      { id: 'person:jordan-lee', label: 'Jordan Lee', kind: 'person' }
    ],
    edges: [
      { source: 'person:jordan-lee', target: 'p1-people.md', type: 'mentions' },
      { source: 'p1-people.md', target: 'p2-atlas.md', type: 'owns' }
    ]
  }
}

/** The always-available offline fixture set (no download needed). */
export const SYNTHETIC_INSTANCES: MultiHopInstance[] = [beaconBridge, lovelaceComparison, atlasBridge]
