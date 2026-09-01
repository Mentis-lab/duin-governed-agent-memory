// Agentic, graph-aware retriever — an UPGRADE to the one-shot `search(query, 6)`
// grounding the /agui chat does today.
//
// A CHEAP model (routeModel('extraction') — the flash tier) drives a short,
// READ-ONLY tool loop over the user's vault AND their constructed knowledge
// graph, then emits a compact list of `note:line` citations. Those citations —
// not the raw RAG dump — become the CONTEXT block fed to the main (expensive)
// answer model, so:
//   - the main model spends ZERO tokens on retrieval, and
//   - it gets focused, MULTI-HOP evidence (e.g. "what blocks Beacon and who
//     owns it" → follow Beacon's `blocks`/`owns` edges to the designer-hire
//     decision and to Sam, then read the notes behind those nodes).
//
// The graph traversal (`graphNeighbors`) is the DUIN-only differentiator: a
// plain vault has no edges to follow, but the constructed graph
// (deriveGraph() + getConstruction()) does.
//
// ADDITIVE + degrade-gracefully: retrieveContext() returns null when no model
// is configured (caller falls back to today's search()), and any throw inside
// the loop is caught and surfaced as null too. The tools + the final-citation
// parser are PURE and unit-tested; only the loop itself needs a live model.

import { readFileSync } from 'fs'
import { relative } from 'path'
import { vaultVersion } from './vault-version'
import { allChunks, collectNoteFiles } from '../local-brain/index-store'
import { readSettings } from '../settings-helper'
import { deriveGraph, type CausalGraph } from '../local-brain/graph-derive'
import { getConstruction, getResolvedConstruction } from './construct'
import { readGraphNative } from './graph-native'
import type { GraphReadResult } from './graph-native'
import { buildDuinGraph } from './build-duin-graph'
import {
  personResolverEnabled,
  buildProfileIndex,
  resolveEntityIdentity as resolvePersonProfiles
} from './person-resolver'
import { entityResolverEnabled } from './entity-resolver'
import type { ConstructedData } from './types'
import { chatStream, routeModel } from '../providers/registry'
import { evalInSandbox } from './code-sandbox'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolMessageParam
} from 'openai/resources/chat/completions'
import type { ToolCallAccumulator } from '../providers/registry'
import { messageOf } from '../guarded'

export type { ToolCallAccumulator } from '../providers/registry'

// ──────────────────── public shapes ────────────────────

export interface Citation {
  /** Note id (relpath) the evidence is in. */
  note: string
  /** Best 1-based line range within that note, when the model pins one. */
  lines?: [number, number]
  /** A short quoted/paraphrased snippet of the evidence. */
  snippet: string
  /** One-line reason this note answers the query (the agent's rationale). */
  why: string
  /** NLI citation-SUPPORT gate (opt-in, DUIN_RETRIEVER_SUPPORT): P(entailment)
   *  that the cited span text ENTAILS the claim. Only set when the gate ran. */
  support?: number
  /** NLI citation-SUPPORT gate: support >= threshold. Only set when the gate ran. */
  supported?: boolean
}

/** A computation the agent performed over the corpus, and what it produced. Kept separate from
 *  `citations` because it is NOT evidence in a note — it is a value derived across many notes, and
 *  collapsing the two would make "this note says X" indistinguishable from "I counted X". */
export interface ComputedEvidence {
  /** The script the agent ran, capped for the log/prompt. */
  code: string
  /** Its rendered result, or the error text if it failed. */
  result: string
  /** True when the script failed — a failed computation must never read as a finding. */
  failed?: boolean
}

export interface RetrieveResult {
  citations: Citation[]
  turns: number
  toolCalls: number
  /** Present only when the code tool ran. Empty array ⇒ it was available and never used. */
  computed?: ComputedEvidence[]
}

export interface RetrieveOptions {
  /** Max model turns (tool round-trips). Default 4. */
  maxTurns?: number
  /** Hard cap on total tool calls across all turns (safety). Default 16. */
  maxToolCalls?: number
  /** Override the model id (tests / callers). Default routeModel('extraction'). */
  model?: string | null
  /** Override the note corpus (tests). Default: reassembled from allChunks(). */
  notes?: NoteText[]
  /** Override the graph (tests). Default: deriveGraph() + getConstruction(). */
  graph?: GraphView
  /** Override the per-turn model call (tests/bench — run the FULL loop offline
   *  with a scripted driver instead of a live provider). Default: chatStream via
   *  routeModel. */
  runTurnFn?: TurnFn
  /** Run the deterministic HyDE + query-decomposition pre-loop. Default: hydeEnabled()
   *  (DUIN_RETRIEVER_HYDE, default ON; =0 disables). Tests set it explicitly. */
  hyde?: boolean
  /** Run the NLI citation-SUPPORT gate after verification. Default:
   *  supportGateEnabled() (DUIN_RETRIEVER_SUPPORT, default OFF; =1 enables).
   *  Tests set it explicitly. */
  support?: boolean
  /** Inject the entailment scorer (tests / bench — run the gate offline with a
   *  stub, never touching the real NLI model / keychain / worker). Default: the
   *  live embeddings-service NLI channel. Returns null → gate degrades to a
   *  no-op (today's citations unchanged). */
  nliScore?: NliScoreFn
  /** Offer the `runCode` tool. Default: codeEvalEnabled() (DUIN_RETRIEVER_CODE, default **OFF**;
   *  =1 enables — DEFAULT REVERSED 2026-08-02, see :1055). Tests set it explicitly. */
  code?: boolean
  /** Inject the sandbox (tests / bench — exercise the loop without node:vm). Default:
   *  defaultCodeEval. */
  codeEval?: CodeEvalFn
}

/** One turn of the loop: given the running message list, return the model's
 *  text content + any tool calls it wants to make. */
export type TurnFn = (
  messages: ChatCompletionMessageParam[]
) => Promise<{ content: string; toolCalls: ToolCallAccumulator[] }>

// ──────────────────── note corpus (line-addressable) ────────────────────

export interface NoteText {
  /** Note id (relpath). */
  id: string
  /** Full reassembled text. */
  text: string
  /** Lines, split on \n (1-based when addressed). */
  lines: string[]
}

/**
 * Reassemble per-note text from the chunk store and split into lines so tools
 * can return `note:line` citations. PURE given the chunk rows. Chunks are stored
 * in file/chunk_index order; we concatenate with '\n' exactly as graph-derive
 * does, so line numbers are consistent across tools.
 */
export function buildNoteCorpus(
  chunks: { file: string; text: string }[]
): NoteText[] {
  const byFile = new Map<string, string>()
  for (const c of chunks) {
    // Mirror graph-derive's reassembly ('\n' + text) so derived nodes and these
    // line numbers agree. The leading '\n' is trimmed off the final text.
    byFile.set(c.file, (byFile.get(c.file) ?? '') + '\n' + c.text)
  }
  const out: NoteText[] = []
  for (const [id, raw] of byFile) {
    const text = raw.replace(/^\n/, '')
    out.push({ id, text, lines: text.split('\n') })
  }
  return out
}

/** Live corpus from the index. */
function liveCorpus(): NoteText[] {
  return buildNoteCorpus(allChunks())
}

/** Public accessor for whole-note grounding (server.ts): every note with its full text, read
 *  DIRECTLY FROM THE VAULT DIR — the CLEAN, COMPLETE, CURRENT corpus (exactly what a BM25 baseline
 *  ranks over). The chunk index (`allChunks`) accumulates STALE files across reindexes (measured:
 *  283 chunk-files vs 50 real notes on the bench), which buries the answer note in look-alikes; the
 *  vault dir never has that pollution. Falls back to the index only when no notes dir is configured. */
// Cache the full-vault read across turns — it changes only on a note mutation (bumpVaultVersion), so a
// per-turn re-read of every note file was pure TTFT tax. Keyed by (vaultVersion, dir): a mutation or a
// dir switch rebuilds; otherwise the cached corpus is returned in O(1).
let wholeNotesCache: { v: number; dir: string; notes: NoteText[] } | null = null

/** Test-only: clear the vault-version-keyed grounding caches. Tests re-setup mocked graph/vault state
 *  WITHOUT bumping the vault version, so they must reset between cases to force a rebuild. */
export function __resetGroundingCache(): void {
  wholeNotesCache = null
  graphCache = null
}

