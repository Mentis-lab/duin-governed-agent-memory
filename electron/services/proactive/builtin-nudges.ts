// builtin-nudges — the concrete two-way nudges wired to real internal triggers (#4).
//
// Where nudges.ts is the mechanism, this is the POLICY: which real signals earn a
// two-way prompt, and what the "yes" follow-up does. First built-in:
//
//   • UNRESOLVED-FORECASTS nudge (from the resolution loop / calibration tick). When
//     N forecasts are due for a verdict, DUIN asks "N forecasts due — want the digest?
//     reply Y". A Y reply delivers the morning brief (deliverDigest). Anything else is
//     acknowledged and drives nothing.
//
// All of it is DEFAULT-OFF and FAIL-CLOSED, matching the watch/notify posture:
//   • Env opt-in (DUIN_PROACTIVE_NUDGES truthy) — a fresh install nudges nothing.
//   • Requires a configured operator AND a two-way home channel (an OS push the
//     operator can't reply to is useless for a nudge).
//   • Threshold-gated so a single due forecast doesn't nag.
// Any missing condition → no nudge. Never throws (best-effort post-step).

import type { CalibrationReport } from '../brain/types'
import type { HomeDigest } from '../brain/home-digest'
import type { ChannelRef } from '../channel-dispatch'
import type { OperatorIdentity } from './approval-roundtrip'
import { sendNudge, type SendNudgeResult, type NudgeReplyContext } from './nudges'
import {
  countDueForecasts,
  deliverDigest,
  type DeliverDigestResult,
  type DigestMode
} from './smart-digest'
import { readApprovalConfig } from './approval-roundtrip'
import { messageOf } from '../guarded'

/** OS-push kinds an operator cannot reply to (so a nudge to them is pointless). */
const PUSH_KINDS = new Set(['push', 'os', 'notification', 'notify'])

/** Default minimum due forecasts before the nudge fires (avoid single-item nag). */
export const DEFAULT_FORECAST_NUDGE_THRESHOLD = 3

/** Default coalesce window for the forecast-due nudge: 6h. `nudgeFromCalibration`
 *  runs on EVERY calibration tick (~15 min), and a due-forecast backlog is a LEVEL
 *  condition that persists across many ticks — without coalescing the operator would
 *  be re-nudged every tick for the same backlog. This window collapses that into at
 *  most one nudge per operator per window. Chosen well above the tick cadence so it
 *  is actually effective (the watchers' default 5-min debounce is shorter than the
 *  tick and does not protect a level condition). Override via
 *  DUIN_FORECAST_NUDGE_DEBOUNCE_MS. */
export const DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS = 6 * 60 * 60_000

// ──────────────────── coalesce memory (in-process) ────────────────────

/** Last time a forecast-due nudge was emitted, keyed per operator identity. In-process
 *  only (a fresh process re-nudges once, which is fine — the fail-safe direction). */
const lastForecastNudge = new Map<string, number>()

/** Test/introspection: clear the forecast-nudge coalesce memory. */
export function __resetForecastNudgeDebounce(): void {
  lastForecastNudge.clear()
}

function forecastNudgeKey(op: OperatorIdentity): string {
  return `${op.channelId} ${op.userId}`
}

/** True if a forecast-due nudge for `op` was emitted within `windowMs` before `now`. */
function forecastNudgeDebounced(op: OperatorIdentity, now: number, windowMs: number): boolean {
  const prev = lastForecastNudge.get(forecastNudgeKey(op))
  return prev !== undefined && now - prev < windowMs
}
function markForecastNudge(op: OperatorIdentity, now: number): void {
  lastForecastNudge.set(forecastNudgeKey(op), now)
  // Bound the map: a rare full clear is fine (worst case one extra nudge later).
  if (lastForecastNudge.size > 512) lastForecastNudge.clear()
}

// ──────────────────── pure gate ────────────────────

export interface ForecastNudgeGateInput {
  enabled: boolean
  dueCount: number
  threshold: number
  operator: OperatorIdentity | null
  homeChannelKind: string
}

/** Should the unresolved-forecasts nudge fire? True ONLY when enabled, an operator is
 *  configured, the home channel is two-way, and the due count meets the threshold. PURE. */
export function shouldFireForecastNudge(input: ForecastNudgeGateInput): boolean {
  if (!input.enabled) return false
  if (input.dueCount < Math.max(1, input.threshold)) return false
  if (!input.operator || !input.operator.channelId || !input.operator.userId) return false
  const kind = String(input.homeChannelKind ?? '').trim().toLowerCase()
  if (!kind || PUSH_KINDS.has(kind)) return false
  return true
}

// ──────────────────── config reader ────────────────────

export interface NudgeConfig {
  enabled: boolean
  operator: OperatorIdentity | null
  homeChannel: ChannelRef
  threshold: number
  /** Coalesce window for the forecast-due nudge (ms). Falls back to
   *  DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS when unset / non-positive. */
  debounceMs?: number
}

/** Read the nudge posture from env + persisted settings. Reuses the approval config
 *  reader for operator + home channel (the SAME operator designation gates both), and
 *  adds the DUIN_PROACTIVE_NUDGES env opt-in. Tolerant of a missing settings file. */
