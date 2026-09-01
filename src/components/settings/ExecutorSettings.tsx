import type React from 'react'
import { t } from '@/lib/i18n'
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'

// Settings → Executors. Two things the operator needs: is the delegated executor ready to use,
// and what did its runs produce. A delegated run works in an isolated copy of the workspace; when
// it finishes with changes, it lands here as a Keep / Discard decision — Keep applies the work
// (merging when the workspace is clean), Discard throws it away. That decision is also what earns
// the executor the trust to start on its own when you're away.

type Status = {
  kind: 'dsh'
  runtimeStaged: boolean
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
function execApi(): typeof window.api.executor | null {
  return window.api.executor ?? null
}

function rungLabel(rung: Status['rung']): string {
  if (rung === 'run') return t('Trusted — may start on its own while you are away (results still held for your review)')
  if (rung === 'hold') return t('Held — always requires your approval to start')
  return t('On probation — you start each run; keeping its results earns it more autonomy over time')
}

export function ExecutorSettings(): React.ReactElement {
  const [status, setStatus] = useState<Status | null>(null)
  const [reviews, setReviews] = useState<Review[]>([])
  const [diff, setDiff] = useState<{ runId: string; diff: Diff } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const api = execApi()
    if (!api) return
    const [s, r] = await Promise.all([api.status(), api.reviews()])
    if (s.success && s.data) setStatus(s.data)
    if (r.success && r.data) setReviews(r.data.reviews)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const viewDiff = async (runId: string): Promise<void> => {
    const api = execApi()
    if (!api) return
    const res = await api.reviewDiff(runId)
    if (res.success && res.data && !('error' in res.data)) setDiff({ runId, diff: res.data as Diff })
    else toast.error(t('Could not load the changes.'))
  }

  const decide = async (runId: string, keep: boolean): Promise<void> => {
    const api = execApi()
    if (!api) return
    setBusy(runId)
    try {
      const res = keep ? await api.keep(runId) : await api.discard(runId)
      if (res.success && res.data) toast.success(res.data.message)
      else toast.error(res.error || t('That did not work.'))
      if (diff?.runId === runId) setDiff(null)
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-[15px] font-medium text-[var(--text-primary)]">{t('Executors')}</h2>
        <p className="mt-1 text-[12px] text-[var(--text-secondary)]">
          {t('DUIN can hand a bounded coding task to an external executor that runs in an isolated copy of your workspace. DUIN checks every action it takes, and you keep or discard what it produces.')}
        </p>
      </div>

      {/* Readiness */}
      <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] p-4">
        <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('DeepSeek Harness executor')}</div>
        <ul className="mt-2 space-y-1.5 text-[12px]">
          <li className="flex items-center gap-2">
            <StatusDot ok={!!status?.runtimeStaged} />
            <span className="text-[var(--text-secondary)]">
              {status?.runtimeStaged ? t('Runtime installed and ready') : t('Runtime not installed') + (status?.runtimeMissing ? ` — ${status.runtimeMissing}` : '')}
            </span>
          </li>
          <li className="flex items-center gap-2">
            <StatusDot ok={!!status?.hasKey} />
            <span className="text-[var(--text-secondary)]">
              {status?.hasKey ? t('DeepSeek API key present') : t('No DeepSeek API key — add one under API Keys to use the executor')}
            </span>
          </li>
          <li className="flex items-start gap-2">
            <StatusDot ok={status?.rung === 'run'} amber={status?.rung !== 'run'} />
            <span className="text-[var(--text-secondary)]">{status ? rungLabel(status.rung) : t('…')}</span>
          </li>
        </ul>
        {status && (status.ratifyN > 0 || status.reverts > 0) && (
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">
            {t('So far')}: {t('kept')} {status.ratifyK}, {t('discarded')} {status.reverts}.
          </p>
        )}
      </div>

      {/* Pending reviews */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-[13px] font-medium text-[var(--text-primary)]">{t('Waiting for your decision')}</div>
          <Button variant="ghost" size="sm" onClick={() => void refresh()}>{t('Refresh')}</Button>
        </div>
        {reviews.length === 0 ? (
          <p className="text-[12px] text-[var(--text-muted)]">{t('Nothing to review. When a delegated run changes files, it appears here.')}</p>
        ) : (
          <ul className="space-y-2">
            {reviews.map((r) => (
              <li key={r.runId} className="rounded-lg border border-[var(--panel-border)] bg-[var(--panel-bg)] p-3">
                <div className="text-[12px] text-[var(--text-primary)]">{r.label}</div>
                <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                  {r.changedFiles} {r.changedFiles === 1 ? t('file changed') : t('files changed')} · {r.branch}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" onClick={() => void viewDiff(r.runId)}>{t('View changes')}</Button>
                  <Button variant="primary" size="sm" disabled={busy === r.runId} onClick={() => void decide(r.runId, true)}>{t('Keep')}</Button>
                  <Button variant="ghost" size="sm" disabled={busy === r.runId} onClick={() => void decide(r.runId, false)}>{t('Discard')}</Button>
                </div>
                {diff?.runId === r.runId && (
                  <pre className="mt-2 max-h-80 overflow-auto rounded bg-[var(--bg-tertiary)] p-2 text-[11px] leading-snug text-[var(--text-secondary)]">
                    {diff.diff.stat}
                    {'\n'}
                    {diff.diff.patch}
                    {diff.diff.truncated ? `\n\n${t('… diff truncated.')}` : ''}
                  </pre>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function StatusDot({ ok, amber }: { ok: boolean; amber?: boolean }): React.ReactElement {
  const color = ok ? 'var(--success, #3fb950)' : amber ? 'var(--warning, #d29922)' : 'var(--danger, #f85149)'
  return <span className="mt-1.5 inline-block size-2 shrink-0 rounded-full" style={{ background: color }} aria-hidden />
}
