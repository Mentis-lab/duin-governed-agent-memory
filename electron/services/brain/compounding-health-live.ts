// Live loader for the Compounding Health benchmark — the side-effectful wrapper that gathers
// deps from the running app's ledgers/DB/config and feeds the PURE computeCompoundingHealth.
// Kept separate (mirrors brain-health-live.ts) so compounding-health.ts stays import-clean (no
// Electron, no better-sqlite3), unit-testable, and runnable outside Electron.
//
// Every source is best-effort: a missing ledger/config contributes a sane neutral/zero signal,
// never throws. `builtAt` + the ledger MTIME are the only clock reads (minted HERE), so the pure
// core stays deterministic.

import { readFileSync, statSync } from 'fs'
import { join } from 'path'
import { messageOf } from '../guarded'
import { brainRootPath, BRAIN_STATE_DIR } from './brain-root'
import { historyPath } from './brain-health-monitor'
import { getOperatorFacts } from './operator-model'
import { loadBindings } from './binding-store'
import { graphExpandGroundEnabled } from './graph-expand-adapt'
import { ENACT_ENABLED } from './improvement-proposer'
import { readSettings } from '../settings-helper'
import {
  computeCompoundingHealth,
  type CompoundingHealthDeps,
  type CompoundingHealth,
  type CompoundingFact,
  type CalibrationConsumeMode
} from './compounding-health'

/** How many recent rebuilds to window the entity-count series over (STABILITY). */
const STABILITY_WINDOW = 10

/** Non-empty trimmed lines of a jsonl file, or [] when absent/unreadable. */
function readJsonlLines(path: string): string[] {
  try {
    return readFileSync(path, 'utf-8').split('\n').map((l) => l.trim()).filter(Boolean)
  } catch (e) {
    console.debug('[compounding-health-live] jsonl unreadable:', path, messageOf(e))
    return []
  }
}

/** STABILITY: the totalEntities series (last N rebuilds) from brain-health-history.jsonl. */
function readEntityCountSeries(vault: string | null): number[] {
  const p = historyPath(vault)
  if (!p) return []
  const nums: number[] = []
  for (const line of readJsonlLines(p)) {
    try {
      const o = JSON.parse(line) as { totalEntities?: number }
      if (typeof o.totalEntities === 'number') nums.push(o.totalEntities)
    } catch (e) {
      console.debug('[compounding-health-live] skip corrupt history line:', messageOf(e))
    }
  }
  return nums.slice(-STABILITY_WINDOW)
}

/** STABILITY: current entity count from .brain/state/brain-construction.json (null on any failure). */
function readCurrentEntities(vault: string | null): number | null {
  const root = brainRootPath(vault)
  if (!root) return null
  try {
    const raw = JSON.parse(readFileSync(join(root, BRAIN_STATE_DIR, 'brain-construction.json'), 'utf-8')) as {
      data?: { entities?: unknown[] }
      entities?: unknown[]
    }
    const ents = raw.data?.entities ?? raw.entities
    return Array.isArray(ents) ? ents.length : null
  } catch (e) {
    console.debug('[compounding-health-live] no construction cache:', messageOf(e))
    return null
  }
}

/** METABOLISM: claim-ledger age (hours) + resolution + verdict-type diversity. A single pass over
 *  the jsonl (rows can be large, but we only touch verdictBy). Absent ledger ⇒ age null / zeros. */
function readMetabolism(vault: string | null, nowMs: number): {
  ledgerFreshnessHours: number | null
  claimTotal: number
  claimResolved: number
  verdictTypes: string[]
} {
  const p = vault ? join(vault, '.duin', '_state', 'claim-ledger.jsonl') : null
  if (!p) return { ledgerFreshnessHours: null, claimTotal: 0, claimResolved: 0, verdictTypes: [] }

  let ledgerFreshnessHours: number | null = null
  try {
    ledgerFreshnessHours = (nowMs - statSync(p).mtimeMs) / 3_600_000
  } catch (e) {
    console.debug('[compounding-health-live] no claim-ledger mtime:', messageOf(e))
  }

  let claimTotal = 0
  let claimResolved = 0
  const verdictTypes = new Set<string>()
  for (const line of readJsonlLines(p)) {
    claimTotal++
    // Cheap pre-filter before the (heavier) JSON.parse: most rows have verdictBy:null.
    if (!line.includes('"verdictBy"')) continue
    try {
      const o = JSON.parse(line) as { verdictBy?: string | null }
      if (o.verdictBy) {
        claimResolved++
        verdictTypes.add(o.verdictBy)
      }
    } catch (e) {
      console.debug('[compounding-health-live] skip corrupt claim line:', messageOf(e))
    }
  }
  return { ledgerFreshnessHours, claimTotal, claimResolved, verdictTypes: [...verdictTypes] }
}

/** COMPOUNDING: rows in corrections.jsonl (the bindingDrain denominator). */
function readCorrectionCount(vault: string | null): number {
  if (!vault) return 0
  return readJsonlLines(join(vault, '.duin', '_state', 'corrections.jsonl')).length
}

/** GROUNDING: decision-window observations available (forecast-track-record.json, informational). */
function readDecisionWindowObs(vault: string | null): number {
  if (!vault) return 0
  try {
    const raw = JSON.parse(readFileSync(join(vault, '.duin', '_state', 'forecast-track-record.json'), 'utf-8')) as {
      patterns?: Record<string, { fired?: number }>
    }
    return raw.patterns?.['decision-window']?.fired ?? 0
  } catch (e) {
    console.debug('[compounding-health-live] no forecast track record:', messageOf(e))
    return 0
  }
}

