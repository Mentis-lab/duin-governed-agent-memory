import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { fetchTaste, fetchClaimMetabolism, resolveClaim, type Taste, type ClaimCorrection } from '@/duin/lib/state'
import { toast } from '@/stores/toast-store'
import {
  learningLoadFailed,
  learningLoadSucceeded,
  requireLearningSuccess,
  requireMutationSuccess,
  type LearningLoadState
} from './learning-state'

// Learning — the audit trail of what DUIN has learned about you, and the place you rule on it.
// Learning is AUTOMATIC: candidate facts auto-promote to probation and the govern loop confirms
// the ones that survive; a keyless install parks them at "ratify" until you do. Every row shows
// where it came from (declared by you / inferred by a model / from a channel) and whether you
// already ruled on it. The verbs (W5): Ratify (land a probation fact as a rule — the person's
// word; "confirm" stays the govern loop's), Veto ("remove"), Un-veto, Revert a supersession, and
// Keep retired / Revert on the claims a model retired from your notes. A fact you STATED is never
// retired by a model on its own (operator-model.ts isOperatorStated).

interface Fact {
  id: string
  fact: string
  kind: string
  status: 'candidate' | 'provisional' | 'promoted' | 'vetoed' | 'reverted' | string
  ts: number
  /** Distinct sessions survived on probation (govern loop). */
  observedSessions?: string[]
  /** Provenance: operator (you said it), machine (a model inferred it), external (a channel). */
  source?: string
  /** 'human' when you promoted, vetoed, ratified or reinstated it yourself. */
  adjudicatedBy?: string
  supersededBy?: string
  invalidatedAt?: number
  govern?: { verdict: string }
}
type MutationResult = { success: boolean; data?: boolean; error?: string } | undefined
interface OperatorApi {
  list?: () => Promise<{ success: boolean; data?: Fact[]; error?: string }>
  listAll?: () => Promise<{ success: boolean; data?: Fact[]; error?: string }>
  ratify?: (id: string, reason?: string) => Promise<MutationResult>
  veto?: (id: string, reason?: string) => Promise<MutationResult>
  unveto?: (id: string, reason?: string) => Promise<MutationResult>
  revertSupersession?: (id: string, reason?: string) => Promise<MutationResult>
  onChanged?: (cb: (facts: unknown[]) => void) => () => void
}
function operatorApi(): OperatorApi | undefined {
  return (window as unknown as { api?: { operator?: OperatorApi } }).api?.operator
}

const ACCENT_BTN =
  'rounded border border-[var(--accent)]/50 px-2 py-0.5 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent)]/10 disabled:opacity-50'
const QUIET_BTN =
  'rounded border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] disabled:opacity-50'
const SECTION = 'mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]'
const ROW = 'flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2'

/** Where a fact came from, and whether you already ruled on it. */
function Provenance({ f }: { f: Fact }): React.ReactElement {
  const src =
    f.source === 'operator'
      ? t('Declared')
      : f.source === 'machine'
        ? t('Inferred')
        : f.source === 'external'
          ? t('From a channel')
          : t('Unknown origin')
  return (
    <span className="whitespace-nowrap rounded-full border border-[var(--panel-border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
      {src}
      {f.adjudicatedBy === 'human' ? ` · ${t('You ruled')}` : ''}
    </span>
  )
}

