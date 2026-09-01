// Brain persistence — durable storage for the decision-loop "made" side and the
// calibration ledger (logged predictions + verdicts), backed by the app's
// encrypted SQLite (database.ts, migration v18). Every call is BEST-EFFORT and
// guarded: if the DB isn't available (test env, read-only mode, early boot) the
// function no-ops / returns null and the facade falls back to in-memory state.
// The facade gates these behind enableBrainPersistence() so unit tests stay
// purely in-memory.

import { getDb, withWriteRetry } from '../database'
import type {
  MadeDecision,
  PredictedRisk,
  LoggedPrediction,
  VerdictOutcome,
  DecisionOutcome
} from './types'

function nowISO(): string {
  return new Date().toISOString()
}

/** Load all made decisions (newest first). Returns null on any failure. */
export function loadDecisions(): MadeDecision[] | null {
  try {
    const rows = getDb()
      .prepare(
        'SELECT node_id, title, choice, note, decided_at FROM brain_decisions ORDER BY decided_at DESC'
      )
      .all() as Array<{
      node_id: string
      title: string
      choice: DecisionOutcome
      note: string | null
      decided_at: string
    }>
    return rows.map((r) => ({
      id: `dec::${r.node_id}`,
      node_id: r.node_id,
      title: r.title,
      choice: r.choice,
      note: r.note ?? undefined,
      decided_at: r.decided_at
    }))
  } catch (err) {
    console.warn('[brain-db] loadDecisions failed:', (err as Error)?.message)
    return null
  }
}

/** Upsert one decision (one row per node; a re-decide replaces it). */
export function saveDecision(d: MadeDecision): void {
  try {
    withWriteRetry(
      () =>
        getDb()
          .prepare(
            `INSERT INTO brain_decisions (node_id, title, choice, note, decided_at)
             VALUES (@node_id, @title, @choice, @note, @decided_at)
             ON CONFLICT(node_id) DO UPDATE SET
               title = excluded.title, choice = excluded.choice,
               note = excluded.note, decided_at = excluded.decided_at`
          )
          .run({
            node_id: d.node_id,
            title: d.title,
            choice: d.choice,
            note: d.note ?? null,
            decided_at: d.decided_at
          }),
      { label: 'brain-db.saveDecision' }
    )
  } catch (err) {
    console.warn('[brain-db] saveDecision failed:', (err as Error)?.message)
  }
}

/** Clear all made decisions (called when the brain source switches). */
export function clearDecisions(): void {
  try {
    withWriteRetry(() => getDb().prepare('DELETE FROM brain_decisions').run(), {
      label: 'brain-db.clearDecisions'
    })
  } catch (err) {
    console.warn('[brain-db] clearDecisions failed:', (err as Error)?.message)
  }
}

/** Append-once log of predictions (preserves first-seen created_at per id). */
export function logPredictions(risks: PredictedRisk[]): void {
  if (risks.length === 0) return
  try {
    const stmt = getDb().prepare(
      `INSERT OR IGNORE INTO brain_predictions (id, kind, title, due, confidence, track, created_at)
       VALUES (@id, @kind, @title, @due, @confidence, @track, @created_at)`
    )
    const ts = nowISO()
    withWriteRetry(
      () => {
        for (const r of risks) {
          stmt.run({
            id: r.id,
            kind: r.kind,
            title: r.title,
            due: r.due ?? null,
            confidence: typeof r.confidence === 'number' ? r.confidence : null,
            track: r.track ?? null,
            created_at: ts
          })
        }
      },
      { label: 'brain-db.logPredictions' }
    )
  } catch (err) {
    console.warn('[brain-db] logPredictions failed:', (err as Error)?.message)
  }
}

/** Record (upsert) a verdict on a logged prediction. */
export function recordVerdict(predictionId: string, outcome: VerdictOutcome, note?: string): void {
  try {
    withWriteRetry(
      () =>
        getDb()
          .prepare(
            `INSERT INTO brain_verdicts (prediction_id, outcome, note, recorded_at)
             VALUES (@id, @outcome, @note, @recorded_at)
             ON CONFLICT(prediction_id) DO UPDATE SET
               outcome = excluded.outcome, note = excluded.note, recorded_at = excluded.recorded_at`
          )
          .run({ id: predictionId, outcome, note: note ?? null, recorded_at: nowISO() }),
      { label: 'brain-db.recordVerdict' }
    )
  } catch (err) {
    console.warn('[brain-db] recordVerdict failed:', (err as Error)?.message)
  }
}

/** Load logged predictions joined with their verdicts. Null on failure. */
export function loadLoggedPredictions(): LoggedPrediction[] | null {
  try {
    const rows = getDb()
      .prepare(
        `SELECT p.id, p.kind, p.title, p.due, p.confidence, p.track, p.created_at,
                COALESCE(v.outcome, 'unobserved') AS outcome, v.note AS note
         FROM brain_predictions p
         LEFT JOIN brain_verdicts v ON v.prediction_id = p.id
         ORDER BY p.created_at DESC`
      )
      .all() as Array<{
      id: string
      kind: string
      title: string
      due: string | null
      confidence: number | null
      track: string | null
      created_at: string
      outcome: VerdictOutcome
      note: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      title: r.title,
      due: r.due,
      confidence: r.confidence,
      track: r.track,
      created_at: r.created_at,
      outcome: r.outcome,
      auto: String(r.note ?? '').startsWith('auto:')
    }))
  } catch (err) {
    console.warn('[brain-db] loadLoggedPredictions failed:', (err as Error)?.message)
    return null
  }
}

