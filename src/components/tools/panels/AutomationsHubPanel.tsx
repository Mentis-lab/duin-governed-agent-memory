import { t } from '@/lib/i18n'
import { useState } from 'react'
import { AutomationsPanel } from '@/components/automations/AutomationsPanel'
import { LoopsPanel } from './LoopsPanel'
import { ActivityTimeline } from '@/components/activity/ActivityTimeline'

// Automations hub — one home for time-triggered background behavior. Two
// distinct engines live here: Automations (a fixed prompt fired on a cron
// schedule, stateless per fire) and Loops (a stateful agentic worker that
// grinds a backlog under a token budget). Event-triggered Hooks are NOT here —
// they live in Settings, since they react to app events, not the clock. The
// Activity tab shows what actually fired. Each tab embeds its self-contained
// panel as-is.

type HubTab = 'automations' | 'loops' | 'activity'

interface TabDef {
  id: HubTab
  label: string
  hint: string
}

const TABS: TabDef[] = [
  { id: 'automations', label: 'Automations', hint: 'A fixed prompt fired on a schedule (cron)' },
  { id: 'loops', label: 'Loops', hint: 'An agentic worker grinding a backlog under a budget' },
  { id: 'activity', label: 'Activity', hint: 'What actually fired' }
]

export function AutomationsHubPanel(): React.ReactElement {
  const [tab, setTab] = useState<HubTab>('automations')

  return (
    <div className="flex h-full flex-col">
      {/* Tab bar — Automations (cron prompt) | Loops (backlog worker) | Activity */}
      <div
        role="tablist"
        aria-label={t('Automations hub')}
        className="flex shrink-0 items-center gap-1 border-b border-[var(--panel-border)] px-2 py-1.5"
      >
        {TABS.map((t) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={active}
              title={t.hint}
              onClick={() => setTab(t.id)}
              className={
                'rounded-md px-2.5 py-1 text-[14px] transition-colors ' +
                (active
                  ? 'bg-[var(--accent)] font-medium text-white'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--panel-border)]/40 hover:text-[var(--text-primary)]')
              }
            >
              {t.label}
            </button>
          )
        })}
      </div>

      {/* Body — each embedded panel owns its own scroll/layout. */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'automations' && <AutomationsPanel />}
        {tab === 'loops' && <LoopsPanel />}
        {tab === 'activity' && <ActivityTimeline />}
      </div>
    </div>
  )
}
