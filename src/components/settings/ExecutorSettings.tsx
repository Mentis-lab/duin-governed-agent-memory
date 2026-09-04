import { useCallback, useEffect, useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { panelError, panelFromResult, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

// Settings → Executors. Two things the operator needs: is the delegated executor ready to use,
// and what did its runs produce. A delegated run works in an isolated copy of the workspace; when
// it finishes with changes, it lands here as a Keep / Discard decision — Keep applies the work
// (merging when the workspace is clean), Discard throws it away. That decision is also what earns
// the executor the trust to start on its own when you're away.
//
// A failed status read is its own state. It used to paint "Runtime not installed / No DeepSeek
// API key" in red, so a working install read as broken whenever the IPC hiccupped.

type Status = {
  kind: 'dsh'
  runtimeStaged: boolean
  /** Developer diagnosis from the main side (a script to run, a missing binary). Support
   *  detail, never the headline. */
  runtimeMissing: string
  hasKey: boolean
  rung: 'run' | 'stage' | 'hold' | 'unknown'
  ratifyN: number
  ratifyK: number
  reverts: number
  pendingReviews: number
}
type Review = { runId: string; label: string; branch: string; changedFiles: number; createdAt: number }
type Diff = { stat: string; patch: string; truncated: boolean; changedFiles: number; branch: string }

// The executor preload surface (window.api.executor) is typed from electron/preload.ts via
// LampreyAPI; results are the generic {success, data?} envelope. Narrowed at each call site.
function execApi(): typeof window.api.executor | undefined {
  return window.api?.executor
}

function rungLabel(rung: Status['rung']): string {
  if (rung === 'run') return t('Trusted — may start on its own while you are away (results still held for your review)')
  if (rung === 'hold') return t('Held — always requires your approval to start')
  return t('On probation — you start each run; keeping its results earns it more autonomy over time')
}

export function ExecutorSettings(): React.ReactElement {
  const [status, setStatus] = useState<PanelStatus<Status>>(panelLoading())
  const [reviews, setReviews] = useState<PanelStatus<Review[]>>(panelLoading())
  const [diff, setDiff] = useState<{ runId: string; diff: Diff } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = execApi()
    const [s, r] = await Promise.all([
      query<Status>(t('the executor status'), api?.status),
      query<{ reviews: Review[] }>(t('pending reviews'), api?.reviews)
    ])
    setStatus(panelFromResult(s))
    setReviews(r.ok ? panelReady(r.data.reviews ?? []) : panelError(r.error, r.cause))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const viewDiff = async (runId: string): Promise<void> => {
    const api = execApi()
    const r = await query<Diff | { error: string }>(t('the changes'), api ? () => api.reviewDiff(runId) : undefined)
    if (r.ok && !('error' in r.data)) setDiff({ runId, diff: r.data })
    else toast.error(r.ok ? t('Could not load the changes.') : r.error)
  }

  const decide = async (runId: string, keep: boolean): Promise<void> => {
    const api = execApi()
    setBusy(runId)
    try {
      const data = await invoke<{ message?: string }>(
        keep ? t('keep the run') : t('discard the run'),
        api ? () => (keep ? api.keep(runId) : api.discard(runId)) : undefined
      )
      toast.success(data?.message ?? (keep ? t('Kept.') : t('Discarded.')))
      if (diff?.runId === runId) setDiff(null)
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('That did not work.')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage
      purpose={t('DUIN can hand a bounded coding task to an external executor that runs in an isolated copy of your workspace. DUIN checks every action it takes, and you keep or discard what it produces.')}
    >
      <SettingsSection label={t('Readiness')}>
        <SettingsRow label={t('DeepSeek Harness executor')}>
          <PanelState
            state={status}
            loading={<p className="text-[12px] text-[var(--text-muted)]">{t('Checking…')}</p>}
            error={(message, retry) => <SettingsLoadError what={t('the executor status')} message={message} onRetry={retry} />}
            empty={
              <SettingsLoadError
                what={t('the executor status')}
                message={t('The main process returned nothing.')}
                onRetry={() => void refresh()}
              />
            }
            onRetry={() => void refresh()}
          >
            {(s) => (
              <>
                <ul className="space-y-1.5 text-[12px] text-[var(--text-secondary)]">
                  <li className="flex items-start gap-2">
                    <StatusDot tone={s.runtimeStaged ? 'ok' : 'error'} />
                    <span className="min-w-0">
                      {s.runtimeStaged
                        ? t('Runtime installed and ready')
                        : t('This build is missing the executor runtime. Reinstall DUIN.')}
                      {!s.runtimeStaged && s.runtimeMissing && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-[var(--text-muted)]">{t('Details for support')}</summary>
                          <pre className="mt-1 whitespace-pre-wrap rounded bg-[var(--bg-tertiary)] p-2 font-mono text-[11px] text-[var(--text-muted)]">
                            {s.runtimeMissing}
                          </pre>
                        </details>
                      )}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <StatusDot tone={s.hasKey ? 'ok' : 'error'} />
                    <span>
                      {s.hasKey ? (
                        t('DeepSeek API key present')
                      ) : (
                        <>
                          {t('No DeepSeek API key.')}{' '}
                          <SettingsLink tab="api">{t('Add one under API Keys to use the executor.')}</SettingsLink>
                        </>
                      )}
                    </span>
                  </li>
                  <li className="flex items-start gap-2">
                    <StatusDot tone={s.rung === 'run' ? 'ok' : 'warning'} />
                    <span>{rungLabel(s.rung)}</span>
                  </li>
                </ul>
                {(s.ratifyN > 0 || s.reverts > 0) && (
                  <p className="mt-2 text-[11px] text-[var(--text-muted)]">
                    {tf('So far: kept {k}, discarded {r}.', { k: s.ratifyK, r: s.reverts })}
                  </p>
                )}
              </>
            )}
          </PanelState>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        label={t('Waiting for your decision')}
        actions={
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>
            {t('Refresh')}
          </Button>
        }
      >
        <PanelState
          state={reviews}
          loading={<SettingsLoading what={t('pending reviews')} />}
          error={(message, retry) => <SettingsLoadError what={t('pending reviews')} message={message} onRetry={retry} />}
          empty={
            <p className="text-[12px] text-[var(--text-muted)]">
              {t('Nothing to review. When a delegated run changes files, it appears here.')}
            </p>
          }
          onRetry={() => void refresh()}
        >
          {(list) => (
            <>
              {list.map((r) => (
                <SettingsRow
                  key={r.runId}
                  label={r.label}
                  hint={
                    r.changedFiles === 1
                      ? tf('1 file changed · {branch}', { branch: r.branch })
                      : tf('{n} files changed · {branch}', { n: r.changedFiles, branch: r.branch })
                  }
                  control={
                    <>
                      <Button variant="ghost" size="sm" onClick={() => void viewDiff(r.runId)}>
                        {t('View changes')}
                      </Button>
                      <Button variant="primary" size="sm" disabled={busy === r.runId} onClick={() => void decide(r.runId, true)}>
                        {t('Keep')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy === r.runId} onClick={() => void decide(r.runId, false)}>
                        {t('Discard')}
                      </Button>
                    </>
                  }
                >
                  {diff?.runId === r.runId && (
                    <pre className="max-h-80 overflow-auto rounded bg-[var(--bg-tertiary)] p-2 text-[11px] leading-snug text-[var(--text-secondary)]">
                      {diff.diff.stat}
                      {'\n'}
                      {diff.diff.patch}
                      {diff.diff.truncated ? `\n\n${t('… diff truncated.')}` : ''}
                    </pre>
                  )}
                </SettingsRow>
              ))}
            </>
          )}
        </PanelState>
      </SettingsSection>
    </SettingsPage>
  )
}

function StatusDot({ tone }: { tone: 'ok' | 'warning' | 'error' }): React.ReactElement {
  const cls = tone === 'ok' ? 'bg-[var(--success)]' : tone === 'warning' ? 'bg-[var(--warning)]' : 'bg-[var(--error)]'
  return <span className={`mt-1.5 inline-block size-2 shrink-0 rounded-full ${cls}`} aria-hidden />
}
