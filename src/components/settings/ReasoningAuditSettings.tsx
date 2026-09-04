import { t } from '@/lib/i18n'
import { SettingsSection, ToggleRow } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'

// The one user-facing knob of the reasoning audit, as one section of the Engine page:
// `includePastReasoningInContext`. Every reply's reasoning is persisted with it
// regardless; this decides whether that reasoning is sent back to the model on the next
// turn. On by default; off saves context in long conversations.

export function ReasoningAuditSettings(): React.ReactElement {
  const enabled = useSettingsStore((s) => s.settings.includePastReasoningInContext ?? true)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  return (
    <SettingsSection label={t('Reasoning audit')}>
      <ToggleRow
        label={t('Send past reasoning back to the model')}
        hint={t('Every reply\'s reasoning is kept with it. When this is on, past reasoning is sent back to the model on the next turn so it can check its own earlier thinking; it costs context, so turn it off in long conversations.')}
        checked={enabled}
        onChange={(v) => updateSettings({ includePastReasoningInContext: v })}
      />
    </SettingsSection>
  )
}