export function liveWholeNotes(): NoteText[] {
  try {
    const dir = readSettings().localBrainNotesDir
    if (typeof dir === 'string' && dir) {
      const v = vaultVersion()
      if (wholeNotesCache && wholeNotesCache.v === v && wholeNotesCache.dir === dir) return wholeNotesCache.notes
      const out: NoteText[] = []
      for (const abs of collectNoteFiles(dir)) {
        try {
          const text = readFileSync(abs, 'utf-8')
          const id = relative(dir, abs).replace(/\\/g, '/')
          out.push({ id, text, lines: text.split('\n') })
        } catch (e) { console.debug('[retrieve-agent] skip an unreadable file:', messageOf(e)) }
      }
      if (out.length > 0) { wholeNotesCache = { v, dir, notes: out }; return out }
    }
  } catch (e) { console.debug('[retrieve-agent] settings/dir unavailable  fall back to the index corpus:', messageOf(e)) }
  return liveCorpus()
}

// ──────────────────── graph view (derive + construction) ────────────────────

export interface GraphNode {
  id: string
  label: string
  kind: string
  /** Source note id (relpath) this node was lifted from, when distinct from `id`.
   *  File-derived nodes omit it (their `id` IS the note id); constructed entity
   *  nodes carry the note they were found in, so a snippet can be resolved. */
  note?: string
}
export interface GraphEdge {
  source: string
  target: string
  type: string
}
export interface GraphView {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/**
 * Flatten a CausalGraph (+ an optional construction merged in by the caller)
 * into the minimal {nodes, edges} the traversal tool needs. PURE.
 */
export function toGraphView(g: CausalGraph): GraphView {
  return {
    nodes: g.nodes.map((n) => ({ id: n.id, label: n.label, kind: n.kind })),
    edges: g.edges.map((e) => ({ source: e.source, target: e.target, type: e.type }))
  }
}

/**
 * The live graph the retriever traverses: the structural derive() graph MERGED
 * with the constructed entities/edges (the LLM-inferred knowledge graph), via the
 * ONE shared builder buildDuinGraph (dedup:'none' — retrieval never deduped edges).
 *
 * Phase B-2: the inline construction merge AND overlayProductStore both fold into
 * buildDuinGraph. The DUIN product-store cascade overlay is still OFF by default
 * (productOverlayEnabled()); when the flag is unset `product` is null, so the output
 * is byte-identical to today. When ON, `canonicalizeProduct` now actually MERGES the
 * store nodes into the DUIN-native id space (vault:/… folds onto its note relpath,
 * bare cascade ids kind-prefix) instead of islanding.
 */
/**
 * Apply the flag-gated identity-spine resolver to the raw construction BEFORE buildDuinGraph.
 * DUIN_ENTITY_RESOLVER (P2, label-keyed alias id-collapse across all kinds) SUBSUMES and takes
 * precedence over DUIN_PERSON_RESOLVER (Phase R, person/org → profile-note fold). Both unset ⇒
 * identity passthrough (output byte-identical to today).
 */
function resolveConstructionIdentity(): ConstructedData | null {
  if (entityResolverEnabled()) {
    // Identity-spine P6: the alias id-collapse now comes from the SHARED, memoized
    // getResolvedConstruction() — the ONE resolver call site the MAP, the benchmark, and the
    // mergedGraph surfaces also use (no per-caller drift). On top of it we LAYER the
    // retrieval-only person→profile-note fold (resolvePersonProfiles), so person-resolution
    // STILL FIRES under the single (now default-on) flag rather than being lost. Composition
    // order matters: alias-collapse preserves labels, so the profile fold (keyed on
    // normName(label)) still matches after the ids are canonicalized. The person fold is kept
    // retrieval-only by design (see the module note) — it must NOT alter the MAP.
    return resolvePersonProfiles(getResolvedConstruction(), buildProfileIndex(retrievalVault()))
  }
  if (personResolverEnabled()) return resolvePersonProfiles(getConstruction(), buildProfileIndex(retrievalVault()))
  return getConstruction()
}

// Cache the built graph across turns — deriveGraph() + construction merge + resolvers is a full rebuild,
// and its inputs (chunk index, construction layer) change only on reindex / construction-refresh, both of
// which bumpVaultVersion. Keyed by vaultVersion so an unchanged vault serves the cached graph in O(1).
let graphCache: { v: number; graph: GraphView } | null = null
export function liveGraph(): GraphView {
  const v = vaultVersion()
  if (graphCache && graphCache.v === v) return graphCache.graph
  // Identity-spine resolvers (flag-gated). DUIN_ENTITY_RESOLVER (default-ON) drives the shared
  // alias-collapse accessor; the retrieval-only person fold layers on top. DUIN_ENTITY_RESOLVER=0
  // + DUIN_PERSON_RESOLVER unset ⇒ raw getConstruction() straight through ⇒ byte-identical to today.
  const cx = resolveConstructionIdentity()
  const built = buildDuinGraph({
    base: toGraphView(deriveGraph()),
    construction: cx,
    product: productOverlayEnabled() ? readProductStore() : null,
    canonicalizeProduct: true,
    dedup: 'none'
  })
  // buildDuinGraph emits base-clone nodes {id,label,kind}, construction nodes
  // {id,kind,label,note}, and product nodes {id,label,kind} — structurally GraphView.
  const graph = { nodes: built.nodes as unknown as GraphNode[], edges: built.edges as unknown as GraphEdge[] }
  graphCache = { v, graph }
  return graph
}

/** Whether liveGraph() overlays the DUIN product-store cascade. Default ON (P3 flip) —
 *  the product cascade now normalizes into the same canonical id space as the resolver
 *  (canonicalizeProduct:true composes with DUIN_ENTITY_RESOLVER's canonical ids), so it
 *  MERGES rather than islands. `DUIN_RETRIEVAL_PRODUCT_OVERLAY=0` is the opt-OUT kill-switch
 *  (product=null ⇒ byte-identical passthrough); unset / any other value ⇒ ENABLED. Matches
 *  the `!== '0'` opt-out polarity of the other default-on identity-spine flags. */
export function productOverlayEnabled(): boolean {
  return process.env.DUIN_RETRIEVAL_PRODUCT_OVERLAY !== '0'
}

/**
 * Read the DUIN product-store graph (readGraphNative) for the configured vault, to be
 * INJECTED into buildDuinGraph as the product layer. Returns null when no notes dir is
 * configured (nothing to overlay). Only called when productOverlayEnabled() is true.
 */
function readProductStore(): GraphReadResult | null {
  const vault = retrievalVault()
  if (!vault) return null
  return readGraphNative(vault)
}

/** The configured vault dir ('' when unset) — shared by the product overlay and the
 *  Phase-R person resolver so both read the same source. */
function retrievalVault(): string {
  return (readSettings().localBrainNotesDir as string) || ''
}

// ──────────────────── READ-ONLY tools (PURE; unit-tested) ────────────────────

/** Cap on rows any single tool returns, so one call can't blow the context. */
const TOOL_RESULT_CAP = 12
const SNIPPET_MAX = 200

function snippet(s: string, max = SNIPPET_MAX): string {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : clean.slice(0, max) + '…'
}

/**
 * A bounded (~200 char) excerpt of a graph node's SOURCE note, when one resolves.
 * A constructed entity carries its `note` (the note it was found in); a file node
 * IS its note (`id` is the relpath), so fall back to `id`. Concept-skeleton nodes
 * and nodes whose note fell out of the corpus resolve to '' (honest — no snippet).
 * PURE (corpus injected as a Map).
 */
function nodeSnippet(node: GraphNode, notesById: Map<string, NoteText>): string {
  const n = notesById.get(node.note ?? node.id)
  return n ? snippet(n.text) : ''
}

/**
 * Resolve a term to one or more graph nodes: exact id wins; else any node whose
 * id or label contains the term (case-insensitive). Shared by graphNeighbors
 * (1-hop) and graphExpand (k-hop) so both seed identically. PURE.
 */
function resolveSeeds(graph: GraphView, idOrTerm: string): GraphNode[] {
  const q = (idOrTerm ?? '').trim()
  if (!q) return []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  if (byId.has(q)) return [byId.get(q)!]
  const lower = q.toLowerCase()
  return graph.nodes.filter(
    (n) => n.id.toLowerCase().includes(lower) || n.label.toLowerCase().includes(lower)
  )
}

export interface GrepHit {
  note: string
  line: number
  text: string
}

/**
 * grep(term) — every note line matching `term` as a case-insensitive REGEX, with
 * its 1-based line number. `term` is compiled as a JS RegExp so the agent can use
 * real patterns (`\bword\b`, `foo.*bar`, `(alice|bob)`, `deadline:\s*\d`); a plain
 * word still matches as a substring. An INVALID pattern (stray metachar) never
 * throws — it falls back to a literal (escaped) substring match, so the tool is
 * strictly more powerful than the old substring grep with no failure mode. PURE.
 * Capped.
 */
export function grep(notes: NoteText[], term: string, cap = TOOL_RESULT_CAP): GrepHit[] {
  const raw = (term ?? '').trim()
  if (!raw) return []
  let re: RegExp
  try {
    re = new RegExp(raw, 'i')
  } catch {
    // Invalid regex → match the pattern literally (escape metachars). Never throw.
    re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  const out: GrepHit[] = []
  for (const n of notes) {
    for (let i = 0; i < n.lines.length; i++) {
      if (re.test(n.lines[i])) {
        out.push({ note: n.id, line: i + 1, text: snippet(n.lines[i]) })
        if (out.length >= cap) return out
      }
    }
  }
  return out
}

export interface GrepTotals {
  /** Total matching LINES across the whole corpus (uncapped). */
  lines: number
  /** Total distinct NOTES containing at least one match (uncapped). */
  notes: number
}

/**
 * Full-corpus match counts for the same pattern `grep` uses. PURE.
 *
 * WHY THIS EXISTS. `grep` returns at most `cap` hits and then RETURNS — silently. "12 matches
 * exist" and "12 shown of 553" were the same value, so a model asked "how many notes mention X"
 * could only count what it was shown and be confidently wrong. That is property 8 in the most
 * consequential tool the retriever has, and it is also the reason "counting is impossible without
 * code execution" looked true: the cheap mechanism had simply never been given a total.
 *
 * Deliberately a SECOND pass rather than instrumentation inside `grep`: `grep` returns early by
 * design (it is a preview, and the cap is what keeps a hot loop cheap), and threading counters
 * through an early return is exactly how a "safe default" becomes wrong for one caller.
 */
export function grepTotals(notes: NoteText[], term: string): GrepTotals {
  const raw = (term ?? '').trim()
  if (!raw) return { lines: 0, notes: 0 }
  let re: RegExp
  try {
    re = new RegExp(raw, 'i')
  } catch {
    re = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }
  let lines = 0
  let noteCount = 0
  for (const n of notes) {
    let hit = false
    for (const line of n.lines) {
      if (re.test(line)) {
        lines++
        hit = true
      }
    }
    if (hit) noteCount++
  }
  return { lines, notes: noteCount }
}

/**
 * glob(pattern) — note ids matching a path glob. Supports `*` (any chars within
 * a segment), `**` (any chars incl. '/'), and `?`. A bare term with no glob
 * metachar matches as a case-insensitive substring of the id (forgiving). PURE.
 */
export function glob(notes: NoteText[], pattern: string): string[] {
  const p = (pattern ?? '').trim()
  if (!p) return []
  const ids = notes.map((n) => n.id)
  const hasMeta = /[*?[\]]/.test(p)
  if (!hasMeta) {
    const needle = p.toLowerCase()
    return ids.filter((id) => id.toLowerCase().includes(needle))
  }
  // Build a regex from the glob. `**` → match anything; `*` → anything but '/';
  // `?` → a single non-'/' char. Other chars are escaped.
  let re = ''
  for (let i = 0; i < p.length; i++) {
    const ch = p[i]
    if (ch === '*') {
      if (p[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '[^/]'
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  let rx: RegExp
  try {
    rx = new RegExp(`^${re}$`, 'i')
  } catch {
    return []
  }
  return ids.filter((id) => rx.test(id))
}

/**
 * readNote(id, lineRange?) — a note's text, optionally a 1-based inclusive line
 * range. Each returned line is prefixed with its number so the model can cite a
 * precise range. Returns '' when the id is unknown. PURE.
 */
export function readNote(
  notes: NoteText[],
  id: string,
  lineRange?: [number, number]
): string {
  const n = notes.find((x) => x.id === id)
  if (!n) return ''
  let from = 1
  let to = n.lines.length
  if (lineRange) {
    // Clamp BOTH ends to [1, lines.length] so a fully-out-of-range request
    // (e.g. [50,60] on a 2-line note) returns the clamped last line — a
    // non-empty result that is distinct from the '' "unknown note id" sentinel.
    from = Math.min(n.lines.length, Math.max(1, Math.min(lineRange[0], lineRange[1])))
    to = Math.min(n.lines.length, Math.max(1, Math.max(lineRange[0], lineRange[1])))
  }
  const out: string[] = []
  for (let i = from; i <= to; i++) out.push(`${i}: ${n.lines[i - 1]}`)
  return out.join('\n')
}

/**
 * graphNeighbors(idOrTerm) — the KEY differentiator. Resolve a term to graph
 * node(s) — by exact id, then by label/id substring — and return the nodes
 * reachable across edges (BOTH directions, so we surface what a thing depends
 * on AND what depends on it), each tagged with the edge `type` and direction.
 * When a note corpus is supplied, each neighbour also carries a bounded (~200
 * char) SNIPPET of its source note (a constructed entity's `note`, or the file
 * node's own id) so the model can judge relevance WITHOUT a readNote hop. PURE
 * (corpus injected). Multi-hop is achieved by the model calling this again on a
 * returned id — or by graphExpand, which ranks a bounded frontier in one call.
 */
export interface NeighborHit {
  /** The neighbour node id. */
  id: string
  label: string
  kind: string
  /** Edge type linking the matched node to this neighbour. */
  via: string
  /** 'out' = matched→neighbour; 'in' = neighbour→matched. */
  dir: 'out' | 'in'
  /** The matched node this neighbour hangs off (when several matched). */
  from: string
  /** A bounded (~200 char) excerpt of the neighbour's source note, when a corpus
   *  is supplied and one resolves — so the model can skip a readNote hop. */
  snippet?: string
}

export function graphNeighbors(graph: GraphView, idOrTerm: string, notes?: NoteText[]): NeighborHit[] {
  const matched = resolveSeeds(graph, idOrTerm)
  if (matched.length === 0) return []
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const notesById = notes ? new Map(notes.map((n) => [n.id, n])) : undefined
  const matchedIds = new Set(matched.map((n) => n.id))

  const out: NeighborHit[] = []
  const seen = new Set<string>()
  const push = (fromId: string, nb: GraphNode, via: string, dir: 'out' | 'in'): void => {
    const key = `${fromId}->${nb.id}:${via}:${dir}`
    if (seen.has(key)) return
    seen.add(key)
    const snip = notesById ? nodeSnippet(nb, notesById) : ''
    out.push({ id: nb.id, label: nb.label, kind: nb.kind, via, dir, from: fromId, ...(snip ? { snippet: snip } : {}) })
  }

  for (const e of graph.edges) {
    if (matchedIds.has(e.source)) {
      const nb = byId.get(e.target)
      if (nb && !matchedIds.has(e.target)) push(e.source, nb, e.type, 'out')
    }
    if (matchedIds.has(e.target)) {
      const nb = byId.get(e.source)
      if (nb && !matchedIds.has(e.source)) push(e.target, nb, e.type, 'in')
    }
  }
  return out.slice(0, TOOL_RESULT_CAP)
}

/**
 * Relation salience for graphExpand's ranking: strong causal/ownership relations
 * dominate weak associative ones. Keyed on POST-mapping edge types (RELATION_TO_EDGE:
 * depends_on→depends), plus the structural link types + the raw `depends_on` as a
 * defensive alias. Unknown/default → 1 (one relation tier).
 */
const EDGE_TYPE_WEIGHT: Record<string, number> = {
  depends: 3,
  depends_on: 3, // defensive alias in case an unmapped raw relation slips through
  blocks: 3,
  owns: 3, // causal / responsibility — highest signal
  affects: 2,
  attends: 2, // directional influence / participation
  synonym: 2, // L3 alias/identity bridge: a strong STRUCTURAL link (same real entity), ranked with
  //             the directional tier — above user-links, below the causal tier so an aliased
  //             duplicate never outranks a genuine depends/owns neighbour.
  wikilink: 1.5,
  link: 1.5, // explicit user-authored links
  about: 1,
  mentions: 1, // weak associative
  grounds: 0.5 // cold-start scaffolding
}

/**
 * graphExpand(idOrTerm, hops<=2) — DETERMINISTIC bounded multi-hop expansion in ONE
 * call. Resolve a term to seed node(s), BFS outward up to `hops` edges in BOTH
 * directions, and return the most relevant connected nodes ranked by a cheap prior:
 * relation type (depends/blocks/owns outrank mentions/about) + sublinear node degree
 * (a HippoRAG-flavoured hub prior) − a hop-distance penalty. This approximates
 * Personalized-PageRank so a small model needn't spend turns on greedy per-hop BFS.
 * First-discovery wins (shortest-path parent edge). PURE + deterministic: `notes` is
 * an OPTIONAL trailing param (default []) so external callers stay source-compatible,
 * and every neighbour carries its source-note snippet ('' when none resolves).
 */
export interface ExpandHit {
  id: string
  label: string
  kind: string
  /** Edge type of the edge that FIRST reached this node (shortest-path parent edge). */
  via: string
  /** That edge's direction: 'out' = from→id, 'in' = id→from. */
  dir: 'out' | 'in'
  /** The parent node on the BFS tree (the node we hopped from). */
  from: string
  /** BFS distance from the nearest seed: 1 or 2. */
  hop: number
  /** ~200-char excerpt of the node's source note, '' when none resolves. */
  snippet: string
  /** Ranking prior (edge-type weight + sublinear degree − hop penalty). */
  score: number
}

export function graphExpand(
  graph: GraphView,
  idOrTerm: string,
  notes: NoteText[] = [],
  hops = 2,
  topN = TOOL_RESULT_CAP
): ExpandHit[] {
  // Clamp hops to [1,2]; NaN/out-of-range → 1.
  const h = Number.isFinite(hops) ? Math.min(2, Math.max(1, Math.trunc(hops))) : 1
  const seeds = resolveSeeds(graph, idOrTerm)
  if (seeds.length === 0) return []

  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const notesById = new Map(notes.map((n) => [n.id, n]))

  // Bidirectional adjacency + degree, precomputed once over the edge set (O(E)).
  const adj = new Map<string, { to: string; via: string; dir: 'out' | 'in' }[]>()
  const degree = new Map<string, number>()
  const bump = (id: string): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1)
  }
  const link = (from: string, to: string, via: string, dir: 'out' | 'in'): void => {
    const list = adj.get(from) ?? []
    list.push({ to, via, dir })
    adj.set(from, list)
  }
  for (const e of graph.edges) {
    link(e.source, e.target, e.type, 'out')
    link(e.target, e.source, e.type, 'in')
    bump(e.source)
    bump(e.target)
  }

  // BFS from all seeds at once. Shortest hop wins; at a node's DISCOVERY hop the
  // STRONGEST edge (by EDGE_TYPE_WEIGHT) wins its via/dir — so a node reachable by
  // both a `mentions` and a `depends` edge is tagged (and scored) as `depends`,
  // not whichever edge the scan happened to hit first.
  const seedIds = new Set(seeds.map((s) => s.id))
  const results = new Map<string, ExpandHit>()
  let frontier = seeds
  for (let d = 1; d <= h; d++) {
    const next: GraphNode[] = []
    const pushedThisHop = new Set<string>()
    for (const node of frontier) {
      for (const { to, via, dir } of adj.get(node.id) ?? []) {
        if (seedIds.has(to)) continue // never surface a seed
        const existing = results.get(to)
        if (existing && existing.hop < d) continue // a shorter path already reached it
        if (!existing) {
          const nb = byId.get(to)
          if (!nb) continue
          results.set(to, {
            id: nb.id,
            label: nb.label,
            kind: nb.kind,
            via,
            dir,
            from: node.id,
            hop: d,
            snippet: nodeSnippet(nb, notesById),
            score: 0
          })
          if (!pushedThisHop.has(to)) {
            next.push(nb)
            pushedThisHop.add(to)
          }
        } else if ((EDGE_TYPE_WEIGHT[via] ?? 1) > (EDGE_TYPE_WEIGHT[existing.via] ?? 1)) {
          // same hop, stronger relation → upgrade the tagging edge used for scoring
          existing.via = via
          existing.dir = dir
          existing.from = node.id
        }
      }
    }
    frontier = next
  }

  // Score: relation weight DOMINATES; the degree hub-prior is a within-tier tiebreak,
  // capped below the smallest edge-type gap (0.5) so a well-connected weak relation
  // can NEVER outrank a strong one; minus a hop-distance penalty.
  const hits = [...results.values()]
  for (const hit of hits) {
    const w = EDGE_TYPE_WEIGHT[hit.via] ?? 1
    const deg = degree.get(hit.id) ?? 0
    const degBonus = Math.min(0.49, 0.2 * Math.log2(1 + deg))
    hit.score = w + degBonus - 1.0 * (hit.hop - 1)
  }
  // Sort DESC by score; deterministic tie-break: hop ASC, then id ASC.
  hits.sort((a, b) => b.score - a.score || a.hop - b.hop || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return hits.slice(0, topN)
}

/** semanticSearch — reuse the index-store hybrid search. Async, not pure;
 *  injected so the loop can run offline in tests. */
export type SemanticSearchFn = (query: string, k: number) => Promise<{ note: string; snippet: string; score: number }[]>

// ──────────────────── final-citation parser (PURE; unit-tested) ────────────────────

interface RawCitation {
  note?: unknown
  lines?: unknown
  snippet?: unknown
  why?: unknown
}

/**
 * Parse the model's FINAL output into Citation[]. Tolerant, like parseConstruction:
 * pulls the first JSON object/array (handling ```json fences / leading prose),
 * accepts either `{citations:[...]}` or a bare `[...]`, coerces `lines` from a
 * [a,b] pair / "a-b" string / single number, drops items with no note, caps
 * snippet/why length, and dedups by note+lines. Returns [] on total failure.
 * PURE — unit-tested.
 */
export function parseCitations(text: string): Citation[] {
  if (!text || typeof text !== 'string') return []
  // Find the outermost JSON container: prefer an object, else an array.
  const objStart = text.indexOf('{')
  const arrStart = text.indexOf('[')
  let slice = ''
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    const end = text.lastIndexOf('}')
    if (end > objStart) slice = text.slice(objStart, end + 1)
  }
  if (!slice && arrStart >= 0) {
    const end = text.lastIndexOf(']')
    if (end > arrStart) slice = text.slice(arrStart, end + 1)
  }
  if (!slice) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return []
  }

  let arr: unknown[]
  if (Array.isArray(parsed)) {
    arr = parsed
  } else if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { citations?: unknown }).citations)) {
    arr = (parsed as { citations: unknown[] }).citations
  } else {
    return []
  }

