// smart-digest — the SCHEDULED BRIEF composer (#4).
//
// A cron job today runs an LLM prompt through the headless agent and delivers the
// completion. That is the right primitive for an ad-hoc "summarize X" automation,
// but a daily brief must be DETERMINISTIC and grounded — not a fresh model
// hallucination each morning. This module composes the SAME data the Home digest
// renders (buildHomeDigest) with the forecast/calibration ledger into ONE structured
// brief object, then renders that object to channel text. No model, no prompt.
//
// Two seams:
//   • PURE core — buildDigestBrief(HomeDigest + CalibrationReport) → DigestBrief, and
//     renderDigestBrief(DigestBrief) → string. Both dependency-free (types only), so
//     they are trivially unit-testable off a fixture. This is the part the tests pin.
//   • DELIVERY — deliverDigest(mode, deps) reads the live digest + calibration through
//     INJECTED readers and pushes the rendered text via the reliable delivery-queue.
//     Deps are injected so delivery is testable without the brain/Electron graph.
//
// It is a SEEDABLE automations job: digestJobTemplates() returns createAutomation
// inputs whose `prompt` is a recognizable directive (#duin-digest:morning|eod). The
// automations runner detects that directive and calls deliverDigest deterministically
// instead of running the model — so the brief is a real composed report, cron-
// scheduled and listed in the UI like any other job, but never a raw prompt.
//
// Carries NO exec authority: it only forwards rendered text through the delivery
// queue → channel-dispatch. It cannot approve, write, or run anything.

import type { HomeDigest } from '../brain/home-digest'
import type { CalibrationReport } from '../brain/types'
import type { ChannelRef } from '../channel-dispatch'
import { enqueue, type DeliveryReceipt } from './delivery-queue'
import { messageOf } from '../guarded'

export type DigestMode = 'morning' | 'eod'

// ──────────────────── pure composition ────────────────────

export interface DigestBriefInput {
  mode: DigestMode
  /** ISO yyyy-mm-dd treated as "today". */
  today: string
  digest: HomeDigest
  calibration: CalibrationReport
  /** Optional operator name for the greeting line. */
  name?: string
}

export interface ForecastSummary {
  /** Unresolved (unobserved) forecasts whose due date is on/before today. */
  dueCount: number
  /** Forecasts resolved so far (from the calibration totals). */
  resolved: number
  /** Foresight hit-rate as a whole percent, or null when nothing has resolved. */
  hitRatePct: number | null
}

export interface DigestBrief {
  mode: DigestMode
  date: string
  /** Section-leading headline (mode-specific). */
  headline: string
  tracks: { label: string; reason: string }[]
  needs: { title: string; reason: string }[]
  insights: { title: string; why: string }[]
  forecasts: ForecastSummary
  /** "Since you were away" line (morning) — may be null. */
  away: string | null
  /** The single "come back for X" line from the digest. */
  returnReason: string
  /** True when there is genuinely nothing to surface (sparse / empty vault). */
  empty: boolean
}

/** How many sections' rows to carry into the brief (keeps a channel message tight). */
const MAX_ROWS = 3

/** Count unresolved forecasts that are due (due date ≤ today). PURE. */
export function countDueForecasts(cal: CalibrationReport, today: string): number {
  const t = Date.parse(today)
  const recent = cal?.recent ?? []
  let n = 0
  for (const p of recent) {
    if (p.outcome !== 'unobserved') continue
    if (!p.due) continue
    const d = Date.parse(p.due)
    if (Number.isNaN(d) || Number.isNaN(t)) continue
    if (d <= t) n++
  }
  return n
}

/** Compose the Home digest + calibration ledger into one structured brief. PURE. */
export function buildDigestBrief(input: DigestBriefInput): DigestBrief {
  const { mode, today, digest, calibration } = input
  const tracks = (digest.tracks ?? []).slice(0, MAX_ROWS).map((t) => ({ label: t.label, reason: t.reason }))
  const needs = (digest.needs ?? []).slice(0, MAX_ROWS).map((n) => ({ title: n.title, reason: n.reason }))
  const insights = (digest.insights ?? []).slice(0, MAX_ROWS).map((i) => ({ title: i.title, why: i.why }))

  const resolved = calibration?.totals?.resolved ?? 0
  const hit = calibration?.totals?.hit_rate
  const forecasts: ForecastSummary = {
    dueCount: countDueForecasts(calibration, today),
    resolved,
    hitRatePct: typeof hit === 'number' ? Math.round(hit * 100) : null
  }

  const empty =
    tracks.length === 0 &&
    needs.length === 0 &&
    insights.length === 0 &&
    forecasts.dueCount === 0 &&
    resolved === 0

  const headline =
    mode === 'morning'
      ? greeting(input.name) + ' Here is your morning brief.'
      : 'End-of-day reconciliation.'

  return {
    mode,
    date: today,
    headline,
    tracks,
    needs,
    insights,
    forecasts,
    away: mode === 'morning' ? (digest.away ?? null) : null,
    returnReason: digest.returnReason ?? '',
    empty
  }
}

function greeting(name?: string): string {
  const who = (name ?? '').trim()
  return who ? `Good morning, ${who}.` : 'Good morning.'
}

// ──────────────────── pure renderer ────────────────────

