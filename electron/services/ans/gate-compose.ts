// gate-compose.ts — Govern/enforcement: compose the two governors that never
// composed. DUIN runs a consequence-TIER gate (agui-approval: allow/prompt/deny by
// how irreversible a tool call is) AND an ANS autonomy RUNG per capability
// (capability-ledger: reflexive/stage/hold by how much autonomy it has earned). Until
// now they decided independently — a capability pinned to 'hold' could still be
// auto-allowed by the tier gate. This makes the choke-point take the LEAST-PERMISSIVE
// meet of the two, so neither governor can be bypassed by the other. PURE.

import { RUNG_ORDER, type Rung } from './capability-ledger'

/** The tier gate's three outcomes, which map onto the SAME autonomy lattice as the
 *  ANS rung: allow ~ reflexive (may run autonomously) < prompt ~ stage (needs
 *  staging/approval) < deny ~ hold (pinned). */
export type GateKind = 'allow' | 'prompt' | 'deny'

const KIND_TO_RUNG: Record<GateKind, Rung> = { allow: 'reflexive', prompt: 'stage', deny: 'hold' }
const RUNG_TO_KIND: Record<Rung, GateKind> = { reflexive: 'allow', stage: 'prompt', hold: 'deny' }

export interface Composition {
  /** The composed gate outcome (never more permissive than the tier verdict). */
  kind: GateKind
  /** true ⇒ the rung tightened the tier verdict (audit/observability signal). */
  tightenedByRung: boolean
  rung: Rung | null
}

/**
 * Least-permissive MEET of the consequence-tier verdict and the ANS autonomy rung.
 * PURE. rung=null (the tool is not an ANS-governed capability) ⇒ the tier verdict
 * stands unchanged. Otherwise the result is the MORE RESTRICTIVE of tier and rung on
 * the reflexive<stage<hold lattice — the rung can only TIGHTEN, never loosen (a gate
 * composition must be fail-safe: adding a governor may add denials, never allowances).
 */
export function composeTierRung(tierKind: GateKind, rung: Rung | null): Composition {
  if (rung == null) return { kind: tierKind, tightenedByRung: false, rung }
  const tierRung = KIND_TO_RUNG[tierKind]
  // Higher index on RUNG_ORDER = less permissive; the meet is the max (least-permissive).
  const meet = RUNG_ORDER.indexOf(rung) > RUNG_ORDER.indexOf(tierRung) ? rung : tierRung
  const kind = RUNG_TO_KIND[meet]
  return { kind, tightenedByRung: kind !== tierKind, rung }
}