  const out: Citation[] = []
  const seen = new Set<string>()
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue
    const r = item as RawCitation
    const note = typeof r.note === 'string' ? r.note.trim() : ''
    if (!note) continue
    const lines = coerceLines(r.lines)
    const snip = typeof r.snippet === 'string' ? snippet(r.snippet, 300) : ''
    const why = typeof r.why === 'string' ? snippet(r.why, 200) : ''
    const key = `${note}#${lines ? lines.join('-') : ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ note, ...(lines ? { lines } : {}), snippet: snip, why })
  }
  return out
}

/**
 * Deterministic reflection on the model's final citations — HONEST filtering, not self-grading:
 *  - DROP a citation only when its note id is provably ABSENT from the corpus (a hallucinated id
 *    the model invented; it can never be real evidence for the answer model).
 *  - CLAMP (never drop) an out-of-range or inverted line range to the note's real [1, len] bounds.
 *    A citation that points at a REAL note but an over-long line keeps the note (the evidence) with
 *    a valid range, instead of being discarded — matching readNote's own clamp semantics.
 * PURE + order-preserving. This can only remove fabrications and fix ranges; it never invents a
 * citation, so it is safe to run unconditionally on the live grounding path.
 */
export function verifyCitations(citations: Citation[], notes: NoteText[]): Citation[] {
  const byId = new Map(notes.map((n) => [n.id, n]))
  const out: Citation[] = []
  for (const c of citations) {
    const n = byId.get(c.note)
    if (!n) continue // provably-absent note id → drop the hallucination
    if (!c.lines) {
      out.push(c)
      continue
    }
    const len = Math.max(1, n.lines.length)
    const lo = Math.min(Math.max(1, Math.min(c.lines[0], c.lines[1])), len)
    const hi = Math.min(Math.max(1, Math.max(c.lines[0], c.lines[1])), len)
    out.push({ ...c, lines: [lo, hi] })
  }
  return out
}

// ──────────────────── NLI citation-SUPPORT gate (L1; opt-in, honest) ────────────────────
//
// verifyCitations (above) checks that a cited note EXISTS and clamps its line
// range — but NOT that the cited passage actually SUPPORTS the claim. This gate
// closes that: after id/line verification, it runs a small local NLI cross-encoder
// (premise = the clamped span text, hypothesis = the citing claim) and marks — or,
// in drop mode, removes — citations the passage does not ENTAIL. MiniCheck-class
// semantics: only entailment counts as support (neutral/contradiction = not
// supported). Honest-by-construction: it can only ADD score fields or DROP; it
// never invents, rewrites, or re-attributes a citation. Degrade-gracefully: the
// scorer is injected, and any throw / null / length-mismatch → citations returned
// UNCHANGED, so a missing model or an OFF flag is byte-identical to today.

/** Injected entailment scorer: one P(entailment) in [0,1] per (premise,
 *  hypothesis) pair, SAME order. Returns null to signal "unavailable" → the gate
 *  skips (no-op). Production wires this to EmbeddingsService.scoreEntailment;
 *  tests pass a stub so they never touch the real model / keychain / worker. */
export type NliScoreFn = (
  pairs: { premise: string; hypothesis: string }[]
) => Promise<number[] | null>

/** Cap the premise (span) text fed to the tokenizer so one long citation can't
 *  blow the 512-token budget and crowd out the hypothesis under longest-first
 *  truncation. The span is already line-bounded, so this is usually a no-op. */
const SUPPORT_PREMISE_CHAR_CAP = 2000

/** Whether the SUPPORT gate runs. Default OFF — the default path, the offline
 *  case, and every existing test stay byte-identical; DUIN_RETRIEVER_SUPPORT=1
 *  enables it. Opposite polarity to DUIN_RETRIEVER_VERIFY/HYDE (which default ON). */
export function supportGateEnabled(): boolean {
  return process.env.DUIN_RETRIEVER_SUPPORT === '1'
}

/** Support threshold: score >= threshold ⇒ supported. Env-tunable (raise toward
 *  0.6-0.7 for stricter dropping); default 0.5. Garbage env → 0.5. */
export function supportThreshold(): number {
  const t = Number(process.env.DUIN_RETRIEVER_SUPPORT_THRESHOLD)
  return Number.isFinite(t) && t > 0 && t <= 1 ? t : 0.5
}

/** Whether an unsupported citation is DROPPED (=1) or just MARKED (default).
 *  Mark-only is the safe default: the hypothesis (why/snippet/query) is a proxy
 *  for the eventual answer sentence, so a hard drop risks discarding real
 *  evidence on a mislabel — the answer model / UI can filter on `supported`. */
function supportDropEnabled(): boolean {
  return process.env.DUIN_RETRIEVER_SUPPORT_DROP === '1'
}

/** premise = the cited note's clamped span text (whole note when no line pin),
 *  length-capped. Run this on verifyCitations OUTPUT so `lines` is already
 *  clamped to [1, len] and the slice is always in range. */
function citationPremise(c: Citation, byId: Map<string, NoteText>): string {
  const n = byId.get(c.note)
  if (!n) return ''
  const text = c.lines ? n.lines.slice(c.lines[0] - 1, c.lines[1]).join('\n') : n.text
  return text.slice(0, SUPPORT_PREMISE_CHAR_CAP)
}

/** hypothesis = the claim the passage must support. No answer-sentence exists at
 *  retrieval time (the retriever emits evidence, not prose), so use the agent's
 *  rationale (`why`), else the query — a proxy, kept in one place so it's tunable.
 *  Deliberately NOT `c.snippet`: the snippet is text drawn FROM the cited passage
 *  (the premise), so entailing it would be self-entailment — trivially "supported" —
 *  which would silently defeat the gate for exactly the citations lacking a `why`. */
function citationHypothesis(c: Citation, query: string): string {
  return (c.why || query || '').trim()
}

/**
 * The SUPPORT gate. PURE given the injected scorer + notes; async. Marks each
 * citation with its P(entailment) (`support`) and `supported = score >=
 * threshold`, preserving order. In drop mode, unsupported citations are removed.
 * Honest-by-construction (only adds score fields / drops, never fabricates) and
 * degrade-graceful (scorer throw / null / length-mismatch → citations unchanged).
 */
export async function verifyCitationsSupported(
  citations: Citation[],
  notes: NoteText[],
  scorer: NliScoreFn,
  opts: { query?: string; threshold?: number; drop?: boolean } = {}
): Promise<Citation[]> {
  if (citations.length === 0) return citations
  const byId = new Map(notes.map((n) => [n.id, n]))
  const query = opts.query ?? ''
  const pairs = citations.map((c) => ({
    premise: citationPremise(c, byId),
    hypothesis: citationHypothesis(c, query)
  }))

  let scores: number[] | null
  try {
    scores = await scorer(pairs)
  } catch {
    return citations // model unavailable / worker failure → today's behavior exactly
  }
  // null (scorer signalled unavailable) or a length mismatch → no-op passthrough.
  if (!scores || scores.length !== citations.length) return citations

  const threshold = opts.threshold ?? supportThreshold()
  const drop = opts.drop ?? supportDropEnabled()
  const out: Citation[] = []
  for (let i = 0; i < citations.length; i++) {
    const score = scores[i]
    if (!Number.isFinite(score)) {
      // A missing/garbage score is NOT evidence of non-support — keep the
      // citation untouched rather than mislabel or drop it (honest).
      out.push(citations[i])
      continue
    }
    const supported = score >= threshold
    if (drop && !supported) continue
    out.push({ ...citations[i], support: score, supported })
  }
  return out
}

/** Live scorer: the embeddings-service NLI channel. Lazy-imported so a test that
 *  injects its own scorer never loads the service, and wrapped so a missing model
 *  / uninitialized service / worker failure resolves to null (gate skipped) rather
 *  than throwing — same best-effort contract as the agentic rerank leg. */
const liveNliScore: NliScoreFn = async (pairs) => {
  try {
    const { getEmbeddingsService } = await import('../rag/embeddings/service')
    const svc = getEmbeddingsService()
    return await svc.scoreEntailment(
      pairs.map((p) => p.premise),
      pairs.map((p) => p.hypothesis)
    )
  } catch {
    return null // model missing / service not initialized / worker died → gate no-op
  }
}

/** Coerce a model-supplied `lines` value into a [from,to] pair or undefined. */
function coerceLines(v: unknown): [number, number] | undefined {
  if (Array.isArray(v) && v.length >= 1) {
    const a = Number(v[0])
    const b = v.length >= 2 ? Number(v[1]) : a
    if (Number.isFinite(a) && Number.isFinite(b)) {
      return [Math.max(1, Math.trunc(Math.min(a, b))), Math.max(1, Math.trunc(Math.max(a, b)))]
    }
    return undefined
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    const n = Math.max(1, Math.trunc(v))
    return [n, n]
  }
  if (typeof v === 'string') {
    const m = v.match(/(\d+)\s*[-–:]\s*(\d+)/)
    if (m) {
      const a = Math.max(1, parseInt(m[1], 10))
      const b = Math.max(1, parseInt(m[2], 10))
      return [Math.min(a, b), Math.max(a, b)]
    }
    const single = v.match(/\d+/)
    if (single) {
      const n = Math.max(1, parseInt(single[0], 10))
      return [n, n]
    }
  }
  return undefined
}

// ──────────────────── HyDE + query-decomposition plan (PURE parse; unit-tested) ────────────────────

export interface RetrievalPlan {
  /** Decomposed sub-queries to grep for (always includes at least the original query). */
  subQueries: string[]
  /** A hypothetical ANSWER paragraph to embed (HyDE) — '' when the model gave none. */
  hypotheticalDoc: string
}

/**
 * Parse the planner's output into a RetrievalPlan. Tolerant like parseCitations: pulls the first
 * JSON object (```json fences / leading prose ok), reads `subQueries: string[]` + `hypotheticalDoc:
 * string`. Any garbage / missing fields → the SAFE fallback `{subQueries:[query], hypotheticalDoc:
 * ''}`, so a bad plan degrades to today's plain one-shot. PURE. `query` is always kept as a
 * sub-query so decomposition can only ADD coverage, never lose the original.
 */
