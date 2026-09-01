// Context compilation — organize + rescue retrieved evidence before it reaches
// the answer model. Graft of SkillRAE (arXiv:2605.10114): organizing retrieved
// evidence (by topic cluster) + rescuing a graph-central note that flat top-k
// dropped beats a flat concatenation, ablated. See PLANNING/
// DUIN_CONTEXT_COMPILATION_SPEC.md.
//
// PURE: takes the citations `retrieveContext` already produced, the GraphView
// (for 1-hop neighbours), and a precomputed community map (caller runs
// detectCommunities). No I/O, no model, no globals — fully unit-tested. The live
// wiring (server.ts chat seam) is a separate, deploy-gated step.

import { graphNeighbors, type Citation, type GraphView } from './retrieve-agent'
import { cjkTokens } from './cjk-tokens'

export interface CompiledContext {
  /** The compiled context block (drop-in for citationsToContext's output). */
  context: string
  /** Note ids pulled in by the rescue pass (not in the original citations). */
  rescued: string[]
  /** Number of topic clusters rendered (excludes the catch-all "other"). */
  clusters: number
}

export interface CompileOptions {
  /** Resolve full snippet text for a rescued note (it wasn't in the citations).
   *  Absent / returns undefined → the graph label is used as the snippet. */
  snippetFor?: (noteId: string) => string | undefined
  /** Flat renderer to fall back to when there's no usable graph. The live wire
   *  passes the existing `citationsToContext` so degraded output is byte-identical
   *  to today's; tests omit it and get the equivalent built-in. */
  flatFallback?: (citations: Citation[]) => string
}

/** ≤2 rescued notes — bounded so the pass can't bloat context or pull in noise. */
const RESCUE_CAP = 2
/** A new snippet whose tokens are ≥90% already covered is a near-duplicate. */
const DEDUP_THRESHOLD = 0.9

/**
 * Tokenize for the rescue lexical match + dedup. Latin/digit runs → whole words
 * (len>1); CJK runs → overlapping bigrams. Shares [[cjk-tokens]] with index-store's
 * tokenizeForLexical so Chinese terms match here too — the whole point of the CJK
 * work — and so the two can never drift apart. PURE.
 */
export function tokenize(s: string): Set<string> {
  return new Set(cjkTokens(s))
}

/** Fraction of `ts`'s tokens already present in `prev` (how covered the new one is). */
function coverage(ts: Set<string>, prev: Set<string>): number {
  if (ts.size === 0) return 0
  let inter = 0
  for (const t of ts) if (prev.has(t)) inter++
  return inter / ts.size
}

/** Render one citation in the legacy `[n] (loc)<marker>\nsnippet\nwhy:` shape —
 *  identical to server.ts:citationsToContext when marker is empty. */
function renderCitation(c: Citation, idx: number, marker = ''): string {
  const loc = c.lines ? `${c.note}:${c.lines[0]}-${c.lines[1]}` : c.note
  const snip = c.snippet ? c.snippet.replace(/^\s*---[\s\S]*?---\s*/, '').trim() : ''
  const why = c.why ? `\nwhy: ${c.why}` : ''
  return `[${idx}] (${loc})${marker}\n${snip}${why}`
}

/** Built-in flat fallback — byte-identical to server.ts:citationsToContext. */
function defaultFlat(citations: Citation[]): string {
  if (citations.length === 0) return '(no relevant notes found in the local index)'
  return citations.map((c, i) => renderCitation(c, i + 1)).join('\n\n')
}

/**
 * Compile retrieved citations into a topic-organized, rescue-augmented, deduped
 * context block. Degrades to the flat fallback when there's no usable graph, so
 * it's never worse than today.
 */
