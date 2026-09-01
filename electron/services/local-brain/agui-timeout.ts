// Per-tool wall-clock bound for the /agui dispatcher.
//
// These two helpers were written for web_search (agui-search.ts) and were already fully generic;
// they simply had one caller. Every OTHER simple tool executed as a bare `await spec.execute(...)`
// with no deadline at all — `write_file`, `edit_file`, `delete_file`, `read_file`, `list_dir`,
// `search_files`, `glob_files`, `create_dir`, `move_file`, `start_command`, `read_command`,
// `stop_command`, `write_todos` and `create_skill` could hang a turn indefinitely on a wedged
// filesystem, a stalled network mount, or an unresponsive child. `run_command` (30s) and
// `web_fetch` (15s) carry their own internal caps; the dispatcher-level bound is the backstop for
// everything that does not.
//
// Living in their own module (rather than being imported from agui-search) keeps the dispatcher
// free of the search stack's dependencies — see the header note in agui-dispatch.ts.

/** Wall-clock budget for one tool call. Env `DUIN_TOOL_TIMEOUT_MS` (default 60s); <= 0 disables. */
export function toolTimeoutMs(): number {
  const raw = Number(process.env.DUIN_TOOL_TIMEOUT_MS)
  return Number.isFinite(raw) && process.env.DUIN_TOOL_TIMEOUT_MS != null && process.env.DUIN_TOOL_TIMEOUT_MS !== ''
    ? raw
    : 60_000
}

/**
 * Race `work` against a hard timeout and (optionally) an external abort signal.
 *
 * The underlying tool cannot always be cancelled mid-flight, so this bounds how long the CALLER
 * waits: on expiry the call resolves with `onExpire()` so the round loop can advance or unwind
 * instead of hanging forever. `timeoutMs <= 0` disables the timer (an already-aborted signal is
 * still honored).
 */
export async function withToolTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onExpire: () => T
): Promise<T> {
  if (signal?.aborted) return onExpire()
  if (timeoutMs <= 0 && !signal) return work
  return new Promise<T>((resolve) => {
    let settled = false
    const finish = (v: T): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (onAbort) signal?.removeEventListener?.('abort', onAbort)
      resolve(v)
    }
    const timer = timeoutMs > 0 ? setTimeout(() => finish(onExpire()), timeoutMs) : null
    const onAbort = signal ? (): void => finish(onExpire()) : null
    if (onAbort) signal?.addEventListener?.('abort', onAbort, { once: true })
    work.then(finish, () => finish(onExpire()))
  })
}

/** The model-facing result of an expired tool call. Shaped like every other tool error string so
 *  the loop's existing `!/^Error:/` success discriminant classifies it as a failure — which is what
 *  feeds the repeat-failure ladder and (correctly) does NOT reset the stall watchdog. */
export function toolTimeoutMessage(name: string, ms: number): string {
  return `Error: ${name} timed out after ${Math.round(ms / 1000)}s and was abandoned. The tool may still be running in the background; do not simply retry it unchanged.`
}