export function parsePlan(text: string, query: string): RetrievalPlan {
  const fallback: RetrievalPlan = { subQueries: [query], hypotheticalDoc: '' }
  if (!text || typeof text !== 'string') return fallback
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(start, end + 1))
  } catch {
    return fallback
  }
  if (!parsed || typeof parsed !== 'object') return fallback
  const p = parsed as { subQueries?: unknown; hypotheticalDoc?: unknown }
  const subs = Array.isArray(p.subQueries)
    ? p.subQueries.map((s) => (typeof s === 'string' ? s.trim() : '')).filter((s) => s.length > 0)
    : []
  // Always keep the original query; dedup case-insensitively, cap the fan-out.
  const seen = new Set<string>()
  const subQueries: string[] = []
  for (const s of [query, ...subs]) {
    const k = s.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    subQueries.push(s.trim())
    if (subQueries.length >= 5) break
  }
  const hypotheticalDoc = typeof p.hypotheticalDoc === 'string' ? p.hypotheticalDoc.trim() : ''
  return { subQueries: subQueries.length ? subQueries : [query], hypotheticalDoc }
}

const PLAN_PROMPT =
  'You are the PLANNING step of a retrieval agent for a local notes brain. Given the user question, ' +
  'output ONLY a JSON object — no prose, no code fence — of the form:\n' +
  '{"subQueries":["<2-4 focused sub-queries / key terms to grep>"],"hypotheticalDoc":"<a short, ' +
  'plausible 1-3 sentence ANSWER to the question, as if written in a note>"}\n' +
  'The hypotheticalDoc is embedded to find semantically-similar notes (HyDE), so write it like the ' +
  'answer would appear in the vault, not like a question. Keep subQueries specific (proper nouns, ' +
  'relations). Output the JSON object only.'

