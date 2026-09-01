// foresight-loop — pre-play the decisions that are already late (world-model Stage 3).
//
// The point of a world model is to be consulted BEFORE the commit. DUIN's rollout surface existed
// but nothing ever triggered it, so foresight only ever ran when a human went looking for it. This
// finds the decision windows that have gone past their decide-by date and pre-plays them.
//
// DELIBERATELY ON-DEMAND, NOT A BACKGROUND TICK. The spec calls this loop "read-only", and it is —
// it never writes a decision, never logs a forecast, never acts. But pre-playing costs model calls,
// and an unattended timer that spends them is a behaviour change of the kind the no-autonomy
// discipline exists to prevent. It is therefore a function + route the operator invokes.
//
// Every result is a NUDGE: it carries a recommendation and the reasoning, and is explicitly marked
// as requiring human ratification. Nothing here decides anything.

import { rankOptions, agreesWithNaive, type RankResult } from './foresight-rank'
import type { DecisionSimResult } from './decision-simulator'

const DAY = 86_400_000

export interface OverdueWindow {
  id: string
  title: string
  /** ISO date the decision was supposed to be made by. */
  dueBy: string
  daysOverdue: number
  track: string
  options: string[]
}

export interface ForesightNudge {
  decisionId: string
  title: string
  daysOverdue: number
  /** Null when the rollout could not separate the options — an honest abstention. */
  recommendation: string | null
  decisive: boolean
  why: string
  ranked: RankResult['ranked']
  /** Did ranking change the answer vs "take the first option"? Null when there is no top. */
  changedTheAnswer: boolean | null
  /** Always true. A nudge is advisory by construction; nothing in this module applies anything. */
  requiresHumanRatify: true
}

export interface ForesightLoopDeps {
  /** Simulate one decision's options. Injected so the loop is testable without a model. */
  simulate: (w: OverdueWindow) => Promise<DecisionSimResult | null>
  /** Earned trust of the risk domain in [0,1], or null when uncalibrated. */
  riskTrust: () => number | null
}

interface LedgerRow {
  id?: string
  kind?: string
  predicted?: string
  track?: string
  verdict?: string
  resolved?: string
  eval_after?: { by?: string }
  options?: string[]
}

const parseDay = (s?: string): number | null => {
  if (!s) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/**
 * PURE: which decision windows are past their decide-by date and still unresolved?
 *
 * "Unresolved" is the honest test — a row that already carries a verdict has been decided, and
 * pre-playing it would be theatre. Rows with no parseable due date are skipped rather than assumed
 * overdue.
 */
export function overdueWindows(rows: LedgerRow[], now: number): OverdueWindow[] {
  const out: OverdueWindow[] = []
  for (const r of rows) {
    if (r.kind !== 'decision-window') continue
    if (r.verdict || r.resolved) continue // already decided
    const by = parseDay(r.eval_after?.by)
    if (by === null || by >= now) continue
    out.push({
      id: r.id ?? '',
      title: r.predicted ?? r.id ?? '',
      dueBy: r.eval_after?.by ?? '',
      daysOverdue: Math.floor((now - by) / DAY),
      track: r.track ?? '',
      options: r.options ?? []
    })
  }
  // Most overdue first — the ones bleeding longest deserve the operator's attention first.
  return out.sort((a, b) => b.daysOverdue - a.daysOverdue)
}

/** Pre-play the overdue windows and return advisory nudges. Never writes, never acts.
 *  A window whose simulation fails is skipped, not guessed at. */
export async function preplayOverdue(
  rows: LedgerRow[],
  now: number,
  deps: ForesightLoopDeps,
  limit = 5
): Promise<{ overdue: number; preplayed: number; nudges: ForesightNudge[] }> {
  const windows = overdueWindows(rows, now)
  const take = windows.slice(0, Math.max(0, limit))
  const nudges: ForesightNudge[] = []
  for (const w of take) {
    let sim: DecisionSimResult | null
    try {
      sim = await deps.simulate(w)
    } catch {
      sim = null
    }
    if (!sim || !sim.options.length) continue
    const ranked = rankOptions(sim, { riskTrust: deps.riskTrust() })
    nudges.push({
      decisionId: w.id,
      title: w.title,
      daysOverdue: w.daysOverdue,
      recommendation: ranked.top?.label ?? null,
      decisive: ranked.decisive,
      why: ranked.top?.why ?? ranked.note ?? 'no separation between options',
      ranked: ranked.ranked,
      changedTheAnswer: agreesWithNaive(sim, ranked) === null ? null : !agreesWithNaive(sim, ranked),
      requiresHumanRatify: true
    })
  }
  return { overdue: windows.length, preplayed: nudges.length, nudges }
}
