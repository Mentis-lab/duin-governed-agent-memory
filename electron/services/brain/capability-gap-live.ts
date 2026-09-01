// @cohesion-invocation: on-demand-diagnostic — pulled via GET /state/capability-gaps; no autonomous
//   tick by design (a diagnostic wrapper over the pure detectGaps). To surface gaps proactively,
//   wire detectGapsLive into the self-improve loop or a nudge watcher — that is a feature, not a bug.
// Live loader for the capability-gap detector — the side-effectful wrapper that
// reads the app's stores and feeds the PURE detectGaps(). Kept separate so
// capability-gap.ts stays import-clean (no better-sqlite3), unit-testable, and
// runnable outside Electron.

import { readFileSync } from 'fs'
import { join } from 'path'
import { listFailedEventCounts } from '../event-log'
import { recordFailure } from '../failure-ledger'
import { getCalibration } from './index'
import { guardedSync } from '../guarded'
import { detectGaps, type GapInputs, type CapabilityGap } from './capability-gap'
import { messageOf } from '../guarded'

/**
 * L0 fuel bridge: sync runtime `*.failed` event counts into the structured
 * failure_ledger (kind 'runtime_failed'). The proof-gate kinds only get written
 * when proof gates run — which they don't in normal second-brain usage — so the
 * ledger (and the verifier + harness-recommendations that read it) stayed empty
 * while real systematic failures piled up as events. Idempotent: the
 * authoritative `count` tracks the events, not the number of sync passes.
 * Returns the number of ledger fingerprints synced. Best-effort.
 */
export function syncRuntimeFailuresToLedger(): number {
  // guardedSync, not a blanket catch: a MISSING ledger is expected (quiet); any
  // other failure — e.g. the kind-CHECK-constraint reject that silently emptied
  // the ledger earlier this session — is a bug and now fires loud telemetry.
  return (
    guardedSync(
      () => {
        let n = 0
        for (const c of listFailedEventCounts()) {
          const entity = c.entityId ?? '(none)'
          recordFailure({
            kind: 'runtime_failed',
            fingerprint: `runtime:${c.type}:${entity}`,
            message: `${c.type} failed for ${entity}`,
            count: c.n,
            // The real time of the newest matching event, so re-syncing does not
            // re-date a failure that stopped happening weeks ago.
            lastSeenAt: c.lastAt || undefined
          })
          n++
        }
        return n
      },
      { label: 'capability-gap.ledger-sync', expected: ['no such table'], fallback: 0 }
    ) ?? 0
  )
}

/** Load the four gap signals from the live stores. Every source is best-effort:
 *  a missing/empty store just contributes nothing (never throws). */
export function loadGapInputs(notesDir: string | null): GapInputs {
  // Recurring failures — expand the all-time GROUP BY counts back into events so
  // the pure detector groups them itself (small: a handful of rows × counts).
  let failedEvents: GapInputs['failedEvents'] = []
  try {
    failedEvents = listFailedEventCounts().flatMap((c) =>
      Array.from({ length: c.n }, () => ({ type: c.type, entityId: c.entityId }))
    )
  } catch (e) { console.debug('[capability-gap-live] no event store:', messageOf(e)) }

  // Corrections — the vault's learn ledger.
  let corrections: string[] = []
  if (notesDir) {
    try {
      const raw = readFileSync(join(notesDir, '.duin', '_state', 'corrections.jsonl'), 'utf-8')
      corrections = raw
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          try {
            const o = JSON.parse(l) as { correction?: string; candidate_rule?: string }
            return o.correction || o.candidate_rule || ''
          } catch {
            return ''
          }
        })
        .filter(Boolean)
    } catch (e) { console.debug('[capability-gap-live] no corrections yet:', messageOf(e)) }
  }

  // Calibration — per-kind hit-rate buckets.
  let calibration: GapInputs['calibration'] = []
  try {
    calibration = (getCalibration(notesDir).buckets ?? [])
      .filter((b) => b.resolved > 0)
      .map((b) => ({ kind: b.kind, hitRate: b.hit_rate ?? 0, resolved: b.resolved }))
  } catch (e) { console.debug('[capability-gap-live] calibration unavailable:', messageOf(e)) }

  return { failedEvents, corrections, calibration }
}

/** Detect gaps from the live stores. Also syncs runtime failures into the
 *  failure_ledger (idempotent) so the structured L0 store stays populated for
 *  downstream consumers. Read-only w.r.t. the vault; safe to call anytime. */
export function detectGapsLive(notesDir: string | null): CapabilityGap[] {
  syncRuntimeFailuresToLedger()
  return detectGaps(loadGapInputs(notesDir))
}
