import { t } from '@/lib/i18n'
import { AutomationsSettings } from './AutomationsSettings'
import { LoopSettings } from './LoopSettings'

// Workflows — the plain-language home for everything DUIN does on its own,
// merging the developer-era "Automations" and "Loops" panels under one roof so
// a non-coder sees a single, legible surface:
//   • Scheduled  — runs at set times (digests, reports, reminders)
//   • Autonomous — multi-step jobs DUIN drives on its own toward a goal
export function WorkflowsSettings() {
  return (
    <div className="flex flex-col gap-10">
      <section>
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Scheduled')}</h3>
        <p className="mt-1 mb-3 text-[12px] text-[var(--text-secondary)]">
          {t('Things DUIN does at set times — digests, reports, reminders.')}
        </p>
        <AutomationsSettings />
      </section>
      <section className="border-t border-[var(--panel-border)] pt-8">
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Autonomous')}</h3>
        <p className="mt-1 mb-3 text-[12px] text-[var(--text-secondary)]">
          {t('Multi-step jobs DUIN runs on its own until a goal or budget is reached.')}
        </p>
        <LoopSettings />
      </section>
    </div>
  )
}
