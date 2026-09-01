import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNoticesStore, type Notice, type NoticeSeverity } from '@/stores/notices-store'
import { followDeepLink } from '@/lib/follow-deep-link'
import { toast } from '@/stores/toast-store'

/** A staged self-tune awaiting the operator (rsi:pending row). */
interface PendingRsi {
  id: string
  changeClass: string
  engine: string
  proposedAt: string
  diff: string
  /** The file this self-tune writes. Shown so ratify is never blind to the write target. */
  targetPath?: string
}

/** Basename of the RSI write target, for a compact "writes: rsi-tunables.json" hint. */
function targetName(p: string | undefined): string | null {
  if (!p) return null
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || null
}

// The inbox: what DUIN did while you weren't looking, and what still wants a decision.
//
// Deliberately NOT a flat feed. One focal block leads (things you still owe an answer
// to), unread sits below it as hairline rows, and everything already seen collapses out
// of the way. A notification system that shows twenty equal rows is the same problem as
// one that shows nothing.

/** Severity is carried by a dot AND a word, never colour alone. */
const SEVERITY: Record<NoticeSeverity, { dot: string; label: string }> = {
  info: { dot: 'bg-[var(--text-muted)]', label: 'Note' },
  warning: { dot: 'bg-[var(--warning,#d97706)]', label: 'Worth a look' },
  error: { dot: 'bg-[var(--error)]', label: 'Failed' }
}

function ago(ts: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000))
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

