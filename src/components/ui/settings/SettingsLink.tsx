import { useUiStore, type SettingsTabId } from '@/stores/ui-store'

/**
 * An inline link to another Settings tab. Every cross-reference in copy ("Settings →
 * Brain") should be one of these rather than plain text, which is only possible now that
 * SettingsTabId names every tab the dialog renders.
 */
export function SettingsLink({ tab, children }: { tab: SettingsTabId; children: React.ReactNode }): React.ReactElement {
  const openSettings = useUiStore((s) => s.openSettings)
  return (
    <button
      type="button"
      onClick={() => openSettings(tab)}
      className="text-[var(--accent)] underline-offset-2 hover:underline"
    >
      {children}
    </button>
  )
}
