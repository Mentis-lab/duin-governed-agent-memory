// consolidation-trigger — the "Consolidate" verb (DUIN Memory Architecture §2), the
// WRITE-side twin of the Retrieve-pull recall. Ports the legacy harness topic_close_trigger:
// fire consolidation on a SEMANTIC-SHIFT topic boundary (not volume-15), so a coherent
// batch of learning consolidates the moment its topic closes — cold-start capable (fires
// in session 1). It also gives the govern loop a better "distinct session" signal:
// topic-close (a semantic unit), not per-conversation.
//
//   push(turnVec) → accumulate a batch; when a turn's cosine to the batch centroid drops
//   below shiftThreshold (topic changed) OR the batch overflows, the topic CLOSES. A
//   closed batch that is coherent + right-sized is consolidated.
//
// Pure detectors (centroid / coherence / shouldConsolidate) are unit-tested; the tracker
// is deterministic given the turn vectors.
import { cosine } from './personalization-recall'
import { reflect, verifyPool, getOperatorFacts } from '../brain/operator-model'
import { consolidationLenses } from '../brain/consolidation-lenses'
import { runConsolidationSynthesis } from '../brain/consolidation-synthesis'
import { runReflectionRollup } from '../brain/reflection-rollup'
import { messageOf } from '../guarded'

export interface ConsolidationPolicy {
  /** Cosine to the batch centroid below which a new turn is a DIFFERENT topic. */
  shiftThreshold: number
  /** Min turns in a closed topic to bother consolidating. */
  minBatch: number
  /** Force-close a topic that runs this long even without a shift. */
  maxBatch: number
  /** Min mean cosine of the batch to its centroid — a topic must be COHERENT. */
  minCoherence: number
}

// CALIBRATION (measured 2026-07-20 against the live embedder — Xenova/multilingual-e5-small,
// q8, `query: ` prefix, the model index_meta actually records). These are not guesses; the
// numbers below come from embedding real turn text from this vault.
//
// THE DEFECT THIS REPLACES: `shiftThreshold` was 0.5, and NOTHING reaches 0.5. E5 embeddings
// occupy a narrow cone — across three real topics (testing / ProjectA release / travel logistics),
// UNRELATED turns scored 0.72–0.85 and related ones 0.765–0.875. So the shift branch never
// fired, topics never closed, consolidation never ran, and the store held ZERO dependsOn edges
// across every session of the reasoning-trace line. The pipeline below it was correct the whole
// time; it was simply never triggered.
//
// WHY THE FIX IS A REACHABLE CAP AND NOT A BETTER THRESHOLD. Measured over all pairs, the two
// distributions OVERLAP: same-topic min 0.765 vs different-topic max 0.852. Centering the
// vectors (the standard fix for an anisotropic cone) separates the MEANS far better
// (0.146 vs -0.209, against 0.837 vs 0.765 raw) but the extremes still overlap. So no global
// threshold on this signal — raw or centered — reliably tells "new topic" from "same topic" on
// this vault's content, and a shift-triggered close would be wrong often enough to fold
// unrelated claims into junk rules. Segmenting by TURN COUNT is deterministic, cannot silently
// stop working, and survives an embedder swap (this vault has already changed embedder once, and
// bge-m3 is selectable with different geometry — any constant re-breaks silently on that switch).
//
// This costs less than it appears: the batch only decides WHEN to consolidate. The fold itself
// re-groups by `clusterByCohesion` inside runConsolidationSynthesis, so a batch spanning two
// topics still yields per-topic clusters. Batch purity was never load-bearing.
export const DEFAULT_CONSOLIDATION_POLICY: ConsolidationPolicy = {
  // Retained as a rare EARLY-close hint only, never the mechanism. 0.70 sits below every
  // observed pair (min 0.72), so it fires only on a genuinely distant turn and effectively
  // never produces a false close. Do not raise it toward 0.76 chasing sensitivity — that is
  // inside the overlap band, where a false close folds unrelated claims together.
  shiftThreshold: 0.7,
  minBatch: 2,
  // THE ACTUAL TRIGGER. Was 15, which needs 15 turns in ONE process lifetime (the batch is
  // in-memory and resets on restart) — unreachable in practice, especially against a deploy
  // cadence. 6 is a plausible conversational stretch and makes consolidation actually happen.
  maxBatch: 6,
  minCoherence: 0.45
}

/** Mean vector. PURE. */
export function centroid(vecs: number[][]): number[] {
  if (vecs.length === 0) return []
  const dim = vecs[0].length
  const out = new Array(dim).fill(0)
  for (const v of vecs) for (let i = 0; i < dim; i++) out[i] += v[i] ?? 0
  for (let i = 0; i < dim; i++) out[i] /= vecs.length
  return out
}

/** Mean cosine of each vector to the batch centroid (coherence). PURE. */
export function meanCoherence(vecs: number[][]): number {
  if (vecs.length < 2) return 1
  const c = centroid(vecs)
  let sum = 0
  for (const v of vecs) sum += cosine(v, c)
  return sum / vecs.length
}

/** A closed batch is worth consolidating when it is right-sized AND coherent. PURE. */
export function shouldConsolidate(batch: number[][], policy: ConsolidationPolicy = DEFAULT_CONSOLIDATION_POLICY): boolean {
  if (batch.length < policy.minBatch || batch.length > policy.maxBatch) return false
  return meanCoherence(batch) >= policy.minCoherence
}

