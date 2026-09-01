// governor — a CIRCUIT BREAKER over each capability, not a ladder.
//
//   TRIP    fast · automatic · safe-direction — any unhandled miss (a ratified-then-
//           reverted act) drops the capability one rung toward `hold`. No human needed.
//   RE-ARM  explicit · operator-only — restores the capability to its floor rung in one
//           step, because a human looked at it and decided it is fit to run.
//
// It was BUILT as a graded ladder: promotion required >= minSamples decisions at a
// >= promoteThreshold ratify-rate, and produced a PROPOSAL for a human to ratify. That
// arm never once fired. Measured 2026-07-30, of the five registered capabilities FOUR had
// never recorded a single adjudication (ratifyN = ratifyK = reverts = 0), so the sampling
// gate could not even be evaluated for them; zero promotions had ever occurred; and the
// only transition the ledger had ever seen was a demote. The one capability with data
// earned it through the govern loop's confirms/reverts, which is not the "human decided on
// a staged item" quantity `ratifyRate` actually measures.
//
// Worse, that rate was incoherent as a quality signal: only DISMISSALS lower it, so 97
// reverts sat alongside a perfect 1.0. The honest revert-aware measure already exists and
// is already live — `trust-score.ts` folds `reverts / (N + reverts)` into the loop-ceiling
// multiplier. Keeping a second, blinder rate next to it and gating autonomy on THAT is the
// incoherence; deleting it removes the question rather than answering it.
//
// So: the trip half is kept exactly as it was (it works, and it is load-bearing — the
// `hold` rung gates operator-fact auto-promotion), the promote half is gone, and the human
// gets one honest affordance instead of a ratification ceremony for proposals nobody could
// see. governDecision + the ladder moves stay PURE + unit-tested.
import {
  listCapabilities,
  getCapability,
  setRung,
  RUNG_ORDER,
  type Rung,
  type Capability
} from './capability-ledger'

/** One rung toward hold (less autonomous). */
export function demoteRung(rung: Rung): Rung {
  const i = RUNG_ORDER.indexOf(rung)
  return RUNG_ORDER[Math.min(i + 1, RUNG_ORDER.length - 1)]
}

export interface GovernorEvidence {
  newReverts: number // unhandled ratified-then-reverted misses — the only trip signal
}

export type GovernorOutcome = 'trip' | 'hold'

/** The breaker. PURE. Any unhandled miss trips it; nothing else moves a rung automatically. */
export function governDecision(ev: GovernorEvidence): GovernorOutcome {
  return ev.newReverts > 0 ? 'trip' : 'hold'
}

export function evidenceFor(cap: Capability): GovernorEvidence {
  return { newReverts: Math.max(0, cap.reverts - cap.revertsHandled) }
}

export interface RungChange {
  id: string
  title: string
  from: Rung
  to: Rung
}
export interface GovernorPassResult {
  /** Breakers tripped this pass (applied — the safe direction). */
  tripped: RungChange[]
  held: number
}

/** Run one governor pass: trip the breaker on any capability carrying an unhandled miss. */
export function runGovernorPass(): GovernorPassResult {
  const tripped: RungChange[] = []
  let held = 0
  for (const cap of listCapabilities()) {
    if (governDecision(evidenceFor(cap)) !== 'trip') {
      held++
      continue
    }
    const to = demoteRung(cap.rung)
    if (to !== cap.rung) {
      setRung(cap.id, to, { demoted: true })
      tripped.push({ id: cap.id, title: cap.title, from: cap.rung, to })
    } else {
      // Already at hold — record the reverts as handled so it doesn't re-fire.
      setRung(cap.id, cap.rung, { demoted: true })
    }
  }
  return { tripped, held }
}

/** Why an operator re-arm was refused. */
export type RearmRefusal = 'unknown-capability' | 'already-armed'

export interface RearmResult {
  ok: boolean
  change?: RungChange
  reason?: RearmRefusal
}

/**
 * Re-arm a tripped capability — the operator half of the breaker, and the ONLY way a rung
 * ever moves toward autonomy.
 *
 * It restores the floor rung in ONE step rather than climbing by one. That is what makes it
 * a breaker instead of a ladder: the human is not awarding a grade for a good run, they are
 * saying "I looked at this and it is fit to run." A per-rung climb would need a rate to
 * justify each step, which is exactly the machinery that never worked.
 *
 * Never called from a tick — only from an explicit operator action
 * (`POST /state/autonomy/rearm`). An unhandled miss cannot survive a re-arm, because
 * `setRung(…, {demoted:true})` consumed the reverts when the breaker tripped; if a NEW miss
 * lands afterwards the next pass trips it straight back, which is the breaker working.
 */
export function rearmCapability(id: string): RearmResult {
  const cap = getCapability(id)
  if (!cap) return { ok: false, reason: 'unknown-capability' }
  const from = cap.rung
  const to = cap.floorRung
  if (to === from) return { ok: false, reason: 'already-armed' }
  setRung(cap.id, to)
  return { ok: true, change: { id: cap.id, title: cap.title, from, to } }
}
