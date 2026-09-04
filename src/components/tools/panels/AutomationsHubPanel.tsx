import { t } from '@/lib/i18n'
import { useState } from 'react'
import { AutomationsPanel } from '@/components/automations/AutomationsPanel'
import { GovernancePanel } from '@/components/automations/GovernancePanel'
import { LoopsPanel } from './LoopsPanel'
import { ActivityTimeline } from '@/components/activity/ActivityTimeline'

// Automations hub — one home for everything DUIN does on its own, on the clock. Two engines
// live here: Automations (a fixed prompt fired on a schedule, stateless per fire) and Loops
// (a stateful worker that grinds a backlog under a budget). Event-triggered Hooks are NOT
// here — they live in Settings, since they react to app events, not the clock. Activity
// shows what actually ran; Governance shows the capability breaker and what the governor
// has done (moved out of Settings on 2026-09-03: monitoring, not settings). Each tab embeds
// its self-contained panel as-is.

type HubTab = 'automations' | 'loops' | 'activity' | 'governance'

interface TabDef {
  id: HubTab
  label: string
  hint: string
}

export function AutomationsHubPanel(): React.ReactElement {
  const [tab, setTab] = useState<HubTab>('automations')

  // Built per render so the labels follow the UI language.
  const tabs: TabDef[] = [
    { id: 'automations', label: t('Automations'), hint: t('Prompts that run on a schedule') },
    { id: 'loops', label: t('Loops'), hint: t('Workers that keep going toward a goal under a budget') },
    { id: 'activity', label: t('Activity'), hint: t('What actually ran') },
    { id: 'governance', label: t('Governance'), hint: t('The capability breaker and what the governor has done') }
  ]

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar — Automations | Loops | Activity | Governance */}
      <div
        role="tablist"
        aria-label={t('Automations hub')}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--panel-border)] px-2 py-1.5"
      >
        {tabs.map((def) => {
          const active = def.id === tab
          return (
            <button
              key={def.id}
              type="button"
              role="tab"
              aria-selected={active}
              title={def.hint}
              onClick={() => setTab(def.id)}
              className={
                'rounded-md px-2.5 py-1 text-[14px] transition-colors ' +
                (active
                  ? 'bg-[var(--accent)] font-medium text-[var(--on-accent)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--panel-border)]/40 hover:text-[var(--text-primary)]')
              }
            >
              {def.label}
            </button>
          )
        })}
      </div>

      {/* Body — each embedded panel owns its own scroll/layout. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'automations' && <AutomationsPanel />}
        {tab === 'loops' && <LoopsPanel />}
        {tab === 'activity' && <ActivityTimeline />}
        {tab === 'governance' && <GovernancePanel />}
      </div>
    </div>
  )
}
