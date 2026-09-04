import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * A short-lived "Saved" flag for auto-applied writes. Call `flash()` when a write
 * resolved true; `saved` stays up for `ms` and then drops. Re-flashing restarts the
 * timer, so a run of quick toggles reads as one save, not a flicker.
 */
export function useSavedFlash(ms = 1400): { saved: boolean; flash: () => void } {
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const flash = useCallback(() => {
    setSaved(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), ms)
  }, [ms])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  return { saved, flash }
}

/**
 * Run a control's onChange and flash only when it reports success. `updateSettings`
 * resolves `true` on a persisted write and `false` after it reverted (and toasted), so a
 * caller that returns that promise gets a mark that cannot claim a save that failed. A
 * handler that returns nothing gets no mark: unknown is not success.
 */
export function flashWhenSaved(result: Promise<boolean | void> | boolean | void, flash: () => void): void {
  Promise.resolve(result)
    .then((ok) => {
      if (ok === true) flash()
    })
    .catch(() => {
      /* the store already toasted; nothing to add */
    })
}
