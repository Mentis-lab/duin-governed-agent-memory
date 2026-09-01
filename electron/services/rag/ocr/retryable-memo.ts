// retryable-memo.ts — memoize a single async load, but NEVER cache a rejection.
//
// Extracted into its own module (not left inline in paddle-worker.ts) because that
// worker imports process.parentPort and the native onnxruntime-node addon at module
// load, so it can't run under vitest. This caching invariant is the load-bearing
// logic and gets its own testable home — the same extraction pattern as
// local-brain/active-skills.ts.
//
// The bug this guards against: a plain `let p; if (p) return p; p = load()` memo
// caches a REJECTED promise forever. One transient load failure (ONNX create on a
// still-copying .onnx, EBUSY/AV lock, momentary allocation failure) then disables
// the loaded resource for the entire process — every later caller awaits the same
// rejected promise. That was invisible for OCR because paddleOcrImage swallows the
// error into { text: '' }, so images kept ingesting with 0 chunks and never retried
// until app restart.

export interface RetryableMemo<T> {
  /** Return the in-flight or resolved load, starting one if none is cached. */
  get(): Promise<T>
  /** Forget any cached load so the next get() starts fresh. */
  reset(): void
}

export function createRetryableMemo<T>(load: () => Promise<T>): RetryableMemo<T> {
  let p: Promise<T> | null = null
  return {
    get(): Promise<T> {
      if (p) return p
      const started = load()
      p = started
      // A rejected load must not be memoized. Clear the slot on failure so a later
      // call re-attempts — but only if it still points at THIS attempt, so a
      // concurrent reset() + new load isn't clobbered by a stale rejection.
      started.catch(() => {
        if (p === started) p = null
      })
      return started
    },
    reset(): void {
      p = null
    }
  }
}