export function compileContext(
  citations: Citation[],
  query: string,
  graph: GraphView | null | undefined,
  communities: Map<string, number>,
  opts: CompileOptions = {}
): CompiledContext {
  const flat = (): string => (opts.flatFallback ? opts.flatFallback(citations) : defaultFlat(citations))

  // ── Degrade cleanly: nothing to organize, or no graph structure ──
  if (citations.length === 0) return { context: flat(), rescued: [], clusters: 0 }
  if (!graph || graph.nodes.length === 0 || communities.size === 0) {
    return { context: flat(), rescued: [], clusters: 0 }
  }

  // ── 1. Dedup near-duplicate snippets (keep first) ──
  const deduped: Citation[] = []
  const seenTokens: Set<string>[] = []
  for (const c of citations) {
    const ts = tokenize(c.snippet)
    if (ts.size > 0 && seenTokens.some((prev) => coverage(ts, prev) >= DEDUP_THRESHOLD)) continue
    deduped.push(c)
    seenTokens.push(ts)
  }

  // ── 2. Rescue: a graph-central note that is ALSO query-relevant but uncited ──
  const citedIds = new Set(deduped.map((c) => c.note))
  const qTokens = tokenize(query)
  const labelOf = new Map(graph.nodes.map((n) => [n.id, n.label]))
  const degree = (id: string): number =>
    graph.edges.reduce((n, e) => n + (e.source === id || e.target === id ? 1 : 0), 0)

  const candidates = new Map<string, string>() // id -> via edge type
  for (const c of deduped) {
    for (const nb of graphNeighbors(graph, c.note)) {
      if (citedIds.has(nb.id) || candidates.has(nb.id)) continue
      // Gate on BOTH: graph-adjacent (already true) AND query-relevant.
      const nbTokens = new Set([...tokenize(nb.id), ...tokenize(nb.label)])
      if (![...qTokens].some((t) => nbTokens.has(t))) continue
      candidates.set(nb.id, nb.via)
    }
  }
  const rescued = [...candidates.entries()]
    .sort((a, b) => degree(b[0]) - degree(a[0]))
    .slice(0, RESCUE_CAP)
  const rescuedCitations: { c: Citation; rescued: boolean }[] = rescued.map(([id, via]) => ({
    c: {
      note: id,
      snippet: opts.snippetFor?.(id) ?? labelOf.get(id) ?? id,
      why: `linked via ${via} to a retrieved note — rescued (flat top-k missed it)`
    },
    rescued: true
  }))

  // ── 3. Group by community + render ──
  const all = [...deduped.map((c) => ({ c, rescued: false })), ...rescuedCitations]
  const commOf = (id: string): number => communities.get(id) ?? -1
  const buckets = new Map<number, { c: Citation; rescued: boolean }[]>()
  for (const item of all) {
    const k = commOf(item.c.note)
    if (!buckets.has(k)) buckets.set(k, [])
    buckets.get(k)!.push(item)
  }

  // Cluster header = label of the highest-degree note in the bucket (human cue).
  const clusterLabel = (items: { c: Citation }[]): string => {
    let best = items[0].c.note
    let bestDeg = -1
    for (const it of items) {
      const d = degree(it.c.note)
      if (d > bestDeg) {
        bestDeg = d
        best = labelOf.get(it.c.note) ?? it.c.note
      }
    }
    return best || 'related notes'
  }

  // Stable order: real clusters by size desc, the catch-all (-1) always last.
  const orderedKeys = [...buckets.keys()].sort((a, b) => {
    if (a === -1) return 1
    if (b === -1) return -1
    return buckets.get(b)!.length - buckets.get(a)!.length
  })

  let idx = 0
  const sections: string[] = []
  for (const k of orderedKeys) {
    const items = buckets.get(k)!
    const header = k === -1 ? '▸ other notes' : `▸ ${clusterLabel(items)}`
    const lines = items.map((it) => renderCitation(it.c, ++idx, it.rescued ? '  (linked)' : ''))
    sections.push(`${header}\n${lines.join('\n\n')}`)
  }

  return {
    context: `organized by topic:\n\n${sections.join('\n\n')}`,
    rescued: rescued.map(([id]) => id),
    clusters: orderedKeys.filter((k) => k !== -1).length
  }
}
