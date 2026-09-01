import { nextFireAfter, parseCron } from './cron-expr'

// The 5-field cron parser this module used to carry was a COPY of the runner's that
// had lost trunk's DoS bound on the step branch and gained a `parseInt` leniency the
// runner lacked. Both are gone; cron-expr.ts is the single implementation and these
// re-exports keep the module surface (and the parity probe's import) intact.
export { parseCron, describeCron, nextFireAfter } from './cron-expr'

export type AutomationTriggerKind = 'one_shot' | 'schedule' | 'event' | 'monitor'

interface RetryPolicy {
  maxAttempts: number
  retryDelaySeconds: number
}

export type AutomationTrigger =
  | ({ kind: 'one_shot'; at: number } & RetryPolicy)
  | ({
      kind: 'schedule'
      cron?: string
      everySeconds?: number
      startAt?: number
      /** Set ONLY by parseStoredAutomationTrigger's last-resort arm: the row's
       *  trigger JSON and its legacy cron column were both unreadable. Carries the
       *  parser message so the runner can name it in `disabled_reason`. Never
       *  produced by parseAutomationTrigger. */
      unreadable?: string
    } & RetryPolicy)
  | ({ kind: 'event'; eventName: string } & RetryPolicy)
  | ({ kind: 'monitor'; everySeconds: number; startAt?: number } & RetryPolicy)

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_SECONDS = 60
const MIN_INTERVAL_SECONDS = 30

function finiteInteger(value: unknown, field: string, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min) {
    throw new Error(`automation trigger: "${field}" must be an integer >= ${min}.`)
  }
  return value
}

function optionalTimestamp(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  return finiteInteger(value, field, 0)
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`automation trigger: "${field}" is required.`)
  }
  return value.trim()
}

function retryPolicy(input: Record<string, unknown>): RetryPolicy {
  return {
    maxAttempts:
      input.maxAttempts === undefined
        ? DEFAULT_MAX_ATTEMPTS
        : finiteInteger(input.maxAttempts, 'maxAttempts', 1),
    retryDelaySeconds:
      input.retryDelaySeconds === undefined
        ? DEFAULT_RETRY_DELAY_SECONDS
        : finiteInteger(input.retryDelaySeconds, 'retryDelaySeconds', 1)
  }
}

export function parseAutomationTrigger(input: unknown): AutomationTrigger {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('automation trigger must be an object.')
  }
  const value = input as Record<string, unknown>
  const kind = requiredText(value.kind, 'kind') as AutomationTriggerKind
  const retry = retryPolicy(value)

  if (kind === 'one_shot') {
    return { kind, at: finiteInteger(value.at, 'at', 0), ...retry }
  }
  if (kind === 'schedule') {
    const cron = typeof value.cron === 'string' && value.cron.trim() !== '' ? value.cron.trim() : undefined
    const everySeconds = value.everySeconds === undefined
      ? undefined
      : finiteInteger(value.everySeconds, 'everySeconds', MIN_INTERVAL_SECONDS)
    if ((cron ? 1 : 0) + (everySeconds ? 1 : 0) !== 1) {
      throw new Error('automation trigger: schedule requires exactly one of "cron" or "everySeconds".')
    }
    if (cron) parseCron(cron)
    return {
      kind,
      ...(cron ? { cron } : {}),
      ...(everySeconds ? { everySeconds } : {}),
      ...(optionalTimestamp(value.startAt, 'startAt') !== undefined
        ? { startAt: optionalTimestamp(value.startAt, 'startAt') }
        : {}),
      ...retry
    }
  }
  if (kind === 'event') {
    return { kind, eventName: requiredText(value.eventName, 'eventName'), ...retry }
  }
  if (kind === 'monitor') {
    return {
      kind,
      everySeconds: finiteInteger(value.everySeconds, 'everySeconds', MIN_INTERVAL_SECONDS),
      ...(optionalTimestamp(value.startAt, 'startAt') !== undefined
        ? { startAt: optionalTimestamp(value.startAt, 'startAt') }
        : {}),
      ...retry
    }
  }
  throw new Error(`automation trigger: unsupported kind "${kind}".`)
}

export function legacyCronTrigger(cron: string): AutomationTrigger {
  return parseAutomationTrigger({ kind: 'schedule', cron })
}

