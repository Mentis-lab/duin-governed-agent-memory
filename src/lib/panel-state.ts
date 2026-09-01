// panel-state — the pure branch logic behind <PanelState>.
//
// Split out of the component on purpose: the renderer test environment is
// node-only (vitest.config.ts sets `environment: 'node'`, and there is no jsdom
// or @testing-library in devDependencies), so anything expressed only as JSX is
// UNTESTABLE in this repo today. The DECISION — which of loading / error / empty
// / ready a panel is in — is the part that was getting this wrong, so it lives
// here where a test can pin it.

import type { Result } from './result'

/**
 * A panel's data lifecycle. There is no "idle" that renders as empty: a panel
 * that has not asked yet is `loading`, because the one thing it must never do is
 * assert emptiness it has not earned.
 */
export type PanelStatus<T> =
  | { readonly phase: 'loading' }
  | { readonly phase: 'error'; readonly error: string; readonly cause?: unknown }
  | { readonly phase: 'ready'; readonly data: T }

export type PanelBranch = 'loading' | 'error' | 'empty' | 'ready'

export const panelLoading = <T,>(): PanelStatus<T> => ({ phase: 'loading' })
export const panelError = <T,>(error: string, cause?: unknown): PanelStatus<T> => ({
  phase: 'error',
  error,
  cause
})
export const panelReady = <T,>(data: T): PanelStatus<T> => ({ phase: 'ready', data })

/** Lift a transport Result straight into a panel status — the whole point of U1. */
export function panelFromResult<T>(r: Result<T>): PanelStatus<T> {
  return r.ok ? panelReady(r.data) : panelError<T>(r.error, r.cause)
}

/**
 * Default emptiness test. Deliberately conservative: only an actually-empty
 * array, an actually-empty map-like object, null or undefined count as empty.
 * A number, a string, or a populated object is READY — guessing wider is how a
 * legitimate `{count: 0}` payload gets painted as "nothing here".
 */
export function isEmptyData(data: unknown): boolean {
  if (data === null || data === undefined) return true
  if (Array.isArray(data)) return data.length === 0
  if (data instanceof Map || data instanceof Set) return data.size === 0
  if (typeof data === 'object') return Object.keys(data as object).length === 0
  return false
}

/**
 * The single branch decision. `isEmpty` overrides the default test for payloads
 * whose emptiness is domain-specific (e.g. `{decisions: [], cascades: []}`).
 *
 * INVARIANT the audit was violating: `error` NEVER collapses into `empty`. A
 * failed read is its own branch, always, so the caller is forced to say what
 * failure looks like instead of inheriting the empty copy by accident.
 */
export function panelBranch<T>(
  status: PanelStatus<T>,
  isEmpty: (data: T) => boolean = isEmptyData
): PanelBranch {
  if (status.phase === 'loading') return 'loading'
  if (status.phase === 'error') return 'error'
  return isEmpty(status.data) ? 'empty' : 'ready'
}
