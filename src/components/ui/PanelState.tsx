import { t } from '@/lib/i18n'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { panelBranch, isEmptyData, type PanelStatus } from '@/lib/panel-state'

// <PanelState> — the wrapper that makes "the read failed" impossible to skip.
//
// `error` and `empty` are REQUIRED props. That is the entire mechanism: a panel
// cannot compile without stating what failure looks like, so the audit's pattern A
// ("No decisions on record yet" printed over an unreachable brain) becomes a type
// error rather than a code review someone has to remember to do.
//
// Do not add a default for `error`. A default would restore exactly the behaviour
// this replaces — a panel silently inheriting copy it never chose.

export interface PanelStateProps<T> {
  /** Current lifecycle of the read. Build it with panelFromResult(). */
  state: PanelStatus<T>
  /** Shown while the read is in flight. */
  loading: React.ReactNode
  /**
   * REQUIRED. Rendered when the read FAILED. Receives the failure sentence and,
   * when `onRetry` is supplied, a retry callback to wire to a button.
   */
  error: (message: string, retry: (() => void) | undefined) => React.ReactNode
  /** REQUIRED. Rendered only when the read SUCCEEDED and returned nothing. */
  empty: React.ReactNode
  /** Rendered with the data on the success path. */
  children: (data: T) => React.ReactNode
  /** Domain-specific emptiness test; defaults to isEmptyData. */
  isEmpty?: (data: T) => boolean
  /** When present, the default error body renders a Retry button bound to it. */
  onRetry?: () => void
}

export function PanelState<T>({
  state,
  loading,
  error,
  empty,
  children,
  isEmpty = isEmptyData,
  onRetry
}: PanelStateProps<T>): React.ReactNode {
  const branch = panelBranch(state, isEmpty)
  if (branch === 'loading') return loading
  if (branch === 'error') {
    // Narrowing is safe: panelBranch only returns 'error' for the error phase.
    return error((state as { error: string }).error, onRetry)
  }
  if (branch === 'empty') return empty
  return children((state as { data: T }).data)
}

/**
 * The default failure body. Panels are free to render their own — the point of the
 * required prop is that they must CHOOSE — but this covers the common case, and it
 * always names the failure instead of implying an empty dataset.
 */
export function PanelErrorState({
  message,
  onRetry,
  what
}: {
  message: string
  onRetry?: () => void
  what?: string
}): React.ReactElement {
  return (
    <div
      role="alert"
      className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <AlertTriangle size={18} className="text-[var(--warning,#d97706)]" />
      <span className="text-[13px] font-medium text-[var(--text-secondary)]">
        {what ? `Couldn't load ${what}` : "Couldn't load this"}
      </span>
      <span className="max-w-[320px] break-words text-[12px] leading-relaxed text-[var(--text-muted)]">
        {message}
      </span>
      <span className="max-w-[320px] text-[11px] leading-relaxed text-[var(--text-muted)] opacity-80">
        {t('This is a read failure, not an empty list — the underlying data may be intact.')}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 inline-flex items-center gap-1.5 rounded-md border border-[var(--panel-border)] px-2.5 py-1 text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-hover)]"
        >
          <RefreshCw size={12} /> {t('Retry')}
        </button>
      )}
    </div>
  )
}
