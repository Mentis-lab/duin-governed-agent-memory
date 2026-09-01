// label-calibration — per-label VERBALIZED-certainty calibration (Agent-BRACE).
//
// The proper-scorer's Murphy skill score (1 − brier/baselineBrier) NULLS OUT under a
// degenerate base rate: when almost every forecast resolves the same way, baselineBrier
// → 0 and the skill score is undefined (the exact Phase-3 weakness). Agent-BRACE's fix:
// bucket each forecast by its VERBALIZED certainty (an ordinal label) and calibrate each
// label against its OWN realized useful-rate with a Wilson bound. That per-label
// empirical curve is well-defined even when the global base rate is degenerate — a
// Wilson interval is meaningful at k=0 or k=n, where a skill score is not.
//
// DUIN forecasts carry a numeric stated confidence; the verbalized label is the ordinal
// bucket of that stated confidence (DUIN's verbalized certainty, just numeric at source).
// PURE — the wilson bound is injected so this stays unit-testable and reuses the
// resolver's exact interval.

export type CertaintyLabel = 'remote' | 'unlikely' | 'even' | 'likely' | 'certain'

export const CERTAINTY_LABELS: CertaintyLabel[] = ['remote', 'unlikely', 'even', 'likely', 'certain']

/** Map a stated probability (0..1) to its verbalized-certainty label. PURE. */
export function verbalizedCertainty(confidence: number): CertaintyLabel {
  const c = confidence < 0 ? 0 : confidence > 1 ? 1 : confidence
  if (c < 0.2) return 'remote'
  if (c < 0.4) return 'unlikely'
  if (c < 0.6) return 'even'
  if (c < 0.85) return 'likely'
  return 'certain'
}

export interface LabeledOutcome {
  /** The forecast's stated confidence (0..1). */
  confidence: number
  /** Did it resolve USEFUL (hit)? null ⇒ unresolved (excluded from calibration). */
  useful: boolean | null
}

export interface LabelReliability {
  label: CertaintyLabel
  /** Resolved forecasts in this label bucket. */
  n: number
  /** How many resolved useful. */
  useful: number
  /** Realized useful-rate (useful/n), or null when n=0. */
  usefulRate: number | null
  /** Wilson lower bound of the useful-rate (well-defined at k=0/k=n). */
  wilsonLo: number | null
  /** Wilson upper bound. */
  wilsonHi: number | null
  /** The label's nominal certainty midpoint, for a calibration-gap read. */
  nominal: number
  /** usefulRate − nominal when both defined (>0 ⇒ under-confident, <0 ⇒ over-confident). */
  calibrationGap: number | null
}

/** Nominal midpoint per label (for the calibration-gap read). */
const NOMINAL: Record<CertaintyLabel, number> = {
  remote: 0.1,
  unlikely: 0.3,
  even: 0.5,
  likely: 0.72,
  certain: 0.93
}

/**
 * Per-label reliability over resolved, labeled outcomes. PURE. `wilson(k,n)` is
 * injected (the resolver's exact interval) so the bounds match the rest of calibration.
 * Robust to degenerate base rates: each label's empirical rate + Wilson interval is
 * defined regardless of the GLOBAL base rate (no skill-score division).
 */
export function perLabelReliability(
  outcomes: LabeledOutcome[],
  wilson: (k: number, n: number) => [number | null, number | null]
): LabelReliability[] {
  const buckets = new Map<CertaintyLabel, { n: number; useful: number }>()
  for (const label of CERTAINTY_LABELS) buckets.set(label, { n: 0, useful: 0 })

  for (const o of outcomes) {
    if (o.useful == null) continue // unresolved
    if (typeof o.confidence !== 'number' || !Number.isFinite(o.confidence)) continue
    const b = buckets.get(verbalizedCertainty(o.confidence))!
    b.n++
    if (o.useful) b.useful++
  }

  return CERTAINTY_LABELS.map((label) => {
    const { n, useful } = buckets.get(label)!
    const usefulRate = n > 0 ? useful / n : null
    const [lo, hi] = n > 0 ? wilson(useful, n) : [null, null]
    const nominal = NOMINAL[label]
    const calibrationGap = usefulRate == null ? null : Math.round((usefulRate - nominal) * 1000) / 1000
    return {
      label,
      n,
      useful,
      usefulRate: usefulRate == null ? null : Math.round(usefulRate * 1000) / 1000,
      wilsonLo: lo == null ? null : Math.round(lo * 1000) / 1000,
      wilsonHi: hi == null ? null : Math.round(hi * 1000) / 1000,
      nominal,
      calibrationGap
    }
  })
}
