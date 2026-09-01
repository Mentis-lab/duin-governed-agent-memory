// Run history for one automation, from the durable `automation_runs` ledger.
//
// This component used to show only `lastRunAt` + `lastResult` — one timestamp and a blob,
// with no status, no duration and no error, so a failed run and a successful one rendered
// identically. Meanwhile `automations:runs` served the full attempt-level ledger through
// preload and had zero callers anywhere in the renderer: the history was written, pruned
// after 24h, and never once displayed. This calls it.

import { useEffect, useState } from 'react'
import type { AutomationRun } from '@/stores/automations-store'

interface Props {
  automationId: string
  lastRunAt: number | null
}

function formatWhen(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return new Date(ts).toLocaleDateString()
}

/** Runs are usually seconds-to-minutes; a bare ms count is unreadable at a glance. */
function formatDuration(startedAt: number, finishedAt: number | null): string {
  if (!finishedAt) return '—'
  const s = Math.max(0, Math.round((finishedAt - startedAt) / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

const STATUS_STYLE: Record<AutomationRun['status'], string> = {
  completed: 'bg-[var(--accent-dim)] text-[var(--text-primary)]',
  failed: 'bg-red-500/15 text-red-400',
  interrupted: 'bg-amber-500/15 text-amber-400',
  running: 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
}

/** `interrupted` is written by boot recovery for runs the app was killed mid-way through —
 *  worth naming as its own thing rather than folding into failure. */
const STATUS_LABEL: Record<AutomationRun['status'], string> = {
  completed: 'Completed',
  failed: 'Failed',
  interrupted: 'Interrupted',
  running: 'Running'
}

export function RunHistoryViewer({ automationId, lastRunAt }: Props) {
  const [runs, setRuns] = useState<AutomationRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      const api = window.api?.automations
      if (!api?.runs) return
      try {
        const res = await api.runs(automationId, 10)
        if (!alive) return
        if (res?.success) setRuns(res.data as AutomationRun[])
        else setError(res?.error ?? 'could not load run history')
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'could not load run history')
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [automationId, lastRunAt])

  if (error) {
    return <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">Run history unavailable — {error}</p>
  }
  if (runs === null) {
    return <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">Loading run history…</p>
  }
  if (runs.length === 0) {
    // The ledger keeps terminal rows for 24h, so "no rows" is genuinely ambiguous — say both.
    return (
      <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">
        {lastRunAt ? 'No runs in the last 24 hours.' : 'Has not run yet.'}
      </p>
    )
  }

  return (
    <div className="flex flex-col">
      {runs.map((r) => (
        <div key={r.id} className="flex flex-col gap-1 border-b border-[var(--panel-border)] px-2 py-1.5 last:border-b-0">
          <div className="flex items-center gap-2 text-[11px]">
            <span className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${STATUS_STYLE[r.status]}`}>
              {STATUS_LABEL[r.status]}
            </span>
            <span className="text-[var(--text-muted)] tabular-nums">
              {formatDuration(r.startedAt, r.finishedAt)}
            </span>
            {r.attempt > 1 && <span className="text-[var(--text-muted)]">attempt {r.attempt}</span>}
            <span className="ml-auto text-[var(--text-muted)] tabular-nums">{formatWhen(r.startedAt)}</span>
          </div>
          {r.error && <p className="text-[11px] leading-snug text-red-400">{r.error}</p>}
          {r.result && (
            <pre className="max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-1.5 text-[11px] leading-snug text-[var(--text-primary)]">
              {r.result}
            </pre>
          )}
        </div>
      ))}
    </div>
  )
}