/** Record (upsert) the user's verdict on a cross-cutting insight. `feature` is
 *  the insight's rule family (id prefix) so affinity accrues per KIND of insight.
 *  One row per insight id — a re-verdict replaces it. Best-effort. */
export function saveInsightVerdict(insightId: string, feature: string, verdict: string): void {
  try {
    withWriteRetry(
      () =>
        getDb()
          .prepare(
            `INSERT INTO brain_insight_verdicts (insight_id, feature, verdict, recorded_at)
             VALUES (@id, @feature, @verdict, @recorded_at)
             ON CONFLICT(insight_id) DO UPDATE SET
               feature = excluded.feature, verdict = excluded.verdict,
               recorded_at = excluded.recorded_at`
          )
          .run({ id: insightId, feature, verdict, recorded_at: nowISO() }),
      { label: 'brain-db.saveInsightVerdict' }
    )
  } catch (err) {
    console.warn('[brain-db] saveInsightVerdict failed:', (err as Error)?.message)
  }
}

/** Per-feature useful/dismissed tallies for the Home Digest Affinity term.
 *  pos = useful|acted, neg = dismissed|inaccurate. Null on failure (→ neutral). */
export function loadInsightAffinity(): Record<string, { pos: number; neg: number }> | null {
  try {
    const rows = getDb()
      .prepare(
        `SELECT feature, verdict, COUNT(*) AS n
         FROM brain_insight_verdicts GROUP BY feature, verdict`
      )
      .all() as Array<{ feature: string; verdict: string; n: number }>
    const out: Record<string, { pos: number; neg: number }> = {}
    for (const r of rows) {
      const bucket = (out[r.feature] ??= { pos: 0, neg: 0 })
      if (r.verdict === 'useful' || r.verdict === 'acted') bucket.pos += r.n
      else if (r.verdict === 'dismissed' || r.verdict === 'inaccurate') bucket.neg += r.n
    }
    return out
  } catch (err) {
    console.warn('[brain-db] loadInsightAffinity failed:', (err as Error)?.message)
    return null
  }
}

/** Home Digest SALIENCE ledgers — Novelty (first-seen age) + Decay (per-day impressions).
 *  Loaded together for the ranker; null on failure → the ranker falls back to NEUTRAL
 *  modulators (byte-identical to the pre-salience digest). See brain-schema.ts. */
export function loadInsightSalience(): { firstSeen: Record<string, string>; impressions: Record<string, number> } | null {
  try {
    const db = getDb()
    const firstSeen: Record<string, string> = {}
    for (const r of db.prepare(`SELECT insight_id, first_seen_at FROM brain_insight_first_seen`).all() as Array<{ insight_id: string; first_seen_at: string }>) {
      firstSeen[r.insight_id] = r.first_seen_at
    }
    const impressions: Record<string, number> = {}
    for (const r of db.prepare(`SELECT insight_id, shown_days FROM brain_insight_impressions`).all() as Array<{ insight_id: string; shown_days: number }>) {
      impressions[r.insight_id] = r.shown_days
    }
    return { firstSeen, impressions }
  } catch (err) {
    console.warn('[brain-db] loadInsightSalience failed:', (err as Error)?.message)
    return null
  }
}

/** Record a digest build's salience sightings. `noticedIds` = every insight the brain
 *  surfaced as a CANDIDATE this build (stamps first-seen once → the Novelty age clock).
 *  `shownIds` = the insights actually RENDERED in the digest (bumps the per-DAY impression
 *  count → Decay anti-nag; at most once per id per `today`, so polling can't inflate it).
 *  `today` is the yyyy-mm-dd the ranker used as now. Best-effort; never breaks the digest. */
export function recordInsightSalience(noticedIds: string[], shownIds: string[], today: string): void {
  try {
    withWriteRetry(
      () => {
        const db = getDb()
        const stampFirst = db.prepare(
          `INSERT INTO brain_insight_first_seen (insight_id, first_seen_at) VALUES (@id, @today)
           ON CONFLICT(insight_id) DO NOTHING`
        )
        const bumpShown = db.prepare(
          `INSERT INTO brain_insight_impressions (insight_id, shown_days, last_shown_on) VALUES (@id, 1, @today)
           ON CONFLICT(insight_id) DO UPDATE SET shown_days = shown_days + 1, last_shown_on = @today
           WHERE brain_insight_impressions.last_shown_on < @today`
        )
        for (const id of noticedIds) stampFirst.run({ id, today })
        for (const id of shownIds) bumpShown.run({ id, today })
      },
      { label: 'brain-db.recordInsightSalience' }
    )
  } catch (err) {
    console.warn('[brain-db] recordInsightSalience failed:', (err as Error)?.message)
  }
}

/** Predictions + current-verdict state for auto-resolution. `manual` = a human
 *  verdict that auto-resolution must not override. Null on failure. */
export function loadPredictionsForResolve():
  | { id: string; kind: string; due: string | null; outcome: VerdictOutcome; manual: boolean }[]
  | null {
  try {
    const rows = getDb()
      .prepare(
        `SELECT p.id, p.kind, p.due, v.outcome AS outcome, v.note AS note
         FROM brain_predictions p
         LEFT JOIN brain_verdicts v ON v.prediction_id = p.id`
      )
      .all() as Array<{ id: string; kind: string; due: string | null; outcome: VerdictOutcome | null; note: string | null }>
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      due: r.due,
      outcome: r.outcome ?? 'unobserved',
      // A verdict exists AND it isn't auto-tagged → human-set → sticky.
      manual: r.outcome != null && !String(r.note ?? '').startsWith('auto:')
    }))
  } catch (err) {
    console.warn('[brain-db] loadPredictionsForResolve failed:', (err as Error)?.message)
    return null
  }
}