/**
 * Whether the P4b wire — bounded empirical calibration of decision-window nudge confidence in
 * predicted-risks-native.ts (calibrateConfidence) — is present in this build. It IS: the nudge
 * generator routes every decision-window confidence through the honest efficacy rate, which reranks
 * the nudges downstream (keyless-answer sorts risks by due then confidence). This const is the
 * single source of truth that gates the honest 'rerank' baseline below — it flips to 'advisory'
 * only if the wire is ever removed, so the metric can never claim consumption without the code.
 */
export const DECISION_WINDOW_CONSUMED = true

/**
 * How the decision-window calibration signal is CONSUMED. Now that P4b (P4, 2026-07) wires the
 * now-honest (P4a) signal into a REAL rerank — decision-window nudge confidence is calibrated by the
 * empirical efficacy rate and that confidence reranks the surfaced nudges — the honest baseline is
 * 'rerank', NOT advisory. Still env-overridable (DUIN_CALIBRATION_CONSUME=gate|rerank|advisory) for
 * ops. Gated on DECISION_WINDOW_CONSUMED so the metric never reports consumption without the wire.
 */
export function calibrationConsumeMode(): CalibrationConsumeMode {
  const v = (process.env.DUIN_CALIBRATION_CONSUME ?? '').toLowerCase()
  if (v === 'gate' || v === 'rerank' || v === 'advisory') return v
  return DECISION_WINDOW_CONSUMED ? 'rerank' : 'advisory'
}

/** Map a live OperatorFact to the pure scorer's minimal CompoundingFact (presence-preserving). */
function toCompoundingFact(f: {
  status: string
  provisionalAt?: number
  observedSessions?: string[]
  efficacy?: unknown
  govern?: unknown
}): CompoundingFact {
  return {
    status: f.status,
    provisionalAt: f.provisionalAt ?? null,
    observedSessions: f.observedSessions ?? null,
    efficacy: f.efficacy,
    govern: f.govern
  }
}

/** backgroundAutonomy setting, best-effort (missing/unreadable settings ⇒ treat as OFF = gated). */
function readBackgroundAutonomy(): boolean {
  try {
    return readSettings().backgroundAutonomy === true
  } catch {
    return false
  }
}

/**
 * Gather deps from live state and compute the Compounding Health report. Read-only w.r.t. every
 * store; a missing source contributes a neutral/zero signal (never throws). Because the grounding
 * flags are process-level env, THIS route reflects the flags the RUNNING app itself was launched
 * with (the launcher sets DUIN_GRAPH_EXPAND_GROUND / DUIN_WHOLENOTE_GROUND / DUIN_RETRIEVER_VERIFY).
 */
export function computeCompoundingHealthLive(vault: string | null): CompoundingHealth {
  const now = new Date()
  const builtAt = now.toISOString()

  // COMPOUNDING facts — the live in-memory operator store (populated at app boot via
  // setOperatorModelPath). getOperatorFacts() = ACTIVE facts (excludes invalidated/superseded),
  // the same base moat-health uses.
  let facts: CompoundingFact[] = []
  try {
    facts = getOperatorFacts().map(toCompoundingFact)
  } catch (e) {
    console.debug('[compounding-health-live] operator store unavailable:', messageOf(e))
  }
  let bindingCount = 0
  try {
    bindingCount = loadBindings(vault).length
  } catch (e) {
    console.debug('[compounding-health-live] binding ledger unavailable:', messageOf(e))
  }

  const metabolism = readMetabolism(vault, now.getTime())

  const deps: CompoundingHealthDeps = {
    builtAt,
    stability: {
      entityCountSeries: readEntityCountSeries(vault),
      currentEntities: readCurrentEntities(vault)
    },
    metabolism,
    compounding: {
      facts,
      bindingCount,
      correctionCount: readCorrectionCount(vault),
      // Gate states so the earn loop's chosen-off sub-signals earn READINESS credit rather than
      // scoring a realization-zero (accept-starvation is a stance, not a failure). Promotion is gated
      // when enact is disabled OR background autonomy is off; the binding drain is human-gated by design.
      promotionGated: !ENACT_ENABLED || readBackgroundAutonomy() !== true,
      bindingGated: true
    },
    grounding: {
      // Always read the RUNTIME helper, never a hand-copied env literal — the polarity has flipped
      // twice (opt-in → default-ON at P1 → back to opt-in on 2026-07-25 after the default-ON path
      // measured −9.0pp recall@5 on the real vault) and a duplicated literal silently desyncs from
      // whatever the app actually runs. graphExpandGroundEnabled() is now `=== '1'` (default OFF).
      graphExpandGround: graphExpandGroundEnabled(),
      // P8 NUANCE (deliberately not corrected here): this credits whole-note's +14pp whenever the FLAG
      // is on, but the P8 private-grounding guard can block whole-note at runtime when the turn's answer
      // model is cloud (see wholeNoteEgressAllowed). Whether it EFFECTIVELY runs depends on per-turn
      // answer-model locality, which this static health snapshot has no clean way to know (no request,
      // no resolved model). Rather than contort the benchmark with a fake answer-model resolution, the
      // flag-level signal is kept and the divergence is documented. Env-level DUIN_WHOLENOTE_ALLOW_CLOUD
      // is NOT folded in either: it only matters for cloud models, which this snapshot can't identify.
      wholeNoteGround: process.env.DUIN_WHOLENOTE_GROUND === '1',
      calibrationMode: calibrationConsumeMode(),
      citationVerifyActive: process.env.DUIN_RETRIEVER_VERIFY !== '0',
      decisionWindowObs: readDecisionWindowObs(vault)
    }
  }

  return computeCompoundingHealth(deps)
}
