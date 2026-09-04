import { t } from '@/lib/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { AGENT_TONES } from '@/lib/agent-tones'
import { cn } from '@/duin/lib/utils'
import { SettingsPage, SettingsSection, SettingsRow, SettingsLink, SavedMark, DraftTextarea } from '@/components/ui/settings'
import { flashWhenSaved, useSavedFlash } from '@/components/ui/settings/useSavedFlash'

// Voice & tone — DUIN is a personal agent, so how it talks is customizable. The
// chosen preset is injected as a <voice> directive into the system prompt (see
// electron/services/agent-tones.ts), shaping every reply in chat + headless runs.
export function PersonalitySettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const active = settings.agentTone ?? 'balanced'
  const { saved, flash } = useSavedFlash()

  return (
    <SettingsPage
      purpose={
        <>
          {t('How DUIN talks to you, in chat and in background runs.')}{' '}
          {t('Character itself lives in SOUL.md under')}{' '}
          <SettingsLink tab="foundations">{t('Foundations')}</SettingsLink>
        </>
      }
    >
      <SettingsSection label={t('Voice')} actions={saved ? <SavedMark /> : undefined}>
        <div role="radiogroup" aria-label={t('Voice')} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {AGENT_TONES.map((tone) => {
            const on = active === tone.id
            const sample = tone.sample()
            return (
              <button
                key={tone.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => {
                  if (!on) flashWhenSaved(updateSettings({ agentTone: tone.id }), flash)
                }}
                className={cn(
                  'rounded-lg border bg-[var(--bg-primary)] p-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
                  on
                    ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                    : 'border-[var(--panel-border)] hover:border-[var(--accent)] hover:bg-[var(--bg-tertiary)]'
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'inline-block h-3 w-3 shrink-0 rounded-full border',
                      on ? 'border-[var(--accent)] bg-[var(--accent)]' : 'border-[var(--text-muted)]'
                    )}
                    aria-hidden
                  />
                  <span className="text-[12px] font-medium text-[var(--text-primary)]">{tone.label()}</span>
                </div>
                <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{tone.hint()}</div>
                {sample && (
                  <div className="mt-1.5 border-l-2 border-[var(--panel-border)] pl-2 text-[12px] italic text-[var(--text-muted)]">
                    “{sample}”
                  </div>
                )}
              </button>
            )
          })}
        </div>
      </SettingsSection>

      {active === 'custom' && (
        <SettingsSection label={t('Custom voice')}>
          <SettingsRow
            label={t('Custom voice directive')}
            hint={t('Used word for word as DUIN’s voice. Describe tone, style and quirks, and keep it short.')}
          >
            {/* A draft, committed on blur or Ctrl+Enter. The textarea this replaces was bound to
                the store value, which only updates after the serialized settings write resolves,
                so fast typing dropped characters and Chinese and Japanese composition broke. */}
            <DraftTextarea
              aria-label={t('Custom voice directive')}
              value={settings.agentToneCustom ?? ''}
              onCommit={(next) => updateSettings({ agentToneCustom: next })}
              rows={4}
              placeholder={t('e.g. Speak like a dry, deadpan British butler. Understated, precise, occasionally droll.')}
            />
          </SettingsRow>
        </SettingsSection>
      )}
    </SettingsPage>
  )
}
