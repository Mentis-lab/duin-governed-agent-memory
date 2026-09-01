// @cohesion-invocation: parked — GATED OFF by design (plan §8 #3, pull-only v1). The pure evaluation
//   gate + copy; deliberately NOT wired into the at-decision write path yet. Intentional, not dead.
// divergence-nudge — Surface B (plan §6): the rare, earned, at-decision-time mirror. When the
// operator marks a decision one-way while holding a promoted "I prefer reversible" fact AND their
// record confidently shows one-way, a MUTED inline card shows the pattern back to them. Never a
// modal, never advice, never an actor — it shows, the operator decides.
//
// GATED OFF by default (plan §8 #3: pull-only v1 — earn the push after the pull card proves the
// signal). This module is the PURE evaluation gate + copy; it is deliberately NOT wired into the
// at-decision write path yet. The five fire conditions are all-or-nothing; sensitive life domains
// are never pushed here (visible in the pull card only).
import type { FingerprintAxis } from './operator-fingerprint'

/** Life domains excluded from the at-decision PUSH (still visible in the pull card). */
export const SENSITIVE_DOMAINS = new Set([
  'relationships',
  'relationship',
  'health',
  'medical',
  'career',
  'family',
  'marriage',
  'divorce'
])

/** Surface B is OFF by default; enable explicitly with DUIN_DIVERGENCE_NUDGE=1. */
export function divergenceNudgeEnabled(): boolean {
  const v = (process.env.DUIN_DIVERGENCE_NUDGE ?? '').trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'on' || v === 'yes'
}

/** Suppression key — dismissing silences THIS pattern (axis × the specific contradicted fact). */
export function nudgePatternKey(axisId: string, factId: string): string {
  return `${axisId}:${factId}`
}

/** Muted, imperative-free copy. Rates/counts + the operator's own stated preference — never a title. */
export function nudgeCopy(countA: number, n: number): string {
  return (
    "Mirror — you're marking this a one-way door. You've told me you lean reversible, and " +
    `${countA} of your last ${n} logged decisions were one-way doors too. ` +
    'Just showing you back to you. The call is yours.'
  )
}

export interface NudgeInputs {
  decisionIsOneWay: boolean // (1) the decision being marked is one-way/irreversible
  decisionDomain: string // for the sensitive-domain + per-domain opt-out checks
  reversibilityAxis: FingerprintAxis // measured behavior (the reversibility-lean axis)
  promotedContradictingFact: { id: string; text: string } | null // (2) a promoted "prefer reversible" fact
  dismissedPatternKeys: ReadonlySet<string> // (4) UI-only suppression store
  domainOptOuts: ReadonlySet<string> // (5) per-domain opt-out
}

export interface NudgeDecision {
  fire: boolean
  reason:
    | 'fires'
    | 'decision-not-one-way'
    | 'no-contradicting-fact'
    | 'axis-not-confident'
    | 'sensitive-domain'
    | 'domain-opted-out'
    | 'dismissed'
  patternKey?: string
  copy?: string
}

/**
 * Evaluate whether the at-decision mirror fires. PURE — no env, no I/O, no mutation. All five
 * conditions must hold; the first failing one is reported (for telemetry + tests). The flag gate
 * (divergenceNudgeEnabled) is checked by the caller, not here, so this stays deterministic.
 */
export function evaluateNudge(inp: NudgeInputs): NudgeDecision {
  if (!inp.decisionIsOneWay) return { fire: false, reason: 'decision-not-one-way' }
  if (!inp.promotedContradictingFact) return { fire: false, reason: 'no-contradicting-fact' }
  const ax = inp.reversibilityAxis
  // (3) the record CONFIDENTLY shows one-way: normed axis whose Wilson band clears τ=0.5 on the
  // one-way (pole A) side. A thin/uncertain sample → wide band → no push.
  const confident = ax.gate === 'norm' && ax.ci[0] != null && ax.ci[0] > 0.5
  if (!confident) return { fire: false, reason: 'axis-not-confident' }
  const domain = (inp.decisionDomain || '').trim().toLowerCase()
  if (SENSITIVE_DOMAINS.has(domain)) return { fire: false, reason: 'sensitive-domain' }
  if (inp.domainOptOuts.has(domain)) return { fire: false, reason: 'domain-opted-out' }
  const patternKey = nudgePatternKey(ax.id, inp.promotedContradictingFact.id)
  if (inp.dismissedPatternKeys.has(patternKey)) return { fire: false, reason: 'dismissed' }
  return { fire: true, reason: 'fires', patternKey, copy: nudgeCopy(ax.countA, ax.n) }
}
