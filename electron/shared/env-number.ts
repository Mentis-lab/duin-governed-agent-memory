// env-number — THE owner of "read a number from the environment".
//
// `Number(process.env.X) || FALLBACK` is the idiom this codebase reached for 14 times, and it
// cannot express zero. `0` is falsy, so the fallback silently wins and any documented "set it to 0
// to disable" is a lie the type system cannot catch.
//
// That is not hypothetical. `construct.ts` documents its backoff helper as "0 disables the sleep —
// used by tests / tight-loop operators", the test suite sets DUIN_CONSTRUCT_BATCH_BACKOFF_MS='0'
// to make retries instant, and `Number('0') || 500` handed back 500 every run. The contract was
// false, the tests were slower than they claimed, and nothing failed.
//
// This is the SIGNAL-EXPRESSIVENESS class: one representation for two different states — here
// "unset" and "explicitly zero". The same shape produced a ten-day construction stall that looked
// like success (`status: 'built'` from four unrelated branches) and a 0% defect rate that read as
// 63% (`kind: 'entity'` meaning both "extraction failed" and "no kind applicable").
//
// Dependency-free on purpose so both the main process and the renderer can import it, and so it
// stays trivially testable.

export interface EnvNumberOptions {
  /** Reject values below this (after parsing). The fallback is used instead. */
  min?: number
  /** Reject values above this. The fallback is used instead. */
  max?: number
  /** Require an integer; a fractional value falls back. */
  integer?: boolean
}

/**
 * Read a number from `raw`, falling back ONLY when the value is genuinely absent or unusable.
 *
 * An explicit `0` is returned as `0`. An empty/whitespace string, an absent variable, `NaN`, and
 * `Infinity` all fall back — those are "no answer", which is a different state from "zero" and is
 * the whole distinction this function exists to preserve.
 *
 * Out-of-range values fall back rather than clamping: silently clamping is itself a collapse, since
 * the caller cannot tell "you asked for 3" from "you asked for -5 and I gave you the floor".
 */
export function envNumber(raw: string | undefined, fallback: number, opts: EnvNumberOptions = {}): number {
  if (raw === undefined || raw === null) return fallback
  const trimmed = String(raw).trim()
  if (trimmed === '') return fallback
  const n = Number(trimmed)
  if (!Number.isFinite(n)) return fallback
  if (opts.integer && !Number.isInteger(n)) return fallback
  if (opts.min !== undefined && n < opts.min) return fallback
  if (opts.max !== undefined && n > opts.max) return fallback
  return n
}

/** Convenience for the overwhelmingly common `process.env.NAME` case. */
export function envNum(name: string, fallback: number, opts: EnvNumberOptions = {}): number {
  return envNumber(process.env[name], fallback, opts)
}
