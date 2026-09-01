// Depth-adaptive, bounded, MODEL-FREE multi-hop graph-expansion retriever.
//
// A clean deterministic SIBLING of retrieve-agent.ts's graphExpand — NOT a fork. Where the agentic
// retriever needs a cheap model to DRIVE per-hop tool calls, this one is pure: no LLM at query time,
// no network, no keychain. It takes (query, notes, entityGraph) and returns a ranked note-id list.
//
// WHY a new arm: fixed 1-hop BM25 (wholenote-ground.bm25Rank) surfaces the note that lexically
// matches the query but MISSES the bridge note a multi-hop question needs — the second-hop evidence
// whose text shares few query terms (e.g. "who owns the project that the designer-hire blocks" →
// the people note never mentions "designer"). Graph expansion over the cached co-mention entity
// graph recovers those bridges; the trick is doing it WITHOUT drowning the gold in a dense mention
// graph. Two knobs control that noise-vs-recall trade:
//   1. DEPTH-ADAPTIVE hop count — seed with BM25, expand, RE-RANK, and only spend another hop while
//      the top-K is still churning (an easy lexical question converges at hop 1; a 4-hop bridge
//      question keeps going up to the budget). Hop-depth is matched to the QUESTION, not fixed.
//   2. FAN-OUT pruning — IDF-weighted edges (a hub entity mentioned in many notes carries little
//      signal), a per-source neighbour cap, a frontier cap, and a hub-degree cap, so a dense graph
//      can't flood the candidate pool.
//
// The graph is the entity co-mention index cached per instance (nodes[].entities + entityIndex:
// normalized-entity → [note ids]), built OFFLINE by a cheap model and read from disk. At query time
// this module reads structure only — never the model, never the gold.
//
// PURE + deterministic: same (query, notes, graph, opts) → same ranking. Unit-testable in isolation
// (it imports only the pure BM25/tokenizer from wholenote-ground).

import { bm25Rank, tokenize, type WNNote } from './wholenote-ground'

/** The cached per-instance entity graph (one JSON on disk per instance id).
 *  - `nodes`: every note with the surface-form entities lifted from it.
 *  - `entityIndex`: normalized (lowercased) entity → the note ids that mention it. This is the
 *    hop table: seed-note → its entities → entityIndex → co-mentioning notes. */
export interface EntityGraph {
  nodes: { note: string; entities: string[] }[]
  entityIndex: Record<string, string[]>
}

