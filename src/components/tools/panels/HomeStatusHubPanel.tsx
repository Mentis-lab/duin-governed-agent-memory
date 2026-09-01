import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { BrainStatusPanel } from './BrainStatusPanel'
import { CalibrationPanel } from './CalibrationPanel'
import { NeedsYouPanel } from './NeedsYouPanel'
import { useNoticesStore } from '@/stores/notices-store'

// Status hub — the glanceable "where do things stand" surface, answering it in three
// registers: is the machine healthy (Brain status), is the judgment paying off
// (Calibration), and what does it want from me (Needs you). Active Work lives on its
// own dedicated surface, so it's no longer duplicated here. Each tab embeds the
// existing, self-contained panel as-is.

type HubTab = 'needs' | 'status' | 'calibration'

interface TabDef {
  id: HubTab
  label: string
  hint: string
}

const TABS: TabDef[] = [
  { id: 'needs', label: 'Needs you', hint: 'What happened while you were away, and what still wants a decision' },
  { id: 'status', label: 'Brain status', hint: 'Engine, graph, loops & sources — what\'s fresh' },
  { id: 'calibration', label: 'Calibration', hint: 'Whether the foresight pays off — track record by tier' }
]

export function HomeStatusHubPanel(): React.ReactElement {
  const counts = useNoticesStore((s) => s.counts)
  const refreshCounts = useNoticesStore((s) => s.refreshCounts)
  // Open on whatever is waiting. Landing on Brain status while something needs an
  // answer is how the old surface managed to hold a decision nobody ever saw.
  const [tab, setTab] = useState<HubTab>(() =>
    useNoticesStore.getState().counts.unread > 0 ? 'needs' : 'status'
  )

  useEffect(() => {
    void refreshCounts()
  }, [refreshCounts])

  return (
    <div className="flex h-full flex-col">
      <div
        role="tablist"
        aria-label={t('Home and status hub')}
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
              {t.id === 'needs' && counts.unread > 0 && (
                <span
                  className={
                    'ml-1.5 rounded-full px-1.5 py-0.5 text-[11px] font-medium tabular-nums ' +
                    (active
                      ? 'bg-white/20 text-white'
                      : 'bg-[var(--accent)]/15 text-[var(--accent)]')
                  }
                >
                  {counts.unread}
                </span>
              )}
            </button>
          )
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'needs' && <NeedsYouPanel embedded />}
        {tab === 'status' && <BrainStatusPanel embedded />}
        {tab === 'calibration' && <CalibrationPanel embedded />}
      </div>
    </div>
  )
}