/** `embedded` — see BrainStatusPanel: the hub tab already names this surface. */
export function NeedsYouPanel({ embedded = false }: { embedded?: boolean } = {}): React.ReactElement {
  const notices = useNoticesStore((s) => s.notices)
  const counts = useNoticesStore((s) => s.counts)
  const loading = useNoticesStore((s) => s.loading)
  const error = useNoticesStore((s) => s.error)
  const loadNotices = useNoticesStore((s) => s.loadNotices)
  const markRead = useNoticesStore((s) => s.markRead)
  const markAllRead = useNoticesStore((s) => s.markAllRead)
  const [showEarlier, setShowEarlier] = useState(false)
  // W2 considerate-RSI: decide IN PLACE. Owed rows whose actionId matches a staged
  // self-tune get Ratify/Dismiss right on the card; staged loop iterations (kind 'loop')
  // get Ratify/Revert/Dismiss through the Governor 4a flow. No navigation, no chore pile.
  const [pendingRsi, setPendingRsi] = useState<Record<string, PendingRsi>>({})
  const [deciding, setDeciding] = useState<string | null>(null)

  const loadPendingRsi = useCallback(async () => {
    try {
      const r = await window.api?.rsi?.pending?.()
      if (r?.success) {
        const rows = (r.data as PendingRsi[]) ?? []
        setPendingRsi(Object.fromEntries(rows.map((p) => [p.id, p])))
      }
    } catch {
      // listing is an affordance; the notice row still works without it
    }
  }, [])

  useEffect(() => {
    void loadNotices()
    void loadPendingRsi()
  }, [loadNotices, loadPendingRsi])

  const decideRsi = async (n: Notice, verb: 'ratify' | 'dismiss'): Promise<void> => {
    if (!n.actionId || deciding) return
    setDeciding(n.id)
    try {
      const r = await window.api?.rsi?.resolve?.(n.actionId, verb)
      if (r?.success) {
        toast.info(verb === 'ratify' ? 'Applied — the held-out A/B will judge it' : 'Parked — it will not ask again')
      } else {
        toast.info(r?.error ?? 'Could not resolve that proposal')
      }
    } finally {
      setDeciding(null)
      void loadNotices()
      void loadPendingRsi()
    }
  }

  const decideLoop = async (n: Notice, verb: 'ratify' | 'revert' | 'dismiss'): Promise<void> => {
    if (!n.actionId || deciding) return
    setDeciding(n.id)
    try {
      const r = await window.api?.loops?.ratify?.(n.actionId, verb)
      if (r?.success) {
        toast.info(verb === 'ratify' ? 'Landed' : verb === 'revert' ? 'Discarded' : 'Deferred')
      } else {
        toast.info(r?.error ?? 'Could not decide that iteration')
      }
    } finally {
      setDeciding(null)
      void loadNotices()
    }
  }

  const { owed, fresh, earlier } = useMemo(() => {
    const owed: Notice[] = []
    const fresh: Notice[] = []
    const earlier: Notice[] = []
    for (const n of notices) {
      if (n.needsDecision && n.resolvedAt === null) owed.push(n)
      else if (n.readAt === null) fresh.push(n)
      else earlier.push(n)
    }
    return { owed, fresh, earlier }
  }, [notices])

  const open = (n: Notice) => {
    void markRead([n.id])
    if (!n.deepLink) return
    if (!followDeepLink(n.deepLink)) {
      toast.info('That item is no longer available')
    }
  }

  if (error) {
    return (
      <div className="p-4">
        <div role="alert" className="rounded-md border border-[var(--error)] bg-[var(--error)]/10 px-3 py-2 text-[12px] text-[var(--error)]">
          Couldn&rsquo;t read the inbox: {error}
        </div>
      </div>
    )
  }

  const nothingAtAll = notices.length === 0 && !loading

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 py-3">
        {!embedded && (
          <span className="font-semibold text-[var(--text-primary)]">{t('Needs you')}</span>
        )}
        <span className="text-[12px] text-[var(--text-muted)]">
          {loading
            ? 'Reading…'
            : counts.needsDecision > 0
              ? `${counts.needsDecision} waiting on you`
              : counts.unread > 0
                ? `${counts.unread} new`
                : 'All caught up'}
        </span>
        <div className="flex-1" />
        {counts.unread > 0 && (
          <button
            onClick={() => void markAllRead()}
            className="rounded px-2 py-1 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          >
            {t('Mark all seen')}
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
        {nothingAtAll && (
          <p className="px-1 py-8 text-center text-[13px] text-[var(--text-muted)]">
            {t('Nothing needs you.')}
          </p>
        )}

        {/* The one focal block. Only these float; everything below is flat. */}
        {owed.length > 0 && (
          <section aria-label={t('Waiting on you')} className="mb-4">
            <h3 className="mb-1.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t('Waiting on you')}
            </h3>
            <div className="space-y-1.5">
              {owed.map((n) => {
                const rsi = n.actionId ? pendingRsi[n.actionId] : undefined
                const isLoopStage = !rsi && n.kind === 'loop' && !!n.actionId
                return (
                  <div key={n.id}>
                    <NoticeRow notice={n} onOpen={open} focal />
                    {rsi && (
                      <div className="mt-1 flex items-center gap-2 px-2.5 pb-1">
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decideRsi(n, 'ratify')}
                          className="rounded border border-[var(--accent)]/50 px-2 py-0.5 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {t('Ratify')}
                        </button>
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decideRsi(n, 'dismiss')}
                          className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {t('Dismiss')}
                        </button>
                        <span className="truncate text-[11px] text-[var(--text-muted)]">
                          {rsi.diff}
                          {targetName(rsi.targetPath) && (
                            <span className="ml-1 opacity-70">· writes {targetName(rsi.targetPath)}</span>
                          )}
                        </span>
                      </div>
                    )}
                    {isLoopStage && (
                      <div className="mt-1 flex items-center gap-2 px-2.5 pb-1">
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decideLoop(n, 'ratify')}
                          className="rounded border border-[var(--accent)]/50 px-2 py-0.5 text-[12px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {t('Ratify')}
                        </button>
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decideLoop(n, 'revert')}
                          className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {t('Revert')}
                        </button>
                        <button
                          type="button"
                          disabled={deciding !== null}
                          onClick={() => void decideLoop(n, 'dismiss')}
                          className="rounded border border-[var(--panel-border)] px-2 py-0.5 text-[12px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                        >
                          {t('Dismiss')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {fresh.length > 0 && (
          <section aria-label={t('New')} className="mb-4">
            <h3 className="mb-0.5 text-[11px] uppercase tracking-wide text-[var(--text-muted)]">
              {t('New')}
            </h3>
            <div className="divide-y divide-[var(--panel-border)]">
              {fresh.map((n) => (
                <NoticeRow key={n.id} notice={n} onOpen={open} />
              ))}
            </div>
          </section>
        )}

        {earlier.length > 0 && (
          <section aria-label={t('Earlier')}>
            <button
              onClick={() => setShowEarlier((v) => !v)}
              aria-expanded={showEarlier}
              className="mb-0.5 flex w-full items-center gap-1 py-1 text-[11px] uppercase tracking-wide text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            >
              <svg
                width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                className={showEarlier ? '' : '-rotate-90'}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
              Earlier ({earlier.length})
            </button>
            {showEarlier && (
              <div className="divide-y divide-[var(--panel-border)] opacity-70">
                {earlier.map((n) => (
                  <NoticeRow key={n.id} notice={n} onOpen={open} />
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

function NoticeRow({
  notice,
  onOpen,
  focal = false
}: {
  notice: Notice
  onOpen: (n: Notice) => void
  focal?: boolean
}): React.ReactElement {
  const sev = SEVERITY[notice.severity]
  const followable = !!notice.deepLink
  return (
    <button
      type="button"
      onClick={() => onOpen(notice)}
      aria-label={`${sev.label}: ${notice.title}`}
      className={
        'flex w-full items-start gap-2.5 py-2 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)] ' +
        (focal
          ? 'rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/[0.06] px-2.5 shadow-sm hover:bg-[var(--accent)]/10'
          : 'px-1 hover:bg-[var(--bg-tertiary)]')
      }
    >
      <span
        aria-hidden
        className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${sev.dot}`}
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] leading-snug text-[var(--text-primary)]">
          {notice.title}
        </span>
        {notice.body && (
          <span className="mt-0.5 block truncate text-[12px] text-[var(--text-secondary)]">
            {notice.body}
          </span>
        )}
        <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <span>{sev.label}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">{ago(notice.createdAt)}</span>
          {notice.count > 1 && (
            <>
              <span aria-hidden>·</span>
              <span className="tabular-nums">{notice.count}×</span>
            </>
          )}
          {notice.readAt === null && !focal && (
            <>
              <span aria-hidden>·</span>
              <span className="text-[var(--accent)]">new</span>
            </>
          )}
        </span>
      </span>
      {followable && (
        <span
          aria-hidden
          className="mt-0.5 shrink-0 text-[var(--text-muted)]"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
      )}
    </button>
  )
}
