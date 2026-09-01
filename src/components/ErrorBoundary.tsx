import { t } from '@/lib/i18n'
import React from 'react'
import { reloadWindow } from '@/lib/global-errors'

// The repo had NO ErrorBoundary and no componentDidCatch anywhere in src/. One
// throw in any component unmounted the entire tree to a blank frameless window
// with no text and no menu — recovery was quit-and-relaunch.
//
// Two placements matter, and they are different jobs:
//   • around <App/>            — the shell of last resort; something is on screen.
//   • around each right-panel branch, SEPARATELY — so one panel's throw costs that
//     panel and leaves the sidebar, chat and titlebar alive. A single boundary at
//     the root would still blank the whole window, just prettily.

interface Props {
  /** Names the failing region in the fallback, e.g. "the workspace panel". */
  label: string
  children: React.ReactNode
  /** Optional hook for telemetry/toasts; receives the thrown value. */
  onError?: (error: unknown) => void
  /** Compact fallback for small regions (skips the border/padding block). */
  compact?: boolean
}

interface State {
  error: Error | null
  /** Bumped by Try again; used as a key so children remount from scratch. */
  attempt: number
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, attempt: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Keep the console trace — devtools is still the fastest read when it is open.
    console.error(`[ErrorBoundary:${this.props.label}]`, error, info?.componentStack)
    this.props.onError?.(error)
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }))
  }

  render(): React.ReactNode {
    const { error, attempt } = this.state
    if (!error) {
      // The key forces a fresh mount on retry: re-rendering the same element tree
      // would hand the children back their broken state and throw again instantly.
      return <React.Fragment key={attempt}>{this.props.children}</React.Fragment>
    }
    return (
      <div
        role="alert"
        className={
          this.props.compact
            ? 'flex flex-col items-start gap-2 p-3 text-[12px] text-[var(--text-secondary)]'
            : 'flex flex-1 flex-col items-center justify-center gap-3 overflow-auto p-6 text-center text-[var(--text-secondary)]'
        }
      >
        <span className="text-[13px] font-medium text-[var(--text-primary)]">
          Something broke in {this.props.label}.
        </span>
        <span className="max-w-[360px] break-words text-[12px] leading-relaxed text-[var(--text-muted)]">
          {error.message || String(error)}
        </span>
        <span className="max-w-[360px] text-[11px] leading-relaxed text-[var(--text-muted)] opacity-80">
          {t('The rest of the app is still running. Nothing was lost on the engine side.')}
        </span>
        <div className="mt-1 flex items-center gap-2">
          <button
            type="button"
            onClick={this.retry}
            className="rounded-md border border-[var(--panel-border)] px-2.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]"
          >
            {t('Try again')}
          </button>
          <button
            type="button"
            onClick={() => void reloadWindow()}
            className="rounded-md border border-[var(--panel-border)] px-2.5 py-1 text-[12px] hover:bg-[var(--bg-hover)]"
          >
            {t('Reload window')}
          </button>
        </div>
      </div>
    )
  }
}
