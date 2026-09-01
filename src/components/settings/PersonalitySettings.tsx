import { t } from '@/lib/i18n'
import { useSettingsStore } from '@/stores/settings-store'
import { AGENT_TONES } from '@/lib/agent-tones'
import { cn } from '@/duin/lib/utils'

// Voice & tone — DUIN is a personal agent, so how it talks is customizable. The
// chosen preset is injected as a <voice> directive into the system prompt (see
// electron/services/agent-tones.ts), shaping every reply in chat + headless runs.
export function PersonalitySettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const active = settings.agentTone ?? 'balanced'

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">Voice &amp; tone</h2>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          {t('How DUIN talks to you. Applies everywhere — chat and background runs.')}
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {AGENT_TONES.map((tone) => {
          const on = active === tone.id
          return (
            <button
              key={tone.id}
              onClick={() => updateSettings({ agentTone: tone.id })}
              className={cn(
                'rounded-lg border p-3 text-left transition-colors',
                on
                  ? 'border-[var(--accent)] bg-[var(--accent-dim)]'
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
                <span className="text-[12px] font-medium text-[var(--text-primary)]">{tone.label}</span>
              </div>
              <div className="mt-1 text-[12px] text-[var(--text-secondary)]">{tone.hint}</div>
              {tone.sample && (
                <div className="mt-1.5 border-l-2 border-[var(--panel-border)] pl-2 text-[12px] italic text-[var(--text-muted)]">
                  “{tone.sample}”
                </div>
              )}
            </button>
          )
        })}
      </div>

      {active === 'custom' && (
        <div>
          <div className="mb-1 text-[12px] font-medium text-[var(--text-secondary)]">{t('Custom voice directive')}</div>
          <textarea
            value={settings.agentToneCustom ?? ''}
            onChange={(e) => updateSettings({ agentToneCustom: e.target.value })}
            placeholder="e.g. Speak like a dry, deadpan British butler. Understated, precise, occasionally droll."
            rows={4}
            className="w-full resize-y rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-2 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
            Injected verbatim as the agent&apos;s voice. Describe tone, style, and quirks — keep it short.
          </div>
        </div>
      )}
    </div>
  )
}