export function readNudgeConfig(env: NodeJS.ProcessEnv = process.env): NudgeConfig {
  let operator: OperatorIdentity | null = null
  let homeChannel: ChannelRef = { kind: 'push', target: '' }
  try {
    const c = readApprovalConfig(env)
    operator = c.operator
    homeChannel = c.homeChannel
  } catch {
    // leave fail-closed defaults
  }
  const flag = String(env.DUIN_PROACTIVE_NUDGES ?? '').trim().toLowerCase()
  const enabled = flag === '1' || flag === 'true' || flag === 'on' || flag === 'yes'
  const rawThresh = Number(env.DUIN_FORECAST_NUDGE_THRESHOLD)
  const threshold = Number.isFinite(rawThresh) && rawThresh >= 1 ? Math.floor(rawThresh) : DEFAULT_FORECAST_NUDGE_THRESHOLD
  const rawDebounce = Number(env.DUIN_FORECAST_NUDGE_DEBOUNCE_MS)
  const debounceMs = Number.isFinite(rawDebounce) && rawDebounce > 0 ? Math.floor(rawDebounce) : DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS
  return { enabled, operator, homeChannel, threshold, debounceMs }
}

// ──────────────────── the forecast nudge ────────────────────

export interface ForecastNudgeDeps {
  config: NudgeConfig
  /** Live Home digest reader (for the follow-up digest delivery). */
  getDigest: () => HomeDigest
  /** Live calibration reader (for the follow-up digest delivery). */
  getCalibration: () => CalibrationReport
  /** Override sendNudge (tests). */
  sendNudge?: typeof sendNudge
  /** Override the digest delivery (tests). */
  deliverDigest?: (mode: DigestMode, deps: Parameters<typeof deliverDigest>[1]) => Promise<DeliverDigestResult>
  now?: number
  today?: string
}

export interface ForecastNudgeResult {
  nudged: boolean
  skipped?: 'gate' | 'error' | string
  interactionId?: string
}

/**
 * Fire the unresolved-forecasts nudge if the gate passes. `dueCount` is the number of
 * forecasts due for a verdict (from countDueForecasts). On a Y reply the follow-up
 * delivers the morning brief. Best-effort — never throws.
 */
export async function fireForecastNudge(
  dueCount: number,
  deps: ForecastNudgeDeps
): Promise<ForecastNudgeResult> {
  try {
    const { config } = deps
    const ok = shouldFireForecastNudge({
      enabled: config.enabled,
      dueCount,
      threshold: config.threshold,
      operator: config.operator,
      homeChannelKind: config.homeChannel.kind
    })
    if (!ok) return { nudged: false, skipped: 'gate' }

    // COALESCE: the gate passed, but a due-forecast backlog persists across many
    // calibration ticks. Suppress a repeat nudge for the same operator inside the
    // window so an enabled nudge can't spam every tick. `operator` is non-null here
    // (the gate above already verified it). Marked BEFORE the (awaited) send so a
    // concurrent tick can't slip a second nudge through the await.
    const now = deps.now ?? Date.now()
    const op = config.operator as OperatorIdentity
    const windowMs =
      config.debounceMs && config.debounceMs > 0 ? config.debounceMs : DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS
    if (forecastNudgeDebounced(op, now, windowMs)) return { nudged: false, skipped: 'debounced' }
    markForecastNudge(op, now)

    const send = deps.sendNudge ?? sendNudge
    const deliver = deps.deliverDigest ?? deliverDigest
    const question =
      `📉 ${dueCount} forecast${dueCount > 1 ? 's' : ''} due for a verdict — want your brief now? Reply Y.`

    const onReply = async (ctx: NudgeReplyContext): Promise<string | void> => {
      if (ctx.answer !== 'yes') return 'No problem — I will keep them queued for your next brief.'
      const res = await deliver('morning', {
        getDigest: deps.getDigest,
        getCalibration: deps.getCalibration,
        ref: config.homeChannel,
        now: deps.now,
        today: deps.today
      })
      return res.delivered ? 'Sending your brief now.' : 'I hit a snag delivering the brief — try opening DUIN.'
    }

    const result: SendNudgeResult = await send(
      { question, nudgeType: 'forecast-due', payload: { dueCount } },
      { operator: config.operator, ref: config.homeChannel, onReply, now: deps.now }
    )
    return { nudged: result.sent, skipped: result.sent ? undefined : result.skipped, interactionId: result.interactionId }
  } catch (e) {
    console.debug('[builtin-nudges] forecast nudge best-effort:', messageOf(e))
    return { nudged: false, skipped: 'error' }
  }
}

/**
 * Convenience wire for the calibration tick: read config, count due forecasts from the
 * full calibration report, and fire the nudge if warranted. Best-effort. Exposed so the
 * tick stays a one-liner and the counting logic is shared (countDueForecasts).
 */
export async function nudgeFromCalibration(
  cal: CalibrationReport,
  deps: Omit<ForecastNudgeDeps, 'config' | 'getCalibration'> & {
    config?: NudgeConfig
    getCalibration: () => CalibrationReport
  }
): Promise<ForecastNudgeResult> {
  const config = deps.config ?? readNudgeConfig()
  const today = deps.today ?? new Date(deps.now ?? Date.now()).toISOString().slice(0, 10)
  const dueCount = countDueForecasts(cal, today)
  return fireForecastNudge(dueCount, { ...deps, config, today })
}
