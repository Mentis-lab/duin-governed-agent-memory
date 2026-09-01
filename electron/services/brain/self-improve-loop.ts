// self-improve-loop.ts — apply / rollback / adjudicate for DUIN's engine self-improvement.
//
// A change edits a .duin config the brain reads; apply is a snapshot-based, byte-exact
// reversible write (durable). The verdict is DEFERRED: at each tick we compare the target
// engine's fitness on the post-apply window against an EQUAL-DURATION pre-apply window (a
// like-for-like A/B — same n scale, so the small-sample wilson_lo bias cancels), and only
// once the target engine is mature (n>=CAL_MIN_N) in BOTH windows. Keep if no engine regressed;
// otherwise roll back and demote the change class. The resolution delay + maturity gate ARE
// the held-out — a change can only be judged on outcomes it could not have overfit.
import { existsSync, readFileSync } from 'fs'
import { atomicWriteDurable } from './durable-write'
import { isConfinedToDuin } from './rsi-confinement'
import { recordAction, closeAction } from '../ans/action-ledger'
import { RSI_APPLY_CAP_ID } from '../ans/capability-ledger'
import { messageOf } from '../guarded'
import { readFitnessVector, gateVector, gradePrediction, gradeForecastError, type FitnessVerdict } from './self-improve-fitness'
import { loadInflight, upsertInflight, recordVerdict, type InflightChange } from './self-improve-registry'
import { recordRsiForecast } from './rsi-forecast-store'
import { CAL_MIN_N } from './calibration-resolve-native'
import {
  registerPromotionPrediction,
  readPromotionPredictions,
  replaySet,
  backwardRetentionGate
} from './promotion-retention'

/** The actionKind the undo ledger files an RSI apply under. FIXED, not derived from the target path:
 *  classifyAction is a first-match-wins pattern table, so a path-derived kind would silently
 *  re-classify to Tier-C the day a change targets (say) a `.duin/config.json` — recordAction would
 *  throw, and the write would land with no undo record. The file identity is not lost: it travels in
 *  the record's inverseSpec.path. Verified B/grad ('edit' → file-edit) by the wiring test. */
const RSI_UNDO_ACTION_KIND = 'edit an RSI tunable file'

/** How long an applied change may sit unmeasurable before it is rolled back unheard.
 *  Sized against the observation substrate, not the code: the recall-efficacy ledger
 *  accrues well under one graded turn a day, so an engine that has produced nothing in
 *  two weeks is not slow, it is silent — usually because its kind is never staged at all.
 *  Waiting longer does not buy evidence, it just holds a knob hostage. */
const MATURITY_HORIZON_MS = 14 * 24 * 60 * 60_000

/** Apply a proposed change: snapshot the current bytes (for rollback), write the new bytes,
 *  stamp appliedAt (the held-out cut point). Reversible by construction.
 *
 *  Item 24 — this is DUIN's only autonomous graduated file-write, so it is also the producer the
 *  safe-undo ledger was built for: before the write we file a revertable record (prior content +
 *  inverse spec) so `POST /state/undo` has something to undo and a human undo demotes the capability.
 *  CLOSED 2026-08-03: rollbackChange now calls closeAction(actionId, 'auto-rollback'), the
 *  revert-without-demote path this note said the ledger did not expose. An auto-reverted change is
 *  no longer a live /state/undo target, so the second-undo-fires-a-spurious-demote path is gone. */
export function applyChange(vault: string, rec: InflightChange, nowISO: string): InflightChange {
  // Re-verify confinement AT THE FORWARD WRITE SINK, symmetric with rollbackChange's guard below.
  // proposeChange checks isConfinedToDuin before staging, but the inflight ledger is an
  // unauthenticated append-only file — a row planted by anything that can write it (a synced
  // vault, a prompt-injected file write, any local process on the control plane) carries an
  // attacker-chosen targetPath + afterBytes straight into this durable write. Both callers reach
  // the write through here — the tier-'auto' auto-apply path (rsi-proposer) AND the operator
  // ratify path (ratifyProposed) — so guarding the sink covers both with one owner. A row whose
  // target escapes <vault>/.duin/ is quarantined (marked rolled-back so it is never re-applied or
  // re-adjudicated) WITHOUT writing anything to disk; callers inspect the returned status.
  if (!isConfinedToDuin(vault, rec.targetPath)) {
    console.warn(`[self-improve] apply refused: targetPath escapes ${vault}/.duin/: ${rec.targetPath}`)
    const quarantined: InflightChange = { ...rec, status: 'rolled-back' }
    upsertInflight(vault, quarantined)
    return quarantined
  }
  const beforeBytes = existsSync(rec.targetPath) ? readFileSync(rec.targetPath, 'utf-8') : ''
  // Best-effort: the undo record is an affordance, never a precondition. captureSnapshot throws
  // until main-process boot has run setActionLedgerPath, and a ledger fault must not cost the loop
  // its write (see self-improve-undo-failsafe.test.ts).
  let actionId: string | undefined
  try {
    actionId = recordAction({
      actionKind: RSI_UNDO_ACTION_KIND,
      capabilityId: RSI_APPLY_CAP_ID,
      inverseSpec: { kind: 'restore-file', path: rec.targetPath },
      // null (not '') when the file did not exist — the honest inverse of a first write is DELETE,
      // whereas '' would restore an empty tunables file the brain would then read as "no keys set".
      priorContent: existsSync(rec.targetPath) ? beforeBytes : null
    }).id
  } catch (e) {
    console.debug('[self-improve] undo record unavailable  applying anyway:', messageOf(e))
  }
  atomicWriteDurable(rec.targetPath, rec.afterBytes)
  const applied: InflightChange = { ...rec, beforeBytes, status: 'applied', appliedAt: nowISO, actionId }
  upsertInflight(vault, applied)
  return applied
}

