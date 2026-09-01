// Long-run L6 — dependency resilience. Every external call the iteration makes
// (the model turn, provider APIs) is wrapped so a flaky dependency degrades
// gracefully instead of killing a multi-hour loop:
//   - classifyError decides retry-vs-escalate,
//   - withRetry does bounded exponential backoff with INJECTED jitter/sleep
//     (deterministic in tests — no Math.random, no real timers in the logic),
//   - CircuitBreaker trips a persistently-failing provider so we stop hammering
//     it, and
//   - nextProviderInChain walks a persisted fallback chain so a mid-run switch
//     survives restart.
// All logic is pure or seam-injected; the only I/O is whatever `fn`/`sleepFn`
// close over.

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

export type ErrorClass = 'transient' | 'permanent'

const PERMANENT_STATUS = new Set([400, 401, 403, 404])
const PERMANENT_MARKERS = ['quota-exhausted', 'quota_exhausted', 'insufficient_quota']
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT'])
const TRANSIENT_MARKERS = ['econnreset', 'etimedout', 'timeout', 'socket hang up']

interface ErrShape {
  status: number | null
  code: string | null
  message: string
}

/** Pull status/code/message off an unknown thrown value without assuming shape. */
function shapeOf(err: unknown): ErrShape {
  if (typeof err === 'number') return { status: err, code: null, message: String(err) }
  if (typeof err === 'string') return { status: null, code: null, message: err }
  if (err && typeof err === 'object') {
    const o = err as Record<string, unknown>
    // status can live on .status or .statusCode (http libs differ)
    const rawStatus = o.status ?? o.statusCode
    const status = typeof rawStatus === 'number' ? rawStatus : null
    const code = typeof o.code === 'string' ? o.code : null
    const message = typeof o.message === 'string' ? o.message : ''
    return { status, code, message }
  }
  return { status: null, code: null, message: '' }
}

/**
 * PURE. Map a thrown value to a retry policy.
 *   transient: 429, any 5xx, ECONNRESET/ETIMEDOUT, 'timeout', 'socket hang up'.
 *   permanent: 400/401/403/404, 'quota-exhausted'/'insufficient_quota'.
 * Unknown -> 'transient' (one cheap retry beats a false escalation). Quota
 * markers are checked BEFORE status so a 429-with-insufficient_quota is
 * correctly permanent (no point retrying an exhausted budget).
 */
export function classifyError(err: unknown): ErrorClass {
  const { status, code, message } = shapeOf(err)
  const hay = `${code ?? ''} ${message}`.toLowerCase()

  // Permanent quota exhaustion wins over the generic 429->transient rule.
  if (PERMANENT_MARKERS.some((m) => hay.includes(m))) return 'permanent'

  // Transient network/code signals.
  if (code != null && TRANSIENT_CODES.has(code)) return 'transient'
  if (status === 429) return 'transient'
  if (status != null && status >= 500 && status < 600) return 'transient'
  if (TRANSIENT_MARKERS.some((m) => hay.includes(m))) return 'transient'

  // Permanent client errors.
  if (status != null && PERMANENT_STATUS.has(status)) return 'permanent'

  // Unknown — retrying once is cheaper than a false escalation.
  return 'transient'
}

// ---------------------------------------------------------------------------
// Retry with injected jitter/sleep
// ---------------------------------------------------------------------------

export interface RetryOptions {
  retries: number
  baseMs: number
  jitterFn: (attempt: number, baseMs: number) => number
  isTransient?: (err: unknown) => boolean
  sleepFn?: (ms: number) => Promise<void>
  maxMs?: number
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Run `fn`, retrying transient failures up to `opts.retries` times. Backoff for
 * attempt N is baseMs*2^N capped at maxMs; the actual delay is
 * jitterFn(attempt, cappedBackoff) so jitter is deterministic in tests. Rethrows
 * immediately on a non-transient error (default classifier = classifyError) or
 * once retries are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  const isTransient = opts.isTransient ?? ((e: unknown) => classifyError(e) === 'transient')
  const sleepFn = opts.sleepFn ?? realSleep
  let attempt = 0
  for (;;) {
    try {
      return await fn()
    } catch (err) {
      const exhausted = attempt >= opts.retries
      if (exhausted || !isTransient(err)) throw err
      const backoff = opts.baseMs * 2 ** attempt
      const capped = opts.maxMs != null && opts.maxMs > 0 ? Math.min(backoff, opts.maxMs) : backoff
      const delay = opts.jitterFn(attempt, capped)
      await sleepFn(delay)
      attempt += 1
    }
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker (one per provider key)
// ---------------------------------------------------------------------------

export type BreakerState = 'closed' | 'open' | 'half-open'

/**
 * Per-provider breaker. `failureThreshold` consecutive failures trip closed->open;
 * after `cooldownMs` an open breaker reports half-open (one trial request
 * allowed); a half-open success closes it, a half-open failure re-opens it. The
 * clock is injected so state transitions are pure/testable. A non-positive
 * `failureThreshold` disables tripping (breaker stays closed) — the "0 disables"
 * env convention.
 */
export class CircuitBreaker {
  readonly key: string
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly clock: () => number
  private failures = 0
  private openedAt: number | null = null
  private opened = false

  constructor(opts: {
    key: string
    failureThreshold: number
    cooldownMs: number
    clock?: () => number
  }) {
    this.key = opts.key
    this.failureThreshold = opts.failureThreshold
    this.cooldownMs = opts.cooldownMs
    this.clock = opts.clock ?? Date.now
  }

  state(now: number = this.clock()): BreakerState {
    if (this.opened && this.openedAt != null) {
      return now - this.openedAt >= this.cooldownMs ? 'half-open' : 'open'
    }
    return 'closed'
  }

  /** Gate a provider before use: true unless the breaker is fully open (in cooldown). */
  canRequest(now: number = this.clock()): boolean {
    return this.state(now) !== 'open'
  }

  onSuccess(): void {
    this.failures = 0
    this.openedAt = null
    this.opened = false
  }

  onFailure(now: number = this.clock()): void {
    if (this.failureThreshold <= 0) return // disabled — never trips
    // A failure during the half-open trial re-opens immediately.
    if (this.state(now) === 'half-open') {
      this.opened = true
      this.openedAt = now
      return
    }
    this.failures += 1
    if (this.failures >= this.failureThreshold) {
      this.opened = true
      this.openedAt = now
    }
  }
}

// ---------------------------------------------------------------------------
// Fallback chain
// ---------------------------------------------------------------------------

/**
 * PURE. First entry of `chain` not already in `tried`; null when the chain is
 * exhausted. Drives the persisted Loop.providerChain so a mid-run provider
 * switch survives restart.
 */
export function nextProviderInChain(chain: string[], tried: string[]): string | null {
  for (const provider of chain) {
    if (!tried.includes(provider)) return provider
  }
  return null
}