/**
 * One planning TurnFn call → a RetrievalPlan. Never throws: any provider/parse failure resolves to
 * the safe fallback `{subQueries:[query], hypotheticalDoc:''}` so retrieval degrades to plain
 * one-shot. Uses the same cheap driver as the loop.
 */
export async function planRetrieval(query: string, turn: TurnFn): Promise<RetrievalPlan> {
  try {
    const { content } = await turn([
      { role: 'system', content: PLAN_PROMPT },
      { role: 'user', content: `Question: ${query}` }
    ])
    return parsePlan(content, query)
  } catch {
    return { subQueries: [query], hypotheticalDoc: '' }
  }
}

/** Whether the deterministic HyDE + decomposition pre-loop runs. Default ON (validated live: the
 *  seed evidence shortens the tool loop, offsetting the planning call; grounding intact);
 *  DUIN_RETRIEVER_HYDE=0 disables it. */
export function hydeEnabled(): boolean {
  return process.env.DUIN_RETRIEVER_HYDE !== '0'
}

/** The code tool (DUIN_RETRIEVER_CODE, default **OFF**; =1 enables).
 *
 *  DEFAULT REVERSED 2026-08-02, same day it shipped, after adversarial review. It went out ON with
 *  a rationale that did not survive:
 *
 *  1. **The shipped tool has never been measured.** The 18/18 came from a bespoke agent inside
 *     `aggregation-arms.eval.ts`, which gets `claims`/`turnBeats`/`corrections` in scope and 8
 *     turns / 30 tool calls. This tool gets `notes` only, 4 turns / 16 calls, through a hardened
 *     sandbox. Nine of those fifteen probes are about ledgers it cannot even see. A more capable
 *     proxy at double the budget is not evidence about this.
 *  2. **The clean isolation says something smaller than was claimed.** "Stock retrieval 0/18, the
 *     SAME agent with a code tool 18/18" is not the same agent — arm D is one search plus one
 *     answer call with no tools. The controlled comparison is P (grep, no code) 3/18 vs P+ 18/18.
 *  3. **The "it hurts lookup" premise was wrong in the other direction too.** The claim was 1/6 vs
 *     curated 6/6. But arm P — same agent MINUS the code tool — scored 2/6. The delta attributable
 *     to code is one trial in six; the 6/6 gap belongs to the bespoke agent harness, not to this.
 *  4. **The regression check was a null experiment.** `retrieve-code-regression.eval.ts` reported
 *     +0.041 with `runCode invoked 0/25` — the arms were mechanically identical, so that number
 *     measures harness noise, and the gate (`> mOff - 0.05` against mOff=0.069) cannot fail.
 *  5. **The cheaper mechanism was never tried.** The eval's grep truncates at 60 matches with no
 *     count mode, which is why it cannot answer "how many". Giving grep a total is a smaller change
 *     than a JS evaluator, and property 7 says try that first.
 *
 *  The capability gap is real — no ranking retrieves a value that exists in no note — and the
 *  sandbox is now hardened against a proven escape. What is missing is a measurement of THIS
 *  configuration. Flip to `=1` and run `aggregation-arms.eval.ts` against `retrieveContext` to earn
 *  the default back; that is a closeable gap, not a permanent no. */