const asPlainObject = (s: string): Record<string, unknown> | null => {
  if (s === '') return {} // an absent file means "no keys set" (readers fall back to defaults)
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Reverse ONLY the keys this change edited (before→after), applied on top of the CURRENT on-disk
 *  object — not the whole-file snapshot. Returns the merged bytes, or null when current/before/after
 *  aren't all JSON objects (the caller then falls back to the whole-file restore). */
function scopedReverseBytes(current: string, rec: InflightChange): string | null {
  const cur = asPlainObject(current)
  const before = asPlainObject(rec.beforeBytes)
  const after = asPlainObject(rec.afterBytes)
  if (!cur || !before || !after) return null
  const out: Record<string, unknown> = { ...cur }
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue // this change never touched k
    if (k in before) out[k] = before[k] // restore this change's prior value for k
    else delete out[k] // k was introduced by this change → remove it
  }
  return JSON.stringify(out, null, 2) + '\n'
}

/** Restore the pre-change bytes. Byte-exact whole-file when this change is the last edit standing on
 *  the file; scoped per-key when a concurrent SIBLING has since written the same file. */
export function rollbackChange(vault: string, rec: InflightChange): InflightChange {
  // Re-verify confinement AT THE WRITE SINK — not just at propose time. proposeChange checks
  // isConfinedToDuin before staging, but the inflight ledger is an unauthenticated append-only
  // file: a row planted by anything that can write it (a synced vault, a prompt-injected file
  // write, any local process on the control plane) carries an attacker-chosen targetPath +
  // beforeBytes straight into this durable write on the next tick's rollback. Guarding only the
  // producer left this sibling sink open. A row that escapes <vault>/.duin/ is quarantined
  // (marked rolled-back so it is never re-adjudicated) WITHOUT writing anything to disk.
  if (!isConfinedToDuin(vault, rec.targetPath)) {
    console.warn(`[self-improve] rollback refused: targetPath escapes ${vault}/.duin/: ${rec.targetPath}`)
    const quarantined: InflightChange = { ...rec, status: 'rolled-back' }
    upsertInflight(vault, quarantined)
    return quarantined
  }
  // beforeBytes is a WHOLE-FILE snapshot taken at apply time. When two changes on DISTINCT engines
  // but the SAME targetPath are in-flight at once — which the RSI population deliberately allows
  // (rsi-proposer RSI_KNOBS: namedSkillTopK + recallFailureLimit both live in one rsi-tunables.json,
  // and the one-in-flight guard is per-engine, not per-path) — the later change's snapshot baked in
  // the earlier change's still-live value. Blindly writing that whole snapshot back on rollback
  // would clobber the sibling's applied key (and resurrect this change's own already-rolled-back key
  // on a later sibling rollback), breaking the "every change is byte-reversible" invariant per-change.
  // Detect the concurrent case by checking whether the file still equals THIS change's afterBytes:
  //   • unchanged since we applied ⇒ we are the last/only edit ⇒ byte-exact whole-file restore;
  //   • a sibling has rewritten it ⇒ reverse ONLY the keys this change edited, preserving the sibling.
  const current = existsSync(rec.targetPath) ? readFileSync(rec.targetPath, 'utf-8') : ''
  const restored = current === rec.afterBytes ? rec.beforeBytes : (scopedReverseBytes(current, rec) ?? rec.beforeBytes)
  atomicWriteDurable(rec.targetPath, restored)
  // The inverse has now been dispatched by US, so the undo record applyChange filed is spent.
  // Close it WITHOUT a demote: nobody objected, the machine took its own change back. Leaving it
  // 'applied' (the behaviour until 2026-08-03) left a spent record as a live /state/undo target,
  // where a later bare undo re-restored already-restored bytes AND fired recordFeedback('revert'),
  // tightening autonomy on the strength of a human objection that never happened.
  // Best-effort for the same reason the recordAction call is: a ledger fault must not cost the
  // rollback its write, and the write above has already landed.
  if (rec.actionId) {
    try {
      closeAction(rec.actionId, 'auto-rollback')
    } catch (e) {
      console.debug('[self-improve] could not close undo record after rollback:', messageOf(e))
    }
  }
  const rolled: InflightChange = { ...rec, status: 'rolled-back' }
  upsertInflight(vault, rolled)
  return rolled
}

