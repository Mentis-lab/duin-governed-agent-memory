// Embedder A/B scoring — the gate that decides whether a multilingual embedder
// earns the default. PURE metric core (recall@k / MRR per language bucket) +
// the promotion DECISION rule. The live run (reindex the dogfood vault under
// each candidate, collect retrieved note-ids per query) is wired by the runner;
// this module just scores + judges, so the rule is unit-tested and unambiguous.
//
// See DUIN_MULTILINGUAL_EMBEDDER_SPEC.md §C.

export type Bucket = 'cn-exact' | 'cn-paraphrase' | 'en'

export interface LabeledQuery {
  query: string
  /** The note id (relpath) that SHOULD be retrieved for this query. */
  expectNote: string
  bucket: Bucket
}

export interface BucketScore {
  bucket: Bucket
  n: number
  recallAt5: number
  mrr: number
}

/** 1-based rank of `expect` in `retrieved` (exact note-id match), or 0 if absent. */
export function rankOf(retrieved: string[], expect: string): number {
  const i = retrieved.indexOf(expect)
  return i < 0 ? 0 : i + 1
}

/**
 * Score retrieval per bucket. `retrievedByQuery` maps each labeled query to the
 * ranked note-ids a candidate embedder returned. recall@k = fraction whose
 * expected note is in the top-k; MRR = mean reciprocal rank (0 when absent).
 */
export function scoreByBucket(
  labels: LabeledQuery[],
  retrievedByQuery: Map<string, string[]>,
  k = 5
): BucketScore[] {
  const acc = new Map<Bucket, { n: number; hits: number; rr: number }>()
  for (const l of labels) {
    const rank = rankOf(retrievedByQuery.get(l.query) ?? [], l.expectNote)
    const b = acc.get(l.bucket) ?? { n: 0, hits: 0, rr: 0 }
    b.n++
    if (rank > 0 && rank <= k) b.hits++
    if (rank > 0) b.rr += 1 / rank
    acc.set(l.bucket, b)
  }
  return [...acc.entries()].map(([bucket, b]) => ({
    bucket,
    n: b.n,
    recallAt5: b.n ? b.hits / b.n : 0,
    mrr: b.n ? b.rr / b.n : 0
  }))
}

const recall = (s: BucketScore[], b: Bucket): number =>
  s.find((x) => x.bucket === b)?.recallAt5 ?? 0

/**
 * The promotion DECISION rule: a multilingual candidate earns the default ONLY
 * if it lifts CN-paraphrase recall by a real margin WITHOUT regressing English —
 * exactly the win the reverted e5 attempt could not demonstrate. Defaults are
 * deliberately conservative; tune the margins, not the shape.
 */
export function multilingualWins(
  baseline: BucketScore[],
  candidate: BucketScore[],
  margins = { cnGain: 0.05, enTolerance: 0.02 }
): boolean {
  const cnLift = recall(candidate, 'cn-paraphrase') - recall(baseline, 'cn-paraphrase')
  const enDrop = recall(baseline, 'en') - recall(candidate, 'en')
  return cnLift > margins.cnGain && enDrop <= margins.enTolerance
}
