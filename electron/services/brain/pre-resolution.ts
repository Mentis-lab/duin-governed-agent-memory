// pre-resolution.ts — Measure: a LEADING calibration signal on OPEN forecasts,
// computed BEFORE ground truth (Milkyway). PURE.
//
// DUIN's calibration only scores a forecast once it RESOLVES (past eval_after): a
// subjects-bearing row materializes iff a subject is still open then, else averts
// (calibration-resolve-native). That's a lagging signal — it buys no calibration data
// until the deadline. Milkyway's finding: the subjects' CURRENT movement toward
// resolution is a leading indicator you can read now. This computes it:
//   - subjects already CLOSED  → the forecast is trending AVERTING (they resolved).
//   - subjects still OPEN as eval_after nears → trending MATERIALIZING.
//   - the signal is weighted by time-progress toward the deadline, so it starts near
//     zero (undetermined) and SHARPENS as resolution approaches — a temporal contrast,
//     not a premature guess. It never fabricates a resolved verdict; it's advisory.
//
// This extends the existing single leading signal (a binding's fail-fast) to every
// open forecast's subject set, reusing the SAME open/closed notion the resolver uses.

export interface OpenForecast {
  id: string
  /** Subject ids the forecast's resolution depends on. */
  subjects: string[]
  /** ISO date the forecast was created (the contrast window's start). */
  created: string
  /** ISO date after which the forecast resolves (the deadline). */
  evalAfter: string
  /** The predicted confidence, carried through for the calibration consumer. */
  confidence?: number | null
}

export type PreLean = 'averting' | 'materializing' | 'undetermined'

export interface PreResolutionSignal {
  id: string
  lean: PreLean
  /** Fraction of subjects already closed (not in openIds), 0..1. */
  closedFraction: number
  /** Progress through [created, evalAfter] at `now`, clamped 0..1. */
  timeProgress: number
  /** Leading indicator in [-1,1]: +1 strongly averting (subjects closing), -1
   *  strongly materializing (still open near the deadline), ~0 early/undetermined.
   *  = (2·closedFraction − 1) · timeProgress. */
  leadingIndicator: number
  /** Subject count the signal was computed over (0 ⇒ not scoreable → undetermined). */
  subjectCount: number
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

/** Lean thresholds on the leading indicator — a band around 0 stays undetermined so
 *  an early, weak signal is not over-read. */
const LEAN_BAND = 0.25

/**
 * Compute the leading pre-resolution signal for one open forecast. PURE.
 * `openIds` is the set of subject ids currently OPEN (the same set the resolver uses).
 * A subject NOT in `openIds` is treated as closed/resolved.
 */
export function preResolutionSignal(
  f: OpenForecast,
  openIds: Set<string>,
  now: Date
): PreResolutionSignal {
  const subjects = (f.subjects ?? []).filter((s) => typeof s === 'string' && s)
  const n = subjects.length
  if (n === 0) {
    return {
      id: f.id,
      lean: 'undetermined',
      closedFraction: 0,
      timeProgress: 0,
      leadingIndicator: 0,
      subjectCount: 0
    }
  }

  const closed = subjects.filter((s) => !openIds.has(s)).length
  const closedFraction = closed / n

  const start = Date.parse(f.created)
  const end = Date.parse(f.evalAfter)
  let timeProgress = 0
  if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
    timeProgress = clamp01((now.getTime() - start) / (end - start))
  } else if (Number.isFinite(end) && now.getTime() >= end) {
    timeProgress = 1
  }

  const leadingIndicator = (2 * closedFraction - 1) * timeProgress
  const lean: PreLean =
    leadingIndicator > LEAN_BAND
      ? 'averting'
      : leadingIndicator < -LEAN_BAND
        ? 'materializing'
        : 'undetermined'

  return {
    id: f.id,
    lean,
    closedFraction: Math.round(closedFraction * 1000) / 1000,
    timeProgress: Math.round(timeProgress * 1000) / 1000,
    leadingIndicator: Math.round(leadingIndicator * 1000) / 1000,
    subjectCount: n
  }
}

/** Compute the leading signal for every open forecast. PURE. */
export function preResolutionSignals(
  open: OpenForecast[],
  openIds: Set<string>,
  now: Date
): PreResolutionSignal[] {
  return open.map((f) => preResolutionSignal(f, openIds, now))
}
