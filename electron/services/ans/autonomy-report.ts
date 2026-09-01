// autonomy-report — read-only aggregator for GET /state/autonomy + the duin_autonomy MCP tool
// (item 11). Surfaces per-capability rung + earned trust (0..1), whether the breaker is about to
// trip, whether the operator can re-arm it, and per-loop effective ceilings (item 19). PURE READ —
// it never moves a rung (runGovernorPass and rearmCapability mutate via setRung).
//
// `ratifyRate` used to be reported here. It is gone deliberately: only DISMISSALS lowered it, so a
// capability with 97 reverts read as a perfect 1.0 — the single most misleading number in the ANS
// surface. `trust` is the revert-aware measure (trust-score folds reverts/(N+reverts)) and is what
// actually scales loop ceilings, so it is the one worth showing.

import { listCapabilities } from './capability-ledger'
import { evidenceFor, governDecision, demoteRung } from './governor'
import { trustScore, snapshotFor } from './trust-score'
import { scoreResolvedLedger } from '../brain/calibration-scoring'
import { listLoops } from '../loop-store'
import { effectiveCeilings } from '../loop-controller'

export interface AutonomyState {
  capabilities: {
    id: string
    title: string
    rung: string
    floorRung: string
    trust: number
    coldStart: boolean
    ratifyN: number
    reverts: number
    calibKind: string | null
    /** The breaker carries an unhandled miss and will trip on the next pass. */
    willTrip: boolean
    /** Which rung a trip would drop it to; null when nothing is pending. */
    tripsTo: string | null
    /** Sitting below its floor, so the operator can re-arm it. */
    canRearm: boolean
  }[]
  loops: {
    id: string
    mode: string
    status: string
    userMaxIterations: number | null
    userTokenBudget: number | null
    effectiveMaxIterations: number | null
    effectiveTokenBudget: number | null
    trustMultiplier: number
  }[]
  calibration: { skillScore: number | null }
}

export function buildAutonomyState(vaultDir: string | null): AutonomyState {
  let skill: number | null = null
  try {
    skill = scoreResolvedLedger(vaultDir).skillScore
  } catch {
    skill = null
  }
  const capabilities = listCapabilities().map((c) => {
    const t = trustScore(snapshotFor(c, skill))
    const willTrip = governDecision(evidenceFor(c)) === 'trip'
    return {
      id: c.id,
      title: c.title,
      rung: c.rung,
      floorRung: c.floorRung,
      trust: t.score,
      coldStart: t.coldStart,
      ratifyN: c.ratifyN,
      reverts: c.reverts,
      calibKind: c.calibKind ?? null,
      willTrip,
      tripsTo: willTrip ? demoteRung(c.rung) : null,
      canRearm: c.rung !== c.floorRung
    }
  })
  const loops = listLoops({ status: ['running', 'paused'] }).map((l) => {
    const eff = effectiveCeilings(l, skill)
    return {
      id: l.id,
      mode: l.mode,
      status: l.status,
      userMaxIterations: l.maxIterations,
      userTokenBudget: l.tokenBudget,
      effectiveMaxIterations: eff.maxIterations,
      effectiveTokenBudget: eff.tokenBudget,
      trustMultiplier: eff.multiplier
    }
  })
  return { capabilities, loops, calibration: { skillScore: skill } }
}
