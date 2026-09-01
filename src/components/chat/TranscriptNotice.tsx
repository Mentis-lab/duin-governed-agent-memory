import { t } from '@/lib/i18n'
import type { InlineNotice, NoticeFeedbackAction } from '@/stores/inline-notices-store'

// Fluidity J9: generic inline transcript row for async-event notices
// (background turn completed, wake-up landed, side-chat reply, etc.).
// MessageList interleaves these with regular message bubbles by
// timestamp so the user reads a single transcript instead of getting
// toasts that steal focus.
//
// DUIN nervous system (organ #1): when a notice is a PROACTIVE surface
// (notice.feedbackEnabled), it grows a verdict row — act / snooze /
// dismiss / not-relevant. Each click is a typed observation the engine
// loops feed on; see electron/services/feedback-observations.ts. Plain
// informational notices keep using the toast/× affordance only.

interface TranscriptNoticeProps {
  notice: InlineNotice
  onDismiss?: () => void
  /** Called with the user's verdict when a feedback button is clicked.
   *  Only wired for feedbackEnabled notices. */
  onFeedback?: (action: NoticeFeedbackAction) => void
}

function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    })
  } catch {
    return ''
  }
}

const FEEDBACK_BUTTONS: ReadonlyArray<{
  action: NoticeFeedbackAction
  label: string
  title: string
  className: string
}> = [
  {
    action: 'act',
    label: 'Act',
    title: 'Useful — I acted on this',
    className:
      'text-emerald-700 dark:text-emerald-300 hover:bg-emerald-500/15 border-emerald-500/30'
  },
  {
    action: 'snooze',
    label: 'Snooze',
    title: 'Not now — remind me later',
    className:
      'text-amber-700 dark:text-amber-300 hover:bg-amber-500/15 border-amber-500/30'
  },
  {
    action: 'dismiss',
    label: 'Dismiss',
    title: 'Right kind of nudge, wrong moment',
    className:
      'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] border-[var(--border)]'
  },
  {
    action: 'not-relevant',
    label: 'Not relevant',
    title: "Shouldn't have surfaced this",
    className:
      'text-red-700 dark:text-red-300 hover:bg-red-500/15 border-red-500/30'
  }
]

export function TranscriptNotice({ notice, onDismiss, onFeedback }: TranscriptNoticeProps) {
  const time = formatTime(notice.ts)
  const showFeedback = !!notice.feedbackEnabled && !!onFeedback
  // A feedback row contains nested buttons, so the wrapper must stay a <div>
  // (buttons can't nest). Otherwise keep the legacy clickable-button behavior.
  const interactive = !!notice.onActivate && !showFeedback
  const Wrap = (interactive ? 'button' : 'div') as 'button' | 'div'

  return (
    <div
      className="mx-auto my-2 w-full max-w-[80%]"
      data-transcript-notice={notice.id}
    >
      <Wrap
        type={interactive ? 'button' : undefined}
        onClick={interactive ? notice.onActivate : undefined}
        className={
          'flex w-full items-center gap-2 rounded-md bg-[var(--bg-tertiary)]/60 px-3 py-1.5 text-left text-[12px] transition-colors ' +
          (showFeedback ? 'rounded-b-none ' : '') +
          (interactive ? 'hover:bg-[var(--bg-tertiary)]' : '')
        }
      >
        <span className="h-1.5 w-1.5 flex-none rounded-full bg-[var(--accent)]" aria-hidden />
        <span className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
          {notice.title}
        </span>
        <span className="truncate text-[var(--text-secondary)]">{notice.message}</span>
        {time && (
          <span className="ml-auto font-mono text-[11px] text-[var(--text-muted)]">{time}</span>
        )}
        {onDismiss && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onDismiss()
            }}
            className="rounded p-0.5 text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
            aria-label={t('Dismiss notice')}
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        )}
      </Wrap>
      {showFeedback && (
        <div
          className="flex items-center gap-1.5 rounded-b-md border-t border-[var(--border)] bg-[var(--bg-tertiary)]/40 px-3 py-1.5"
          role="group"
          aria-label={t('Feedback on this nudge')}
        >
          {FEEDBACK_BUTTONS.map((b) => (
            <button
              key={b.action}
              type="button"
              title={b.title}
              onClick={(e) => {
                e.stopPropagation()
                onFeedback?.(b.action)
              }}
              className={
                'rounded border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider transition-colors ' +
                b.className
              }
            >
              {b.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