/** Render a brief to plain channel text. Deterministic + dependency-free. PURE. */
export function renderDigestBrief(brief: DigestBrief): string {
  const lines: string[] = []
  const title = brief.mode === 'morning' ? '☀️ Morning brief' : '🌙 End-of-day'
  lines.push(`${title} · ${brief.date}`)
  lines.push('')
  lines.push(brief.headline)

  if (brief.empty) {
    lines.push('')
    lines.push('Nothing pressing surfaced today. Enjoy the quiet — I will nudge you when something needs you.')
    return lines.join('\n')
  }

  // Needs You — the obligations, first (they carry the urgency floor).
  if (brief.needs.length) {
    lines.push('')
    lines.push('🔴 Needs you')
    for (const n of brief.needs) lines.push(`• ${n.title} (${n.reason})`)
  }

  // Forecasts / calibration — the foresight ledger.
  const f = brief.forecasts
  if (f.dueCount > 0 || f.resolved > 0) {
    lines.push('')
    lines.push('📉 Forecasts')
    if (f.dueCount > 0) {
      lines.push(`• ${f.dueCount} forecast${f.dueCount > 1 ? 's' : ''} due for a verdict`)
    }
    if (f.resolved > 0) {
      const acc = f.hitRatePct !== null ? ` · foresight ${f.hitRatePct}% on point` : ''
      lines.push(`• ${f.resolved} resolved so far${acc}`)
    }
  }

  // Jump back in — active tracks (morning only; EOD leans on reconciliation).
  if (brief.mode === 'morning' && brief.tracks.length) {
    lines.push('')
    lines.push('↩️ Jump back in')
    for (const t of brief.tracks) lines.push(`• ${t.label} — ${t.reason}`)
  }

  // Brain noticed — insights.
  if (brief.insights.length) {
    lines.push('')
    lines.push('💡 Brain noticed')
    for (const i of brief.insights) lines.push(`• ${i.title}${i.why ? ` — ${i.why}` : ''}`)
  }

  // Away line (morning) — what changed while you were gone.
  if (brief.mode === 'morning' && brief.away) {
    lines.push('')
    lines.push(`Since you were away: ${brief.away}.`)
  }

  // The single come-back reason — the sign-off.
  if (brief.returnReason) {
    lines.push('')
    lines.push(brief.mode === 'morning' ? `Today: ${brief.returnReason}` : `Tomorrow: ${brief.returnReason}`)
  }

  return lines.join('\n')
}

// ──────────────────── seedable job templates ────────────────────

/** The prompt sentinel that marks an automation as a deterministic digest job.
 *  The automations runner detects this and composes the brief instead of running
 *  the model. Kept as the `prompt` so the job reads honestly in the UI. */
export const DIGEST_DIRECTIVE_PREFIX = '#duin-digest:'

export function digestDirective(mode: DigestMode): string {
  return `${DIGEST_DIRECTIVE_PREFIX}${mode}`
}

/** Parse an automation prompt into a digest mode, or null if it is an ordinary job. */
export function parseDigestDirective(prompt: string | null | undefined): DigestMode | null {
  const p = String(prompt ?? '').trim()
  if (!p.startsWith(DIGEST_DIRECTIVE_PREFIX)) return null
  const mode = p.slice(DIGEST_DIRECTIVE_PREFIX.length).trim().toLowerCase()
  if (mode === 'morning' || mode === 'eod') return mode
  return null
}

export interface DigestJobTemplate {
  label: string
  cron: string
  prompt: string
  /** JSON-encoded ChannelRef for cron→channel delivery. */
  deliverTo: string
}

/** Seedable automations for a morning brief (08:00) + EOD reconciliation (18:00),
 *  both delivered to the given home channel. The caller passes these to
 *  createAutomation(). */
export function digestJobTemplates(ref: ChannelRef): DigestJobTemplate[] {
  const deliverTo = JSON.stringify({ kind: ref.kind, target: ref.target })
  return [
    { label: 'Morning brief', cron: '0 8 * * *', prompt: digestDirective('morning'), deliverTo },
    { label: 'EOD reconciliation', cron: '0 18 * * *', prompt: digestDirective('eod'), deliverTo }
  ]
}

// ──────────────────── delivery ────────────────────

export interface DeliverDigestDeps {
  /** Live Home digest reader (getHomeDigest). */
  getDigest: () => HomeDigest
  /** Live calibration reader (getCalibration). */
  getCalibration: () => CalibrationReport
  /** Destination channel. */
  ref: ChannelRef
  /** Override the delivery seam (else the reliable delivery-queue enqueue). */
  enqueue?: (ref: ChannelRef, text: string, meta: Record<string, unknown>) => Promise<DeliveryReceipt>
  /** Override "today" (yyyy-mm-dd); else derived from now. */
  today?: string
  now?: number
  name?: string
}

export interface DeliverDigestResult {
  delivered: boolean
  text?: string
  receipt?: DeliveryReceipt
  error?: string
}

/**
 * Compose the live brief and deliver it. Never throws — a reader/format/enqueue
 * failure resolves to {delivered:false, error}. Returns the rendered text so a
 * caller/test can assert on the exact brief that went out.
 */
export async function deliverDigest(mode: DigestMode, deps: DeliverDigestDeps): Promise<DeliverDigestResult> {
  try {
    const now = deps.now ?? Date.now()
    const today = deps.today ?? new Date(now).toISOString().slice(0, 10)
    const digest = deps.getDigest()
    const calibration = deps.getCalibration()
    const brief = buildDigestBrief({ mode, today, digest, calibration, name: deps.name })
    const text = renderDigestBrief(brief)
    const enq =
      deps.enqueue ??
      ((ref: ChannelRef, t: string, meta: Record<string, unknown>) => enqueue(ref, t, { meta, now }))
    const receipt = await enq(deps.ref, text, { source: 'digest', mode })
    return { delivered: receipt.ok, text, receipt }
  } catch (e) {
    return { delivered: false, error: messageOf(e) }
  }
}
