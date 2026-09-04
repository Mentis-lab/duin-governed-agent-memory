import { useCallback, useEffect, useState } from 'react'
import { t } from '@/lib/i18n'
import { isMac } from '@/lib/platform'
import { toast } from '@/stores/toast-store'
import { invoke, query } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { PanelState } from '@/components/ui/PanelState'
import { Button } from '@/components/ui/Button'
import { SettingsSection, SettingsRow, SettingsLoadError, SettingsLoading } from '@/components/ui/settings'

type Status = 'granted' | 'denied' | 'not-applicable'

const STATUS_LABEL: Record<Status, () => string> = {
  granted: () => t('Granted'),
  denied: () => t('Not granted'),
  'not-applicable': () => t('Not applicable')
}

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
  const [state, setState] = useState<PanelStatus<Status>>(panelLoading())
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    const r = await query(t('Full Disk Access status'), () => window.api.settings.fullDiskAccessStatus())
    setState(panelFromResult(r))
  }, [])

  useEffect(() => {
    if (!isMac()) return
    void refresh()
    // Re-check on focus: the user grants this in System Settings, in another window,
    // so nothing in DUIN would otherwise tell it the answer changed.
    const onFocus = (): void => void refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  if (!isMac()) return null

  const open = async (): Promise<void> => {
    setBusy(true)
    try {
      const opened = await invoke(t('open System Settings'), () => window.api.settings.openFullDiskAccessSettings())
      // The deep link can fail on a locked-down Mac. Say where to go rather than
      // leaving a button that appears to do nothing.
      if (!opened) toast.error(t('Could not open the pane. In System Settings, go to Privacy & Security, then Full Disk Access.'))
    } catch (e) {
      toast.error(describeError(e, t('Could not open System Settings')))
    } finally {
      setBusy(false)
    }
  }

  const what = t('the Full Disk Access status')

  return (
    <SettingsSection label={t('Full Disk Access')}>
      <SettingsRow
        label={t('Let DUIN read protected folders')}
        hint={t('macOS blocks apps from reading protected folders until you allow it. Grant this if DUIN cannot reach a vault you have pointed it at.')}
        control={
          <Button onClick={() => void open()} disabled={busy}>
            {busy ? t('Opening…') : t('Open System Settings')}
          </Button>
        }
      >
        <PanelState
          state={state}
          loading={<SettingsLoading what={what} />}
          error={(message, retry) => <SettingsLoadError what={what} message={message} onRetry={retry} />}
          empty={null}
          isEmpty={() => false}
          onRetry={() => void refresh()}
        >
          {(status) => (
            <span
              className={`rounded bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[11px] ${
                status === 'granted' ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'
              }`}
            >
              {STATUS_LABEL[status]()}
            </span>
          )}
        </PanelState>
        <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-muted)]">
          {t('In the pane that opens, switch DUIN on. If DUIN is not listed, use + to add it from Applications. An unsigned build may need this granted again after an update.')}
        </p>
      </SettingsRow>
    </SettingsSection>
  )
}
