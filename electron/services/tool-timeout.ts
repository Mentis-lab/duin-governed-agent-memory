// R4 (Phase-4) — per-tool hard wall-clock timeout at the native dispatch seam.
//
// A native tool handler that never resolves (a hung child process, a socket
// that never closes, a filesystem call blocked on a dead mount) otherwise
// parks the whole agentic round forever: the turn Promise only settles from
// inside onDone, which is awaiting this handler. The inactivity watchdogs on
// the streaming layer detect *silence*, not a stuck tool — so nothing upstream
// ever trips. This module races every native dispatch against a wall-clock
// deadline AND the turn's abort signal, so the seam ALWAYS settles: on expiry
// (or abort) it rejects with a descriptive error that the dispatch site's
// existing catch turns into a synthetic tool-result row. A handler that was
// already running is left to settle on its own (we can't truly cancel arbitrary
// work), but its late settle is swallowed so it can never become an unhandled
// rejection. A call that arrives with the signal ALREADY aborted is never
// started at all — see the pre-aborted branch in raceToolCallTimeout.
//
// Env `DUIN_TOOL_TIMEOUT_MS`; default 60000; 0/negative disables the wall-clock
// timeout (abort-signal racing still applies). Kept as a tiny, side-effect-free
// unit so the budget + race logic is unit-testable without the chat IPC path.

/** Thrown when a tool handler exceeds the per-call wall-clock timeout. */
export class ToolTimeoutError extends Error {
  constructor(
    readonly toolName: string,
    readonly timeoutMs: number
  ) {
    super(`Tool '${toolName}' exceeded ${timeoutMs}ms wall-clock timeout`)
    this.name = 'ToolTimeoutError'
  }
}

/** Thrown when the turn's abort signal fires before a tool handler settles. */
export class ToolAbortError extends Error {
  constructor(readonly toolName: string) {
    super(`Tool '${toolName}' was aborted before it completed`)
    this.name = 'ToolAbortError'
  }
}

/**
 * Resolve the per-tool timeout in ms. Env `DUIN_TOOL_TIMEOUT_MS`; default
 * 60000; a non-finite/empty value falls back to the default; 0/negative
 * disables the wall-clock timeout (never a silent unraisable hardcode — it is
 * env-tunable and can be raised or turned off explicitly).
 */
export function toolTimeoutMs(): number {
  const rawEnv = process.env.DUIN_TOOL_TIMEOUT_MS
  const raw = Number(rawEnv)
  return Number.isFinite(raw) && rawEnv != null && rawEnv !== '' ? raw : 60_000
}

// Extra head-room added on top of a tool's OWN advertised timeout when that
// timeout is used as the outer wall-clock budget. The generic race is a
// backstop for a HUNG handler; a tool that already self-terminates (shell kills
// its child at its own timeout, then waits SIGKILL_GRACE_MS, then serialises a
// possibly-30KB result) must be given time for that whole path to run so the
// backstop only ever fires AFTER the tool's own timeout — never before it.
const WALL_CLOCK_GRACE_MS = 15_000

/**
 * Effective outer wall-clock budget (ms) for a native tool dispatch, or
 * `undefined` to let {@link raceToolCallTimeout} apply its generic default.
 *
 * WHY this exists: the generic default is 60s, but `shell_command` advertises to
 * the model a 120s default / 600s ceiling (`timeout_ms`) and keeps its child
 * alive that long. Racing it against the flat 60s backstop clipped that promise:
 * a `timeout_ms: 300000` job — or a plain `npm install`/build under the 120s
 * default — died at 60s with a ToolTimeoutError, silently overriding the budget
 * the model was told it had. This was invisible because the two timeouts live in
 * different modules (shell-tool clamps its own; the seam races a separate one)
 * and nothing threaded the tool's budget into the race. For `shell_command` we
 * therefore lift the backstop to at least its effective timeout + grace, so the
 * R4 hung-handler guard still fires, just only once the tool's own kill path has
 * had time to run. Other tools are unaffected (returns `undefined`).
 */
/** `wait_tasks` bounds its own wait: task-query clamps timeoutMs to [0, 300_000] and
 *  defaults to 30_000. Its schema advertises exactly that ceiling to the model. */
const WAIT_TASKS_DEFAULT_MS = 30_000
const WAIT_TASKS_MAX_MS = 300_000

