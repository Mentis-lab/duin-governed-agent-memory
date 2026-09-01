// Pure debounce controller extracted from VisualHtmlEditor so its teardown /
// pre-read FLUSH behaviour is unit-testable without booting GrapesJS or a DOM.
//
// Why this exists: the visual editor's only route from a GrapesJS edit into the
// shared source buffer was a 400ms `setTimeout`. On teardown the effect cleanup
// called `clearTimeout` and dropped the armed export — so an edit made <400ms
// before switching modes (or before Save/Download/Copy read the source) was
// silently lost. A raw timer has no way to say "fire now and give me the value";
// this controller adds exactly that (`flush`) alongside the cancel path.

export interface DebouncedExport<T> {
  /** Arm (or re-arm) the debounce; the trailing edge calls produce()+emit(). */
  schedule(): void
  /**
   * Fire any armed export immediately and return the produced value, or null if
   * nothing was pending. Callers that read a value the emit feeds asynchronously
   * (e.g. React state) use the return so they see the freshest value NOW.
   */
  flush(): T | null
  /** Drop any armed export WITHOUT emitting. */
  cancel(): void
  /** True while an export is armed. */
  isPending(): boolean
}

export function createDebouncedExport<T>(
  produce: () => T,
  emit: (value: T) => void,
  delayMs: number
): DebouncedExport<T> {
  let timer: ReturnType<typeof setTimeout> | null = null

  const run = (): T => {
    timer = null
    const value = produce()
    emit(value)
    return value
  }

  return {
    schedule() {
      if (timer) clearTimeout(timer)
      timer = setTimeout(run, delayMs)
    },
    flush() {
      if (timer === null) return null
      clearTimeout(timer)
      return run()
    },
    cancel() {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
    },
    isPending() {
      return timer !== null
    }
  }
}