export function codeEvalEnabled(): boolean {
  return process.env.DUIN_RETRIEVER_CODE === '1'
}

// ──────────────────── tool schemas (OpenAI function-calling) ────────────────────

/** EXPORTED for the live measurement harness (agentic-bypass.eval.ts) only. The eval drives the real
 *  `retrieveContext` loop through the documented `runTurnFn` seam, which hands the driver only the
 *  message list — so the driver has to supply these tool schemas to the provider itself. Exporting the
 *  production array (instead of letting the harness keep a copy) is what stops the measured loop and
 *  the shipped loop from silently drifting apart. Not used anywhere in the product path. */
export const TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'grep',
      description:
        'Search every note for lines matching a case-insensitive REGEX (JS syntax). Returns note id + line number + line text, PLUS a footer with the TOTAL number of matching lines and the TOTAL number of notes containing a match across the whole vault. The listed lines are a capped preview; the footer totals are complete, so answer "how many notes mention X" from the FOOTER and never by counting the lines shown. Use a plain word for a substring match, or a real pattern for precision: "\\bAtlas\\b" (whole word), "deadline:\\s*\\d" (structured), "(alice|bob)" (alternation). Invalid patterns fall back to a literal match.',
      parameters: {
        type: 'object',
        properties: { term: { type: 'string', description: 'A word or a JS regular expression (case-insensitive).' } },
        required: ['term']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'glob',
      description: 'List note ids matching a path/glob pattern (e.g. "**/atlas*", "people.md").',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'readNote',
      description:
        'Read a note by id, optionally a 1-based inclusive line range. Returns numbered lines so you can cite a precise range.',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          from: { type: 'number', description: '1-based start line (optional).' },
          to: { type: 'number', description: '1-based end line (optional).' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'semanticSearch',
      description: 'Hybrid lexical+vector search over the notes. Returns the top notes with snippets. Best for conceptual / paraphrased queries.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          k: { type: 'number', description: 'How many results (default 6).' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'graphNeighbors',
      description:
        'Traverse the knowledge graph: resolve a term (entity/note id or name like "Beacon") to graph nodes and return the 1-hop connected nodes via typed edges (depends_on, owns, blocks, mentions, …), in BOTH directions. Each neighbour includes a short snippet of its source note, so you often do NOT need a separate readNote. Use graphExpand instead when you need 2-hop reasoning in one call.',
      parameters: {
        type: 'object',
        properties: { idOrTerm: { type: 'string' } },
        required: ['idOrTerm']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'graphExpand',
      description:
        'Multi-hop knowledge-graph expansion in ONE call. Resolve a term (entity/note id or name like "Beacon") to seed node(s), then walk up to `hops` (1-2) edges outward in BOTH directions and return the most relevant connected nodes — ranked by relation type (depends/blocks/owns outrank mentions/about) and connectivity — each with its source-note snippet and hop distance. Prefer this over repeated graphNeighbors calls when a question needs 2-hop reasoning (e.g. "who owns what blocks project X"). graphNeighbors is the 1-hop primitive; graphExpand ranks a bounded frontier for you.',
      parameters: {
        type: 'object',
        properties: {
          idOrTerm: { type: 'string' },
          hops: { type: 'number', description: 'Edges to expand outward: 1 or 2 (default 2).' }
        },
        required: ['idOrTerm']
      }
    }
  }
]

const SYSTEM_PROMPT =
  'You are a RETRIEVAL agent for a local notes brain. Your ONLY job is to find the ' +
  'notes (and precise line ranges) that ANSWER the user\'s question, using the tools. ' +
  'You do NOT answer the question yourself — you gather evidence for another model.\n' +
  'You have NO prior knowledge of this vault — treat your own memory as EMPTY. Every ' +
  'note id and fact you cite MUST come from a tool result in THIS session; never ' +
  'invent or recall one.\n\n' +
  'Strategy:\n' +
  '- ALWAYS call at least one retrieval tool (grep / semanticSearch / graphNeighbors / ' +
  'graphExpand) BEFORE you emit citations — even if you think you know the answer. If ' +
  'the first round returns nothing useful, BROADEN and search again (try both grep AND ' +
  'semanticSearch) before giving up.\n' +
  '- Start broad: grep for the key proper nouns, or semanticSearch for concepts.\n' +
  '- Use graphNeighbors (1-hop) or graphExpand (up to 2 hops, ranked, in ONE call) to ' +
  'follow RELATIONSHIPS — e.g. if asked what blocks X and who owns it, resolve X, read ' +
  'its `blocks`/`depends_on`/`owns` neighbours, then read the notes behind those ' +
  'neighbours. This multi-hop traversal is your advantage. Graph results include source ' +
  'snippets, so you often can cite without a separate readNote.\n' +
  '- readNote to confirm the exact lines before citing.\n' +
  '- Issue tool calls IN PARALLEL when they are independent.\n' +
  '- Stop as soon as you have the evidence (within your turn budget).\n\n' +
  'When done, output ONLY a JSON object — no prose, no code fence — of the form:\n' +
  '{"citations":[{"note":"<exact note id>","lines":[<from>,<to>],"snippet":"<short quote>","why":"<one line: why this answers the question>"}]}\n' +
  'Rules: `note` MUST be an exact id seen in tool results. Include `lines` when you ' +
  'know them. Keep it to the few notes that truly answer the question. Emitting ' +
  'citations without having called a tool is a FAILURE. An empty citations array is ' +
  'allowed only AFTER you have actually searched and found nothing.'

