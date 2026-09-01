// moat-health — the "is the moat compounding?" instrument. Every learning loop built
// into DUIN (recall/taste, the govern loop, the ANS governor, calibration, consolidation)
// is correct but INVISIBLE: it computes over a store that starts cold, so nothing has
// graduated yet and there's no way to see it earning. This aggregates the existing stores
// into one health surface so the compounding is watchable — the promotion funnel, the
// revoke-fast asymmetry, whether calibration tiers are earning past min_n, and where the
// ANS capabilities sit on the autonomy ladder.
//
// PURE aggregator (simple inputs → the health object) so it's testable without the live
// stores; getMoatHealth() gathers the real data and a native route serves it.

export interface FactCounts {
  candidate: number
  provisional: number
  promoted: number
  vetoed: number
  reverted: number
  total: number
}

export interface CalibrationKind {
  kind: string
  observed: number
  gated: boolean
  usefulRate: number | null
}

export interface MoatHealthInputs {
  facts: {
    status: string
    observedSessions?: string[]
    /** Probation start — set when a human promotes candidate → provisional. Presence (with
     *  `govern`) is the honest-graduation marker; legacy promoted facts have neither. */
    provisionalAt?: number | null
    /** Govern-loop provenance — PRESENCE marks a jury-confirmed promotion. Legacy promoted
     *  facts (asserted before the govern loop existed) carry no govern block. */
    govern?: unknown
  }[]
  capabilities: { rung: string; ratifyN: number; ratifyK: number }[]
  calibration: CalibrationKind[]
  successCount: number
  /** Distinct-session survival bar the govern loop confirms on (default 2). */
  minSessions?: number
}

export interface MoatHealth {
  facts: FactCounts
  promotion: {
    onProbation: number // provisional (proving out)
    confirmed: number // GOVERNED promotions only (earned) — legacy promoted are NOT counted here
    /** Promotions carrying govern provenance + provisionalAt — the HONESTLY earned ones. Same
     *  value as `confirmed`; kept explicit so consumers don't have to know the alias. */
    governed: number
    /** Legacy promotions (asserted pre-govern: no provenance, no provisionalAt). Reported for
     *  visibility but EXCLUDED from `confirmed`/earned and from the `compounding` verdict — the
     *  honesty fix that stops the instrument reading "compounding" off never-juried facts. */
    legacyPromoted: number
    reverted: number
    /** reverted / (promoted + reverted) — low is healthy (grant-slow/revoke-fast working). */
    revertRate: number
    /** provisional facts that have survived enough distinct sessions to be confirm-eligible. */
    survivalReady: number
  }
  capabilities: {
    reflexive: number
    stage: number
    hold: number
    total: number
    /** mean ratifyK/ratifyN over capabilities with any feedback (0 if none). */
    avgRatifyRate: number
  }
  calibration: {
    kinds: CalibrationKind[]
    earned: number // kinds past min_n (not gated) — the loop is turning
    gated: number // kinds still accruing
    /** true ⇒ no kind has earned out yet — the loops are still cold. */
    coldStart: boolean
  }
  success: { traces: number }
  /** A one-line human read on where the moat is. */
  status: 'cold' | 'warming' | 'compounding'
}

import { getOperatorFacts } from './operator-model'
import { listCapabilities } from '../ans/capability-ledger'
import { loadKindRates } from './calibration-weight'
import { getSuccesses } from './success-miner'

const round = (x: number, nd = 3): number => {
  const m = 10 ** nd
  return Math.round(x * m) / m
}

/** Gather the live loop stores and compute the moat-health surface. Best-effort — a
 *  missing store degrades to zeros, never throws. */
export function getMoatHealth(vaultDir: string | null): MoatHealth {
  let facts: MoatHealthInputs['facts']
  try {
    facts = getOperatorFacts().map((f) => ({
      status: f.status,
      observedSessions: f.observedSessions,
      provisionalAt: f.provisionalAt,
      govern: f.govern
    }))
  } catch {
    facts = []
  }
  let capabilities: MoatHealthInputs['capabilities']
  try {
    capabilities = listCapabilities().map((c) => ({ rung: c.rung, ratifyN: c.ratifyN, ratifyK: c.ratifyK }))
  } catch {
    capabilities = []
  }
  let calibration: CalibrationKind[]
  try {
    calibration = [...loadKindRates(vaultDir).entries()].map(([kind, r]) => ({
      kind,
      observed: r.observed,
      gated: r.gated,
      usefulRate: r.rate
    }))
  } catch {
    calibration = []
  }
  let successCount: number
  try {
    successCount = getSuccesses().length
  } catch {
    successCount = 0
  }
  return computeMoatHealth({ facts, capabilities, calibration, successCount })
}

