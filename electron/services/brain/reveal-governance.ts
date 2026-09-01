// reveal-governance.ts — the auto-accept-vs-review decision for a proposed edge.
//
// Governance decides which proposed edges auto-accept silently vs which surface for operator review.
// This composes the reveal's per-(source,edge-type) calibration TRUST (reveal-outcomes.revealTrust)
// with the edge's own CONFIDENCE — the "per-edge-confidence × rung" logic the design doc flags as NEW.
// It MATURES for free: while a source is under-sampled (trust.gated), everything reviews; once it is
// well-calibrated AND trusted AND the specific edge is confident, it auto-accepts.
//
// PURE. The autonomy governor (ans/governor) still owns the capability RUNG (whether auto-accept is
// permitted at all); this is the per-edge refinement applied at the reveal site within that permission.

import type { RevealTrust } from './reveal-outcomes'

export interface AutoAcceptPolicy {
  /** minimum Wilson-lower-bound trust for a source:edge-type to auto-accept (default 0.8) — the real
   *  earned-autonomy gate (only a well-sampled, high-endorse-rate source clears it). */
  trustFloor: number
  /** minimum per-edge proposed confidence to auto-accept (default 0.6). Set at the LLM prior so a
   *  well-TRUSTED llm edge can auto-accept (else the majority source never matures); it still blocks a
   *  genuinely-low-confidence proposal. This is the floor the RSI edge-confidence knob would tune. */
  confidenceFloor: number
}

export const DEFAULT_AUTO_ACCEPT_POLICY: AutoAcceptPolicy = { trustFloor: 0.8, confidenceFloor: 0.6 }

export type AcceptDecision = 'auto' | 'review'

/**
 * Decide whether a proposed edge auto-accepts (silent) or must surface for operator review.
 *   - no / under-sampled trust (gated) → REVIEW  (cold start: the operator teaches the source first)
 *   - calibrated AND trust ≥ floor AND edge confidence ≥ floor → AUTO
 *   - otherwise → REVIEW
 * The gate on trust.gated is what makes this mature: a fresh source always reviews until it has earned
 * ≥ CAL_MIN_N endorse/veto samples, then high-confidence proposals from a trusted source go silent.
 */
export function shouldAutoAccept(
  trust: RevealTrust | undefined,
  confidence: number,
  policy: AutoAcceptPolicy = DEFAULT_AUTO_ACCEPT_POLICY
): AcceptDecision {
  if (!trust || trust.gated) return 'review'
  if (trust.wilson_lo >= policy.trustFloor && confidence >= policy.confidenceFloor) return 'auto'
  return 'review'
}
