// Native port of Python `scenario_forks()` (server.py) — Layer-3 conditional
// futures off decision points. Each open stream that has a `decide_by` AND both a
// `cleared` (good path) and `blocked` (risk path) is a FORK: the decision branches
// the future. ISOLATION: personal/confidential streams (track=='personal') are
// excluded from this shared view. Reuses the causal-substrate loaders/date helpers.
// Part of the brain unification (retire the Python engine); see DUIN_UNIFICATION_HANDOFF.

import { loadFutures, parseDeadline, type FutureStream } from './causal-substrate'

export interface ScenarioFork {
  stream: string
  track: string
  decision: string
  decide_by: string
  overdue: boolean
  days_to_decide: number | null
  target: string
  fork: { if_cleared: string; if_blocked: string }
  pending_steps: { event: string; when: string }[]
}

export interface ScenarioForksResponse {
  forks: ScenarioFork[]
  generated: string
  note: string
}

const NOTE =
  'conditional futures off decision points (if_cleared vs if_blocked); ' +
  'personal/confidential streams isolated from this shared view'

/** UTC-midnight of `t`'s LOCAL calendar day — mirrors Python `date.today()` so
 *  comparisons against parseDeadline() (also UTC-midnight) are day-exact. */
function todayUTC(t: Date): Date {
  return new Date(Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()))
}

function s80(v: unknown): string {
  return String(v ?? '').slice(0, 80)
}
function s200(v: unknown): string {
  return String(v ?? '').slice(0, 200)
}

/** Faithful port of server.py:scenario_forks(). Pure fs (via the shared loader). */
export function scenarioForks(vaultDir: string | null, now: Date = new Date()): ScenarioForksResponse {
  const today = todayUTC(now)
  const forks: ScenarioFork[] = []
  for (const s of loadFutures(vaultDir)) {
    const g = s as FutureStream & Record<string, unknown>
    if ((g.track || '') === 'personal') continue // isolation guard — confidential lane never enters the shared view
    if (!(g.cleared && g.blocked)) continue // need a real two-way fork
    const dby = parseDeadline(g.decide_by)
    const pending = (g.steps || []).filter((st) => !st?.done)
    forks.push({
      stream: s80(g.title || g.objective || ''),
      track: (g.track as string) ?? '',
      decision: s200(g.decision || g.trigger || ''),
      decide_by: (g.decide_by as string) ?? '',
      overdue: Boolean(dby && dby < today),
      days_to_decide: dby ? Math.round((dby.getTime() - today.getTime()) / 86400000) : null,
      target: (g.target as string) ?? '',
      fork: { if_cleared: s200(g.cleared || ''), if_blocked: s200(g.blocked || '') },
      pending_steps: pending
        .map((st) => ({ event: s80(st?.event || ''), when: String(st?.when ?? '') }))
        .slice(0, 6),
    })
  }
  // Python sort key: (decide_by or '~',) — ordinal string compare, empty sorts last.
  forks.sort((a, b) => {
    const ka = a.decide_by || '~'
    const kb = b.decide_by || '~'
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return { forks, generated: today.toISOString().slice(0, 10), note: NOTE }
}
