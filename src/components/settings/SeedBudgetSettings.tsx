import { t } from '@/lib/i18n'
import { NumberRow, SettingsSection } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'

// The fork seed budget, as one section of the Engine page. Above this many characters
// the forked conversation's seed is attached as a document instead of filling the
// first turn inline.

const DEFAULT_SEED_LENGTH = 8192

export function SeedBudgetSettings(): React.ReactElement {
  const value = useSettingsStore((s) => s.settings.safeSeedLength ?? DEFAULT_SEED_LENGTH)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  return (
    <SettingsSection label={t('Seed budget')}>
      <NumberRow
        label={t('Inline seed limit')}
        hint={t('When you fork a chat, how much of it is copied inline before it is attached as a document instead.')}
        value={value}
        spec={{ min: 1000 }}
        unit={t('characters')}
        defaultValue={DEFAULT_SEED_LENGTH}
        onCommit={(n) => updateSettings({ safeSeedLength: n })}
      />
    </SettingsSection>
  )
}
