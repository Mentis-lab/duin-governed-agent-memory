import { t } from '@/lib/i18n'
import { useSettingsStore } from '@/stores/settings-store'

export function SeedBudgetSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const value = settings.safeSeedLength ?? 8192

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-[16px] font-semibold text-[var(--text-primary)]">{t('Seed budget')}</h2>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          {t('Maximum inline fork seed length before the seed is represented as an attached document marker.')}
        </p>
      </div>
      <label className="block text-[12px] text-[var(--text-secondary)]">
        <span className="mb-1 block">{t('Inline seed limit')}</span>
        <input
          type="number"
          min={1000}
          max={100000}
          step={512}
          value={value}
          onChange={(e) => {
            const next = Math.max(1000, Math.min(100000, Number(e.target.value) || 8192))
            void updateSettings({ safeSeedLength: next })
          }}
          className="w-40 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[16px] text-[var(--text-primary)]"
        />
      </label>
    </div>
  )
}
