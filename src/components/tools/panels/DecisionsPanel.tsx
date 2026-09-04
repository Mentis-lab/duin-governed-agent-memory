import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PanelState, PanelErrorState } from '@/components/ui/PanelState'
import { CalmEmpty, PanelSection, PanelSummary, Row, RowList, Verb } from '@/components/ui/PanelKit'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { useBrainStore } from '@/stores/brain-store'
import { toast } from '@/stores/toast-store'
import {
  readState,
  fetchDecisions,
  makeDecision,
  recordVerdict,
  fetchCascadePending,
  postCascadeResolve,
  fetchForecastRecord,
  type Decision,
  type CascadePending,
  type ForecastRecord
} from '@/duin/lib/state'

// Decisions — the auditable record of the calls you made, and the place you score them.
//  1. What waits on you: decisions whose review date has come (score the call: right, wrong,
//     partial) and cascades the brain proposes (approve or dismiss).
//  2. On record: every decision, newest first; click to open its note.
//  3. Record a decision: an inline form that opens from the section, not a permanent block at
//     the top. Recording is one click away; reading is what the surface is for.
// Track record from fetchForecastRecord sits in the summary line when present.
//
// Shape (2026-09-03, the PanelKit pass): the same grammar as Home and Learning. Hand-resolving
// stays removed (closing an owed window is brain/decision-loop's job on the calibration tick);
// verdict scoring stays, because that retrospective judgment is the operator's alone.

type CallChoice = 'Cleared' | 'Blocked' | 'custom'

// Terminal-status test. Used ONLY for the status dot; it gates no action.
function statusLooksResolved(status: string): boolean {
  const s = (status || '').toLowerCase()
  return /resolv|closed|archiv|done|verdict|decided|cleared|blocked|made/.test(s)
}
function verdictDue(d: Decision): boolean {
  if (!d.reviewOn) return false
  const ts = Date.parse(d.reviewOn)
  if (Number.isNaN(ts)) return false
  return ts <= Date.now()
}