/** Render computed evidence for the ANSWER model's context. Labelled as a computation over the
 *  whole corpus, never as something a note said — the two must stay distinguishable or a derived
 *  number becomes indistinguishable from a quoted one. Failed computations are dropped: a caller
 *  reading an error string as evidence is worse than it seeing nothing. */
export function renderComputed(computed?: ComputedEvidence[]): string {
  const ok = (computed ?? []).filter((c) => !c.failed && c.result.trim())
  if (!ok.length) return ''
  return [
    '<computed_over_whole_vault>',
    'These values were COMPUTED across every note, not quoted from one. Prefer them over any count',
    'you might infer from the excerpts below, which are only a sample.',
    ...ok.map((c, i) => `[c${i + 1}] ${c.code.replace(/\s+/g, ' ').slice(0, 200)}\n     => ${c.result.slice(0, 500)}`),
    '</computed_over_whole_vault>'
  ].join('\n')
}

/** Appended to the system prompt ONLY when the code tool is offered. A prompt that describes a tool
 *  the model does not have is a reliable way to waste a turn on a hallucinated call. */
const CODE_GUIDANCE =
  '\n\nCROSS-NOTE QUESTIONS: some questions have no answer in any single note — "how many notes ' +
  'mention X", "which note has the most Y", "what is the most common Z". Ranking cannot retrieve a ' +
  'value that exists nowhere, and grep TRUNCATES its match list so counting its output is wrong. ' +
  'For those, call runCode and compute over the whole corpus. Then still emit citations for the ' +
  'notes a reader would want to see (an empty citations array is correct when the answer is purely ' +
  'a computed number). Never put a computed number in a `snippet` as though a note stated it.'

/** The code tool. Kept OUT of `TOOLS` so the base six stay the stable, always-offered set and a
 *  caller that disables code gets a byte-identical tool list to before this existed. */
export const CODE_TOOL: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'runCode',
    description:
      'Run JavaScript across the WHOLE note corpus at once and return whatever you assign to `result`. ' +
      'In scope: `notes`, an object mapping note id -> full note text. No require, no fs, no network, ' +
      'synchronous only, 3s limit.\n' +
      'Use this when the answer is NOT in any single note — counting, tallying, finding a maximum, ' +
      'or comparing across many notes. grep shows you matching lines but truncates, so it cannot tell ' +
      'you a total; this can.\n' +
      'Example: result = Object.keys(notes).filter(k => notes[k].includes("Atlas")).length',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'JavaScript. Assign your answer to `result`.' } },
      required: ['code']
    }
  }
}

/** The tool list actually offered to the model this run. */
export function activeTools(codeEnabled: boolean): ChatCompletionTool[] {
  return codeEnabled ? [...TOOLS, CODE_TOOL] : TOOLS
}

// ──────────────────── the agent loop ────────────────────

/** Run a single chatStream turn and resolve to {content, toolCalls}. */
function runTurn(
  messages: ChatCompletionMessageParam[],
  model: string,
  tools: ChatCompletionTool[] = TOOLS
): Promise<{ content: string; toolCalls: ToolCallAccumulator[] }> {
  return new Promise((resolve, reject) => {
    chatStream(
      messages,
      model,
      tools,
      {
        onChunk: () => {},
        onDone: (content: string, toolCalls?: ToolCallAccumulator[]) => {
          resolve({ content: content ?? '', toolCalls: toolCalls ?? [] })
        },
        onError: (error: string) => reject(new Error(error))
      }
    ).catch(reject)
  })
}

/** Injectable so tests exercise the loop without `node:vm` and a bench can stub the result. */
export type CodeEvalFn = (code: string, notes: NoteText[]) => { output: string; error?: string; truncated?: boolean }

interface ToolDeps {
  notes: NoteText[]
  graph: GraphView
  semanticSearch: SemanticSearchFn
  /** Absent ⇒ the code tool was not offered, and a call to it is an unknown-tool error. */
  codeEval?: CodeEvalFn
  /** Where `runCode` results accumulate for RetrieveResult.computed. Mutated by execTool. */
  computedSink?: ComputedEvidence[]
}

/** Build the sandbox scope once per call. `notes` is exposed as a plain id -> text object because
 *  that is the shape a model reaches for (`Object.keys(notes)`), and NoteText[] would force it to
 *  learn our record type before it could count anything. */
export const defaultCodeEval: CodeEvalFn = (code, notes) => {
  const map: Record<string, string> = {}
  for (const n of notes) map[n.id] = n.text
  // The scope must be pure JSON DATA. evalInSandbox serialises it and rebuilds it inside the
  // context, which is what prevents a script reaching the host realm through a passed object's
  // prototype (`notes.constructor.constructor('return process')()`). Handing a live object or an
  // array here instead would reopen a proven RCE — see code-sandbox.ts's threat model.
  return evalInSandbox(code, { notes: map })
}

/** Execute one accumulated tool call → a string result for the model. */
async function execTool(
  call: ToolCallAccumulator,
  deps: ToolDeps
): Promise<string> {
  let args: Record<string, unknown>
  try {
    args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {}
  } catch {
    return 'ERROR: could not parse tool arguments as JSON.'
  }
  try {
    switch (call.function.name) {
      case 'grep': {
        const term = String(args.term ?? '')
        const hits = grep(deps.notes, term)
        if (!hits.length) return '(no matching lines)'
        // ALWAYS publish the totals, not only when truncated. A model that sees a bare list has to
        // infer whether it is complete, and it infers wrongly — this is the whole reason counting
        // looked impossible without code execution.
        const t = grepTotals(deps.notes, term)
        const shown = hits.length
        const footer =
          shown < t.lines
            ? `\n[showing ${shown} of ${t.lines} matching lines, across ${t.notes} note(s) — this list is TRUNCATED; use the totals, do not count the lines above]`
            : `\n[${t.lines} matching line(s) across ${t.notes} note(s) — complete]`
        return hits.map((h) => `${h.note}:${h.line}: ${h.text}`).join('\n') + footer
      }
      case 'glob': {
        const ids = glob(deps.notes, String(args.pattern ?? ''))
        return ids.length ? ids.join('\n') : '(no matching note ids)'
      }
      case 'readNote': {
        const from = typeof args.from === 'number' ? args.from : undefined
        const to = typeof args.to === 'number' ? args.to : undefined
        const range = from != null ? ([from, to ?? from] as [number, number]) : undefined
        const text = readNote(deps.notes, String(args.id ?? ''), range)
        return text || '(unknown note id)'
      }
      case 'semanticSearch': {
        const k = typeof args.k === 'number' && args.k > 0 ? Math.min(args.k, 12) : 6
        const hits = await deps.semanticSearch(String(args.query ?? ''), k)
        return hits.length
          ? hits.map((h) => `${h.note} (${h.score.toFixed(2)}): ${snippet(h.snippet)}`).join('\n')
          : '(no results)'
      }
      case 'graphNeighbors': {
        const nbs = graphNeighbors(deps.graph, String(args.idOrTerm ?? ''), deps.notes)
        return nbs.length
          ? nbs
              .map(
                (n) =>
                  `${n.from} --[${n.via}${n.dir === 'in' ? ' (incoming)' : ''}]--> ${n.id} (${n.kind}: ${n.label})` +
                  (n.snippet ? `\n    “${n.snippet}”` : '')
              )
              .join('\n')
          : '(no graph neighbours — try grep/semanticSearch instead)'
      }
      case 'graphExpand': {
        const hops = typeof args.hops === 'number' ? args.hops : 2
        const hits = graphExpand(deps.graph, String(args.idOrTerm ?? ''), deps.notes, hops)
        return hits.length
          ? hits
              .map(
                (h) =>
                  `[h${h.hop}] ${h.from} --[${h.via}${h.dir === 'in' ? ' (incoming)' : ''}]--> ${h.id} (${h.kind}: ${h.label})` +
                  (h.snippet ? `\n    ↳ ${h.snippet}` : '')
              )
              .join('\n')
          : '(no graph expansion — try grep/semanticSearch instead)'
      }
      case 'runCode': {
        if (!deps.codeEval) return 'ERROR: unknown tool runCode'
        const code = String(args.code ?? '')
        const r = deps.codeEval(code, deps.notes)
        // Record BOTH outcomes. A failed computation that vanished from `computed` would let the
        // caller read "no computation happened" and "the computation broke" as the same state.
        deps.computedSink?.push({
          code: code.slice(0, 600),
          result: r.error ? r.error : r.output,
          ...(r.error ? { failed: true } : {})
        })
        if (r.error) return `ERROR: ${r.error}`
        return r.truncated ? `${r.output}\n[TRUNCATED — result was longer than the cap]` : r.output
      }
      default:
        return `ERROR: unknown tool ${call.function.name}`
    }
  } catch (err) {
    return `ERROR: ${(err as Error)?.message ?? 'tool failed'}`
  }
}

