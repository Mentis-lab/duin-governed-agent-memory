import { useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { SettingsRow, SettingsSection } from '@/components/ui/settings'
import { invoke } from '@/lib/ipc-client'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import { useSettingsStore } from '@/stores/settings-store'

// Settings portability (2026-09-03 settings evaluation, D4). "My DUIN settings" lived in
// eight places with no export, import or reset; this section covers the four that are
// plain JSON under userData (settings, channels, pairings, connected agents). Keys never
// travel — safeStorage ciphertext is bound to the OS user — and the database has its own
// backups on this same page.

type ExportResult = { cancelled: true } | { cancelled: false; path: string; files: string[] }
type ImportResult =
  | { cancelled: true }
  | { cancelled: false; applied: string[]; refused: string[]; keptVaultPath: boolean; restartNeeded: boolean }
type ResetResult = { kept: string[] }

type Busy = 'export' | 'import' | 'reset' | null

export function SettingsBackupSection(): React.ReactElement {
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const [busy, setBusy] = useState<Busy>(null)

  const run = async (kind: Exclude<Busy, null>, fallback: string, work: () => Promise<void>): Promise<void> => {
    setBusy(kind)
    try {
      await work()
    } catch (e) {
      toast.error(describeError(e, fallback))
    } finally {
      setBusy(null)
    }
  }

  const exportBundle = (): void =>
    void run('export', t('Could not export settings'), async () => {
      const r = await invoke<ExportResult>('export settings', () => window.api?.settings?.exportBundle?.())
      if (r.cancelled) return
      toast.success(tf('Settings exported to {path}', { path: r.path }))
    })

  const importBundle = (): void =>
    void run('import', t('Could not import settings'), async () => {
      const r = await invoke<ImportResult>('import settings', () => window.api?.settings?.importBundle?.())
      if (r.cancelled) return
      await loadSettings()
      toast.success(
        r.restartNeeded
          ? t('Settings imported. Restart DUIN to apply channels, pairings and connected agents.')
          : t('Settings imported.')
      )
      if (r.keptVaultPath) toast.info(t('Kept your current brain folder: the exported one is not on this computer.'))
      if (r.refused.length > 0) toast.warning(tf('Some entries were not applied: {reasons}', { reasons: r.refused.join('; ') }))
    })

  const reset = (): void => {
    if (typeof window !== 'undefined' && !window.confirm(t('Reset every setting to its default? Your brain folder and keys are kept.')))
      return
    void run('reset', t('Could not reset settings'), async () => {
      await invoke<ResetResult>('reset settings', () => window.api?.settings?.resetToDefaults?.())
      await loadSettings()
      toast.success(t('Settings reset to defaults.'))
    })
  }

  return (
    <SettingsSection
      label={t('Settings backup')}
      description={t(
        'Export your settings, channels, pairings and connected agents as one file, or bring them back from one. API keys are never exported; enter them again on the new computer.'
      )}
    >
      <SettingsRow
        label={t('Export settings')}
        hint={t('Saves a JSON file you can keep or move to another computer.')}
        control={
          <Button size="sm" onClick={exportBundle} disabled={busy !== null}>
            {t('Export…')}
          </Button>
        }
      />
      <SettingsRow
        label={t('Import settings')}
        hint={t('Replaces the current settings with the ones in the file. Channels, pairings and agents apply after a restart.')}
        control={
          <Button size="sm" onClick={importBundle} disabled={busy !== null}>
            {t('Import…')}
          </Button>
        }
      />
      <SettingsRow
        label={t('Reset to defaults')}
        hint={t('Puts every setting back to its default. Your brain folder, your keys and the consent you gave are kept.')}
        tone="warning"
        control={
          <Button size="sm" variant="danger" onClick={reset} disabled={busy !== null}>
            {t('Reset…')}
          </Button>
        }
      />
    </SettingsSection>
  )
}
