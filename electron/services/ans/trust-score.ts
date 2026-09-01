// trust-score — a single earned-trust scalar (0..1) folding the live merit signals (capability
// ratify-rate, calibration skill, revert-rate, time-decayed demotions) for reliability-proportional
// autonomy (Track D items 11/19/24). PURE + dependency-free (no fs, no imports) so it stays
// trivially testable and importable from both the main process and the route handler.
//
// The SHAPE is the contract (weights are tunable): reward ratify-rate + calibration skill, penalize
// revert-rate and a time-decayed recent demotion, with a MIN_N cold-start floor. clamp01 + the floor
// guarantee the score is always in [0.1, 1] and never NaN.

export const TRUST_COLD_START_FLOOR = 0.1
export const TRUST_MIN_N = 5
// N at which the ledger is "thick enough" to bank the full calibration + revert credit. Below it we
// RAMP those two credits from 0 (at TRUST_MIN_N) to full (at TRUST_RAMP_N) — see the P2 note below.
export const TRUST_RAMP_N = 20
const DECAY_TAU_MS = 30 * 24 * 3600_000 // ~30d e-folding time for a demotion penalty to fade

export interface TrustSnapshot {
  ratifyN: number
  ratifyK: number
  reverts: number
  revertsHandled: number
  lastDemoteAt?: number
  updatedAt: number
  skillScore: number | null
  now?: number
}

export interface TrustScore {
  score: number
  coldStart: boolean
  components: { ratifyRate: number; revertRate: number; calib: number; demotePenalty: number }
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

export function trustScore(s: TrustSnapshot): TrustScore {
  const now = s.now ?? Date.now()
  const N = s.ratifyN
  if (N < TRUST_MIN_N) {
    // Cold start: too little evidence to earn trust → the floor (a few supervised turns, not zero).
    return { score: TRUST_COLD_START_FLOOR, coldStart: true, components: { ratifyRate: 0, revertRate: 0, calib: 0, demotePenalty: 0 } }
  }
  const ratifyRate = s.ratifyK / N
  const netReverts = Math.max(0, s.reverts)
  const revertRate = netReverts / (N + netReverts)
  const calib = s.skillScore == null ? 0.5 : clamp01(s.skillScore) // null = unmeasured → neutral
  const since = s.lastDemoteAt ? now - s.lastDemoteAt : Infinity
  const demotePenalty = s.lastDemoteAt ? Math.exp(-since / DECAY_TAU_MS) : 0
  // P2 — thin-ledger cliff fix. Just past cold-start (N == TRUST_MIN_N) the calibration credit
  // defaults to NEUTRAL 0.5 and the revert credit is FULL, which used to hand a barely-proven
  // capability ~0.85. Those two credits are only trustworthy once there's real evidence, so ramp
  // them 0→1 across N ∈ [TRUST_MIN_N, TRUST_RAMP_N]. The ratify credit (0.5·ratifyRate) is left at
  // full weight — it IS the earned evidence — and the demote penalty is never damped (a miss must
  // bite immediately). At N == 5 a clean 5/5-unmeasured cap now scores 0.5, not 0.85; by N == 20 it
  // reaches the full 0.85. clamp01 + the floor keep the result in [0.1, 1].
  const evidence = TRUST_RAMP_N > TRUST_MIN_N ? clamp01((N - TRUST_MIN_N) / (TRUST_RAMP_N - TRUST_MIN_N)) : 1
  let score = clamp01(0.5 * ratifyRate + evidence * (0.3 * calib + 0.2 * (1 - revertRate)) - 0.3 * demotePenalty)
  score = Math.max(score, TRUST_COLD_START_FLOOR)
  return { score, coldStart: false, components: { ratifyRate, revertRate, calib, demotePenalty } }
}

/** Assemble a TrustSnapshot from a capability-ledger row + the current calibration skill, so
 *  items 11/19/24 never re-derive the field mapping. */
export function snapshotFor(
  cap: { ratifyN: number; ratifyK: number; reverts: number; revertsHandled: number; lastDemoteAt?: number; updatedAt: number },
  skillScore: number | null,
  now?: number
): TrustSnapshot {
  return {
    ratifyN: cap.ratifyN,
    ratifyK: cap.ratifyK,
    reverts: cap.reverts,
    revertsHandled: cap.revertsHandled,
    lastDemoteAt: cap.lastDemoteAt,
    updatedAt: cap.updatedAt,
    skillScore,
    now
  }
}
