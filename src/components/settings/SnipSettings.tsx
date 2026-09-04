import { t, tf } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsLoadError, SettingsPage, SettingsRow, SettingsSection, ToggleRow } from '@/components/ui/settings'
import { useSettingsStore } from '@/stores/settings-store'
import { formatCount, useSnipStore } from '@/stores/snip-store'
import { SnipDiscoverPanel } from './SnipDiscoverPanel'

// SnipSettings — gain dashboard + filter library + discover panel. All numbers come from
// the snip IPC; the master switch is the one settings key (`snipEnabled`) the shell
// handler reads fresh on every call.

export function SnipSettings(): React.ReactElement {
  const stats = useSnipStore((s) => s.stats)
  const recent = useSnipStore((s) => s.recent)
  const filters = useSnipStore((s) => s.filters)
  const loading = useSnipStore((s) => s.loading)
  const error = useSnipStore((s) => s.error)
  const loadAll = useSnipStore((s) => s.loadAll)
  const reloadFilters = useSnipStore((s) => s.reloadFilters)
  const clearHistory = useSnipStore((s) => s.clearHistory)
  const openFilterDir = useSnipStore((s) => s.openFilterDir)

  const enabled = useSettingsStore((s) => s.settings.snipEnabled)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [showFilters, setShowFilters] = useState(false)
  const [resetting, setResetting] = useState(false)

  useEffect(() => {
    void loadAll()
  }, [loadAll])

  // Hot-reload when the watcher reports a YAML change in the user filter folder.
  useEffect(() => {
    if (!window.api?.snip?.onFiltersChanged) return
    return window.api.snip.onFiltersChanged(() => void loadAll())
  }, [loadAll])

  // The two-click "click again to confirm" button had no cancel path: the first click armed
  // it and nothing disarmed it. A confirm dialog has both answers.
  const onResetHistory = async (): Promise<void> => {
    if (!window.confirm(t('Reset the snip history? Statistics and recent activity go back to zero. Filters are kept.'))) return
    setResetting(true)
    try {
      await clearHistory()
    } finally {
      setResetting(false)
    }
  }

  const tokensSaved = stats ? stats.totalTokensBefore - stats.totalTokensAfter : 0
  const savingsPct = stats ? Math.round(stats.avgSavings * 100) : 0

  return (
    <SettingsPage
      purpose={t('Trims shell command output before it reaches the model, so long listings and logs cost fewer tokens. Filters are YAML rules; add your own in the user filter folder.')}
    >
      {error && <SettingsLoadError what={t('snip statistics')} message={error} onRetry={() => void loadAll()} />}

      <ToggleRow
        label={t('Trim shell output')}
        hint={t('When this is off, raw shell output reaches the model.')}
        checked={enabled}
        onChange={(v) => updateSettings({ snipEnabled: v })}
      >
        <div className="grid grid-cols-3 gap-4 font-mono text-[11px]">
          <Stat label={t('Tokens saved')} value={formatCount(tokensSaved)} />
          <Stat label={t('Average saving')} value={`${savingsPct}%`} />
          <Stat label={t('Commands')} value={formatCount(stats?.totalEvents ?? 0)} />
        </div>
        <div className="mt-3">
          <Sparkline values={stats?.sparkline ?? new Array<number>(14).fill(0)} />
        </div>
      </ToggleRow>

      <SettingsSection label={t('Top filters by tokens saved')}>
        <Card>
          {stats && stats.topByTokens.length > 0 ? (
            <table className="w-full font-mono text-[11px]">
              <thead>
                <tr className="text-left text-[var(--text-muted)]">
                  <th scope="col" className="py-1 font-medium">{t('Filter')}</th>
                  <th scope="col" className="py-1 text-right font-medium">{t('Runs')}</th>
                  <th scope="col" className="py-1 text-right font-medium">{t('Tokens saved')}</th>
                  <th scope="col" className="py-1 font-medium">{t('Ratio')}</th>
                </tr>
              </thead>
              <tbody>
                {stats.topByTokens.map((row) => (
                  <tr key={row.filter} className="border-t border-[var(--panel-border)]">
                    <td className="py-1 text-[var(--text-primary)]">{row.filter}</td>
                    <td className="py-1 text-right text-[var(--text-secondary)]">{row.runs}</td>
                    <td className="py-1 text-right text-[var(--text-secondary)]">
                      {formatCount(row.tokensSaved)}
                    </td>
                    <td className="py-1">
                      <Bar ratio={row.savingsRatio} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <EmptyState>{loading ? t('Loading…') : t('No events yet. Run a few shell commands.')}</EmptyState>
          )}
        </Card>
      </SettingsSection>

      <SettingsSection label={t('Recent activity')}>
        <Card>
          {recent.length > 0 ? (
            <ul className="space-y-1 font-mono text-[11px]">
              {recent.map((row, i) => (
                <li key={i} className="flex items-baseline justify-between gap-2">
                  <span className="truncate text-[var(--text-primary)]">
                    <span className="text-[var(--text-muted)]">[{row.filter}]</span> {row.command}
                  </span>
                  <span className="shrink-0 text-[var(--text-secondary)]">
                    {tf('{n} saved', { n: formatCount(row.tokensBefore - row.tokensAfter) })}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState>{t('No recent activity.')}</EmptyState>
          )}
        </Card>
      </SettingsSection>

      <SnipDiscoverPanel />

      <SettingsSection
        label={t('Filter library')}
        actions={
          <>
            <span className="text-[11px] text-[var(--text-muted)]">{tf('{n} filters', { n: filters.length })}</span>
            <Button size="sm" onClick={() => void openFilterDir()}>
              {t('Open filter folder')}
            </Button>
            <Button size="sm" onClick={() => void reloadFilters()}>
              {t('Reload')}
            </Button>
            <Button size="sm" aria-expanded={showFilters} onClick={() => setShowFilters((s) => !s)}>
              {showFilters ? t('Hide') : t('Show')}
            </Button>
          </>
        }
      >
        {showFilters && (
          <Card>
            {filters.length > 0 ? (
              <ul className="max-h-64 space-y-0.5 overflow-y-auto font-mono text-[11px]">
                {filters.map((f) => (
                  <li
                    key={`${f.source}-${f.name}-${f.path}`}
                    className="flex items-baseline justify-between gap-2"
                  >
                    <span className="truncate">
                      <span
                        className={
                          f.source === 'user'
                            ? 'rounded bg-[var(--accent)] px-1 text-[11px] text-[var(--on-accent)]'
                            : 'rounded border border-[var(--panel-border)] px-1 text-[11px] text-[var(--text-muted)]'
                        }
                      >
                        {f.source === 'user' ? t('yours') : t('built-in')}
                      </span>{' '}
                      <span className="text-[var(--text-primary)]">{f.name}</span>{' '}
                      <span className="text-[var(--text-muted)]">— {f.description}</span>
                      {f.overriddenByUser && (
                        <span className="ml-1 text-[11px] text-[var(--text-muted)]">
                          ({t('replaced by your file')})
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState>{loading ? t('Loading…') : t('No filters loaded.')}</EmptyState>
            )}
          </Card>
        )}
      </SettingsSection>

      <SettingsSection label={t('History')}>
        <SettingsRow
          tone="danger"
          label={t('Reset history')}
          hint={t('Clears the saved statistics and recent activity. Filters are kept.')}
          control={
            <Button variant="danger" size="sm" disabled={resetting} onClick={() => void onResetHistory()}>
              {resetting ? t('Resetting…') : t('Reset history')}
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPage>
  )
}

function Card({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">{children}</div>
  )
}

function Stat({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div>
      <div className="text-[var(--text-muted)]">{label}</div>
      <div className="text-[13px] text-[var(--text-primary)]">{value}</div>
    </div>
  )
}

function Sparkline({ values }: { values: number[] }): React.ReactElement {
  const max = Math.max(1, ...values)
  const last = values.length - 1
  return (
    <div role="img" aria-label={t('Tokens saved per day over the last 14 days')} className="flex h-8 items-end gap-0.5">
      {values.map((v, i) => (
        <div
          key={i}
          className="flex-1 rounded-t bg-[var(--accent)]"
          style={{ height: `${(v / max) * 100}%`, minHeight: v > 0 ? '2px' : '1px', opacity: v > 0 ? 0.9 : 0.2 }}
          title={
            i === last
              ? tf('{n} tokens saved today', { n: v })
              : tf('{n} tokens saved {d} days ago', { n: v, d: last - i })
          }
        />
      ))}
    </div>
  )
}

function Bar({ ratio }: { ratio: number }): React.ReactElement {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-[var(--bg-tertiary)]">
      <div
        className="h-full bg-[var(--accent)]"
        style={{ width: `${Math.max(0, Math.min(100, ratio * 100))}%` }}
      />
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="rounded-md border border-dashed border-[var(--panel-border)] px-3 py-4 text-center font-mono text-[11px] text-[var(--text-muted)]">
      {children}
    </div>
  )
}