export interface RatifyOutcome {
  ok: boolean
  reason: string
  change?: InflightChange
}

/** Apply a STAGED (proposed) change on the operator's say-so (W2 ratify path). The rollback
 *  snapshot is taken NOW, at apply time, so a ratified change is byte-reversible exactly like an
 *  auto-applied one — and from here it enters the same held-out A/B adjudication, so verdicts
 *  (and the GRADUATE_N autonomy ratchet) accrue through the human gate. */
export function ratifyProposed(vault: string, id: string, nowISO: string): RatifyOutcome {
  const rec = loadInflight(vault).find((c) => c.id === id)
  if (!rec) return { ok: false, reason: `no in-flight change '${id}'` }
  if (rec.status !== 'proposed') return { ok: false, reason: `change '${id}' is '${rec.status}', not 'proposed'` }
  const applied = applyChange(vault, rec, nowISO)
  // applyChange quarantines (status 'rolled-back', nothing written) a row whose target escapes
  // the confinement root. Do not claim a successful ratify for one — the operator pressed
  // ratify on a planted target, and nothing was applied.
  if (applied.status !== 'applied') {
    return { ok: false, reason: `refused: targetPath escapes ${vault}/.duin/ — nothing applied`, change: applied }
  }
  return { ok: true, reason: 'ratified + applied (byte-reversible; awaiting held-out A/B)', change: applied }
}

/** Decline a STAGED change without applying anything. Terminal 'dismissed': frees the engine's
 *  in-flight slot, and the QD archive treats the value as a dead end so the proposer never asks
 *  the same question twice (patient, not nagging). Nothing was applied, so there is nothing to
 *  roll back and no fitness verdict to record. */
export function dismissProposed(vault: string, id: string): RatifyOutcome {
  const rec = loadInflight(vault).find((c) => c.id === id)
  if (!rec) return { ok: false, reason: `no in-flight change '${id}'` }
  if (rec.status !== 'proposed') return { ok: false, reason: `change '${id}' is '${rec.status}', not 'proposed'` }
  const dismissed: InflightChange = { ...rec, status: 'dismissed' }
  upsertInflight(vault, dismissed)
  return { ok: true, reason: 'dismissed (parked; this value will not be re-proposed)', change: dismissed }
}

export interface Adjudication {
  id: string
  engine: string
  changeClass: string
  outcome: 'kept' | 'rolled-back' | 'maturing'
  observedN: number
  verdict?: FitnessVerdict
}
export interface AdjudicationReport {
  adjudicated: Adjudication[]
}

/** Advance every applied-but-undecided change through its verdict. Pure of clocks except the
 *  injected `now`, so it's deterministic under test. Best-effort per record — a bad row must
 *  not stop the others. */
