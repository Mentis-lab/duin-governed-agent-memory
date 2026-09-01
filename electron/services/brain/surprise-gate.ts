// surprise-gate.ts — Capture: gate MACHINE-inferred candidate facts on SURPRISE (prediction-error).
//
// Nemori-style capture: a candidate that is already predictable from existing memory — a near
// paraphrase of an active operator fact — carries no new signal, so capturing it only adds churn
// (a duplicate the reflect() merge would later collapse anyway, and noise the human must review).
// The gate skips ONLY such clearly-redundant candidates (cosine ≥ a deliberately HIGH bar) and
// keeps everything else.
//
// Two safety properties, both load-bearing (dropping a real fact is far worse than keeping a
// near-duplicate):
//   - CONSERVATIVE: the threshold is a near-paraphrase bar, not a topical-overlap bar. A candidate
//     that is merely "about the same thing" as an existing fact is still captured.
//   - FAIL-OPEN: with no existing facts, no candidates, or an unavailable/cold embedder (embedForRecall
//     returns [] or a length mismatch), EVERY candidate is kept. The gate can only ever SUBTRACT
//     confidence in redundancy; when it has no signal it subtracts nothing.
//
// PURE + electron-free (no index-store / app import) so it unit-tests headless. The caller
// (operator-model.learnFromTurn) injects the production embedder (embedForRecall) via a lazy import.

import { cosine, type EmbedFn } from './claim-entities'

/** Cosine at/above which a machine candidate is deemed a REDUNDANT restatement of an existing
 *  active fact and skipped. Deliberately HIGH (near-paraphrase only) — the cost of dropping a
 *  real fact outweighs the cost of keeping a near-duplicate, so the gate errs toward capture. */
export const SURPRISE_REDUNDANT_THRESHOLD = 0.92

export interface SurpriseGateResult {
  /** Candidates surprising enough to capture (kept). */
  keep: string[]
  /** Candidates skipped as clearly-redundant, each with the nearest existing fact + similarity. */
  skipped: { fact: string; nearest: string; similarity: number }[]
  /** True when the gate FAILED OPEN (no usable signal) — every candidate kept regardless of similarity. */
  failedOpen: boolean
}

/**
 * Partition candidate facts into surprising-enough-to-capture (`keep`) vs clearly-redundant
 * (`skipped`), comparing each candidate only against EXISTING (currently-grounding) facts —
 * "surprise" is prediction-error relative to what memory already holds. Conservative + fail-open:
 * no existing facts, no candidates, or an unavailable embedder ⇒ every candidate kept. Never throws
 * (embed errors fail open), so a caller can treat `keep` as "the facts to record".
 */
export async function surpriseGate(
  candidates: string[],
  existingFacts: string[],
  embed: EmbedFn,
  threshold: number = SURPRISE_REDUNDANT_THRESHOLD
): Promise<SurpriseGateResult> {
  const keepAll = (failedOpen: boolean): SurpriseGateResult => ({ keep: [...candidates], skipped: [], failedOpen })
  if (candidates.length === 0) return { keep: [], skipped: [], failedOpen: false }
  // Nothing to be redundant against ⇒ everything is surprising (not a fail-open, just empty memory).
  if (existingFacts.length === 0) return keepAll(false)

  let vecs: number[][]
  try {
    vecs = await embed([...candidates, ...existingFacts])
  } catch {
    return keepAll(true)
  }
  // Fail-open on any shape problem — a cold embedder returns [] or a length mismatch, and a
  // zero-length vector would make cosine meaningless.
  if (!vecs || vecs.length !== candidates.length + existingFacts.length || !vecs.every((v) => v && v.length)) {
    return keepAll(true)
  }
  const candVecs = vecs.slice(0, candidates.length)
  const existVecs = vecs.slice(candidates.length)

  const keep: string[] = []
  const skipped: SurpriseGateResult['skipped'] = []
  for (let i = 0; i < candidates.length; i++) {
    let best = -1
    let bestJ = -1
    for (let j = 0; j < existVecs.length; j++) {
      const s = cosine(candVecs[i], existVecs[j])
      if (s > best) {
        best = s
        bestJ = j
      }
    }
    if (best >= threshold) {
      skipped.push({ fact: candidates[i], nearest: existingFacts[bestJ], similarity: best })
    } else {
      keep.push(candidates[i])
    }
  }
  return { keep, skipped, failedOpen: false }
}
