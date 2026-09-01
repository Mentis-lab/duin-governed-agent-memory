import { useCallback, useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { isMac } from '@/lib/platform'

type State = 'granted' | 'denied' | 'not-applicable' | 'unknown'

/**
 * Full Disk Access, macOS only.
 *
 * There is NO API to request it. Apple exposes `askForMediaAccess` for camera and
 * microphone and nothing equivalent here, so every app that offers a button for this —
 * node-mac-permissions included — does exactly what this does: opens the pane and asks
 * the user to flip the switch. The value this adds is telling them whether it is already
 * on, and taking them straight there instead of describing a path through System Settings.
 *
 * Renders nothing off macOS, where the concept does not exist.
 */
export function FullDiskAccessRow() {
  const [state, setState] = useState<State>('unknown')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const res = await window.api?.settings?.fullDiskAccessStatus?.()
    setState(res?.success && res.data ? res.data : 'unknown')
  }, [])

  useEffect(() => {
    if (!isMac()) return
    void refresh()
    // Re-check on focus: the user grants this in System Settings, in another window,
    // so nothing in DUIN would otherwise tell it the answer changed.
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (!isMac()) return null

  const open = async () => {
    setBusy(true)
    const res = await window.api?.settings?.openFullDiskAccessSettings?.()
    setBusy(false)
    if (!res?.success || !res.data) {
      // The deep link can fail on a locked-down Mac. Say where to go rather than
      // leaving a button that appears to do nothing.
      setState('unknown')
    }
  }

  const granted = state === 'granted'

  return (
    <div>
      <div className="mb-2 text-[12px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
        {t('Full Disk Access')}
      </div>
      <p className="mb-2 text-[12px] leading-relaxed text-[var(--text-muted)]">
        macOS blocks apps from reading protected folders until you allow it. Grant this if
        DUIN cannot reach a vault you have pointed it at.
      </p>
      <div className="flex items-center gap-3">
        <span
          className={`rounded px-2 py-1 font-mono text-[11px] ${
            granted
              ? 'bg-[var(--bg-primary)] text-[var(--success)]'
              : 'bg-[var(--bg-primary)] text-[var(--text-muted)]'
          }`}
        >
          {granted ? 'granted' : state === 'denied' ? 'not granted' : 'unknown'}
        </span>
        <button
          onClick={() => void open()}
          disabled={busy}
          className="rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-60"
        >
          {busy ? 'Opening…' : t('Open System Settings')}
        </button>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
        In the pane that opens, switch DUIN on. If DUIN is not listed, use <b>+</b> to add
        it from Applications. macOS ties this permission to an app’s code signature, so an
        unsigned or ad-hoc build may need it re-applied after an update.
      </p>
    </div>
  )
}