/** A promoted fact is HONESTLY earned only if it carries govern-loop provenance AND was actually
 *  on probation (provisionalAt). Legacy promoted facts — asserted before the govern loop existed —
 *  have neither, so they DON'T count as earned. Mirrors compounding-health.ts's isGovernedPromotion
 *  (promotionThroughput = governed only), so both instruments read the funnel the same, honest way.
 *  PURE. */
function isGovernedPromotion(f: MoatHealthInputs['facts'][number]): boolean {
  return f.status === 'promoted' && f.govern != null && f.provisionalAt != null
}

/** Aggregate the loop stores into a moat-health surface. PURE. */
export function computeMoatHealth(inputs: MoatHealthInputs): MoatHealth {
  const minSessions = inputs.minSessions ?? 2
  const facts: FactCounts = { candidate: 0, provisional: 0, promoted: 0, vetoed: 0, reverted: 0, total: 0 }
  let survivalReady = 0
  let governed = 0
  let legacyPromoted = 0
  for (const f of inputs.facts) {
    facts.total++
    if (f.status === 'candidate') facts.candidate++
    else if (f.status === 'provisional') {
      facts.provisional++
      if ((f.observedSessions?.length ?? 0) >= minSessions) survivalReady++
    } else if (f.status === 'promoted') {
      facts.promoted++
      // The honesty split: only jury-governed promotions count as earned; legacy (pre-govern,
      // asserted) promotions are tallied separately and never inflate the earned/compounding read.
      if (isGovernedPromotion(f)) governed++
      else legacyPromoted++
    } else if (f.status === 'vetoed') facts.vetoed++
    else if (f.status === 'reverted') facts.reverted++
  }
  const revertDenom = facts.promoted + facts.reverted
  const revertRate = revertDenom > 0 ? round(facts.reverted / revertDenom) : 0

  const caps = { reflexive: 0, stage: 0, hold: 0, total: inputs.capabilities.length, avgRatifyRate: 0 }
  let ratifySum = 0
  let ratifyN = 0
  for (const c of inputs.capabilities) {
    if (c.rung === 'reflexive') caps.reflexive++
    else if (c.rung === 'stage') caps.stage++
    else if (c.rung === 'hold') caps.hold++
    if (c.ratifyN > 0) {
      ratifySum += c.ratifyK / c.ratifyN
      ratifyN++
    }
  }
  caps.avgRatifyRate = ratifyN > 0 ? round(ratifySum / ratifyN) : 0

  const earned = inputs.calibration.filter((k) => !k.gated).length
  const gated = inputs.calibration.filter((k) => k.gated).length
  const coldStart = inputs.calibration.length === 0 || earned === 0

  // A coarse read: cold = nothing earned; compounding = calibration earning AND at least one
  // GOVERNED (honestly earned) promotion. Legacy promoted facts do NOT flip this to compounding —
  // they keep the store at 'warming' (some learning happened) so a dead confirm funnel reads as
  // stalled, not compounding. This is the honesty fix (mirrors compounding-health.ts).
  let status: MoatHealth['status'] = 'cold'
  const anyLearning = facts.promoted > 0 || facts.provisional > 0 || inputs.successCount > 0
  if (!coldStart && governed > 0) status = 'compounding'
  else if (anyLearning || !coldStart) status = 'warming'

  return {
    facts,
    promotion: {
      onProbation: facts.provisional,
      confirmed: governed,
      governed,
      legacyPromoted,
      reverted: facts.reverted,
      revertRate,
      survivalReady
    },
    capabilities: caps,
    calibration: { kinds: inputs.calibration, earned, gated, coldStart },
    success: { traces: inputs.successCount },
    status
  }
}
