// Result — the renderer's ONE way to carry "this read failed" across a transport
// boundary without it being mistakable for data.
//
// WHY THIS EXISTS (audit pattern A, "the confident zero"): both renderer transports
// could express failure only as an absence. `IpcResponse` carries `success:false`,
// but every consumer unwrapped it as `res.data ?? []`, so a dead brain and an empty
// ledger produced the SAME value — and the UI then asserted the empty one out loud
// ("No decisions on record yet", "No conversation policies"). Over a security
// surface and an autonomy product that is not a cosmetic bug: it is the product
// stating a fact it has no evidence for.
//
// The fix is structural, not a lint: a failed read must not be ASSIGNABLE to the
// success branch. `Result<T>` is a discriminated union, so `r.data` does not exist
// until `r.ok` has been narrowed, and there is deliberately NO `unwrapOr(fallback)`
// helper here — that helper IS the bug, spelled politely.

/** A read that succeeded. `data` is only reachable after narrowing on `ok`. */
export type Ok<T> = { readonly ok: true; readonly data: T }

/** A read that failed. `error` is always a human-readable sentence, never empty. */
export type Err = { readonly ok: false; readonly error: string; readonly cause?: unknown }

export type Result<T> = Ok<T> | Err

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data }
}

export function err(error: string, cause?: unknown): Err {
  // An empty message is how a failure state ends up rendering as blank space,
  // which is the confident zero again one layer up.
  return { ok: false, error: error.trim() || 'Unknown error', cause }
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok
}

export function isErr<T>(r: Result<T>): r is Err {
  return !r.ok
}

/**
 * Best-effort human sentence for an unknown thrown value. `fallback` is used when
 * the throw carried nothing usable (a bare `throw undefined`, an empty message).
 */
export function describeError(cause: unknown, fallback = 'Unknown error'): string {
  if (cause instanceof Error && cause.message.trim()) return cause.message.trim()
  if (typeof cause === 'string' && cause.trim()) return cause.trim()
  if (cause && typeof cause === 'object') {
    const maybe = cause as { message?: unknown; error?: unknown }
    if (typeof maybe.message === 'string' && maybe.message.trim()) return maybe.message.trim()
    if (typeof maybe.error === 'string' && maybe.error.trim()) return maybe.error.trim()
  }
  return fallback
}

/** The shape every main-process IPC handler returns. Declared here rather than
 *  imported so this module stays dependency-free and usable from both projects. */
export interface IpcEnvelope<T> {
  success: boolean
  data?: T
  error?: string
}

/**
 * Convert an IPC envelope into a Result. `label` names the read so the error the
 * operator sees says WHICH read failed, not just "failed".
 *
 * A missing/undefined envelope (preload surface absent — the `if (!window.api?.x) return`
 * guard that used to leave stores silently empty) is a FAILURE, not an empty success.
 */
export function fromIpc<T>(
  envelope: IpcEnvelope<T> | null | undefined,
  label: string
): Result<T> {
  if (!envelope) return err(`${label}: no response from the main process`)
  if (!envelope.success) return err(`${label}: ${envelope.error ?? 'request failed'}`)
  if (envelope.data === undefined) return err(`${label}: request succeeded but returned no data`)
  return ok(envelope.data)
}

/**
 * Run an async read and land it in a Result. Anything thrown becomes `ok:false`
 * carrying the original as `cause`, so nothing is swallowed and nothing is
 * silently coerced to an empty collection.
 *
 * An AbortError is re-thrown, not converted: an aborted read is a CANCELLED read
 * (the component unmounted, the query changed), and painting "failed to load" for
 * a deliberate cancellation is its own species of lie.
 */
export async function attempt<T>(label: string, run: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await run())
  } catch (cause) {
    if (isAbort(cause)) throw cause
    return err(`${label}: ${describeError(cause, 'request failed')}`, cause)
  }
}

/** True for the DOMException / error a fetch AbortSignal produces, cross-runtime. */
export function isAbort(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false
  const name = (cause as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
}
