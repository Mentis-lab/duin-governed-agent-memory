// retrieval-probe.ts — measure RETRIEVAL directly, without an answer model.
//
// THE GAP THIS CLOSES. Every DUIN benchmark artifact records (question, gold answer, DUIN's answer,
// judge verdict) but NOT which documents retrieval actually returned, and not which config produced
// the run. Two consequences, both real:
//
//   1. A wrong answer cannot be attributed. "Retrieval never surfaced the evidence" and "retrieval
//      surfaced it and the model fumbled it" are indistinguishable in the logs, so every fix is a
//      guess. (A hand pass over bench/locomo/duin_locomo-2026-07-25.jsonl found 53/53 failures were
//      confidently wrong with ZERO abstentions, and that cat1 multi-hop failures carry MORE gold
//      evidence turns than passes -- 3.30 vs 2.29 -- which points at recall, but could not be
//      confirmed without the retrieved set.)
//   2. Config<->result linkage lives only in prose. The LongMemEval 74->87 config search has to be
//      reconstructed by reading a planning doc, because no run stamped its own parameters.
//
// So: record R(q;theta) and stamp theta. Both are cheap, and together they turn a 22-minute
// answer-model benchmark into a seconds-per-query retrieval measurement that needs no API key,
// no judge, and no tokens -- which is what makes a config search affordable at all.
//
// Gold labels are the retrieval target (e.g. LoCoMo's per-question `evidence` note ids), so
// recall@k here is measured against ground truth, not against a model's opinion.
import {
  RETRIEVAL_TUNABLE_DEFAULTS,
  retrievalConfigFingerprint,
  type RetrievalTunables
} from './retrieval-tunables'

/** One labelled retrieval question: what was asked, and which notes SHOULD come back. */
export interface RetrievalProbe {
  id: string
  query: string
  /** Note identifiers that answer the query. Matched leniently — see `matchesGold`. */
  gold: string[]
}

/** One retrieved item — the R(q;theta) row that was previously discarded. */
export interface RetrievedItem {
  file: string
  /** top-normalized fused score (best hit is always 1.0) */
  score: number
  /** absolute vector similarity when the file had a vector hit; undefined for lexical-only */
  rawScore?: number
}

export interface ProbeResult {
  id: string
  query: string
  gold: string[]
  /** the ranked retrieved set — R(q;theta) */
  retrieved: RetrievedItem[]
  /** fraction of gold items present in the top-k */
  recallAtK: number
  /** did ANY gold item make the top-k */
  hitAtK: boolean
  /** 1/(rank of first gold hit), 0 if none. Rank is 1-based. */
  reciprocalRank: number
  /** gold items that never appeared — the retrieval-miss list a diagnosis pass consumes */
  missed: string[]
}

export interface ProbeRun {
  /** the exact config that produced these results — the stamp benchmarks were missing */
  config: RetrievalTunables
  configFingerprint: string
  k: number
  n: number
  /** mean recall@k across probes */
  recallAtK: number
  /** mean reciprocal rank */
  mrr: number
  /** fraction of probes with at least one gold hit in the top-k */
  hitRate: number
  /** probes where retrieval returned nothing at all */
  empty: number
  results: ProbeResult[]
}

