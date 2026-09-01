import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { fetchTaste, type Taste } from '@/duin/lib/state'
import { toast } from '@/stores/toast-store'
import {
  learningLoadFailed,
  learningLoadSucceeded,
  requireLearningSuccess,
  requireMutationSuccess,
  type LearningLoadState
} from './learning-state'

// Learning — the audit trail of what DUIN has learned about you. Learning is
// AUTOMATIC: candidate facts auto-promote and the govern loop confirms the ones
// that survive; there is no human endorse/review gate. This surface is the
// readable record of what was learned — recently learned (proving out) and the
// confirmed rules DUIN follows — plus a quiet "remove" to retract a wrong fact.

interface Fact {
  id: string
  fact: string
  kind: string
  status: 'candidate' | 'provisional' | 'promoted' | 'vetoed' | 'reverted' | string
  ts: number
  /** Distinct sessions survived on probation (govern loop). */
  observedSessions?: string[]
}
interface OperatorApi {
  list?: () => Promise<{ success: boolean; data?: Fact[]; error?: string }>
  veto?: (id: string, reason?: string) => Promise<{ success: boolean; error?: string }>
  onChanged?: (cb: (facts: unknown[]) => void) => () => void
}
function operatorApi(): OperatorApi | undefined {
  return (window as unknown as { api?: { operator?: OperatorApi } }).api?.operator
}

