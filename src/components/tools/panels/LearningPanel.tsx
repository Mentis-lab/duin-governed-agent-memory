import { t, tf } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { CalmEmpty, Folded, PanelSection, PanelSummary, Row, RowList, Verb } from '@/components/ui/PanelKit'
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
//
// Shape (2026-09-03, the PanelKit pass): what needs you first, then what is proving out, then
// the rules in force; the history (vetoed, superseded, retired claims) and the compiled taste
// start folded. One summary line instead of a paragraph; hairline rows instead of card walls;
// provenance as a muted meta line instead of a pill.

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

/** Where a fact came from, and whether you already ruled on it: one muted phrase. */
function provenance(f: Fact): string {
  const src =
    f.source === 'operator'
      ? t('declared by you')
      : f.source === 'machine'
        ? t('inferred by a model')
        : f.source === 'external'
          ? t('from a channel')
          : t('origin unknown')
  return f.adjudicatedBy === 'human' ? `${src} · ${t('you ruled')}` : src
}

function sessionsPhrase(n: number): string {
  return n === 1 ? t('1 session') : tf('{n} sessions', { n })
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
  // The folded history groups. Session-local: history is for looking up, not for reading daily.
  const [open, setOpen] = useState<Set<'vetoed' | 'superseded' | 'claims' | 'taste'>>(new Set())
  const toggle = (k: 'vetoed' | 'superseded' | 'claims' | 'taste'): void =>
    setOpen((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })

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
  const remove = (id: string): Promise<void> => act(`veto:${id}`, () => operatorApi()?.veto?.(id) ?? Promise.resolve(undefined), t('Removed'), t('Could not remove'))
  const ratify = (id: string): Promise<void> => act(`ratify:${id}`, () => operatorApi()?.ratify?.(id) ?? Promise.resolve(undefined), t('Ratified'), t('Could not ratify'))
  const unveto = (id: string): Promise<void> => act(`unveto:${id}`, () => operatorApi()?.unveto?.(id) ?? Promise.resolve(undefined), t('Restored'), t('Could not restore'))
  const revert = (id: string): Promise<void> =>
    act(`revert:${id}`, () => operatorApi()?.revertSupersession?.(id) ?? Promise.resolve(undefined), t('Reinstated'), t('Could not reinstate'))
  const decideClaim = async (claimId: string, action: 'confirm' | 'revert'): Promise<void> => {
    setBusy(`claim:${claimId}`)
    try {
      const r = await resolveClaim(claimId, action)
      if (!r.ok) throw new Error(r.error || 'resolve failed')
      toast.success(action === 'revert' ? t('Reverted') : t('Kept retired'))
    } catch {
      toast.error(t('Could not rule on that claim'))
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
  const tasteRules = taste?.correction_rules ?? []
  const nothingYet = learningState.status === 'ready' && learning.length === 0 && promoted.length === 0 && awaiting.length === 0 && vetoed.length === 0

  const summary = [
    promoted.length === 1 ? t('1 rule in force') : tf('{n} rules in force', { n: promoted.length }),
    learning.length > 0 ? (learning.length === 1 ? t('1 proving out') : tf('{n} proving out', { n: learning.length })) : '',
    awaiting.length > 0 ? (awaiting.length === 1 ? t('1 awaits you') : tf('{n} await you', { n: awaiting.length })) : ''
  ]

  return (
    <div className="flex h-full flex-col overflow-hidden px-2 pb-2 pt-1 text-[12px]">
      <PanelSummary
        parts={learningState.status === 'loading' ? [t('Loading')] : summary}
        action={
          <button onClick={() => void load()} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            {t('Refresh')}
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {learningState.status === 'unavailable' && (
          <div role="alert" className="mx-1 mt-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-3 text-[12px] text-[var(--text-secondary)]">
            <div>{learningState.error}</div>
            <button onClick={() => void load()} className="mt-2 font-medium text-[var(--accent)] hover:underline">{t('Retry')}</button>
          </div>
        )}

        {learningState.status === 'stale' && (
          <div role="alert" className="mx-1 mt-2 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/10 p-2 text-[11px] text-[var(--text-secondary)]">
            {t('Showing the last loaded facts.')} {learningState.error}{' '}
            <button onClick={() => void load()} className="font-medium text-[var(--accent)] hover:underline">{t('Retry')}</button>
          </div>
        )}

        {nothingYet && (
          <CalmEmpty text={t('Nothing learned yet. As you chat, and tell DUIN things like "remember" or "I prefer", the facts it learns about you land here.')} />
        )}

        {awaiting.length > 0 && (
          <PanelSection label={t('Awaiting your ratification')}>
            <RowList>
              {awaiting.map((f) => (
                <Row
                  key={f.id}
                  emphasis
                  primary={f.fact}
                  secondary={provenance(f)}
                  actions={
                    <>
                      <Verb tone="accent" disabled={busy !== null} onClick={() => void ratify(f.id)}>{t('Ratify')}</Verb>
                      <Verb disabled={busy !== null} onClick={() => void remove(f.id)}>{t('Veto')}</Verb>
                    </>
                  }
                />
              ))}
            </RowList>
          </PanelSection>
        )}

        {learning.length > 0 && (
          <PanelSection label={t('Proving out')} aside={<span className="text-[11px] normal-case tracking-normal text-[var(--text-muted)]">{t('a rule after a few sessions, or when you ratify')}</span>}>
            <RowList>
              {learning.map((f) => (
                <Row
                  key={f.id}
                  primary={f.fact}
                  secondary={`${provenance(f)} · ${tf('survived {sessions}', { sessions: sessionsPhrase(f.observedSessions?.length ?? 0) })}`}
                  actions={
                    <>
                      {f.status === 'provisional' && (
                        <Verb tone="accent" disabled={busy !== null} onClick={() => void ratify(f.id)}>{t('Ratify')}</Verb>
                      )}
                      <Verb tone="danger" disabled={busy !== null} onClick={() => void remove(f.id)}>{t('Remove')}</Verb>
                    </>
                  }
                />
              ))}
            </RowList>
          </PanelSection>
        )}

        {promoted.length > 0 && (
          <PanelSection label={t('Rules DUIN follows')}>
            <RowList>
              {promoted.map((f) => (
                <Row
                  key={f.id}
                  primary={f.fact}
                  secondary={provenance(f)}
                  actions={<Verb tone="danger" disabled={busy !== null} onClick={() => void remove(f.id)}>{t('Remove')}</Verb>}
                />
              ))}
            </RowList>
          </PanelSection>
        )}

        {vetoed.length > 0 && (
          <Folded label={t('Vetoed')} count={vetoed.length} open={open.has('vetoed')} onToggle={() => toggle('vetoed')}>
            <RowList>
              {vetoed.map((f) => (
                <Row
                  key={f.id}
                  struck
                  primary={f.fact}
                  secondary={provenance(f)}
                  actions={<Verb disabled={busy !== null} onClick={() => void unveto(f.id)}>{t('Un-veto')}</Verb>}
                />
              ))}
            </RowList>
          </Folded>
        )}

        {superseded.length > 0 && (
          <Folded label={t('Superseded')} count={superseded.length} open={open.has('superseded')} onToggle={() => toggle('superseded')}>
            <RowList>
              {superseded.map((f) => (
                <Row
                  key={f.id}
                  struck
                  primary={f.fact}
                  secondary={`${t('replaced by')} ${textOf(f.supersededBy)} · ${provenance(f)}`}
                  actions={<Verb disabled={busy !== null} onClick={() => void revert(f.id)}>{t('Revert')}</Verb>}
                />
              ))}
            </RowList>
          </Folded>
        )}

        {claims.length > 0 && (
          <Folded label={t('Claims the model retired')} count={claims.length} open={open.has('claims')} onToggle={() => toggle('claims')}>
            <RowList>
              {claims.map((c) => (
                <Row
                  key={c.claimId}
                  primary={c.reason}
                  secondary={
                    c.reviewState === 'confirmed' || c.reviewState === 'reverted'
                      ? t('you ruled')
                      : c.applied === false
                        ? `${t('blocked')}${c.blockedBy ? ` · ${c.blockedBy}` : ''}`
                        : t('applied')
                  }
                  actions={
                    <>
                      {c.reviewState !== 'reverted' && (
                        <Verb disabled={busy !== null} onClick={() => void decideClaim(c.claimId, 'revert')}>{t('Revert')}</Verb>
                      )}
                      {c.applied !== false && c.reviewState !== 'confirmed' && (
                        <Verb disabled={busy !== null} onClick={() => void decideClaim(c.claimId, 'confirm')}>{t('Keep retired')}</Verb>
                      )}
                    </>
                  }
                />
              ))}
            </RowList>
          </Folded>
        )}

        {tasteRules.length > 0 && (
          <Folded label={t('Taste, compiled from your verdicts')} count={tasteRules.length} open={open.has('taste')} onToggle={() => toggle('taste')}>
            <RowList>
              {tasteRules.map((r, i) => {
                const text = r.candidate_rule || r.correction || r.why || '(rule)'
                const positive = r.polarity === 'positive'
                // Context = the why/correction fields NOT already shown as the
                // headline. Only render a Context toggle when there's something.
                const ctx: { label: string; value: string }[] = []
                if (r.why && r.why !== text) ctx.push({ label: t('Why'), value: r.why })
                if (r.correction && r.correction !== text) ctx.push({ label: t('Correction'), value: r.correction })
                const ctxOpen = openCtx.has(i)
                return (
                  <Row
                    key={i}
                    dot={positive ? 'accent' : 'muted'}
                    primary={text}
                    secondary={
                      ctxOpen ? (
                        <span className="block space-y-0.5">
                          {ctx.map((c) => (
                            <span key={c.label} className="block">
                              <span className="text-[var(--text-muted)]">{c.label}: </span>
                              <span className="text-[var(--text-secondary)]">{c.value}</span>
                            </span>
                          ))}
                        </span>
                      ) : (
                        positive ? t('confirmed') : t('correction')
                      )
                    }
                    actions={
                      ctx.length > 0 ? (
                        <Verb
                          onClick={() =>
                            setOpenCtx((prev) => {
                              const n = new Set(prev)
                              if (n.has(i)) n.delete(i)
                              else n.add(i)
                              return n
                            })
                          }
                        >
                          {ctxOpen ? t('Hide') : t('Context')}
                        </Verb>
                      ) : undefined
                    }
                  />
                )
              })}
            </RowList>
          </Folded>
        )}
      </div>
    </div>
  )
}