export interface TopicCloseEvent {
  /** The current topic closed on this turn. */
  closed: boolean
  /** Stable id for the closed topic (survival-counting key). */
  topicId: string
  /** How many turns were in the closed topic. */
  batchSize: number
  /** The closed batch qualifies for a consolidation pass. */
  consolidate: boolean
}

/** Accumulates turn embeddings and detects topic boundaries. Per-process, deterministic. */
export class ConsolidationTracker {
  private batch: number[][] = []
  private counter = 0
  // Per-instance run nonce so emitted topic ids are UNIQUE ACROSS PROCESS LIFETIMES. The
  // ordinal `counter` resets to 0 on every process start, so a restart's first closed topic
  // was again `topic-1` — and noteSession() dedupes a provisional fact's observedSessions by
  // this id, so a fact that already banked `topic-1/2/3` got NO new survival bump after a
  // restart (the promotion funnel silently stalled across a multi-restart lifetime). Minting
  // `topic-<runNonce>-<n>` keeps the id stable + distinct WITHIN a process (dedup still works)
  // while guaranteeing a fresh process — or a fresh tracker — never collides with a prior run.
  private readonly runNonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  private policy: ConsolidationPolicy

  constructor(policy: ConsolidationPolicy = DEFAULT_CONSOLIDATION_POLICY) {
    this.policy = policy
  }

  /** Feed one turn's embedding. Returns whether the PRIOR topic just closed. */
  push(vec: number[]): TopicCloseEvent {
    const noClose: TopicCloseEvent = { closed: false, topicId: '', batchSize: this.batch.length, consolidate: false }
    if (!vec || vec.length === 0) return noClose
    if (this.batch.length === 0) {
      this.batch = [vec]
      return { ...noClose, batchSize: 1 }
    }
    const sim = cosine(vec, centroid(this.batch))
    const shifted = sim < this.policy.shiftThreshold
    const overflow = this.batch.length >= this.policy.maxBatch
    if (!shifted && !overflow) {
      this.batch.push(vec)
      return { ...noClose, batchSize: this.batch.length }
    }
    // The current topic closes. A shift starts a new topic with `vec`; an overflow
    // (same topic, too long) also restarts from `vec` so progress isn't lost.
    const closing = this.batch
    const topicId = `topic-${this.runNonce}-${++this.counter}`
    const consolidate = shouldConsolidate(closing, this.policy)
    this.batch = [vec]
    return { closed: true, topicId, batchSize: closing.length, consolidate }
  }

  reset(): void {
    this.batch = []
  }
}

/** The consolidation ACTION fired at a qualifying topic-close: dedup near-duplicate
 *  captures (reflect), prune contradictory/vague ones (verifyPool, key-gated), and run
 *  the GC lenses (decay + re-abstraction) to SURFACE stale/over-general facts for review.
 *  Best-effort; keyless-safe. Lenses never mutate the store — pruning stays human-gated. */
export async function runConsolidation(): Promise<{
  merged: number
  pruned: number
  stale: number
  overGeneral: number
  synthesized: boolean
  reflected: boolean
}> {
  let merged = 0
  let pruned = 0
  try {
    merged = reflect()
  } catch (e) { console.debug('[consolidation-trigger] nothing to merge:', messageOf(e)) }
  try {
    const r = await verifyPool()
    pruned = r.dropped
  } catch (e) { console.debug('[consolidation-trigger] no engine  keyless, skip prune:', messageOf(e)) }
  let stale = 0
  let overGeneral = 0
  try {
    const lensFacts = getOperatorFacts().map((f) => ({ id: f.id, text: f.fact, status: f.status, ts: f.ts }))
    const findings = consolidationLenses(lensFacts, Date.now())
    stale = findings.stale.length
    overGeneral = findings.overGeneral.length
    if (stale || overGeneral) {
      console.log(`[consolidation-lenses] ${stale} stale (decayed), ${overGeneral} over-general — surfaced for review`)
    }
  } catch (e) { console.debug('[consolidation-trigger] lenses are advisory  never affect consolidation:', messageOf(e)) }
  // Episodic→semantic ASCENT: fold the topic's fresh captures into one durable summary
  // candidate (key-gated; human/govern still gates its promotion).
  let synthesized = false
  try {
    const s = await runConsolidationSynthesis()
    synthesized = s.synthesized
    if (synthesized) console.log(`[consolidation-synthesis] folded ${s.consumed} captures → 1 durable rule`)
  } catch (e) { console.debug('[consolidation-trigger] synthesis is upkeep  never affects consolidation:', messageOf(e)) }
  // SECOND-LEVEL ASCENT (reflection tree): fold several PROMOTED rules into one higher-
  // order reflection candidate (key-gated; human/govern still gates ITS promotion too).
  let reflected = false
  try {
    const rr = await runReflectionRollup()
    reflected = rr.reflected
    if (reflected) console.log(`[reflection-rollup] folded ${rr.consumed} promoted rules → 1 higher-order reflection`)
  } catch (e) { console.debug('[consolidation-trigger] reflection is upkeep  never affects consolidation:', messageOf(e)) }
  return { merged, pruned, stale, overGeneral, synthesized, reflected }
}
