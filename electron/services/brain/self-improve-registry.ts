// self-improve-registry.ts — the deferred-verdict + earned-autonomy state for the
// self-improvement loop. Two append-only jsonl ledgers under <vault>/.duin/_state/, written
// crash-safe via durable-write. Records mutate by re-append; readers dedup keeping the last.
//
// This is the piece the existing evolution machinery lacked: a change is APPLIED, its verdict
// is DEFERRED until its target engine's outcomes resolve, and each change CLASS earns autonomy
// (propose -> auto) only by accumulating positive verdicts — a rollback demotes it. That ratchet
// is what makes taking the loop live safe.
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { durableAppend } from './durable-write'
import type { EngineFitness, FitnessVerdict } from './self-improve-fitness'

const stateDir = (vault: string): string => join(vault, '.duin', '_state')
const inflightPath = (vault: string): string => join(stateDir(vault), 'self-improve-inflight.jsonl')
const autonomyPath = (vault: string): string => join(stateDir(vault), 'self-improve-autonomy.jsonl')

/** consecutive kept verdicts a change class needs to graduate propose -> auto */
export const GRADUATE_N: number = (() => {
  const raw = Number(process.env.DUIN_RSI_GRADUATE_N)
  return Number.isInteger(raw) && raw > 0 ? raw : 3
})()

/** 'dismissed' (W2, posture 2026-08-21) = the operator declined a STAGED proposal. Terminal like
 *  'rolled-back' — the QD archive treats it as a dead end so the same value is never re-asked —
 *  but distinct, because nothing was ever applied and no fitness verdict exists. */
export type ChangeStatus = 'proposed' | 'applied' | 'kept' | 'rolled-back' | 'dismissed'

export interface InflightChange {
  /** stable hash of (changeClass, targetPath, afterBytes) */
  id: string
  /** the autonomy-graduation bucket, e.g. 'loop-schedule' | 'kind-weight' | 'named-skill' */
  changeClass: string
  /** the fitness engine this change targets — drives maturity + the one-in-flight-per-engine rule */
  engine: string
  /** the .duin config the brain reads that this change edits */
  targetPath: string
  beforeBytes: string
  afterBytes: string
  proposedAt: string
  status: ChangeStatus
  appliedAt?: string
  /** The ans/action-ledger ActionRecord id filed by applyChange, when one could be filed. It is the
   *  ONLY link between the two ledgers — without it an automatic rollback cannot close the undo
   *  record it created, and the record stays a live `/state/undo` target after the change is gone.
   *  Optional because recordAction is best-effort: it throws before main-process boot has run
   *  setActionLedgerPath, and a ledger fault must never cost the loop its write. */
  actionId?: string
  /** filled at adjudication once the target engine matured on the held-out window */
  resolvedVerdict?: FitnessVerdict
  observedN?: number
  baseline?: EngineFitness[]
  /** Per-change falsifiable IMPROVEMENT contract (AHE): the ex-ante claim registered at propose time.
   *  `minDelta` is the DIRECTIONAL threshold (kept-vs-improved); `predictedDelta` is the ex-ante
   *  MAGNITUDE forecast whose error is graded into the rsi-forecast calibration domain. */
  prediction?: { engine: string; claim: string; minDelta: number; predictedDelta: number; predictedAt: string }
  /** Graded at adjudication: did the target engine actually improve by >= prediction.minDelta? This is
   *  STRICTER than `status:'kept'` (no-regression), so a change can be kept yet predictionHeld=false. */
  predictionHeld?: boolean
}

export interface AutonomyState {
  changeClass: string
  tier: 'propose' | 'auto'
  keptStreak: number
  rollbacks: number
  updatedAt: string
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const s = line.trim()
    if (!s) continue
    try {
      out.push(JSON.parse(s) as T)
    } catch {
      /* skip malformed */
    }
  }
  return out
}

/** All in-flight changes, deduped by id keeping the latest (status mutations are re-appends). */
export function loadInflight(vault: string): InflightChange[] {
  const m = new Map<string, InflightChange>()
  for (const r of readJsonl<InflightChange>(inflightPath(vault))) m.set(r.id, r)
  return [...m.values()]
}

export function upsertInflight(vault: string, rec: InflightChange): void {
  durableAppend(inflightPath(vault), JSON.stringify(rec) + '\n')
}

/** Undecided changes touching a given engine — used to enforce ONE in-flight change per engine
 *  at a time, without which the global fitness signal can't be attributed to a single change. */
export function inflightForEngine(vault: string, engine: string): InflightChange[] {
  return loadInflight(vault).filter((c) => c.engine === engine && (c.status === 'proposed' || c.status === 'applied'))
}

export function loadAutonomy(vault: string): Map<string, AutonomyState> {
  const m = new Map<string, AutonomyState>()
  for (const r of readJsonl<AutonomyState>(autonomyPath(vault))) m.set(r.changeClass, r)
  return m
}

export function tierFor(vault: string, changeClass: string): 'propose' | 'auto' {
  return loadAutonomy(vault).get(changeClass)?.tier ?? 'propose'
}

/** The earned-autonomy ratchet: a kept verdict advances the streak (graduating to 'auto' at
 *  GRADUATE_N); ANY rollback resets the streak and demotes the class back to 'propose'. */
export function recordVerdict(vault: string, changeClass: string, kept: boolean, nowISO: string): AutonomyState {
  const cur = loadAutonomy(vault).get(changeClass) ?? {
    changeClass,
    tier: 'propose' as const,
    keptStreak: 0,
    rollbacks: 0,
    updatedAt: nowISO,
  }
  const next: AutonomyState = kept
    ? {
        ...cur,
        keptStreak: cur.keptStreak + 1,
        tier: cur.keptStreak + 1 >= GRADUATE_N ? 'auto' : cur.tier,
        updatedAt: nowISO,
      }
    : { ...cur, keptStreak: 0, rollbacks: cur.rollbacks + 1, tier: 'propose', updatedAt: nowISO }
  durableAppend(autonomyPath(vault), JSON.stringify(next) + '\n')
  return next
}
