import { useEffect, useState } from 'react'
import { useUiStore } from '@/stores/ui-store'
import { t } from '@/lib/i18n'

// C5 (audit remediation — PLANNING/DUIN_AUDIT_REMEDIATION.md). When no reasoning model
// is available (no BYO provider key AND no local Ollama), DUIN's entire intelligence
// layer is silently OFF: temporal extraction returns null, so the causal graph is bare
// wikilinks and every foresight surface (insights, forecasts, predicted-risks, patterns)
// renders EMPTY with no signal — the app looks alive but isn't reasoning. This banner
// surfaces that honestly and offers a one-click path to connect a model.
//
// Reads `brain:status` (already exposes `hasModel`). Re-checks on an interval + on
// window focus so it disappears the moment a model is connected. Session-dismissible so
// it isn't naggy for a user deliberately running keyless.
export function ReasoningOffBanner(): React.ReactElement | null {
  const [hasModel, setHasModel] = useState<boolean | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const openSettings = useUiStore((s) => s.openSettings)

  useEffect(() => {
    let cancelled = false
    const check = (): void => {
      window.api?.brain
        ?.status?.()
        .then((r: { success: boolean; data?: { hasModel: boolean } }) => {
          if (!cancelled && r?.success && r.data) setHasModel(r.data.hasModel)
        })
        .catch(() => {
          /* silent — banner just won't show */
        })
    }
    check()
    const timer = setInterval(check, 20_000)
    const onFocus = (): void => check()
    window.addEventListener('focus', onFocus)
    // Re-check the moment ANY key lands (onboarding card, Settings, unlock prompt) —
    // the 20s poll alone left this banner shouting "connect a model" for up to 20s
    // AFTER the operator had just connected one.
    const offKeychain = window.api?.settings?.onKeychainChanged?.(() => check())
    return () => {
      cancelled = true
      clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      offKeychain?.()
    }
  }, [])

  // Only show when we KNOW there's no model (not while status is still unknown).
  if (hasModel !== false || dismissed) return null

  return (
    <div className="flex items-start justify-between gap-3 border-b border-[var(--warning)] bg-[var(--warning)]/10 px-4 py-2.5 text-[12px] text-[var(--text-primary)]">
      <div className="flex flex-col gap-0.5">
        <div className="font-semibold">{t('Connect an AI model to get more from DUIN')}</div>
        <div className="text-[var(--text-muted)]">
          {t('DUIN already answers from your notes. Connect a model — a free one that runs on your computer, or an online service — to also get the connections, risks, and suggestions it spots for you.')}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <button
          onClick={() => openSettings('models')}
          className="rounded border border-[var(--warning)] bg-[var(--warning)]/20 px-2 py-1 text-[12px] font-medium hover:bg-[var(--warning)]/30"
        >
          {t('Connect a model')}
        </button>
        <button
          onClick={() => setDismissed(true)}
          aria-label={t('Dismiss')}
          className="rounded px-1.5 py-1 text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