/**
 * Read a stored trigger, NEVER throwing.
 *
 * This is on the hot path of every `listAutomations()`, which `tick()` calls every
 * 60 seconds inside a `try { … } catch { return }`. The legacy fallback used to sit
 * OUTSIDE the try, so a single row whose `cron` column no longer parses (an older,
 * more permissive expression; a hand-edited DB; a cron the converged parser now
 * correctly rejects) made `fromRow` throw → `listAutomations` throw → `tick` bail →
 * EVERY automation stop being scheduled, with a blank panel and no error anywhere.
 * One bad row must not take the scheduler down with it.
 *
 * An unreadable trigger is now surfaced, not swallowed: it comes back as a
 * `{ kind:'schedule' }` with NEITHER cron nor everySeconds, which
 * `isUnrunnableTrigger` reports and the runner turns into a disabled automation with
 * a reason on the card. Nothing silently no-ops.
 */
export function parseStoredAutomationTrigger(
  json: string | null | undefined,
  legacyCron: string
): AutomationTrigger {
  try {
    if (json) {
      try {
        return parseAutomationTrigger(JSON.parse(json))
      } catch {
        // Fall through to the shipped cron column. A malformed additive field
        // must not make a previously valid automation unreadable.
      }
    }
    return legacyCronTrigger(legacyCron)
  } catch (err) {
    return {
      kind: 'schedule',
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      retryDelaySeconds: DEFAULT_RETRY_DELAY_SECONDS,
      unreadable: err instanceof Error ? err.message : String(err)
    }
  }
}

/**
 * Why an automation's trigger cannot be scheduled, or null when it can.
 *
 * A `schedule` carrying neither `cron` nor `everySeconds` is the sentinel
 * `parseStoredAutomationTrigger` returns for a row it could not read at all —
 * `parseAutomationTrigger` rejects that shape, so it can never arrive from a
 * well-formed config.
 */
export function unrunnableTriggerReason(trigger: AutomationTrigger): string | null {
  if (trigger.kind === 'schedule' && !trigger.cron && !trigger.everySeconds) {
    return `its schedule could not be read (${trigger.unreadable ?? 'no cron or interval'})`
  }
  return null
}

export function serializeAutomationTrigger(trigger: AutomationTrigger): string {
  return JSON.stringify(trigger)
}

function nextIntervalBoundary(trigger: { everySeconds: number; startAt?: number }, now: number): number {
  const intervalMs = trigger.everySeconds * 1000
  const anchor = trigger.startAt ?? now
  if (anchor > now) return anchor
  return anchor + (Math.floor((now - anchor) / intervalMs) + 1) * intervalMs
}

export function initialNextRunAt(trigger: AutomationTrigger, now: number): number | null {
  if (trigger.kind === 'event') return null
  if (trigger.kind === 'one_shot') return Math.max(trigger.at, now)
  if (trigger.kind === 'schedule' && trigger.cron) {
    return nextFireAfter(trigger.cron, new Date(now))?.getTime() ?? null
  }
  return trigger.kind === 'schedule'
    ? nextIntervalBoundary({ everySeconds: trigger.everySeconds!, startAt: trigger.startAt }, now)
    : nextIntervalBoundary(trigger, now)
}

export function nextRunAfterSettlement(trigger: AutomationTrigger, now: number): number | null {
  if (trigger.kind === 'one_shot' || trigger.kind === 'event') return null
  if (trigger.kind === 'schedule' && trigger.cron) {
    return nextFireAfter(trigger.cron, new Date(now))?.getTime() ?? null
  }
  return trigger.kind === 'schedule'
    ? nextIntervalBoundary({ everySeconds: trigger.everySeconds!, startAt: trigger.startAt }, now)
    : nextIntervalBoundary(trigger, now)
}

export function triggerKey(trigger: AutomationTrigger, scheduledAt: number, eventId?: string): string {
  if (trigger.kind === 'event') {
    if (!eventId) throw new Error('event trigger requires a stable event id.')
    return `event:${trigger.eventName}:${eventId}`
  }
  return `${trigger.kind}:${scheduledAt}`
}

export function retryAt(trigger: AutomationTrigger, attempt: number, failedAt: number): number | null {
  if (attempt >= trigger.maxAttempts) return null
  const multiplier = 2 ** Math.max(0, attempt - 1)
  return failedAt + trigger.retryDelaySeconds * 1000 * multiplier
}
