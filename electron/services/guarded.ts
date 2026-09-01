// guarded() — the anti-swallow error discipline (DUIN_BRAIN_UNIFICATION_SPEC.md §4).
//
// Replaces blanket `catch {}`. The distinction it enforces:
//   - EXPECTED degradation (no model key, no vault, offline) → quiet debug log,
//     return a typed fallback that the UI surfaces honestly.
//   - UNEXPECTED failure (a bug) → loud: console.error + telemetry + surfaced,
//     NEVER silent.
//
// This is what would have made this session's dead vector stack + the ledger
// CHECK failure LOUD instead of invisible. PURE + injectable telemetry (no
// event-log import) so it unit-tests in vitest and stays decoupled.

export interface GuardOptions<T> {
  /** A short label for logs/telemetry (e.g. 'embeddings.load', 'ledger.sync'). */
  label?: string
  /** Substrings that mark an error as EXPECTED degradation, not a bug. Matched
   *  against the classified reason; a hit → quiet + fallback. */
  expected?: string[]
  /** Value returned when an error is caught. The "typed degraded state." */
  fallback?: T
  /** Map a caught error → a reason string to test against `expected`.
   *  Default: the error message. */
  classify?: (err: unknown) => string
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Human-facing error text with a curated fallback. Unlike `messageOf(err) ?? fb`
 *  — which is dead code because messageOf never returns nullish — this returns the
 *  fallback for a NON-Error throw (e.g. `throw {code:'ENOENT'}` → '[object Object]',
 *  `throw undefined` → 'undefined') OR an Error with an empty message, and the real
 *  message only when there IS one. Use for IPC/user-surfaced catch blocks. */
export const friendly = (err: unknown, fallback: string): string =>
  err instanceof Error && err.message ? err.message : fallback

/** Telemetry sink for UNEXPECTED failures. Injected at boot (wired to event-log)
 *  so this module imports nothing heavy. Default: console.error only. */
type TelemetrySink = (label: string, err: unknown) => void
let onUnexpected: TelemetrySink = (label, err) => {
  console.error(`[${label}] unexpected failure:`, err)
}

/** Wire the telemetry sink at boot (e.g. → recordEvent). Idempotent. */
export function setGuardTelemetry(sink: TelemetrySink): void {
  onUnexpected = sink
}

/** Test-only: restore the default console-only sink. */
export function __resetGuardTelemetry(): void {
  onUnexpected = (label, err) => console.error(`[${label}] unexpected failure:`, err)
}

/** Returns true when the caught error is EXPECTED (quiet); false when it's a
 *  bug (loud). Exposed for callers that need the decision without the wrapper. */
export function isExpected(err: unknown, opts: GuardOptions<unknown> = {}): boolean {
  const reason = opts.classify?.(err) ?? messageOf(err)
  return !!opts.expected?.some((e) => reason.includes(e))
}

function handle(err: unknown, opts: GuardOptions<unknown>): void {
  const label = opts.label ?? 'guarded'
  if (isExpected(err, opts)) {
    console.debug(`[${label}] expected degradation: ${opts.classify?.(err) ?? messageOf(err)}`)
    return
  }
  onUnexpected(label, err)
}

/** Async guard: run fn; on throw, classify + (quiet | loud), return fallback. */
export async function guarded<T>(
  fn: () => Promise<T> | T,
  opts: GuardOptions<T> = {}
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (err) {
    handle(err, opts)
    return opts.fallback
  }
}

/** Sync guard: same contract, no await. */
export function guardedSync<T>(fn: () => T, opts: GuardOptions<T> = {}): T | undefined {
  try {
    return fn()
  } catch (err) {
    handle(err, opts)
    return opts.fallback
  }
}