export function LearningPanel(): React.ReactElement {
  const [learningState, setLearningState] = useState<LearningLoadState<Fact>>({ status: 'loading' })
  const [taste, setTaste] = useState<Taste | null>(null)
  // Per-taste-rule Context expander. Only rules that actually carry context
  // (why / correction beyond the headline) get a toggle; others render none.
  const [openCtx, setOpenCtx] = useState<Set<number>>(new Set())

  const load = async (): Promise<void> => {
    try {
      const r = await operatorApi()?.list?.()
      setLearningState(learningLoadSucceeded(requireLearningSuccess(r, 'Could not load learning data.')))
    } catch (err) {
      const message = (err as Error)?.message || 'Could not load learning data.'
      setLearningState((previous) => learningLoadFailed(previous, message))
    }
    // Taste is compiled by the engine from the corrections stream your verdicts
    // feed (learn-bridge → corrections.jsonl → reflect → taste). Best-effort.
    try {
      setTaste(await fetchTaste())
    } catch { /* retain the last compiled taste on a transient refresh failure */ }
  }
  useEffect(() => {
    void load()
    // Live: refresh when facts change — the automatic capture/govern loop OR a
    // veto from any window. Lets the operator watch the model being built in real
    // time instead of hitting "refresh". Best-effort; unsubscribe on unmount.
    const unsubscribe = operatorApi()?.onChanged?.(() => void load())
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  // Learning is automatic; the only human action left is retracting a wrong fact.
  const remove = async (id: string): Promise<void> => {
    try {
      const result = await operatorApi()?.veto?.(id)
      requireMutationSuccess(result, 'Could not remove')
      toast.success('Removed')
    } catch {
      toast.error('Could not remove')
    } finally {
      void load()
    }
  }

  // Candidate + provisional both read as "recently learned, proving out" — with
  // auto-promotion a candidate is transient, so we don't distinguish them here.
  const facts = learningState.status === 'ready' || learningState.status === 'stale'
    ? learningState.facts
    : []
  const learning = facts.filter((f) => f.status === 'candidate' || f.status === 'provisional')
  const promoted = facts.filter((f) => f.status === 'promoted')

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-[var(--text-primary)]">{t('Learning')}</span>
        {promoted.length > 0 && (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            {promoted.length} learned
          </span>
        )}
        <button onClick={() => void load()} className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          refresh
        </button>
      </div>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        DUIN learns automatically — no review needed. A new fact proves out over a few
        sessions and an independent check before it becomes a confirmed rule. This is the
        audit trail; remove anything that&apos;s wrong.
      </p>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {learningState.status === 'loading' && <div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}

        {learningState.status === 'unavailable' && (
          <div role="alert" className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-[12px] text-[var(--text-secondary)]">
            <div>{learningState.error}</div>
            <button onClick={() => void load()} className="mt-2 font-medium text-[var(--accent)] hover:underline">{t('Retry')}</button>
          </div>
        )}

        {learningState.status === 'stale' && (
          <div role="alert" className="rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-[11px] text-[var(--text-secondary)]">
            Showing the last loaded facts. {learningState.error}{' '}
            <button onClick={() => void load()} className="font-medium text-[var(--accent)] hover:underline">{t('Retry')}</button>
          </div>
        )}

        {learningState.status === 'ready' && learning.length === 0 && promoted.length === 0 && (
          <PanelEmptyState
            icon={<span className="text-[20px]">🧠</span>}
            title={t('Nothing learned yet')}
            body={
              <>
                As you chat (and tell DUIN things like “remember…”, “I prefer…”), it learns facts
                about you automatically and records them here.
              </>
            }
          />
        )}

        {learning.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {t('Recently learned — proving out')}
            </div>
            <div className="space-y-1.5">
              {learning.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                  <span className="text-[12px] text-[var(--text-primary)]">{f.fact}</span>
                  <span className="ml-auto whitespace-nowrap text-[11px] text-[var(--text-muted)]">
                    survived {f.observedSessions?.length ?? 0} session{(f.observedSessions?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                  <button
                    onClick={() => void remove(f.id)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)]"
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {promoted.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {t('Confirmed rules DUIN follows')}
            </div>
            <div className="space-y-1.5">
              {promoted.map((f) => (
                <div key={f.id} className="flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                  <span className="text-[12px] text-[var(--text-primary)]">{f.fact}</span>
                  <button
                    onClick={() => void remove(f.id)}
                    className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--error)]"
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {taste && (taste.correction_rules?.length ?? 0) > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              Taste — compiled from your verdicts ({taste.correction_rules.length})
            </div>
            <p className="mb-1.5 text-[11px] text-[var(--text-muted)]">
              Each verdict you cast feeds the engine&apos;s corrections stream, which reflect folds into
              taste — the fast signal that shifts behavior before any rule is promoted.
            </p>
            <div className="space-y-1.5">
              {taste.correction_rules.map((r, i) => {
                const text = r.candidate_rule || r.correction || r.why || '(rule)'
                const positive = r.polarity === 'positive'
                // Context = the why/correction fields NOT already shown as the
                // headline. Only render a Context toggle when there's something.
                const ctx: { label: string; value: string }[] = []
                if (r.why && r.why !== text) ctx.push({ label: 'Why', value: r.why })
                if (r.correction && r.correction !== text)
                  ctx.push({ label: 'Correction', value: r.correction })
                const hasCtx = ctx.length > 0
                const ctxOpen = openCtx.has(i)
                return (
                  <div key={i} className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                    <div className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${positive ? 'bg-[var(--accent)]' : 'bg-[var(--text-muted)]'}`}
                        title={positive ? 'confirmed (promote)' : 'correction (veto)'}
                      />
                      <span className="min-w-0 flex-1 text-[12px] text-[var(--text-secondary)]">{text}</span>
                      {hasCtx && (
                        <button
                          type="button"
                          onClick={() =>
                            setOpenCtx((prev) => {
                              const n = new Set(prev)
                              if (n.has(i)) n.delete(i)
                              else n.add(i)
                              return n
                            })
                          }
                          className="shrink-0 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                        >
                          {ctxOpen ? 'Hide ▴' : 'Context ▾'}
                        </button>
                      )}
                    </div>
                    {hasCtx && ctxOpen && (
                      <div className="mt-1.5 space-y-1 border-t border-[var(--panel-border)] pt-1.5 pl-3.5">
                        {ctx.map((c) => (
                          <div key={c.label} className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                            <span className="text-[var(--text-muted)]">{c.label}: </span>
                            {c.value}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