export interface GraphExpandOpts {
  /** BM25 seeds that anchor the personalized expansion. Default 5. */
  seedN?: number
  /** The top-K window whose STABILITY drives the depth-adaptive stop. Default 10. */
  topK?: number
  /** Hop budget — the retriever covers up to this many hops (task asks for 4). Default 4. */
  maxHops?: number
  /** Per-source neighbour cap: only the top-F strongest edges out of each frontier note are
   *  followed (fan-out control). Default 6. */
  fanoutPerNode?: number
  /** Only the top-M most-activated frontier notes expand each hop (fan-out control). Default 8. */
  frontierCap?: number
  /** DENSITY BRAKE (output-side frontier cap). Max NEW notes a single hop may admit to the reached
   *  pool; when a hop's fresh reach exceeds this, only the strongest-inflow `maxFrontierPerHop` new
   *  notes are admitted and the long noise tail is dropped. This is the fix for the dense-graph
   *  over-expansion regression: on a pathologically dense mention graph, adaptive depth otherwise
   *  floods the pool with weakly-activated notes whose beta·activation demotes gold (-2.6pp measured);
   *  bounding fresh admissions keeps the depth matched to signal, not to graph density. INERT on
   *  sparse graphs — when a hop's new reach is <= this cap the branch never fires, so the ranking is
   *  byte-identical to uncapped. Default ON at a conservative 16 (existing frontierCap·fanoutPerNode
   *  bounds a hop at ~48, so 16 bites only genuinely dense hops); pass Infinity to disable. */
  maxFrontierPerHop?: number
  /** Drop an entity from the adjacency when it is mentioned in MORE than this many notes — a hub
   *  entity connects everything and only adds noise. Default: max(4, floor(N*0.4)).
   *
   *  ⚠ CORPUS-SIZE ASSUMPTION (measured 2026-07-25, NOT retuned — no evidence for a better value).
   *  The `N*0.4` proportional form was tuned on 10–20-note TUNE corpora, where it caps df at ~4–8 and
   *  genuinely prunes hubs. It does NOT scale: on the operator's real vault (N≈1130 notes reaching
   *  this retriever) it computes max(4, ⌊1130·0.4⌋) = 452, i.e. an entity would have to appear in 452
   *  notes before being treated as a hub — so the brake prunes essentially nothing and the adjacency
   *  keeps every noisy hub edge. This is one of the two root causes of the measured retrieval
   *  regression that made DUIN_GRAPH_EXPAND_GROUND default-OFF (see graph-expand-adapt.ts). A
   *  size-independent form (absolute cap, or a df QUANTILE) is the likely fix, but nothing has been
   *  measured — do not change this constant without a fresh evaluation. */
  hubDfCap?: number
  /** Per-hop activation damping (PPR-style). Lower ⇒ later hops matter less. Default 0.5. */
  decay?: number
  /** Weight on the lexical (BM25) signal in the final re-rank. Default 1.0.
   *  See the beta note below — the alpha/beta BALANCE, not alpha alone, is what is miscalibrated. */
  alpha?: number
  /** Weight on the graph-activation signal (edge weight + seed proximity). Tuned on the TUNE split:
   *  1.2 slightly over-weights the graph vs the lexical signal — it lifts a reached but low-BM25
   *  bridge one rank higher (R@5 67.8→68.4 on TUNE) with no R@gold/R@10 cost. Past ~1.3 the graph
   *  starts outranking strong lexical seeds and strict R@gold drops, so 1.2 is the plateau edge.
   *  Default 1.2.
   *
   *  ⚠ CORPUS-SIZE ASSUMPTION (measured 2026-07-25, NOT retuned — no evidence for a better value).
   *  "TUNE" above is a set of 10–20-note corpora. On a real vault the same beta=1.2 > alpha=1.0
   *  balance inverts: with thousands of candidates the activation term promotes WEAKLY-activated
   *  reached notes above genuine BM25 hits and evicts gold from the top-k window. Measured on the
   *  operator's index (25 probes, 12,793 chunks): recall@5 0.318 vs RRF 2:1 fusion's 0.408 (−9.0pp),
   *  MRR 0.533 vs 0.636. This is one of the two root causes (with hubDfCap above) of the regression
   *  that made DUIN_GRAPH_EXPAND_GROUND default-OFF (see graph-expand-adapt.ts). Plausibly beta
   *  should be < alpha at vault scale, or scale with corpus size — but that is UNMEASURED; do not
   *  change these constants without a fresh evaluation on a real-sized corpus. */
  beta?: number
  /** Weight on a LEXICAL-GATED ACTIVATION term: gamma·act·[bmNorm>0]. Intended as a bridge-vs-noise
   *  discriminator (reward a reached note that shares ANY query term over pure mention-graph noise).
   *  MEASURED NET-NEGATIVE on TUNE (any gamma>0 lowered R@gold monotonically): the gate also promotes
   *  reached lexical DISTRACTORS, and it costs more than the true bridges it saves. Kept as a tunable
   *  seam but OFF by default. Default 0. */
  gamma?: number
  /** Depth-adaptive STOP patience: require the top-K window to hold for this many CONSECUTIVE hops
   *  before declaring convergence (frontier exhaustion is always a hard stop). Provably INERT on the
   *  TUNE corpora — the graphs are tiny (~10-20 notes) so the frontier exhausts before any window
   *  stabilizes, making `!anyNew` the operative stop. Retained as a correct guard for larger
   *  real-vault graphs where a deep chain can plateau mid-expansion; default 1 = iter1 stop
   *  semantics, so the default ranking is unchanged. Default 1. */
  patience?: number
}

export interface GraphExpandResult {
  /** Every note id, best-first: seeds + graph-reached notes by fused score, then any unreached
   *  notes by BM25 as a defensive tail so recall@k is defined for all k. */
  ranked: string[]
  /** How many hops the adaptive loop actually spent (1..maxHops) — the depth it matched to the
   *  question. Exposed so the harness can report the depth distribution. */
  hopsUsed: number
}

