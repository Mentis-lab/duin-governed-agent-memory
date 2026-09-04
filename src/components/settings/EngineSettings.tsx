import { t } from '@/lib/i18n'
import { Select } from '@/components/ui/Select'
import { SettingsPage, SettingsRow, SettingsSection, useSavedFlash } from '@/components/ui/settings'
import type { ToolSurfaceMode } from '@/lib/types'
import { useSettingsStore } from '@/stores/settings-store'
import { StreamingTimeoutsSettings } from './StreamingTimeoutsSettings'
import { ReasoningAuditSettings } from './ReasoningAuditSettings'
import { SeedBudgetSettings } from './SeedBudgetSettings'

// Engine — one page for the small engine-level knobs that each used to occupy their own
// near-empty Advanced tab. Each child renders one SettingsSection and no heading of its
// own; the page title is the tab label, drawn by SettingsDialog.
export function EngineSettings(): React.ReactElement {
  const toolSurface = useSettingsStore((s) => s.settings.toolSurface ?? 'full')
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const { saved, flash } = useSavedFlash()

  const setToolSurface = (next: ToolSurfaceMode): void => {
    void updateSettings({ toolSurface: next }).then((ok) => {
      if (ok) flash()
    })
  }

  return (
    <SettingsPage
      purpose={t('Timeouts, reasoning carry-over, fork seeds, and how tools are listed to the model.')}
    >
      <StreamingTimeoutsSettings />
      <ReasoningAuditSettings />
      <SeedBudgetSettings />
      <SettingsSection label={t('Tools')}>
        <SettingsRow
          label={t('Tool surface')}
          hint={t('Full: every tool is listed to the model on each turn. Lazy: MCP tools load on demand (fewer tokens, one extra step).')}
          saved={saved}
          control={
            <Select
              aria-label={t('Tool surface')}
              value={toolSurface}
              onChange={(e) => setToolSurface(e.target.value as ToolSurfaceMode)}
            >
              <option value="full">{t('Full')}</option>
              <option value="lazy">{t('Lazy')}</option>
            </Select>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}
