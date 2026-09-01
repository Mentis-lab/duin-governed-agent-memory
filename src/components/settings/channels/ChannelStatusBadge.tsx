import { t } from '@/lib/i18n'
import type { ChannelState } from './channel-types'

// The pill an operator reads BEFORE deciding whether to touch anything. Its whole job
// is to separate three things the pane must never blur:
//   "you owe it something"  (needs-setup)
//   "it is coming up"       (connecting)
//   "it broke"              (failed)
// channel-types collapsed the summary into one ChannelState precisely so a badge and a
// status line cannot disagree about which of those is true. This file is the badge half.

/**
 * The word on the pill.
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so the
 * judgement is unit-tested through helpers rather than by rendering — the same
 * convention as ChannelsSettings' channelStatusLine / secretPlaceholder.
 *
 * 'needs-setup' is the one that had to be got right, in both directions:
 *   - It is NOT a fault. Nothing has gone wrong; the operator simply has not pasted
 *     the token yet. So the label names the next ACTION ("Needs credentials") rather
 *     than a condition ("Not configured", "Unavailable", "Incomplete") that reads as
 *     something the operator has to diagnose instead of just do.
 *   - It equally must not read as connected. An enabled channel with no secret never
 *     starts however hard the toggle is thrown, and a badge implying otherwise is a
 *     lie discovered only when no message ever arrives.
 */
export function stateLabel(state: ChannelState): string {
  switch (state) {
    case 'off':
      return t('Off')
    case 'needs-setup':
      return t('Needs credentials')
    case 'connecting':
      return t('Connecting…')
    case 'live':
      return t('Live')
    case 'failed':
      return t('Failed')
    default: {
      // Unreachable while the union is fully covered above. Typing the fall-through as
      // `never` turns a NEW ChannelState into a compile error here rather than a pill
      // that silently renders nothing.
      const unhandled: never = state
      return String(unhandled)
    }
  }
}

/**
 * The pill's colour classes.
 *
 * Amber for BOTH 'needs-setup' and 'connecting' is deliberate: both mean "not running
 * yet, and not broken". Red stays reserved for a real adapter failure, so "you have
 * not pasted the token" never wears the colour of "the token was rejected" — the eye
 * triages by colour long before it reads a word, and mis-colouring here sends the
 * operator hunting for a fault that does not exist.
 *
 * 'connecting' carries animate-pulse so the two amber states stay distinguishable
 * without relying on the label alone (same signal as MCPStatusBar's connecting dot).
 * Semantic vars only — never a literal Tailwind colour, or the pill stops following
 * the theme (styles/index.css --success / --warning / --error).
 */
export function stateTone(state: ChannelState): string {
  switch (state) {
    case 'off':
      return 'border-[var(--border)] text-[var(--text-muted)]'
    case 'needs-setup':
      return 'border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]'
    case 'connecting':
      return 'animate-pulse border-[var(--warning)]/40 bg-[var(--warning)]/10 text-[var(--warning)]'
    case 'live':
      return 'border-[var(--success)]/40 bg-[var(--success)]/10 text-[var(--success)]'
    case 'failed':
      return 'border-[var(--error)]/40 bg-[var(--error)]/10 text-[var(--error)]'
    default: {
      const unhandled: never = state
      return String(unhandled)
    }
  }
}

export function ChannelStatusBadge({ state }: { state: ChannelState }): React.ReactElement {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[10px] leading-none ${stateTone(state)}`}
    >
      {stateLabel(state)}
    </span>
  )
}
