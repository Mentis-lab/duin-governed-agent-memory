// self-improve-tick.ts — periodic adjudication of in-flight self-improvement changes on the
// app clock, mirroring calibration-tick / claim-metabolism-tick. DOUBLE-GATED: a hard no-op
// (zero background work) unless the operator has turned on backgroundAutonomy, and disableable
// via DUIN_RSI_TICK_MS=0. adjudicateInflight is idempotent + best-effort, so a tick over an
// empty ledger is a cheap no-op.
import { readSettings } from '../settings-helper'
import { adjudicateInflight } from './self-improve-loop'
import { proposeNextRsiKnob } from './rsi-proposer'
import { readRsiTunables } from './rsi-tunables'
import { recordNotice } from '../proactive/notices-store'
import type { InflightChange } from './self-improve-registry'

const TICK_MS = (() => {
  const raw = Number(process.env.DUIN_RSI_TICK_MS)
  return Number.isFinite(raw) && raw >= 0 ? raw : 15 * 60_000
})()
const INITIAL_MS = 60_000 // stagger after calibration (30s) and claim-metabolism (45s)

let timer: ReturnType<typeof setInterval> | null = null
let initial: ReturnType<typeof setTimeout> | null = null

/** Operator gate: self-improvement adjudication runs only when backgroundAutonomy is explicitly
 *  on. Checked per-tick so a live toggle takes effect without a restart. */
function autonomyOn(): boolean {
  try {
    return readSettings().backgroundAutonomy === true
  } catch {
    return false
  }
}

/** Adjudicate once for the current vault. Best-effort: never throws — a bad vault dir or IO
 *  error must not crash the tick. Exposed for tests. */
export function selfImproveTick(getVaultDir: () => string | null): void {
  if (!autonomyOn()) return
  let dir: string | null
  try {
    dir = getVaultDir()
  } catch {
    return // a throwing settings read must not crash the tick
  }
  if (!dir) return
  try {
    // Producer THEN adjudicator: stage the next safe knob proposal if the engine is free (the
    // rsi-proposer half that was missing), then adjudicate any applied-but-undecided change on
    // its held-out A/B. Both gated by autonomyOn above; both byte-reversible + fitness-gated.
    proposeNextRsiKnob(dir, new Date().toISOString())
    adjudicateInflight(dir, new Date())
  } catch (e) {
    console.warn('[self-improve-tick] pass failed (non-fatal):', (e as Error)?.message)
  }
}

// ── ENGAGE-TIME advance (W2, posture directive 2026-08-21; split-gate 2026-08-22) ──────────
// The loop moves when the operator is present — a chat turn just ended — never on the wall
// clock. SPLIT GATE (operator R3 decision): STAGING runs on presence alone — the proposer
// stages a change and a Needs-you card asks — because "presence" (a completed turn, which can
// be a bridge/channel turn, not necessarily the operator watching) is enough to ASK but not to
// WRITE. An autonomous APPLY at earned 'auto' tier additionally requires the backgroundAutonomy
// master switch: with it off, a graduated class STAGES instead of applying (the operator can
// ratify it once, or turn on backgroundAutonomy to let earned classes self-apply). Debounced so
// a burst of turns pays one pass.

const ENGAGE_DEBOUNCE_MS = 30 * 60_000
let lastEngageMs = 0

/** Test seam. */
export function __resetEngageDebounce(): void {
  lastEngageMs = 0
}

/** One honest line for the card: which key would change, from what, to what. For a STAGED
 *  change the "from" is the live tunables (nothing was written); for an applied one it is
 *  the change's own pre-apply snapshot. Exported for the rsi:pending IPC (same wording on
 *  the card and in the panel — one description, not two drifting ones). */
export function describeRsiChange(vault: string, c: InflightChange): string {
  try {
    const before: Record<string, unknown> =
      c.status === 'proposed'
        ? (readRsiTunables(vault) as unknown as Record<string, unknown>)
        : ((): Record<string, unknown> => {
            try { return JSON.parse(c.beforeBytes || '{}') as Record<string, unknown> } catch { return {} }
          })()
    const after = JSON.parse(c.afterBytes) as Record<string, unknown>
    const parts: string[] = []
    for (const k of Object.keys(after)) {
      if (JSON.stringify(after[k]) === JSON.stringify(before[k])) continue
      parts.push(`${k}: ${k in before ? String(before[k]) : 'default'} → ${String(after[k])}`)
    }
    return parts.join(', ') || 'no visible diff'
  } catch {
    return 'unreadable proposal'
  }
}

/** Advance the self-improve loop at engage time: stage/apply the next knob per its EARNED tier,
 *  tell the operator honestly either way, then adjudicate any matured A/B. Best-effort. */
export function selfImproveEngageTick(getVaultDir: () => string | null, nowMs: number = Date.now()): void {
  if (nowMs - lastEngageMs < ENGAGE_DEBOUNCE_MS) return
  let dir: string | null
  try {
    dir = getVaultDir()
  } catch {
    return
  }
  if (!dir) return
  lastEngageMs = nowMs
  try {
    // Split gate: earned-tier auto-apply only when backgroundAutonomy is on; else stage a card.
    const r = proposeNextRsiKnob(dir, new Date(nowMs).toISOString(), { applyEarnedTier: autonomyOn() })
    if (r?.staged && r.change) {
      const c = r.change
      const staged = c.status === 'proposed'
      recordNotice({
        kind: 'approval',
        severity: 'info',
        // Staged → a decision the operator owes; applied at earned 'auto' → an FYI, never a chore.
        needsDecision: staged,
        title: staged ? 'DUIN proposes a self-tune — your call' : 'Self-tune applied (earned autonomy)',
        body: describeRsiChange(dir, c),
        actionId: c.id,
        dedupKey: `rsi:${c.changeClass}`,
        deepLink: 'duin://tool/homeStatus',
        now: nowMs
      })
    }
    adjudicateInflight(dir, new Date(nowMs))
  } catch (e) {
    console.warn('[self-improve-engage] pass failed (non-fatal):', (e as Error)?.message)
  }
}

export function startSelfImproveTick(getVaultDir: () => string | null): void {
  if (timer || TICK_MS === 0) return
  initial = setTimeout(() => selfImproveTick(getVaultDir), INITIAL_MS)
  timer = setInterval(() => selfImproveTick(getVaultDir), TICK_MS)
}

export function stopSelfImproveTick(): void {
  if (initial) {
    clearTimeout(initial)
    initial = null
  }
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