export function adjudicateInflight(vault: string, now: Date): AdjudicationReport {
  const adjudicated: Adjudication[] = []
  for (const rec of loadInflight(vault)) {
    if (rec.status !== 'applied' || !rec.appliedAt) continue
    try {
      const appliedMs = new Date(rec.appliedAt).getTime()
      const elapsedMs = Math.max(now.getTime() - appliedMs, 0)
      const sinceDate = rec.appliedAt.slice(0, 10)
      const beforeStart = new Date(appliedMs - elapsedMs).toISOString().slice(0, 10)
      const after = readFitnessVector(vault, sinceDate) // [appliedAt, now]
      const before = readFitnessVector(vault, beforeStart, sinceDate) // equal-duration pre-window
      const aT = after.find((e) => e.engine === rec.engine)
      const bT = before.find((e) => e.engine === rec.engine)
      const observedN = aT?.n ?? 0
      // Only a like-for-like A/B counts: the target engine must be mature in BOTH windows.
      if (!aT || aT.gated || !bT || bT.gated) {
        // ...but `maturing` had no exit. A change aimed at an engine that never receives an
        // observation (its kind is never staged, so the engine name never even appears) stayed
        // applied forever, and the one-inflight-per-engine guard then froze that knob for good —
        // leaving an unvalidated value live with no path back. Past the horizon, treat silence as
        // failure and roll back: an unmeasurable change is not an accepted one.
        if (elapsedMs > MATURITY_HORIZON_MS) {
          rollbackChange(vault, rec)
          adjudicated.push({
            id: rec.id,
            engine: rec.engine,
            changeClass: rec.changeClass,
            outcome: 'rolled-back',
            observedN
          })
          continue
        }
        adjudicated.push({ id: rec.id, engine: rec.engine, changeClass: rec.changeClass, outcome: 'maturing', observedN })
        continue
      }
      const verdict = gateVector(before, after)
      // Grade the per-change improvement contract (AHE): did the target engine actually rise by
      // >= minDelta? Stricter than the keep-gate — tracked even for kept-but-flat changes.
      const predictionHeld = gradePrediction(before, after, rec.engine, rec.prediction?.minDelta) ?? undefined

      // CALIBRATED-FORECAST accrual (rsi-forecast domain): grade the ex-ante MAGNITUDE forecast's error
      // against the same mature held-out A/B and record hit/wrong, so the proposer learns which knob
      // cells it MODELS well (not just which lift). Guarded by the maturity gate above (aT/bT ungated →
      // scores non-null). Best-effort: a ledger write must never stall the self-improve loop.
      try {
        const pd = rec.prediction?.predictedDelta
        if (typeof pd === 'number') {
          const graded = gradeForecastError(before, after, rec.engine, pd)
          if (graded) {
            const cfg = JSON.parse(rec.afterBytes) as Record<string, unknown>
            recordRsiForecast(vault, {
              id: rec.id,
              engine: rec.engine,
              topK: typeof cfg.namedSkillTopK === 'number' ? cfg.namedSkillTopK : -1,
              failLimit: typeof cfg.recallFailureLimit === 'number' ? cfg.recallFailureLimit : -1,
              predictedDelta: pd,
              actualDelta: (aT.score as number) - (bT.score as number),
              hit: graded.hit,
              resolved: now.toISOString(),
            })
          }
        }
      } catch {
        /* forecast accrual is upkeep — never break the loop */
      }

      // BACKWARD-RETENTION GATE (SIP-Bench). A forward pass on THIS engine is not an
      // improvement if it regressed an engine an earlier PASSED promotion was validated
      // at. Replay the prior passed promotions against the current fitness vector; a
      // regression turns a would-be keep into a rollback. Best-effort + empty-ledger-
      // safe: with no prior promotions the replay set is empty → retained → keep exactly
      // as before (zero regression on a fresh brain).
      let retentionBlocked = false
      try {
        const replay = replaySet(readPromotionPredictions(vault))
        if (verdict.pass && replay.length) {
          const scoreOf = (eng: string): number | null => after.find((e) => e.engine === eng)?.score ?? null
          retentionBlocked = !backwardRetentionGate(replay, scoreOf).retained
        }
      } catch {
        /* retention read/parse failure must not stall the loop — treat as no block */
      }

      const kept = verdict.pass && !retentionBlocked
      if (kept) {
        upsertInflight(vault, { ...rec, status: 'kept', resolvedVerdict: verdict, observedN, predictionHeld })
        recordVerdict(vault, rec.changeClass, true, now.toISOString())
        adjudicated.push({ id: rec.id, engine: rec.engine, changeClass: rec.changeClass, outcome: 'kept', observedN, verdict })
      } else {
        rollbackChange(vault, { ...rec, resolvedVerdict: verdict, observedN, predictionHeld })
        recordVerdict(vault, rec.changeClass, false, now.toISOString())
        adjudicated.push({ id: rec.id, engine: rec.engine, changeClass: rec.changeClass, outcome: 'rolled-back', observedN, verdict })
      }

      // WRITER: register the resolved promotion into the (previously dark) ledger, so
      // calRowsPromotion has evidence AND future adjudications can gate on backward
      // retention. Best-effort — a ledger write must never break the self-improve loop.
      try {
        registerPromotionPrediction(vault, {
          id: rec.id,
          engine: rec.engine,
          expected_behavior: `${rec.changeClass} keeps ${rec.engine} fitness`,
          trigger_signature: { changeClass: rec.changeClass, targetPath: rec.targetPath },
          verdict: kept ? 'passed' : 'failed',
          passed_at_fitness: aT.score ?? null,
          created: now.toISOString(),
          landed_in: rec.targetPath,
          eval_after: { by: now.toISOString() }
        })
      } catch {
        /* ledger write is best-effort */
      }
    } catch {
      /* a single bad record must not stall the loop */
    }
  }
  return { adjudicated }
}