export function toolWallClockBudgetMs(
  toolName: string,
  args: unknown,
  shellTimeouts: { defaultMs: number; maxMs: number }
): number | undefined {
  const generic = toolTimeoutMs()
  // Operator explicitly disabled/relaxed the backstop via env — honor it.
  if (generic <= 0) return undefined

  // A tool that declares and clamps its OWN wait must not be killed by the generic
  // backstop before that wait can finish. wait_tasks advertises up to 300s and clamps
  // to it, but got the generic 60s — so a legitimately-still-waiting call (nothing
  // hung, just a long real wait the model asked for) died at 60s with a generic
  // timeout message that pointed at the wrong thing entirely.
  if (toolName === 'wait_tasks') {
    const requested = (args as { timeoutMs?: unknown } | null | undefined)?.timeoutMs
    const n =
      typeof requested === 'number' && Number.isFinite(requested)
        ? requested
        : WAIT_TASKS_DEFAULT_MS
    // Mirror task-query's own clamp, so the backstop tracks the real wait rather than
    // whatever the model asked for.
    const effective = Math.min(Math.max(0, Math.floor(n)), WAIT_TASKS_MAX_MS)
    const budget = effective + WALL_CLOCK_GRACE_MS
    return budget > generic ? budget : undefined
  }

  if (toolName !== 'shell_command') return undefined
  const requested = (args as { timeout_ms?: unknown } | null | undefined)?.timeout_ms
  const n =
    typeof requested === 'number' && Number.isFinite(requested)
      ? requested
      : shellTimeouts.defaultMs
  const effective = Math.min(Math.max(0, n), shellTimeouts.maxMs)
  const budget = effective + WALL_CLOCK_GRACE_MS
  // Only override when the generic default would clip the tool's own budget.
  return budget > generic ? budget : undefined
}

export interface ToolTimeoutOpts {
  /** Turn/round abort signal — when it fires, the race rejects immediately. */
  signal?: AbortSignal
  /** Override the wall-clock timeout (ms). Defaults to {@link toolTimeoutMs}. */
  timeoutMs?: number
  /** Tool id/name, only used to make the error message legible. */
  toolName?: string
}

/**
 * Run `handler` but never wait longer than the wall-clock timeout, and bail as
 * soon as `signal` aborts. Resolves with the handler's value on success;
 * rejects with {@link ToolTimeoutError} on timeout or {@link ToolAbortError} on
 * abort. The losing handler promise is `.catch`-swallowed so a late rejection
 * can't surface as an unhandled rejection after we've already settled.
 *
 * If `signal` is ALREADY aborted on entry the handler is not invoked at all —
 * an aborted call must have no side effect, not merely a discarded result.
 */
export function raceToolCallTimeout<T>(
  handler: () => Promise<T>,
  opts: ToolTimeoutOpts = {}
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? toolTimeoutMs()
  const toolName = opts.toolName ?? 'tool'
  const signal = opts.signal

  return new Promise<T>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const finishResolve = (value: T): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }
    function onAbort(): void {
      finishReject(new ToolAbortError(toolName))
    }

    // Already aborted → reject and RETURN. The handler is never invoked.
    //
    // This previously invoked the handler anyway and discarded its value. That
    // discards the RESULT, not the SIDE EFFECT: a tool call already queued when
    // the user pressed Stop still ran, so push_notification still pushed,
    // spawn_task still spawned, schedule_wakeup still scheduled, loop_enqueue
    // still enqueued. Approval-gated tools were shielded (the gate auto-denies
    // on abort, upstream of here), which is why this only bit the ~20 mutating
    // tools that carry no approval gate. The old comment justified it as
    // avoiding "a tool that ignores the signal left hanging as an unhandled
    // promise" — but not calling the handler creates no promise to hang.
    //
    // Only the pre-aborted case is preventable here. A call already IN FLIGHT
    // when the signal fires has, by definition, started; `onAbort` still
    // settles the race and the late result is still swallowed, unchanged.
    if (signal?.aborted) {
      finishReject(new ToolAbortError(toolName))
      return
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finishReject(new ToolTimeoutError(toolName, timeoutMs))
      }, timeoutMs)
      // Don't keep the event loop alive purely for this watchdog.
      if (typeof (timer as { unref?: () => void }).unref === 'function') {
        ;(timer as { unref: () => void }).unref()
      }
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    // Kick off the handler. A throw from calling `handler()` (sync throw before
    // returning a promise) is captured by Promise.resolve().then. If we've
    // already settled via timeout/abort, finish* are no-ops and the late
    // settle is swallowed here — never an unhandled rejection.
    Promise.resolve()
      .then(handler)
      .then(finishResolve, (err) =>
        finishReject(err instanceof Error ? err : new Error(String(err)))
      )
  })
}
