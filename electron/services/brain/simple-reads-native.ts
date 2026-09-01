// simple-reads-native — trivial jsonl-backed read routes ported together.
//   stream-verdicts : raw dump of stream-verdicts.jsonl
//   forecast-owed   : the adjudication backlog — subjects-empty, unresolved forecasts
//                     whose eval date has passed (port of forecast_owed_verdicts's READ;
//                     Python's resolve-on-read side effect is owned by calibration-store,
//                     deferred to the coordinated flip).
import { readFileSync } from 'fs'
import { join } from 'path'

const stateDir = (v: string): string => join(v, '.duin', '_state')
function readJsonl<T = Record<string, unknown>>(path: string): T[] {
  try {
    return readFileSync(path, 'utf-8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as T
        } catch {
          return null
        }
      })
      .filter((x): x is T => x !== null)
  } catch {
    return []
  }
}

export function streamVerdicts(vaultDir: string | null): { verdicts: unknown[] } {
  if (!vaultDir) return { verdicts: [] }
  return { verdicts: readJsonl(join(stateDir(vaultDir), 'stream-verdicts.jsonl')) }
}

/** The cascade review tray: judged-but-unapplied cascades awaiting a nod. Port of
 *  list_cascade_pending. */
export function cascadePending(vaultDir: string | null): { pending: unknown[] } {
  if (!vaultDir) return { pending: [] }
  const rows = readJsonl<{ status?: string }>(join(stateDir(vaultDir), 'cascade-pending.jsonl'))
  return { pending: rows.filter((i) => i.status === 'pending') }
}

/** Meetings & Events feed — chat-mined commitments, dismissed hidden, soonest first
 *  (Python sort key: confirmed AFTER unconfirmed, then by `when`). Port of list_meetings. */
export function listMeetings(vaultDir: string | null): { meetings: unknown[] } {
  if (!vaultDir) return { meetings: [] }
  const ms = readJsonl<{ status?: string; when?: unknown }>(join(stateDir(vaultDir), 'meetings.jsonl')).filter(
    (m) => m.status !== 'dismissed'
  )
  ms.sort((a, b) => {
    const ca = a.status === 'confirmed' ? 1 : 0
    const cb = b.status === 'confirmed' ? 1 : 0
    if (ca !== cb) return ca - cb
    const wa = String(a.when ?? '9999')
    const wb = String(b.when ?? '9999')
    return wa < wb ? -1 : wa > wb ? 1 : 0
  })
  return { meetings: ms }
}

interface OwedRow {
  id?: string
  kind?: string
  predicted?: string
  title?: string
  confidence?: number
  track?: string
  subjects?: string[]
  verdict?: string | null
  resolution?: string
  eval_after?: { by?: string }
}
/** Confidence floor for a "committed belief". A hedged <0.6 forecast being wrong is
 *  not a surprise; a >=0.6 miss is a genuine prediction error worth consolidating. */
export const CONFIDENT_MISS_FLOOR = 0.6

interface MissRow {
  id?: string
  kind?: string
  predicted?: string
  title?: string
  confidence?: number
  track?: string
  subjects?: string[]
  verdict?: string
  outcome?: string
  resolution?: string
  eval_after?: { by?: string }
}
/** Confident misses on the ledger: a bare probabilistic forecast (subjects-empty) that
 *  carried a committed confidence (>= CONFIDENT_MISS_FLOOR) and was refuted by reality
 *  (outcome/resolution 'miss', or verdict 'refuted'). Richest-surprise (highest
 *  confidence) first. READ-only — mirrors surprise_consolidation_trigger's predicate. */
export function confidentMisses(vaultDir: string | null): { misses: unknown[]; count: number } {
  if (!vaultDir) return { misses: [], count: 0 }
  const out: Record<string, unknown>[] = []
  for (const r of readJsonl<MissRow>(join(stateDir(vaultDir), 'risk-predictions.jsonl'))) {
    if (r.subjects?.length) continue // signal-mode miss is "window slipped", not a wrong belief
    if (typeof r.confidence !== 'number') continue // conf=None ⇒ structural detector, not a belief
    if (r.confidence < CONFIDENT_MISS_FLOOR) continue // hedged miss ⇒ not a surprise
    if (!(r.outcome === 'miss' || r.resolution === 'miss' || r.verdict === 'refuted')) continue
    out.push({
      id: r.id,
      kind: r.kind ?? '',
      predicted: r.predicted || r.title || '',
      confidence: r.confidence,
      track: r.track ?? '',
      eval_by: r.eval_after?.by ?? ''
    })
  }
  out.sort((a, b) => (b.confidence as number) - (a.confidence as number))
  return { misses: out, count: out.length }
}

/**
 * Predictions OWED a verdict from the operator — overdue AND actionable by hand.
 *
 * The two exclusions below are deliberate and stay: a row with `subjects[]` is signal-mode and
 * self-resolves on subject status, so it is not owed from anyone; a row whose `eval_after.by` is
 * still in the future is not owed YET. Widening this to "everything unresolved" would put rows in
 * front of the operator that they cannot act on, which is worse than showing none.
 *
 * But the counts are returned now, because the Calibration panel showed a tile reading
 * `56 open` above a list that was STRUCTURALLY always empty — 49 self-resolving + 7 not-yet-due,
 * 0 listable — with nothing anywhere explaining the gap. "Open" and "owed from you" are different
 * quantities, and a UI that shows the first while implying the second reads as broken. The caller
 * can now say WHY the list is empty instead of just being empty.
 */
export function forecastOwed(
  vaultDir: string | null,
  today: Date = new Date()
): { owed: unknown[]; count: number; selfResolving: number; notDueYet: number } {
  if (!vaultDir) return { owed: [], count: 0, selfResolving: 0, notDueYet: 0 }
  const t0 = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()))
  const todayIso = t0.toISOString().slice(0, 10)
  const out: Record<string, unknown>[] = []
  let selfResolving = 0
  let notDueYet = 0
  for (const r of readJsonl<OwedRow>(join(stateDir(vaultDir), 'risk-predictions.jsonl'))) {
    if (r.verdict != null && r.verdict !== 'null') continue
    if (r.resolution) continue // already adjudicated, awaiting its date
    if (r.subjects?.length) {
      selfResolving++ // signal-mode self-resolves on subject status — never owed from a human
      continue
    }
    const by = r.eval_after?.by ?? ''
    if (!/^\d{4}-\d{2}-\d{2}$/.test(by)) continue
    if (by > todayIso) {
      notDueYet++
      continue
    }
    {
      const daysOverdue = Math.floor((t0.getTime() - new Date(by + 'T00:00:00Z').getTime()) / 86400000)
      out.push({
        id: r.id,
        kind: r.kind ?? '',
        predicted: r.predicted || r.title || '',
        confidence: r.confidence,
        track: r.track ?? '',
        eval_by: by,
        days_overdue: daysOverdue
      })
    }
  }
  out.sort((a, b) => (b.days_overdue as number) - (a.days_overdue as number))
  return { owed: out, count: out.length, selfResolving, notDueYet }
}
