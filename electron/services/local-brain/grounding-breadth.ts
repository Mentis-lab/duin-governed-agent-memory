// grounding-breadth.ts — per-turn choice between SNIPPET grounding and WHOLE-NOTE
// grounding. PURE decision; the caller (server.ts handleAgui) owns the effect.
//
// WHY THIS EXISTS (measured, not assumed). The 2026-08-17 LongMemEval_S re-run
// (bench/longmemeval/RESULTS-2026-08-17.md) put DUIN 9 points behind a naive
// whole-SESSION RAG baseline on the same model, and the deficit was not spread evenly:
//
//     single-session-assistant  100.0%  vs  90.9%   +9.1   ← DUIN wins
//     single-session-user       100.0%  vs  92.9%   +7.1   ← DUIN wins
//     knowledge-update           75.0%  vs  81.2%   -6.2
//     temporal-reasoning         84.6%  vs  92.3%   -7.7
//     multi-session              55.6%  vs  81.5%  -25.9   ← the whole gap
//
// DUIN already WINS every question whose evidence sits in ONE place, and loses badly
// exactly when the answer must be assembled from SEVERAL. That is the signature of
// retrieval granularity, not of memory quality: the baseline hands the reader whole
// sessions, while chunk retrieval under a slot budget delivers fragments of each.
//
// So the fix is not "always send whole notes" (that regresses the categories DUIN wins,
// costs context, and egresses far more of the vault). It is: KEEP snippets for the
// narrow turns DUIN is already best at, and WIDEN only when this turn's evidence is
// genuinely spread across sources.
//
// THE SIGNAL: distinct source files among the top hits. It is chosen over query-text
// classification deliberately — it is model-free (no extra call, no latency), language
// independent (this operator works in English and Chinese), and it measures the actual
// failure condition rather than guessing intent from wording. A question can *sound*
// broad and be answered by one note; what matters is where the evidence landed.
//
// Distinct-SOURCE, not hit-count: five chunks of one note are still one place to look,
// and widening there buys nothing a snippet did not already carry.

export type GroundingBreadth = 'snippets' | 'whole-note'

export interface BreadthInput {
  /** This turn's retrieval hits, best-first. Only `file` is read. */
  hits: { file: string }[]
  /** How many top hits to consider. Default DUIN_WHOLENOTE_SPREAD_WINDOW or 8. */
  window?: number
  /** Distinct sources at/above which the turn counts as spread. Default
   *  DUIN_WHOLENOTE_SPREAD_MIN or 3. */
  spreadMin?: number
}

export interface BreadthDecision {
  breadth: GroundingBreadth
  /** Distinct sources seen in the window (the deciding measurement). */
  distinctFiles: number
  /** Those sources, in rank order, deduped — the bounded set a caller may widen to. */
  files: string[]
  reason: 'no-hits' | 'concentrated' | 'spread'
}

/** Explicit parse so `0` is honoured and never collapses into "unset" (property 8). */
function envInt(name: string, fallback: number, min: number): number {
  const raw = process.env[name]
  if (raw !== undefined && raw.trim() !== '') {
    const n = Number(raw)
    if (Number.isFinite(n) && n >= min) return Math.floor(n)
  }
  return fallback
}

export const DEFAULT_SPREAD_WINDOW = 8
export const DEFAULT_SPREAD_MIN = 3

/**
 * Decide this turn's grounding breadth. PURE apart from reading its two env defaults.
 *
 * `spreadMin = 0` forces 'whole-note' whenever there is any hit (an escape hatch for
 * reproducing the always-on configuration the July A/B measured), which is why the
 * threshold compare is `>=` against a floor of 0 rather than a truthiness check.
 */
export function decideBreadth(input: BreadthInput): BreadthDecision {
  const window = input.window ?? envInt('DUIN_WHOLENOTE_SPREAD_WINDOW', DEFAULT_SPREAD_WINDOW, 1)
  const spreadMin = input.spreadMin ?? envInt('DUIN_WHOLENOTE_SPREAD_MIN', DEFAULT_SPREAD_MIN, 0)

  const files: string[] = []
  for (const h of (input.hits ?? []).slice(0, window)) {
    const f = (h?.file ?? '').trim()
    if (f && !files.includes(f)) files.push(f)
  }

  if (files.length === 0) {
    // Nothing retrieved — there is no source to widen TO. Whole-note grounding here
    // would ship unrelated notes, so the snippet path (which will also be empty) is
    // the honest answer.
    return { breadth: 'snippets', distinctFiles: 0, files, reason: 'no-hits' }
  }
  if (files.length >= spreadMin) {
    return { breadth: 'whole-note', distinctFiles: files.length, files, reason: 'spread' }
  }
  return { breadth: 'snippets', distinctFiles: files.length, files, reason: 'concentrated' }
}
