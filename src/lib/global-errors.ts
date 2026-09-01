// global-errors — the renderer's last line of defence.
//
// WHY (audit blocker 13, "the multiplier on every other silent catch"): src/main.tsx
// passed createRoot no options, so React 19's onUncaughtError was unset; there was
// ZERO ErrorBoundary in src/; and the only unhandledrejection listener in the repo
// lived in artifact-sandbox.ts, a DIFFERENT WebContentsView. One render or effect
// throw in any of ~100 components therefore unmounted the whole tree to a blank
// window with no text — and recovery was quit-and-relaunch, because
// Menu.setApplicationMenu is never called and the window is frame:false.
//
// The logic lives here rather than inline in main.tsx so it can be tested: the
// vitest environment is node-only (no jsdom), so anything expressed only inside
// the entry module or a JSX fallback is untestable in this repo.

/** Minimal surface of the thing we attach to — `window` in the app, a fake in tests. */
export interface ErrorEventTarget {
  addEventListener: (type: string, listener: (event: unknown) => void) => void
  removeEventListener?: (type: string, listener: (event: unknown) => void) => void
}

export interface GlobalErrorReport {
  /** Where it came from, for the operator-visible message. */
  source: 'render' | 'promise' | 'error'
  message: string
  cause: unknown
}

/**
 * Turn whatever was thrown/rejected into a sentence worth showing. Deliberately
 * never returns '' — a blank toast is the silent failure this whole item is about.
 */
export function formatGlobalError(cause: unknown, source: GlobalErrorReport['source']): string {
  const raw =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string'
          ? ((cause as { message: string }).message)
          : ''
  const body = raw.trim() || 'an error with no message'
  const prefix =
    source === 'promise'
      ? 'Unhandled background error'
      : source === 'render'
        ? 'Interface error'
        : 'Unexpected error'
  return `${prefix}: ${body}`
}

/**
 * Browser noise that is loud but harmless — the canonical ignore pair every
 * error-reporting stack (Sentry et al.) ships by default. The browser fires
 * these when a ResizeObserver callback causes another layout pass in the same
 * frame; delivery simply defers to the next frame and nothing is lost. The
 * cosmos canvas + panel layout produce them during launch/resize storms, and
 * toasting them turned a benign browser hiccup into "DUIN shows an unexpected
 * error at every launch" (operator report, 2026-08-14). Filtered HERE, at the
 * window-error listener, so everything genuinely unexpected stays loud —
 * which is this module's whole job.
 */
const IGNORED_BROWSER_NOISE = [
  'ResizeObserver loop completed with undelivered notifications',
  'ResizeObserver loop limit exceeded'
]

export function isIgnoredBrowserNoise(cause: unknown): boolean {
  const msg =
    cause instanceof Error
      ? cause.message
      : typeof cause === 'string'
        ? cause
        : cause && typeof cause === 'object' && typeof (cause as { message?: unknown }).message === 'string'
          ? ((cause as { message: string }).message)
          : ''
  return IGNORED_BROWSER_NOISE.some((noise) => msg.includes(noise))
}

/**
 * Register the two window-level listeners the renderer never had.
 *
 * `unhandledrejection` is the load-bearing one: every `.catch(() => [])` this wave
 * removed now surfaces a rejection instead of a fabricated empty value, and without
 * a listener those would be console-only — i.e. invisible on a frameless window
 * with no menu and no devtools shortcut.
 *
 * Returns an uninstaller so a test (or a hot reload) can detach cleanly.
 */
export function installGlobalErrorHandlers(
  target: ErrorEventTarget,
  report: (r: GlobalErrorReport) => void
): () => void {
  const onRejection = (event: unknown): void => {
    const cause = (event as { reason?: unknown })?.reason
    report({ source: 'promise', message: formatGlobalError(cause, 'promise'), cause })
  }
  const onError = (event: unknown): void => {
    const cause = (event as { error?: unknown })?.error ?? (event as { message?: unknown })?.message
    if (isIgnoredBrowserNoise(cause)) return
    report({ source: 'error', message: formatGlobalError(cause, 'error'), cause })
  }
  target.addEventListener('unhandledrejection', onRejection)
  target.addEventListener('error', onError)
  return () => {
    target.removeEventListener?.('unhandledrejection', onRejection)
    target.removeEventListener?.('error', onError)
  }
}

/**
 * Ask main to reload the window. `window:reload` has been registered in
 * electron/main.ts and exposed on the preload as `window.api.window.reload` the
 * whole time with ZERO renderer callers — this is the first one. Falls back to
 * location.reload() so a detached surface or a stale preload can still recover.
 */
export async function reloadWindow(): Promise<void> {
  const api = (globalThis as { window?: { api?: { window?: { reload?: () => Promise<unknown> } } } })
    .window?.api?.window?.reload
  if (typeof api === 'function') {
    try {
      await api()
      return
    } catch {
      // fall through to the renderer-side reload below
    }
  }
  ;(globalThis as { location?: { reload?: () => void } }).location?.reload?.()
}
