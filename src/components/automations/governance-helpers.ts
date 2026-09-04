import { t, tf } from '@/lib/i18n'

// The pure half of the Governance tab in the Automations hub: the capability BREAKER and the
// governor's own RECORD. No React and no IPC in here, so this repo's node-only vitest env can
// pin the behaviour (src/components/settings/LoopSettings.test.tsx) without rendering.
//
// Moved out of Settings → Automations on 2026-09-03: the breaker and the governor's record are
// monitoring, not settings, and they belong beside the Activity tab of the hub.

export interface BreakerCap {
  id: string
  title: string
  rung: string
  floorRung: string
  trust: number
  coldStart: boolean
  reverts: number
  willTrip: boolean
  tripsTo: string | null
  canRearm: boolean
}

/** English source strings per rung. Render through rungLabel() so they translate. */
export const RUNG_LABEL: Record<string, string> = {
  reflexive: 'Runs on its own',
  stage: 'Prepares, waits for you',
  hold: 'Held — will not act'
}

export function rungLabel(rung: string): string {
  return t(RUNG_LABEL[rung] ?? rung)
}

/**
 * Which capabilities the operator is offered a re-arm for.
 *
 * The filter is `canRearm` — "sitting below its floor" — NOT "has reverts on record". A
 * capability can carry a long revert history and still be fully armed, and offering to re-arm
 * something already at its floor is the `already-armed` refusal surfaced as a button.
 */
export function trippedCapabilities(caps: BreakerCap[]): BreakerCap[] {
  return caps.filter((c) => c.canRearm)
}

/** The one-line status under a tripped capability's title. Pure, so it is testable. */
export function breakerLine(c: BreakerCap): string {
  const parts = [
    rungLabel(c.rung),
    c.reverts === 1 ? t('1 revert on record') : tf('{n} reverts on record', { n: c.reverts }),
    c.coldStart ? t('trust not yet earned') : tf('trust {score}', { score: c.trust.toFixed(2) })
  ]
  if (c.willTrip && c.tripsTo) {
    parts.push(tf('a new miss is pending and will drop it to {rung}', { rung: c.tripsTo }))
  }
  return parts.join(' · ')
}

// ── The governor's record ──────────────────────────────────────────────────────
//
// /state/govern-audit, /state/improvements and /state/undo all returned real content and had
// ZERO renderer callers: an agent could query the governor's record over HTTP, and the
// operator that record is ABOUT could not see it. Read-only apart from the undo, because
// everything else here is either already decided (audit) or a SHADOW proposal that must not
// become a one-click apply.

export interface GovernFactRow {
  id: string
  fact: string
  status: string
  govern?: { verdict: string; juryProvider: string | null; crossModel: boolean; ts: number }
  reliability?: number
}
export interface GovernActionRow {
  id: string
  ts: number
  actionKind: string
  capabilityId: string
  status: string
}
export interface ImprovementRow {
  type: string
  targetId: string
  target: string
  rationale: string
  reversible: boolean
}

/** Plain-language line for one audited rule. */
export function governFactLine(f: GovernFactRow): string {
  const parts: string[] = []
  if (f.govern) {
    parts.push(
      f.govern.verdict === 'confirm'
        ? t('Confirmed by the jury')
        : f.govern.verdict === 'revert'
          ? t('Reverted by the jury')
          : t('Held by the jury')
    )
    // A single-model jury grading its own model's output is a weaker check, and the audit is
    // the one place that must not quietly round it up to "verified".
    parts.push(f.govern.crossModel ? t('cross-model') : t('same-model check'))
    if (f.govern.juryProvider) parts.push(f.govern.juryProvider)
  } else {
    parts.push(tf('status {status}', { status: f.status }))
  }
  if (typeof f.reliability === 'number') parts.push(tf('reliability {score}', { score: f.reliability.toFixed(2) }))
  return parts.join(' · ')
}

/**
 * The confirm text for an undo.
 *
 * revertAction does TWO things: it dispatches the inverse (restoring bytes) and it fires
 * recordFeedback('revert'), which DEMOTES the capability that took the action. The second is
 * invisible from the button and is the one an operator would not have predicted, so the
 * confirm has to say it out loud — a dialog that only says "are you sure?" is a speed bump,
 * not consent.
 */
export function undoConfirmMessage(a: GovernActionRow | undefined): string {
  const what = a ? `${a.actionKind} (${a.capabilityId})` : t('the most recent reversible action')
  return tf(
    'Undo {what}?\n\nThis restores what that action changed, and it also DEMOTES the capability that performed it — that capability will act less autonomously until you re-arm it above.\n\nThis is recorded in the governor audit.',
    { what }
  )
}

/** Which actions are worth offering an undo for: only ones still applied. */
export function undoableActions(actions: GovernActionRow[]): GovernActionRow[] {
  return actions.filter((a) => a.status === 'applied')
}
