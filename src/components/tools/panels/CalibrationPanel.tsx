import { t as tr } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import {
  fetchCalibration,
  fetchForecastOwed,
  markPrediction,
  type Calibration,
  type ForecastOwed
} from '@/duin/lib/state'
import { useBrainStore } from '@/stores/brain-store'
import { toast } from '@/stores/toast-store'

// Calibration — the honest forecast track-record surface. DUIN logs risk /
// stream / promotion predictions; this shows whether they pay off: per-tier and
// per-domain useful-rates (Wilson-bounded, gated below min_n), the running
// totals, and the most recently resolved predictions. Cold-start-aware: a fresh
// vault reads 0/gated and says "track record starts now" instead of faking a rate.
//
// Open predictions: the scorecard counts `open` (owed) forecasts but the engine
// only ever LISTED the already-resolved ones, so a vault with all-open forecasts
// showed a count with an empty body. fetchForecastOwed surfaces those rows into
// the "Open predictions" section below. Resolved items still take human feedback
// via markPrediction (flag / clear a false alarm); both kinds open their source
// note on click when the id maps to a graph node.

function pct(x: number | null | undefined): string {
  return typeof x === 'number' ? `${Math.round(x * 100)}%` : '—'
}

/** `embedded` — see BrainStatusPanel: the hub tab already names this surface. */
export function CalibrationPanel({ embedded = false }: { embedded?: boolean } = {}): React.ReactElement {
  const [cal, setCal] = useState<Calibration | null>(null)
  const [open, setOpen] = useState<ForecastOwed[]>([])
  // Why the open list is empty even when the tile above shows a count.
  const [owedWhy, setOwedWhy] = useState<{ selfResolving: number; notDueYet: number } | null>(null)
  const [err, setErr] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const focusNode = useBrainStore((s) => s.focusNode)
  const setDetail = useBrainStore((s) => s.setDetail)
  const setChatContext = useBrainStore((s) => s.setChatContext)
  const graphNodes = useBrainStore((s) => s.data?.nodes)

  const load = async (): Promise<void> => {
    try {
      setErr(false)
      setCal(await fetchCalibration())
    } catch {
      setErr(true)
      setCal(null)
    }
    // Open (owed) predictions — independent of the scorecard so a forecast-owed
    // failure doesn't blank the panel. Empty on any failure.
    try {
      const r = await fetchForecastOwed()
      setOpen(r.owed)
      setOwedWhy(r.ok ? { selfResolving: r.selfResolving, notDueYet: r.notDueYet } : null)
    } catch {
      setOpen([])
      setOwedWhy(null)
    }
  }
  useEffect(() => {
    void load()
  }, [])

  // Open a resolved prediction's source note (OrgsPanel pattern), if it maps to
  // a graph node.
  const openPrediction = (id: string, label: string): void => {
    const node = (graphNodes ?? []).find((n) => n.id === id)
    if (!node) return
    focusNode(id)
    setDetail(node as never)
    setChatContext({ id, label: node.label ? String(node.label) : label, kind: node.kind ?? 'note' })
  }

  // Human feedback overlay on a resolved prediction (false-alarm flag / clear).
  const onMark = async (
    id: string,
    domain: string,
    mark: 'false_alarm' | 'clear'
  ): Promise<void> => {
    setBusyId(id)
    try {
      const r = await markPrediction(id, domain, mark)
      if (r.ok) {
        toast.success(mark === 'false_alarm' ? 'Flagged as false alarm' : 'Feedback cleared')
        await load()
      } else {
        toast.error(r.error ?? 'Could not record feedback')
      }
    } catch (e) {
      toast.error((e as Error)?.message ?? 'Could not record feedback')
    } finally {
      setBusyId(null)
    }
  }

  const tiers = cal ? Object.entries(cal.tier_calibration ?? {}) : []
  const domains = cal ? Object.entries(cal.domains ?? {}) : []
  const resolved = cal?.recently_resolved ?? []
  const t = cal?.totals
  // Every list can be empty even when the count is non-zero (predictions logged
  // but not yet due). The breakdown line always explains what the number means.
  const allListsEmpty =
    tiers.length === 0 && domains.length === 0 && resolved.length === 0 && open.length === 0

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        {!embedded && (
          <span className="font-semibold text-[var(--text-primary)]">{tr('Calibration')}</span>
        )}
        {t && (
          <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-[11px] font-medium text-[var(--accent)]">
            {t.resolved}/{t.predictions} resolved
          </span>
        )}
        <button onClick={() => void load()} className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          refresh
        </button>
      </div>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        Does the foresight pay off? Useful-rate per confidence tier and domain, gated until there&apos;s
        enough resolved signal to be honest (min_n {cal?.min_n ?? 20}).
      </p>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {cal === null && !err && <div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}
        {err && (
          <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-3 text-[12px] text-[var(--text-secondary)]">
            Calibration unavailable — the brain engine isn&apos;t reachable yet.
          </div>
        )}

        {cal && t && t.predictions > 0 && (
          <div className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] px-2.5 py-1.5 text-[12px] text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-primary)]">{t.predictions} logged</span> ·{' '}
            {t.resolved} resolved · {t.open} awaiting outcome
            {allListsEmpty && (
              <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                {tr('Predictions resolve into the scorecard as their review dates arrive — nothing to score yet.')}
              </div>
            )}
          </div>
        )}

        {cal && t && (
          <div className="grid grid-cols-4 gap-1.5">
            {[
              ['predictions', t.predictions],
              ['resolved', t.resolved],
              ['open', t.open],
              ['false alarms', t.false_alarms]
            ].map(([label, n]) => (
              <div key={label} className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2 text-center">
                <div className="text-[14px] font-semibold text-[var(--text-primary)]">{n as number}</div>
                <div className="text-[11px] text-[var(--text-muted)]">{label}</div>
              </div>
            ))}
          </div>
        )}

        {cal && t && t.predictions === 0 && (
          <PanelEmptyState
            icon={<span className="text-[20px]">🎯</span>}
            title={tr('Track record starts now')}
            body={
              <>
                As DUIN logs forecasts and you resolve them (right / wrong / partial), per-tier and
                per-domain rates appear here — gated until {cal.min_n} are resolved, so the first
                number you see is one you can trust.
              </>
            }
          />
        )}

        {tiers.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {tr('By confidence tier')}
            </div>
            <div className="space-y-1">
              {tiers.map(([name, tier]) => (
                <div key={name} className="flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                  <span className="w-14 text-[12px] capitalize text-[var(--text-primary)]">{name}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">fired {tier.fired} · obs {tier.observed}</span>
                  <span className="ml-auto text-[12px] font-medium text-[var(--text-primary)]">
                    {tier.gated ? <span className="text-[var(--text-muted)]">gated</span> : pct(tier.useful_rate)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {domains.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {tr('By domain')}
            </div>
            <div className="space-y-1">
              {domains.map(([name, d]) => (
                <div key={name} className="flex items-center gap-2 rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                  <span className="text-[12px] text-[var(--text-primary)]">{name}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{d.resolved}/{d.total} resolved</span>
                  <span className="ml-auto text-[12px] font-medium text-[var(--text-primary)]">
                    {d.gated ? <span className="text-[var(--text-muted)]">gated</span> : pct(d.useful_rate)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* A non-zero `open` tile with no listable rows is the normal case here, not a fault:
            most unresolved forecasts are signal-mode (they resolve themselves off subject status)
            or simply not due yet. Saying so is the fix — the tile used to read "56 open" above a
            permanently empty section with nothing to explain the gap. */}
        {open.length === 0 && (t?.open ?? 0) > 0 && owedWhy &&
          owedWhy.selfResolving + owedWhy.notDueYet > 0 && (
          <p className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2 text-[11px] text-[var(--text-muted)]">
            {t?.open} open, none awaiting your verdict. Of those,{' '}
            {owedWhy.selfResolving > 0 && <>{owedWhy.selfResolving} resolve themselves from subject status</>}
            {owedWhy.selfResolving > 0 && owedWhy.notDueYet > 0 && <>, </>}
            {owedWhy.notDueYet > 0 && <>{owedWhy.notDueYet} are not due yet</>}
            {owedWhy.selfResolving + owedWhy.notDueYet < (t?.open ?? 0) && (
              <> ; the remainder sit in ledgers this breakdown does not cover</>
            )}
            .
          </p>
        )}

        {open.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {tr('Open predictions')}
            </div>
            <div className="space-y-1.5">
              {open.slice(0, 20).map((o) => {
                const hasNode = (graphNodes ?? []).some((n) => n.id === o.id)
                return (
                  <div key={o.id} className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--text-muted)]"
                        title="awaiting verdict"
                      />
                      {hasNode ? (
                        <button
                          type="button"
                          title={tr('Open the source note')}
                          onClick={() => openPrediction(o.id, o.predicted)}
                          className="cursor-pointer text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                        >
                          {o.predicted}
                        </button>
                      ) : (
                        <span className="text-[12px] text-[var(--text-secondary)]">{o.predicted}</span>
                      )}
                      {typeof o.confidence === 'number' && (
                        <span className="ml-auto text-[11px] text-[var(--text-muted)]">{pct(o.confidence)}</span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-3.5">
                      {o.track && <span className="text-[11px] text-[var(--text-muted)]">{o.track}</span>}
                      {o.eval_by && <span className="text-[11px] text-[var(--text-muted)]">due {o.eval_by}</span>}
                      {o.days_overdue > 0 && (
                        <span className="text-[11px] text-[var(--warning)]">{o.days_overdue}d overdue</span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {resolved.length > 0 && (
          <div>
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">
              {tr('Recently resolved')}
            </div>
            <div className="space-y-1.5">
              {resolved.slice(0, 12).map((r) => {
                const hasNode = (graphNodes ?? []).some((n) => n.id === r.id)
                return (
                  <div key={r.id} className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${r.false_alarm ? 'bg-[var(--text-muted)]' : 'bg-[var(--accent)]'}`}
                        title={r.verdict}
                      />
                      {hasNode ? (
                        <button
                          type="button"
                          title={tr('Open the source note')}
                          onClick={() => openPrediction(r.id, r.predicted)}
                          className="cursor-pointer text-left text-[12px] text-[var(--text-secondary)] hover:text-[var(--accent)]"
                        >
                          {r.predicted}
                        </button>
                      ) : (
                        <span className="text-[12px] text-[var(--text-secondary)]">{r.predicted}</span>
                      )}
                      <span className="ml-auto text-[11px] uppercase text-[var(--text-muted)]">{r.verdict}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 pl-3.5">
                      {r.domain && <span className="text-[11px] text-[var(--text-muted)]">{r.domain}</span>}
                      <div className="ml-auto flex gap-1.5">
                        {r.false_alarm ? (
                          <Button variant="secondary" className="px-1.5 hover:text-[var(--text-secondary)]"
                            disabled={busyId === r.id}
                            onClick={() => void onMark(r.id, r.domain, 'clear')}
                          >
                            {tr('Clear flag')}
                          </Button>
                        ) : (
                          <button
                            type="button"
                            disabled={busyId === r.id}
                            onClick={() => void onMark(r.id, r.domain, 'false_alarm')}
                            className="rounded border border-[var(--panel-border)] px-1.5 py-0.5 text-[11px] text-[var(--text-muted)] transition-colors hover:text-[var(--accent)] disabled:opacity-50"
                          >
                            {tr('False alarm')}
                          </button>
                        )}
                      </div>
                    </div>
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
