import { t } from '@/lib/i18n'
import { useEffect, useState, useCallback } from 'react'
import { useLoopsStore, type LoopEntity, type LoopBacklogItem } from '@/stores/loops-store'

// Loop Phase LP-9 — docked panel for the recurring loop entities. Lists each
// loop with live status / iteration / budget / next-fire, exposes
// pause/resume/stop/delete, and an expandable backlog with add/remove.

const BTN =
  'rounded-md border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
const BTN_DANGER =
  'rounded-md border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:border-[var(--error)] hover:text-[var(--error)]'

const STATUS_TONE: Record<string, string> = {
  running: 'text-[var(--accent)]',
  paused: 'text-[var(--warning)]',
  stopped: 'text-[var(--text-muted)]',
  done: 'text-[var(--text-secondary)]',
  error: 'text-[var(--error)]'
}

function fmtCountdown(nextFireAt: number | null): string {
  if (nextFireAt == null) return '—'
  const ms = nextFireAt - Date.now()
  if (ms <= 0) return 'due'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  return `${Math.round(m / 60)}h`
}

function budgetPct(loop: LoopEntity): number | null {
  if (!loop.tokenBudget || loop.tokenBudget <= 0) return null
  return Math.min(100, Math.round((loop.tokensUsed / loop.tokenBudget) * 100))
}

export function LoopsPanel(): React.ReactElement {
  const loops = useLoopsStore((s) => s.loops)
  const refresh = useLoopsStore((s) => s.refresh)
  const pause = useLoopsStore((s) => s.pause)
  const resume = useLoopsStore((s) => s.resume)
  const stop = useLoopsStore((s) => s.stop)
  const remove = useLoopsStore((s) => s.remove)
  const listBacklog = useLoopsStore((s) => s.listBacklog)
  const enqueue = useLoopsStore((s) => s.enqueue)
  const removeBacklog = useLoopsStore((s) => s.removeBacklog)

  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [backlog, setBacklog] = useState<LoopBacklogItem[]>([])
  const [taskDraft, setTaskDraft] = useState('')
  const [, forceTick] = useState(0)

  useEffect(() => {
    void refresh()
    const unsub = window.api?.loops?.onLoopEvent?.(() => void refresh())
    const ticker = window.setInterval(() => forceTick((n) => n + 1), 1000)
    return () => {
      unsub?.()
      window.clearInterval(ticker)
    }
  }, [refresh])

  const refreshBacklog = useCallback(
    async (loopId: string) => setBacklog(await listBacklog(loopId)),
    [listBacklog]
  )

  const toggleBacklog = useCallback(
    async (loopId: string) => {
      if (expanded === loopId) {
        setExpanded(null)
        return
      }
      setExpanded(loopId)
      await refreshBacklog(loopId)
    },
    [expanded, refreshBacklog]
  )

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-3 text-[12px]">
      {loops.length === 0 && (
        <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-4 text-center text-[var(--text-muted)]">
          No loops yet. Start one with <code>/loop &lt;task&gt;</code> — enable loops under
          Settings&nbsp;→&nbsp;Automations first.
        </div>
      )}
      {loops.map((loop) => {
        const pct = budgetPct(loop)
        return (
          <div
            key={loop.id}
            className="rounded-xl border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2">
                <span
                  className={`text-[11px] font-semibold uppercase tracking-wide ${STATUS_TONE[loop.status] ?? ''}`}
                >
                  {loop.status}
                </span>
                <span className="text-[12px] text-[var(--text-secondary)]">
                  {loop.mode.replace('_', '-')}
                </span>
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                iter {loop.iteration}
                {loop.maxIterations ? `/${loop.maxIterations}` : ''}
                {pct != null ? ` · budget ${pct}%` : ''}
                {loop.status === 'running' ? ` · next ${fmtCountdown(loop.nextFireAt)}` : ''}
              </span>
            </div>
            {loop.instruction && (
              <div
                className="mt-1 truncate text-[12px] text-[var(--text-secondary)]"
                title={loop.instruction}
              >
                {loop.instruction}
              </div>
            )}
            {loop.stopReason && (
              <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                stopped: {loop.stopReason}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {loop.status === 'running' && (
                <button className={BTN} onClick={() => void pause(loop.id)}>
                  {t('Pause')}
                </button>
              )}
              {(loop.status === 'paused' || loop.status === 'stopped') && (
                <button className={BTN} onClick={() => void resume(loop.id)}>
                  {t('Resume')}
                </button>
              )}
              {(loop.status === 'running' || loop.status === 'paused') && (
                <button className={BTN} onClick={() => void stop(loop.id)}>
                  {t('Stop')}
                </button>
              )}
              <button className={BTN} onClick={() => void toggleBacklog(loop.id)}>
                {expanded === loop.id ? 'Hide' : 'Backlog'}
              </button>
              {confirmDelete === loop.id ? (
                <>
                  <button
                    className={BTN_DANGER}
                    onClick={() => {
                      setConfirmDelete(null)
                      void remove(loop.id)
                    }}
                  >
                    {t('Confirm delete?')}
                  </button>
                  <button className={BTN} onClick={() => setConfirmDelete(null)}>
                    {t('Cancel')}
                  </button>
                </>
              ) : (
                <button className={BTN_DANGER} onClick={() => setConfirmDelete(loop.id)}>
                  {t('Delete')}
                </button>
              )}
            </div>
            {expanded === loop.id && (
              <div className="mt-2 border-t border-[var(--panel-border)] pt-2">
                {backlog.length === 0 && (
                  <div className="text-[11px] text-[var(--text-muted)]">{t('Backlog empty.')}</div>
                )}
                <ul className="flex flex-col gap-1">
                  {backlog.map((b) => (
                    <li key={b.id} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="min-w-0 truncate">
                        <span className="mr-1 text-[11px] uppercase text-[var(--text-muted)]">
                          {b.status}
                        </span>
                        {b.task}
                      </span>
                      {b.status === 'pending' && (
                        <button
                          className="shrink-0 text-[var(--text-muted)] hover:text-[var(--error)]"
                          title={t('Remove task')}
                          onClick={async () => {
                            await removeBacklog(b.id)
                            await refreshBacklog(loop.id)
                          }}
                        >
                          ×
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 flex gap-1"
                  onSubmit={async (e) => {
                    e.preventDefault()
                    const t = taskDraft.trim()
                    if (!t) return
                    await enqueue(loop.id, [t])
                    setTaskDraft('')
                    await refreshBacklog(loop.id)
                  }}
                >
                  <input
                    value={taskDraft}
                    onChange={(e) => setTaskDraft(e.target.value)}
                    placeholder={t('Add a task…')}
                    className="min-w-0 flex-1 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1 text-[12px] outline-none focus:border-[var(--accent)]"
                  />
                  <button type="submit" className={BTN}>
                    {t('Add')}
                  </button>
                </form>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