/** Normalize a path/id for comparison: lowercase, forward slashes, no leading "./". */
function norm(s: string): string {
  return (s ?? '').trim().toLowerCase().replace(/\\/g, '/').replace(/^\.\//, '')
}

/**
 * Lenient gold matching. A caller may label gold as a full relpath ("sessions/D2.md"), a bare
 * basename ("D2.md"), or a stem ("D2") depending on how its corpus was written; retrieval returns
 * vault-relative paths. Match when either side contains the other as a path-ish component, so a
 * label does not have to encode the harness's directory layout. PURE.
 */
export function matchesGold(file: string, gold: string): boolean {
  const f = norm(file)
  const g = norm(gold)
  if (!f || !g) return false
  if (f === g) return true
  const stem = (p: string): string => {
    const base = p.slice(p.lastIndexOf('/') + 1)
    const dot = base.lastIndexOf('.')
    return dot > 0 ? base.slice(0, dot) : base
  }
  return stem(f) === stem(g) || f.endsWith('/' + g) || g.endsWith('/' + f)
}

/** Score one probe against its retrieved set, truncated to the top k. PURE. */
export function scoreProbe(probe: RetrievalProbe, retrieved: RetrievedItem[], k: number): ProbeResult {
  const top = retrieved.slice(0, k)
  const gold = probe.gold.filter((g) => (g ?? '').trim().length > 0)
  const found = new Set<string>()
  let firstRank = 0
  top.forEach((item, i) => {
    for (const g of gold) {
      if (matchesGold(item.file, g)) {
        found.add(g)
        if (firstRank === 0) firstRank = i + 1
      }
    }
  })
  return {
    id: probe.id,
    query: probe.query,
    gold,
    retrieved: top,
    // No gold labels ⇒ nothing to be right or wrong about; report 0 rather than a fake 1.0 so an
    // unlabelled probe cannot inflate an aggregate.
    recallAtK: gold.length > 0 ? found.size / gold.length : 0,
    hitAtK: found.size > 0,
    reciprocalRank: firstRank > 0 ? 1 / firstRank : 0,
    missed: gold.filter((g) => !found.has(g))
  }
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
const round4 = (n: number): number => Math.round(n * 10_000) / 10_000

/** Aggregate scored probes into the run-level fitness numbers. PURE. */
export function aggregateProbes(
  results: ProbeResult[],
  config: RetrievalTunables,
  k: number
): ProbeRun {
  return {
    config,
    configFingerprint: retrievalConfigFingerprint(config),
    k,
    n: results.length,
    recallAtK: round4(mean(results.map((r) => r.recallAtK))),
    mrr: round4(mean(results.map((r) => r.reciprocalRank))),
    hitRate: round4(mean(results.map((r) => (r.hitAtK ? 1 : 0)))),
    empty: results.filter((r) => r.retrieved.length === 0).length,
    results
  }
}

/** The retrieval call this probe drives. Injected so the scorer is testable without a live index. */
export type SearchFn = (
  query: string,
  k: number,
  tuning: RetrievalTunables
) => Promise<RetrievedItem[]>

/**
 * Run every probe under ONE config and return the scored run. Sequential on purpose: the embeddings
 * worker batches internally and a parallel fan-out here just queues behind it while making failures
 * harder to attribute. A probe whose search throws scores as a miss rather than aborting the run —
 * a partial measurement is still a measurement, and a run that dies on question 40 of 200 teaches
 * nothing.
 */
export async function runRetrievalProbes(
  probes: RetrievalProbe[],
  searchFn: SearchFn,
  config: RetrievalTunables = RETRIEVAL_TUNABLE_DEFAULTS
): Promise<ProbeRun> {
  const k = config.searchK
  const results: ProbeResult[] = []
  for (const p of probes) {
    let hits: RetrievedItem[] = []
    try {
      hits = await searchFn(p.query, k, config)
    } catch (err) {
      console.warn('[retrieval-probe] search failed for', p.id, (err as Error).message)
    }
    results.push(scoreProbe(p, hits, k))
  }
  return aggregateProbes(results, config, k)
}

/**
 * Compare two runs on the SAME probe set. This is the keep-if-better primitive a config search needs;
 * it deliberately reports the delta and leaves the keep/reject decision to the caller's gate
 * (brain/self-improve-fitness.ts already owns that policy — this does not duplicate it). PURE.
 */
export function compareRuns(
  before: ProbeRun,
  after: ProbeRun
): { recallDelta: number; mrrDelta: number; hitRateDelta: number; comparable: boolean } {
  return {
    recallDelta: round4(after.recallAtK - before.recallAtK),
    mrrDelta: round4(after.mrr - before.mrr),
    hitRateDelta: round4(after.hitRate - before.hitRate),
    // Deltas across different probe sets are meaningless; say so rather than returning a number
    // the caller will treat as a result.
    comparable: before.n === after.n && before.n > 0
  }
}