/** Normalize a surface-form entity to the entityIndex key convention (lowercased, ws-collapsed). */
function normEntity(e: string): string {
  return (e ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

interface Edge {
  to: string
  /** Transition weight (per-source normalized so a note's out-edges sum to ~1) — PPR-style. */
  w: number
}

/**
 * Depth-adaptive bounded multi-hop graph-expansion retrieval. Returns a full best-first note-id
 * ranking. MODEL-FREE + deterministic. See the file header for the design; the short version:
 *   1. BM25 seeds → personalized activation.
 *   2. Expand over IDF-weighted, hub-pruned, fan-out-capped entity edges; propagate activation.
 *   3. RE-RANK the pool each hop by alpha·BM25 + beta·activation.
 *   4. Stop when the top-K stops changing, the frontier is exhausted, or the hop budget is spent.
 */
export function graphExpandRetrieve(
  query: string,
  notes: WNNote[],
  graph: EntityGraph,
  opts: GraphExpandOpts = {}
): GraphExpandResult {
  const N = notes.length
  const seedN = opts.seedN ?? 5
  const topK = opts.topK ?? 10
  const maxHops = Math.max(1, Math.min(4, opts.maxHops ?? 4))
  const fanoutPerNode = opts.fanoutPerNode ?? 6
  const frontierCap = opts.frontierCap ?? 8
  const maxFrontierPerHop = Math.max(1, opts.maxFrontierPerHop ?? 16)
  const hubDfCap = opts.hubDfCap ?? Math.max(4, Math.floor(N * 0.4))
  const decay = opts.decay ?? 0.5
  const alpha = opts.alpha ?? 1.0
  const beta = opts.beta ?? 1.2
  const gamma = opts.gamma ?? 0
  const patience = Math.max(1, opts.patience ?? 1)

  const noteIds = notes.map((n) => n.id)
  const idSet = new Set(noteIds)
  if (N === 0) return { ranked: [], hopsUsed: 0 }

  // ── lexical signal: BM25 over the query, normalized to [0,1] ──
  const bmScore = new Map<string, number>()
  for (const r of bm25Rank(query, notes)) bmScore.set(r.id, r.score)
  const maxBm = Math.max(0, ...bmScore.values())
  const bmNorm = (id: string): number => (maxBm > 0 ? (bmScore.get(id) ?? 0) / maxBm : 0)

  // ── entity document frequencies + IDF (rare entity = strong, specific bridge) ──
  const df = new Map<string, number>()
  for (const [ent, ids] of Object.entries(graph.entityIndex)) {
    // Count only notes actually present in this corpus (a cached graph may reference stale ids).
    const cnt = ids.filter((id) => idSet.has(id)).length
    if (cnt > 0) df.set(ent, cnt)
  }
  const idf = (ent: string): number => {
    const d = df.get(ent) ?? 0
    return d > 0 ? Math.log(1 + N / d) : 0
  }

  // ── build IDF-weighted, hub-pruned adjacency once (corpus is tiny: ~10-20 notes) ──
  // note → its usable entities (present in index, 2..hubDfCap notes: df<2 bridges nothing, df>cap
  // is a hub). Then note → note edge weight = Σ idf(shared entity), per-source normalized.
  const noteEnts = new Map<string, string[]>()
  for (const node of graph.nodes) {
    if (!idSet.has(node.note)) continue
    const ents = new Set<string>()
    for (const raw of node.entities ?? []) {
      const e = normEntity(raw)
      const d = df.get(e) ?? 0
      if (d >= 2 && d <= hubDfCap) ents.add(e)
    }
    noteEnts.set(node.note, [...ents])
  }
  const adj = new Map<string, Edge[]>()
  for (const [note, ents] of noteEnts) {
    const wsum = new Map<string, number>()
    for (const e of ents) {
      const w = idf(e)
      for (const m of graph.entityIndex[e] ?? []) {
        if (m === note || !idSet.has(m)) continue
        wsum.set(m, (wsum.get(m) ?? 0) + w)
      }
    }
    // Keep the strongest fanoutPerNode neighbours; normalize their weights to a transition dist.
    const edges = [...wsum.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, fanoutPerNode)
    const total = edges.reduce((s, [, w]) => s + w, 0) || 1
    adj.set(note, edges.map(([to, w]) => ({ to, w: w / total })))
  }

  // ── seed the activation from BM25 top-N (normalized) ──
  const seeds = bm25Rank(query, notes).slice(0, seedN)
  const seedMax = Math.max(0, ...seeds.map((s) => s.score))
  const activation = new Map<string, number>()
  for (const s of seeds) activation.set(s.id, seedMax > 0 ? s.score / seedMax : 1)
  // Cold-start guard: no lexical hit at all → seed the whole corpus uniformly so expansion still runs.
  if (activation.size === 0) for (const id of noteIds.slice(0, seedN)) activation.set(id, 1)
  const reached = new Set(activation.keys())

  // Re-rank the current pool by the fused score; return the top-K id window (for the stop test).
  const rankPool = (): { order: string[]; window: string[] } => {
    const maxAct = Math.max(1e-9, ...activation.values())
    const scored = [...reached].map((id) => {
      const bm = bmNorm(id)
      const act = (activation.get(id) ?? 0) / maxAct
      // Additive lexical + graph, plus a lexical-GATED activation bonus: a reached note that shares
      // any query term (bm>0) is a plausible bridge; one that shares none is mention-graph noise. The
      // gate is an INDICATOR (not the bm magnitude) so a low-BM25 bridge isn't punished for being
      // lexically weak — exactly the note BM25 alone misses.
      const coact = bm > 0 ? act : 0
      return { id, score: alpha * bm + beta * act + gamma * coact }
    })
    scored.sort((a, b) => b.score - a.score || bmNorm(b.id) - bmNorm(a.id) || (a.id < b.id ? -1 : 1))
    const order = scored.map((s) => s.id)
    return { order, window: order.slice(0, topK) }
  }

  // hop 0: seed-only ranking establishes the baseline top-K window.
  let prevWindow = rankPool().window
  let finalOrder = rankPool().order
  let hopsUsed = 1
  let stableRun = 0 // consecutive hops with an unchanged top-K window

  for (let hop = 1; hop <= maxHops; hop++) {
    hopsUsed = hop
    // Expand only the strongest-activated frontier notes (fan-out control).
    const frontier = [...activation.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, frontierCap)
    const inflow = new Map<string, number>()
    for (const [from, mass] of frontier) {
      for (const { to, w } of adj.get(from) ?? []) inflow.set(to, (inflow.get(to) ?? 0) + mass * w)
    }
    // Split inflow into already-reached (always take their inflow) vs NEW candidates. The density
    // brake caps only fresh admissions: reached notes keep accumulating activation exactly as before.
    const newCandidates: [string, number][] = []
    for (const [to, m] of inflow) {
      if (reached.has(to)) activation.set(to, (activation.get(to) ?? 0) + m * decay)
      else newCandidates.push([to, m])
    }
    // Admit at most `maxFrontierPerHop` new notes, strongest inflow first (deterministic id tiebreak).
    // <= cap ⇒ admit all in inflow order ⇒ byte-identical to the uncapped single-loop; > cap ⇒ the
    // weak noise tail is dropped, the fix for dense over-expansion.
    const admitted =
      newCandidates.length > maxFrontierPerHop
        ? [...newCandidates].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, maxFrontierPerHop)
        : newCandidates
    let anyNew = false
    for (const [to, m] of admitted) {
      activation.set(to, (activation.get(to) ?? 0) + m * decay) // per-hop damping (cumulative decay^hop)
      reached.add(to)
      anyNew = true
    }

    const { order, window } = rankPool()
    finalOrder = order
    // Depth-adaptive stop: the answer-bearing evidence proxy is top-K CHURN. Frontier exhaustion is a
    // hard stop (nothing left to reach). A stable top-K is a SOFT stop, gated by `patience`: a deep
    // (3/4-hop) question can plateau at hop 2 before the hop-3/4 bridge activates, so we require the
    // window to hold for `patience` consecutive hops before declaring convergence. This keeps the
    // depth matched to the question (easy lexical questions still converge fast) without aborting the
    // deep chains early — the fix for 3/4-hop reach.
    if (!anyNew) break
    const sameWindow = window.length === prevWindow.length && window.every((id, i) => id === prevWindow[i])
    stableRun = sameWindow ? stableRun + 1 : 0
    if (stableRun >= patience) break
    prevWindow = window
  }

  // Defensive tail: append notes the expansion never reached, BM25-first, then original order, so
  // the ranking is total (recall@k defined for every k) without letting unreached notes outrank
  // anything the retriever actually surfaced.
  const inRanking = new Set(finalOrder)
  const tail = noteIds
    .filter((id) => !inRanking.has(id))
    .sort((a, b) => bmNorm(b) - bmNorm(a) || (a < b ? -1 : 1))
  return { ranked: [...finalOrder, ...tail], hopsUsed }
}

/** Convenience: a note-id-only ranking (drops the hop count). */
export function graphExpandRank(
  query: string,
  notes: WNNote[],
  graph: EntityGraph,
  opts: GraphExpandOpts = {}
): string[] {
  return graphExpandRetrieve(query, notes, graph, opts).ranked
}

// Re-export the note shape so callers/harness need only this module.
export type { WNNote }