export function DecisionsPanel(): React.ReactElement {
  const focusNode = useBrainStore((s) => s.focusNode)
  const setDetail = useBrainStore((s) => s.setDetail)
  const setChatContext = useBrainStore((s) => s.setChatContext)
  const graph = useBrainStore((s) => s.data)

  // U1: the ledger read is a PanelStatus, not `Decision[] | null`. `null` used to
  // mean "loading" and `[]` meant both "no decisions" and "the brain is dead" —
  // and the panel printed the reassuring sentence for the second case.
  const [decisionsState, setDecisionsState] = useState<PanelStatus<Decision[]>>(panelLoading)
  const [cascades, setCascades] = useState<CascadePending[]>([])
  const [record, setRecord] = useState<ForecastRecord | null>(null)
  const decisions = decisionsState.phase === 'ready' ? decisionsState.data : []

  // record-a-decision form (inline, opened on demand)
  const [recordOpen, setRecordOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [callChoice, setCallChoice] = useState<CallChoice>('Cleared')
  const [customCall, setCustomCall] = useState('')
  const [rationale, setRationale] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const aliveRef = useRef(true)
  const titleRef = useRef<HTMLInputElement>(null)

  const load = useCallback(async (): Promise<void> => {
    // The ledger read owns the panel's state; cascades and the track-record header
    // are decorations that may legitimately be absent, so they stay best-effort.
    const [d, c, fr] = await Promise.all([
      readState('decisions', (s) => fetchDecisions(s)),
      readState('pending cascades', (s) => fetchCascadePending(s)),
      readState('forecast record', (s) => fetchForecastRecord(s))
    ])
    if (!aliveRef.current) return
    setDecisionsState(panelFromResult(d))
    setCascades(c.ok ? c.data : [])
    setRecord(fr.ok && Object.keys(fr.data).length > 0 ? fr.data : null)
  }, [])

  const reload = useCallback((): void => {
    setDecisionsState(panelLoading())
    void load()
  }, [load])

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => {
      aliveRef.current = false
    }
  }, [load])

  useEffect(() => {
    if (recordOpen) titleRef.current?.focus()
  }, [recordOpen])

  // Open a decision's note via the OrgsPanel pattern. Prefer a matching graph
  // node (so the detail panel gets the full node), else synthesize a minimal one.
  const openDecision = (d: Decision): void => {
    // `d.id` is a BARE FILENAME (decisions-native builds it from the file stem), while a vault
    // node's graph id is its vault-RELATIVE PATH ("DUIN/Decisions/2026-06-10-….md"). An equality
    // test therefore never matched for any decision in a subfolder — which is all of them — so
    // every row click fell through to the synthesized 3-field stub below and opened a detail
    // pane with no group, no tags and no neighbours. Match on the path suffix as well.
    const node = (graph?.nodes ?? []).find(
      (n) => n.id === d.id || String(n.id).endsWith('/' + d.id)
    )
    const target = node ?? ({ id: d.id, label: d.title, kind: 'decision' } as never)
    focusNode(d.id)
    setDetail(target as never)
    setChatContext({ id: d.id, label: d.title, kind: 'decision' })
  }

  const effectiveCall = callChoice === 'custom' ? customCall.trim() : callChoice

  const submitRecord = async (): Promise<void> => {
    const tt = title.trim()
    if (!tt || !effectiveCall || recording) return
    setRecording(true)
    try {
      const r = await makeDecision({ title: tt, call: effectiveCall, rationale: rationale.trim() || undefined })
      if (!r.ok) throw new Error('make-decision failed')
      toast.success(t('Decision recorded'))
      setTitle('')
      setRationale('')
      setCustomCall('')
      setCallChoice('Cleared')
      setRecordOpen(false)
      await load()
    } catch {
      toast.error(t('Could not record decision'))
    } finally {
      setRecording(false)
    }
  }

  // doResolve (the 5-outcome hand-resolve) was removed 2026-07-27; its menu followed on
  // 2026-07-30. `resolveOwed` remains in brain-client with NO production caller — it is dead
  // code kept only by its own tests.

  const doVerdict = async (id: string, verdict: 'right' | 'wrong' | 'partial'): Promise<void> => {
    if (busy) return
    setBusy(id + verdict)
    try {
      // NOTE: intentionally still on the legacy /state/verdict path. The decision self-verdict
      // vocab (right/wrong/partial) is a DIFFERENT concept + id-space from brain-client's
      // recordPredictionVerdict (happened/averted/false_alarm) — migrating it is a product-vocab
      // decision, not a mechanical swap, so it is left until that mapping is settled.
      const ok = await recordVerdict(id, verdict)
      if (!ok) throw new Error('verdict failed')
      toast.success(tf('Verdict: {verdict}', { verdict }))
      await load()
    } catch {
      toast.error(t('Could not record verdict'))
    } finally {
      setBusy(null)
    }
  }

  const doCascade = async (id: string, action: 'approve' | 'dismiss'): Promise<void> => {
    if (busy) return
    setBusy(id + action)
    try {
      const r = await postCascadeResolve(id, action)
      if (!r.ok) throw new Error(r.error || 'cascade failed')
      toast.success(action === 'approve' ? t('Cascade approved') : t('Cascade dismissed'))
      await load()
    } catch {
      toast.error(t('Could not resolve cascade'))
    } finally {
      setBusy(null)
    }
  }

  const trackline = (() => {
    const pats = record?.patterns
    if (!pats) return ''
    let fired = 0
    let materialized = 0
    for (const v of Object.values(pats)) {
      fired += v.fired ?? 0
      materialized += v.materialized ?? 0
    }
    if (fired === 0) return ''
    return tf('foresight {fired} fired, {materialized} materialized', { fired, materialized })
  })()

  const due = decisions.filter(verdictDue)
  const waiting = due.length + cascades.length
  const summary =
    decisionsState.phase === 'ready'
      ? [
          decisions.length === 1 ? t('1 on record') : tf('{n} on record', { n: decisions.length }),
          waiting > 0 ? (waiting === 1 ? t('1 waits on you') : tf('{n} wait on you', { n: waiting })) : '',
          trackline
        ]
      : decisionsState.phase === 'loading'
        ? [t('Loading')]
        : [t('The decision ledger could not be read')]

  const recordForm = (
    <div className="mx-1 my-1 space-y-1.5 rounded-md border border-[var(--accent)]/40 bg-[var(--bg-primary)] p-2" onKeyDown={(e) => { if (e.key === 'Escape') setRecordOpen(false) }}>
      <input
        ref={titleRef}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitRecord() } }}
        placeholder={t('What did you decide?')}
        className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
      <div className="flex flex-wrap items-center gap-1.5">
        {(['Cleared', 'Blocked', 'custom'] as CallChoice[]).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setCallChoice(c)}
            aria-pressed={callChoice === c}
            className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
              callChoice === c
                ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg,#fff)]'
                : 'border-[var(--panel-border)] text-[var(--text-secondary)] hover:border-[var(--accent)]'
            }`}
          >
            {c === 'custom' ? t('Free text') : c === 'Cleared' ? t('Cleared') : t('Blocked')}
          </button>
        ))}
        {callChoice === 'custom' && (
          <input
            value={customCall}
            onChange={(e) => setCustomCall(e.target.value)}
            placeholder={t('The call…')}
            className="min-w-0 flex-1 rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
        )}
      </div>
      <textarea
        value={rationale}
        onChange={(e) => setRationale(e.target.value)}
        placeholder={t('Rationale (optional)…')}
        rows={2}
        className="w-full resize-none rounded-md border border-[var(--panel-border)] bg-[var(--panel-bg)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
      />
      <div className="flex items-center gap-2">
        <Button variant="primary" className="active:translate-y-px disabled:cursor-default" onClick={() => void submitRecord()} disabled={recording || !title.trim() || !effectiveCall}>
          {recording ? t('Recording…') : t('Record')}
        </Button>
        <Verb onClick={() => setRecordOpen(false)} disabled={recording}>{t('Cancel')}</Verb>
      </div>
    </div>
  )

  const recordVerb = (
    <Verb tone="accent" onClick={() => setRecordOpen(true)} title={t('Record a decision you made')}>
      {t('Record a decision')}
    </Verb>
  )

  const decisionMeta = (d: Decision): string =>
    [d.status?.trim(), d.oneWay ? t('one-way') : '', d.reversibility?.trim(), d.date?.trim()].filter(Boolean).join(' · ')

  return (
    <div className="flex h-full flex-col overflow-hidden px-2 pb-2 pt-1 text-[12px]">
      <PanelSummary
        parts={summary}
        action={
          <button onClick={reload} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
            {t('Refresh')}
          </button>
        }
      />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {waiting > 0 && (
          <PanelSection label={t('Waiting on you')}>
            <RowList>
              {due.map((d) => (
                <Row
                  key={d.id}
                  emphasis
                  primary={d.title}
                  secondary={tf('review was due {date}. Was the call right?', { date: d.reviewOn })}
                  onOpen={() => openDecision(d)}
                  title={t('Open decision note')}
                  actions={
                    <>
                      {(['right', 'wrong', 'partial'] as const).map((v) => (
                        <Verb
                          key={v}
                          tone={v === 'right' ? 'accent' : 'quiet'}
                          // Per-ROW, not global: `busy` is one shared slot also used by doCascade.
                          disabled={busy != null && busy.startsWith(d.id)}
                          onClick={() => void doVerdict(d.id, v)}
                        >
                          {busy === d.id + v ? '…' : v === 'right' ? t('Right') : v === 'wrong' ? t('Wrong') : t('Partly')}
                        </Verb>
                      ))}
                    </>
                  }
                />
              ))}
              {cascades.map((c) => {
                const label = c.proposal?.label || c.proposal?.title || c.proposal?.task_title || c.proposal?.goal || c.source || c.kind
                return (
                  <Row
                    key={c.id}
                    emphasis
                    primary={label}
                    secondary={[c.kind, c.proposal?.why].filter(Boolean).join(' · ')}
                    actions={
                      <>
                        <Verb tone="accent" disabled={busy === c.id + 'approve'} onClick={() => void doCascade(c.id, 'approve')}>{t('Approve')}</Verb>
                        <Verb disabled={busy === c.id + 'dismiss'} onClick={() => void doCascade(c.id, 'dismiss')}>{t('Dismiss')}</Verb>
                      </>
                    }
                  />
                )
              })}
            </RowList>
          </PanelSection>
        )}

        <PanelSection label={t('On record')} aside={!recordOpen ? recordVerb : undefined}>
          {recordOpen && recordForm}
          <PanelState
            state={decisionsState}
            onRetry={reload}
            loading={<div className="px-2 py-2 text-[12px] text-[var(--text-muted)]">{t('Loading')}</div>}
            error={(message, retry) => <PanelErrorState what="the decision ledger" message={message} onRetry={retry} />}
            empty={<CalmEmpty text={t('No decisions on record yet.')} action={!recordOpen ? recordVerb : undefined} />}
          >
            {(rows) => (
              <RowList>
                {rows.map((d) => (
                  <Row
                    key={d.id}
                    dot={statusLooksResolved(d.status) ? 'ok' : d.oneWay ? 'warn' : 'muted'}
                    primary={d.title}
                    secondary={decisionMeta(d) || undefined}
                    onOpen={() => openDecision(d)}
                    title={t('Open decision note')}
                  />
                ))}
              </RowList>
            )}
          </PanelState>
        </PanelSection>
      </div>
    </div>
  )
}
