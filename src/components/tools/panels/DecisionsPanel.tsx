import { t } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PanelState, PanelErrorState } from '@/components/ui/PanelState'
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

// Decisions — "make the call" workspace. Three defensively-rendered sections:
//  1. Record a decision (makeDecision)
//  2. Open / recent decisions (fetchDecisions) — click to open the note, and score a
//     verdict on the rows where a review date has come due
//  3. Pending cascades (fetchCascadePending) — approve / dismiss
// Track-record header from fetchForecastRecord when present.

type CallChoice = 'Cleared' | 'Blocked' | 'custom'

// Terminal-status test. Now used ONLY to show the ✓ chip — it no longer gates any
// action, because hand-resolving was removed and closing an owed window is
// brain/decision-loop's job on the calibration tick.
function statusLooksResolved(status: string): boolean {
  const s = (status || '').toLowerCase()
  return /resolv|closed|archiv|done|verdict|decided|cleared|blocked|made/.test(s)
}
function verdictDue(d: Decision): boolean {
  if (!d.reviewOn) return false
  const t = Date.parse(d.reviewOn)
  if (Number.isNaN(t)) return false
  return t <= Date.now()
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

  // record-a-decision form
  const [title, setTitle] = useState('')
  const [callChoice, setCallChoice] = useState<CallChoice>('Cleared')
  const [customCall, setCustomCall] = useState('')
  const [rationale, setRationale] = useState('')
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const aliveRef = useRef(true)

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
    const t = title.trim()
    if (!t || !effectiveCall || recording) return
    setRecording(true)
    try {
      const r = await makeDecision({ title: t, call: effectiveCall, rationale: rationale.trim() || undefined })
      if (!r.ok) throw new Error('make-decision failed')
      toast.success('Decision recorded')
      setTitle('')
      setRationale('')
      setCustomCall('')
      setCallChoice('Cleared')
      await load()
    } catch {
      toast.error('Could not record decision')
    } finally {
      setRecording(false)
    }
  }

  // doResolve (the 5-outcome hand-resolve) was removed 2026-07-27; its menu followed on
  // 2026-07-30 (see the verdict buttons in the row below). `resolveOwed` remains in
  // brain-client with NO production caller — it is dead code kept only by its own tests.

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
      toast.success(`Verdict: ${verdict}`)
      await load()
    } catch {
      toast.error('Could not record verdict')
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
      toast.success(action === 'approve' ? 'Cascade approved' : 'Cascade dismissed')
      await load()
    } catch {
      toast.error('Could not resolve cascade')
    } finally {
      setBusy(null)
    }
  }

  const trackline = (() => {
    const pats = record?.patterns
    if (!pats) return null
    let fired = 0
    let materialized = 0
    for (const v of Object.values(pats)) {
      fired += v.fired ?? 0
      materialized += v.materialized ?? 0
    }
    if (fired === 0) return null
    return `Track record · ${fired} fired · ${materialized} materialized`
  })()

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-[var(--text-primary)]">{t('Decisions')}</span>
        {decisionsState.phase === 'ready' && decisions.length > 0 && (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            {decisions.length} on record
          </span>
        )}
      </div>

      {trackline && (
        <div className="mb-2 rounded-md border border-[var(--panel-border)] bg-[var(--app-bg)] px-2 py-1 text-[11px] text-[var(--text-muted)]">
          {trackline}
        </div>
      )}

      <div className="flex-1 space-y-4 overflow-y-auto">
        {/* 1. Record a decision — make the call */}
        <section>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {t('Make the call')}
          </div>
          <div className="space-y-1.5 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('What did you decide?')}
              className="w-full rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex flex-wrap items-center gap-1.5">
              {(['Cleared', 'Blocked', 'custom'] as CallChoice[]).map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCallChoice(c)}
                  className={`rounded-md border px-2 py-0.5 text-[11px] transition-colors ${
                    callChoice === c
                      ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                      : 'border-[var(--panel-border)] text-[var(--text-secondary)] hover:border-[var(--accent)]'
                  }`}
                >
                  {c === 'custom' ? 'Free text' : c}
                </button>
              ))}
              {callChoice === 'custom' && (
                <input
                  value={customCall}
                  onChange={(e) => setCustomCall(e.target.value)}
                  placeholder={t('The call…')}
                  className="min-w-0 flex-1 rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              )}
            </div>
            <textarea
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder={t('Rationale (optional)…')}
              rows={2}
              className="w-full resize-none rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
            />
            <div className="flex justify-end">
              <Button variant="primary" className="disabled:cursor-default"
                onClick={() => void submitRecord()}
                disabled={recording || !title.trim() || !effectiveCall}
              >
                {recording ? 'Recording…' : 'Record'}
              </Button>
            </div>
          </div>
        </section>

        {/* 2. Open / recent decisions */}
        <section>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            Open & recent
          </div>
          <PanelState
            state={decisionsState}
            onRetry={reload}
            loading={<div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}
            error={(message, retry) => (
              <PanelErrorState what="the decision ledger" message={message} onRetry={retry} />
            )}
            empty={
              <p className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3 text-[12px] text-[var(--text-secondary)]">
                No decisions on record yet. Use “Make the call” above to log your first one.
              </p>
            }
          >
            {(rows) => (
            <ul className="space-y-1.5">
              {rows.map((d) => {
                const resolved = statusLooksResolved(d.status)
                const dueVerdict = verdictDue(d)
                // The five RESOLVE outcomes (Cleared/Blocked/Done/Dismissed/Cancelled) were
                // removed 2026-07-27 with the Active Work retirement. They were the second
                // copy of the same manual queue — this panel's own comment above pointed at
                // Active Work as the place owed calls get recorded, and both wrote through
                // resolveOwed. Closing an owed window is now brain/decision-loop's job on the
                // calibration tick, so leaving a hand-resolve menu here would mean two
                // mechanisms writing the same field with different semantics.
                //
                // VERDICT scoring stays. It is a different act: not "did you do this yet" but
                // "did the call you already made prove right", which is retrospective judgment
                // an engine cannot supply without grading its own homework. This panel is the
                // auditable RECORD of decisions plus that judgment — not a to-do list.
                return (
                  <li
                    key={d.id}
                    className="relative rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2"
                  >
                    <button
                      type="button"
                      onClick={() => openDecision(d)}
                      title={t('Open decision note')}
                      className="flex w-full items-start gap-2 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                          {d.title}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                          {d.status && <span>{d.status}</span>}
                          {d.oneWay && <span className="text-[var(--warning)]">one-way</span>}
                          {d.reversibility && <span>{d.reversibility}</span>}
                          {d.date && <span>{d.date}</span>}
                        </span>
                      </span>
                      {/* Explicit status chip — the visible proof the press took
                          effect, computed from the refetched decision's status. */}
                      {resolved && (
                        <span className="shrink-0 rounded-full bg-[var(--success)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--success)]">
                          ✓ {d.status?.trim() || 'resolved'}
                        </span>
                      )}
                    </button>
                    {/* Score the call, inline. This used to be a dropdown labelled "Resolve",
                        which lied twice over: the five resolve outcomes were removed on
                        2026-07-27 and only right/wrong/partial were left inside, so the button
                        named an act it could no longer perform — and because the button's own
                        render gate (`!resolved || dueVerdict`) was wider than the gate that
                        filled it (`dueVerdict`), a not-yet-resolved row with no review date
                        opened an empty menu. Three flat buttons shown only when a verdict is
                        actually due say what they do and cannot open onto nothing.
                        The WRITE is deliberately unchanged: recordVerdict is the only producer
                        of decision-outcomes.jsonl, which feeds the decision track-record block
                        into chat grounding (agui-grounding). Removing it would starve that. */}
                    {dueVerdict && (
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] text-[var(--text-muted)]">
                          review due {d.reviewOn} — was the call
                        </span>
                        {(['right', 'wrong', 'partial'] as const).map((v) => (
                          <Button
                            key={v}
                            size="sm"
                            variant="secondary"
                            // Per-ROW, not global. `busy` is one shared slot also used by
                            // doCascade, so `!!busy` froze the verdict buttons on every row
                            // whenever any write was in flight — approving a cascade in the
                            // section below disabled scoring up here. The removed dropdown
                            // scoped this correctly via rowBusy; restore that scope.
                            disabled={busy != null && busy.startsWith(d.id)}
                            onClick={() => void doVerdict(d.id, v)}
                          >
                            {busy === d.id + v ? '…' : v}
                          </Button>
                        ))}
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
            )}
          </PanelState>
        </section>

        {/* 3. Pending cascades */}
        <section>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
            {t('Pending cascades')}
          </div>
          {cascades.length === 0 ? (
            <p className="text-[12px] text-[var(--text-muted)]">{t('No cascades waiting on your call.')}</p>
          ) : (
            <ul className="space-y-1.5">
              {cascades.map((c) => {
                const label =
                  c.proposal?.label ||
                  c.proposal?.title ||
                  c.proposal?.task_title ||
                  c.proposal?.goal ||
                  c.source ||
                  c.kind
                return (
                  <li
                    key={c.id}
                    className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2"
                  >
                    <div className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] font-medium text-[var(--text-primary)]">
                          {label}
                        </span>
                        <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
                          <span>{c.kind}</span>
                          {c.proposal?.why && <span className="truncate">{c.proposal.why}</span>}
                        </span>
                      </span>
                    </div>
                    <div className="mt-1.5 flex items-center gap-1.5">
                      <Button variant="primary"
                        onClick={() => void doCascade(c.id, 'approve')}
                        disabled={busy === c.id + 'approve'}
                      >
                        {t('Approve')}
                      </Button>
                      <Button variant="secondary" className="hover:border-[var(--accent)]"
                        onClick={() => void doCascade(c.id, 'dismiss')}
                        disabled={busy === c.id + 'dismiss'}
                      >
                        {t('Dismiss')}
                      </Button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>
    </div>
  )
}