export function LearningPanel(): React.ReactElement {
  const [learningState, setLearningState] = useState<LearningLoadState<Fact>>({ status: 'loading' })
  const [all, setAll] = useState<Fact[]>([])
  const [claims, setClaims] = useState<ClaimCorrection[]>([])
  const [taste, setTaste] = useState<Taste | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
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
    // The superseded rows (retired by a newer statement) live only in the full list. Best-effort.
    try {
      const r = await operatorApi()?.listAll?.()
      if (r?.success && Array.isArray(r.data)) setAll(r.data)
    } catch { /* keep the last full list */ }
    // Claims a model retired from your notes (a shadow pass; reading persists nothing). Best-effort.
    try {
      const m = await fetchClaimMetabolism()
      setClaims((m.corrections ?? []).filter((c) => !!c.supersededBy))
    } catch { /* the brain may be down; the operator facts above still render */ }
    // Taste is compiled by the engine from the corrections stream your verdicts
    // feed (learn-bridge → corrections.jsonl → reflect → taste). Best-effort.
    try {
      setTaste(await fetchTaste())
    } catch { /* retain the last compiled taste on a transient refresh failure */ }
  }
  useEffect(() => {
    void load()
    // Live: refresh when facts change — the automatic capture/govern loop OR a
    // verb from any window. Lets the operator watch the model being built in real
    // time instead of hitting "refresh". Best-effort; unsubscribe on unmount.
    const unsubscribe = operatorApi()?.onChanged?.(() => void load())
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  /** One shape for every verb: refuse-aware (a false `data` is a refusal), toast, reload. */
  const act = async (key: string, run: () => Promise<MutationResult>, done: string, fail: string): Promise<void> => {
    setBusy(key)
    try {
      const result = await run()
      requireMutationSuccess(result, fail)
      if (result?.data === false) throw new Error(fail)
      toast.success(done)
    } catch {
      toast.error(fail)
    } finally {
      setBusy(null)
      void load()
    }
  }
  const remove = (id: string): Promise<void> => act(`veto:${id}`, () => operatorApi()?.veto?.(id) ?? Promise.resolve(undefined), 'Removed', 'Could not remove')
  const ratify = (id: string): Promise<void> => act(`ratify:${id}`, () => operatorApi()?.ratify?.(id) ?? Promise.resolve(undefined), 'Ratified', 'Could not ratify')
  const unveto = (id: string): Promise<void> => act(`unveto:${id}`, () => operatorApi()?.unveto?.(id) ?? Promise.resolve(undefined), 'Restored', 'Could not restore')
  const revert = (id: string): Promise<void> =>
    act(`revert:${id}`, () => operatorApi()?.revertSupersession?.(id) ?? Promise.resolve(undefined), 'Reinstated', 'Could not reinstate')
  const decideClaim = async (claimId: string, action: 'confirm' | 'revert'): Promise<void> => {
    setBusy(`claim:${claimId}`)
    try {
      const r = await resolveClaim(claimId, action)
      if (!r.ok) throw new Error(r.error || 'resolve failed')
      toast.success(action === 'revert' ? 'Reverted' : 'Kept retired')
    } catch {
      toast.error('Could not rule on that claim')
    } finally {
      setBusy(null)
      void load()
    }
  }

  // Candidate + provisional both read as "recently learned, proving out" — with
  // auto-promotion a candidate is transient, so we don't distinguish them here.
  const facts = learningState.status === 'ready' || learningState.status === 'stale'
    ? learningState.facts
    : []
  const awaiting = facts.filter((f) => f.status === 'provisional' && f.govern?.verdict === 'ratify')
  const awaitingIds = new Set(awaiting.map((f) => f.id))
  const learning = facts.filter((f) => (f.status === 'candidate' || f.status === 'provisional') && !awaitingIds.has(f.id))
  const promoted = facts.filter((f) => f.status === 'promoted')
  const vetoed = facts.filter((f) => f.status === 'vetoed')
  const superseded = all.filter((f) => typeof f.invalidatedAt === 'number' && !!f.supersededBy)
  const textOf = (id: string | undefined): string => (id ? (all.find((f) => f.id === id)?.fact ?? id) : '')

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
        DUIN learns automatically. A new fact proves out over a few sessions and an
        independent check before it becomes a confirmed rule; you can ratify it sooner, remove
        it, take a removal back, or reinstate a fact a newer statement replaced. A fact you stated
        is never retired by a model on its own. Each row says where it came from.
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

        {learningState.status === 'ready' && learning.length === 0 && promoted.length === 0 && awaiting.length === 0 && vetoed.length === 0 && (
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

        {awaiting.length > 0 && (
          <div>
            <div className={SECTION}>{t('Awaiting your ratification')}</div>
            <div className="space-y-1.5">
              {awaiting.map((f) => (
                <div key={f.id} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-primary)]">{f.fact}</span>
                  <Provenance f={f} />
                  <button type="button" disabled={busy !== null} onClick={() => void ratify(f.id)} className={ACCENT_BTN}>
                    {t('Ratify')}
                  </button>
                  <button type="button" disabled={busy !== null} onClick={() => void remove(f.id)} className={QUIET_BTN}>
                    {t('Veto')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {learning.length > 0 && (
          <div>
            <div className={SECTION}>{t('Recently learned — proving out')}</div>
            <div className="space-y-1.5">
              {learning.map((f) => (
                <div key={f.id} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-primary)]">{f.fact}</span>
                  <Provenance f={f} />
                  <span className="whitespace-nowrap text-[11px] text-[var(--text-muted)]">
                    survived {f.observedSessions?.length ?? 0} session{(f.observedSessions?.length ?? 0) === 1 ? '' : 's'}
                  </span>
                  {f.status === 'provisional' && (
                    <button type="button" disabled={busy !== null} onClick={() => void ratify(f.id)} className={ACCENT_BTN}>
                      {t('Ratify')}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove(f.id)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] disabled:opacity-50"
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
            <div className={SECTION}>{t('Confirmed rules DUIN follows')}</div>
            <div className="space-y-1.5">
              {promoted.map((f) => (
                <div key={f.id} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-primary)]">{f.fact}</span>
                  <Provenance f={f} />
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void remove(f.id)}
                    className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] disabled:opacity-50"
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {vetoed.length > 0 && (
          <div>
            <div className={SECTION}>{t('Vetoed')}</div>
            <div className="space-y-1.5">
              {vetoed.map((f) => (
                <div key={f.id} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-secondary)] line-through decoration-[var(--text-muted)]">{f.fact}</span>
                  <Provenance f={f} />
                  <button type="button" disabled={busy !== null} onClick={() => void unveto(f.id)} className={QUIET_BTN}>
                    {t('Un-veto')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {superseded.length > 0 && (
          <div>
            <div className={SECTION}>{t('Superseded')}</div>
            <div className="space-y-1.5">
              {superseded.map((f) => (
                <div key={f.id} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-secondary)]">
                    <span className="line-through decoration-[var(--text-muted)]">{f.fact}</span>
                    <span className="mx-1 text-[var(--text-muted)]">{t('replaced by')}</span>
                    <span className="text-[var(--text-primary)]">{textOf(f.supersededBy)}</span>
                  </span>
                  <Provenance f={f} />
                  <button type="button" disabled={busy !== null} onClick={() => void revert(f.id)} className={QUIET_BTN}>
                    {t('Revert')}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {claims.length > 0 && (
          <div>
            <div className={SECTION}>{t('Claims the model retired')}</div>
            <div className="space-y-1.5">
              {claims.map((c) => (
                <div key={c.claimId} className={ROW}>
                  <span className="min-w-0 flex-1 text-[12px] text-[var(--text-secondary)]">{c.reason}</span>
                  <span className="whitespace-nowrap rounded-full border border-[var(--panel-border)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                    {c.reviewState === 'confirmed' || c.reviewState === 'reverted'
                      ? t('You ruled')
                      : c.applied === false
                        ? `${t('Blocked')}${c.blockedBy ? ` · ${c.blockedBy}` : ''}`
                        : t('Applied')}
                  </span>
                  {c.reviewState !== 'reverted' && (
                    <button type="button" disabled={busy !== null} onClick={() => void decideClaim(c.claimId, 'revert')} className={QUIET_BTN}>
                      {t('Revert')}
                    </button>
                  )}
                  {c.applied !== false && c.reviewState !== 'confirmed' && (
                    <button type="button" disabled={busy !== null} onClick={() => void decideClaim(c.claimId, 'confirm')} className={QUIET_BTN}>
                      {t('Keep retired')}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {taste && (taste.correction_rules?.length ?? 0) > 0 && (
          <div>
            <div className={SECTION}>
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
