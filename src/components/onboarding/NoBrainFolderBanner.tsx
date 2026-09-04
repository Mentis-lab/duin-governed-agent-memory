import { useSettingsStore } from '@/stores/settings-store'
import { t } from '@/lib/i18n'

// The way back into first-run setup. "Skip for now" on the welcome step used to be a dead end:
// onboarding is consumed, the brain view renders an honestly empty canvas, and the only path to
// a folder was Settings → Brain, which a new operator has no reason to know about. While no brain
// folder is set (and the flow itself is not open), this sits where the other banners do and
// re-opens the flow. It disappears the moment a folder lands — the flow resyncs the settings
// store right after its settings write, so there is no reload in between.
interface NoBrainFolderBannerProps {
  /** True while the onboarding dialog is open — the banner would only duplicate it. */
  hidden: boolean
  onSetUp: () => void
}

export function NoBrainFolderBanner({ hidden, onSetUp }: NoBrainFolderBannerProps): React.ReactElement | null {
  const loaded = useSettingsStore((s) => s.loaded)
  const dir = useSettingsStore((s) => s.settings.localBrainNotesDir)
  // Not before settings have loaded: the store's default is '' and the banner would flash for
  // every operator who has a folder, on every boot.
  if (hidden || !loaded || (dir ?? '').trim()) return null
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-[var(--accent)]/35 bg-[var(--accent-dim)] px-4 py-2.5 text-[12px] text-[var(--text-primary)]"
    >
      <span className="min-w-0 flex-1">
        <span className="font-semibold">{t('No brain folder yet.')}</span>{' '}
        <span className="text-[var(--text-secondary)]">
          {t('Point DUIN at a folder of notes — or any empty folder — to start your brain.')}
        </span>
      </span>
      <button
        onClick={onSetUp}
        className="shrink-0 rounded border border-[var(--accent)] bg-[var(--accent)]/15 px-2.5 py-1 text-[12px] font-medium hover:bg-[var(--accent)]/25"
      >
        {t('Set up my brain')}
      </button>
    </div>
  )
}