/**
 * Agentic, graph-aware retrieval. Drives a cheap model through a read-only tool
 * loop over the vault + constructed graph and returns compact `note:line`
 * citations. Returns null when no model is configured (caller → today's
 * search()) or on any failure (degrade gracefully — never regress grounding).
 */
export async function retrieveContext(
  query: string,
  opts: RetrieveOptions = {}
): Promise<RetrieveResult | null> {
  const q = (query ?? '').trim()
  if (!q) return null

  // When a scripted driver is supplied (bench/tests) we never touch the live
  // provider/keychain — resolve the model only for the real path.
  const model = opts.runTurnFn
    ? opts.model ?? 'scripted'
    : opts.model !== undefined
      ? opts.model
      : routeModel('extraction')
  if (!model && !opts.runTurnFn) return null
  const codeOn = opts.code ?? codeEvalEnabled()
  const tools = activeTools(codeOn)
  const turn: TurnFn =
    opts.runTurnFn ?? ((messages) => runTurn(messages, model as string, tools))

  const maxTurns = opts.maxTurns ?? 4
  const maxToolCalls = opts.maxToolCalls ?? 16

  // Resolve the corpus + graph once per retrieval (live, or injected for tests).
  const computedSink: ComputedEvidence[] = []
  let deps: ToolDeps
  try {
    deps = {
      ...(codeOn ? { codeEval: opts.codeEval ?? defaultCodeEval, computedSink } : {}),
      notes: opts.notes ?? liveCorpus(),
      graph: opts.graph ?? liveGraph(),
      // Lazy import of the index-store search to keep this a thin reuse and
      // avoid a hard dep when a test injects its own corpus.
      semanticSearch:
        opts.notes
          ? async () => [] // test corpus → no live vector store; grep/graph cover it
          : async (sq, k) => {
              const store = await import('../local-brain/index-store')
              let hits = await store.search(sq, k)
              // Bring the cross-encoder reranker to the AGENTIC path too — it previously fired ONLY
              // on the one-shot fallback, so the loop's strongest ranking signal never reached the
              // model. Gated by the same rag.rerankMode setting; best-effort (rerankHits returns the
              // fusion order on any failure), so this can only improve or no-op the ranking.
              try {
                if (hits.length > 1) {
                  const [{ resolveRerankMode }, { readSettings }] = await Promise.all([
                    import('../rag/rerank'),
                    import('../settings-helper')
                  ])
                  const ragCfg = ((readSettings() as { rag?: { rerankMode?: string; rerankerId?: string } }).rag) ?? {}
                  if (resolveRerankMode(ragCfg) !== 'off') hits = await store.rerankHits(sq, hits, ragCfg.rerankerId)
                }
              } catch (e) { console.debug('[retrieve-agent] keep the fusion order:', messageOf(e)) }
              return hits.map((h) => ({ note: h.file, snippet: h.snippet, score: h.score }))
            }
    }
  } catch {
    return null
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: codeOn ? SYSTEM_PROMPT + CODE_GUIDANCE : SYSTEM_PROMPT },
    { role: 'user', content: `Question: ${q}\n\nFind the notes that answer this.` }
  ]

  // ── Deterministic HyDE + query-decomposition pre-loop ──
  // Plan (one model call) → subQueries + a hypothetical ANSWER. Then DETERMINISTICALLY seed
  // evidence: embed the hypothetical answer (HyDE — semantically finds notes the weak query
  // misses) and grep each sub-query. Inject the seed as a plain context message (NOT fabricated
  // tool_calls — provider-fragile). DUIN_RETRIEVER_HYDE default ON (=0 disables); any throw falls
  // back to today's one-shot exactly. The seed searches are deterministic, so no tool-call budget.
  if ((opts.hyde ?? hydeEnabled()) && (maxToolCalls > 0)) {
    try {
      const plan = await planRetrieval(q, turn)
      const seed: string[] = []
      const seenSeed = new Set<string>()
      const pushSeed = (line: string): void => {
        const k = line.trim()
        if (k && !seenSeed.has(k)) {
          seenSeed.add(k)
          seed.push(k)
        }
      }
      if (plan.hypotheticalDoc) {
        for (const h of await deps.semanticSearch(plan.hypotheticalDoc, 6)) pushSeed(`${h.note}: ${snippet(h.snippet)}`)
      }
      for (const sq of plan.subQueries.slice(0, 4)) {
        for (const g of grep(deps.notes, sq).slice(0, 4)) pushSeed(`${g.note}:${g.line}: ${g.text}`)
      }
      if (seed.length) {
        messages.push({
          role: 'user',
          content:
            'Pre-fetched seed evidence (from a hypothetical-answer embedding + sub-query greps). ' +
            'Verify with readNote before citing; use the tools to fill gaps:\n' +
            seed.slice(0, 24).join('\n')
        })
      }
    } catch (e) { console.debug('[retrieve-agent] HyDE is best-effort  fall back to the plain loop with no seed:', messageOf(e)) }
  }

  let turns = 0
  let toolCallsUsed = 0
  let lastContent = ''

  try {
    while (turns < maxTurns) {
      turns++
      const { content, toolCalls } = await turn(messages)
      lastContent = content || lastContent

      if (!toolCalls.length) {
        // The model produced its final answer (citations) with no further tools.
        break
      }

      // Record the assistant tool-call turn, then execute (in parallel) and feed
      // results back. Respect the global tool-call cap.
      const budget = Math.max(0, maxToolCalls - toolCallsUsed)
      const toRun = toolCalls.slice(0, budget)
      toolCallsUsed += toRun.length

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toRun.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: { name: tc.function.name, arguments: tc.function.arguments }
        }))
      } as ChatCompletionMessageParam)

      const results = await Promise.all(toRun.map((tc) => execTool(tc, deps)))
      toRun.forEach((tc, i) => {
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: results[i]
        } as ChatCompletionToolMessageParam)
      })

      if (toolCallsUsed >= maxToolCalls) {
        // Out of budget — ask once more for the final citations, then stop.
        messages.push({
          role: 'user',
          content: 'Tool budget reached. Output your final citations JSON now.'
        })
        const final = await turn(messages)
        lastContent = final.content || lastContent
        break
      }
    }
  } catch {
    // Any provider/loop failure → degrade to the caller's fallback.
    return null
  }

  // Deterministic reflection: drop provably-absent (hallucinated) note ids and clamp out-of-range
  // line spans, so the answer model never grounds on a fabricated citation. Honest-by-construction
  // (can only remove/clamp), so it runs by default; DUIN_RETRIEVER_VERIFY=0 restores raw parsing.
  const parsed = parseCitations(lastContent)
  let citations = process.env.DUIN_RETRIEVER_VERIFY === '0' ? parsed : verifyCitations(parsed, deps.notes)

  // NLI citation-SUPPORT gate (L1) — opt-in (default OFF), honest, degrade-graceful.
  // Runs AFTER verifyCitations so the premise slice uses the already-clamped span.
  // OFF, or an unavailable model (injected scorer → null / throw), leaves `citations`
  // byte-identical to today.
  if (opts.support ?? supportGateEnabled()) {
    citations = await verifyCitationsSupported(citations, deps.notes, opts.nliScore ?? liveNliScore, { query: q })
  }

  // `computed` is present only when the tool was offered — absent and empty are different states
  // (not available vs available and unused), and a caller may reasonably branch on that.
  return { citations, turns, toolCalls: toolCallsUsed, ...(codeOn ? { computed: computedSink } : {}) }
}
