import { t, tf } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { SettingsLoading, SettingsSection } from '@/components/ui/settings'
import { formatCount, useSnipStore } from '@/stores/snip-store'

// SnipDiscoverPanel — scans the command log for shell calls in the last N days that did
// NOT match any filter, ranks them by total estimated tokens, and surfaces the top ones
// as candidates for a custom YAML filter. "Write a filter" opens the user filter folder
// in the OS file explorer.

const WINDOWS: number[] = [7, 30, 90]

function windowLabel(days: number): string {
  switch (days) {
    case 7:
      return t('7 days')
    case 30:
      return t('30 days')
    case 90:
      return t('90 days')
    default:
      return tf('{n} days', { n: days })
  }
}

export function SnipDiscoverPanel(): React.ReactElement {
  const discover = useSnipStore((s) => s.discover)
  const loadDiscover = useSnipStore((s) => s.loadDiscover)
  const openFilterDir = useSnipStore((s) => s.openFilterDir)
  const [sinceDays, setSinceDays] = useState(7)

  useEffect(() => {
    void loadDiscover(sinceDays)
  }, [loadDiscover, sinceDays])

  return (
    <SettingsSection
      label={t('Find missed savings')}
      description={t('Shell commands that no filter matched, ranked by the tokens they cost. Write a filter for the big ones.')}
      actions={
        <div role="group" aria-label={t('Time window')} className="flex gap-1">
          {WINDOWS.map((days) => (
            <Button
              key={days}
              size="sm"
              variant={sinceDays === days ? 'primary' : 'secondary'}
              aria-pressed={sinceDays === days}
              onClick={() => setSinceDays(days)}
            >
              {windowLabel(days)}
            </Button>
          ))}
        </div>
      }
    >
      <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        {discover === null ? (
          <SettingsLoading what={t('suggestions')} />
        ) : discover.suggestions.length > 0 ? (
          <table className="w-full font-mono text-[11px]">
            <thead>
              <tr className="text-left text-[var(--text-muted)]">
                <th scope="col" className="py-1 font-medium">{t('Command')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('Runs')}</th>
                <th scope="col" className="py-1 text-right font-medium">{t('Tokens')}</th>
                <th scope="col" className="py-1 font-medium">{t('Category')}</th>
                <th scope="col" className="py-1" />
              </tr>
            </thead>
            <tbody>
              {discover.suggestions.map((s) => (
                <tr key={s.commandPattern} className="border-t border-[var(--panel-border)]">
                  <td className="py-1 text-[var(--text-primary)]" title={s.sampleCommand}>
                    {s.commandPattern}
                  </td>
                  <td className="py-1 text-right text-[var(--text-secondary)]">{s.runs}</td>
                  <td className="py-1 text-right text-[var(--text-secondary)]">
                    {formatCount(s.estimatedTokens)}
                  </td>
                  <td className="py-1 text-[var(--text-muted)]">{s.suggestedCategory}</td>
                  <td className="py-1 text-right">
                    <Button
                      size="sm"
                      onClick={() => void openFilterDir()}
                      title={tf('Drop a YAML filter into the {category} folder of your filter folder.', {
                        category: s.suggestedCategory
                      })}
                    >
                      {t('Write a filter')}
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="rounded-md border border-dashed border-[var(--panel-border)] px-3 py-4 text-center font-mono text-[11px] text-[var(--text-muted)]">
            {tf('No unfiltered commands in the last {days} days. Run some shell commands and check back.', {
              days: sinceDays
            })}
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
