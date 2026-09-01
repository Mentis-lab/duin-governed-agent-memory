import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from '@/stores/toast-store'
import {
  fetchSchedulesWithRunner,
  fetchBrainGraphSummary,
  scheduleAction,
  fetchTaste,
  fetchLearnLoop,
  runReflect,
  bindCandidate,
  type Schedule,
  type Taste,
  type LearnLoop
} from '@/duin/lib/state'

// Brain status — the "error log the brain never had". DUIN surfaces its own
// health here, and every line carries an ACTION, not a static readout. The
// failure modes this project actually hit are the ones it makes visible +
// fixable: a stale engine ("looks connected but the graph is empty"), loops
// that silently never fire, learning that never compiles, sources that drift
// out of sync. Each section reads a live source and exposes the one button
// that repairs it.

// ── window.api surfaces this panel touches (typed inline so it doesn't depend
//    on the main process's preload type across the tsconfig boundary). The real
//    preload key for ingest sources is `connections` (not `connectors`); we
//    wire to the live key so Sync actually fires. ───────────────────────────
interface BrainApi {
  reindex?: () => Promise<{ success: boolean; data?: { ok: boolean; count: number }; error?: string }>
  onUpdated?: (cb: (e: { count: number }) => void) => () => void
}
interface Connection {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  lastSyncMs: number | null
  lastCount: number | null
  lastError: string | null
}
interface ConnApi {
  list?: () => Promise<{ success: boolean; data?: Connection[]; error?: string }>
  sync?: (id: string) => Promise<{ success: boolean; data?: { ok: boolean; count: number; error?: string }; error?: string }>
}
function brainApi(): BrainApi | undefined {
  return (window as unknown as { api?: { brain?: BrainApi } }).api?.brain
}
function connApi(): ConnApi | undefined {
  return (window as unknown as { api?: { connections?: ConnApi } }).api?.connections
}

// Humanize a ms-since-epoch timestamp into a relative "synced …" label.
function ago(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 0) return 'just now'
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** Compact human form of a loop's last-fired stamp. The raw value is a full ISO string
 *  ("2026-07-25T06:24:28.910Z"), which the narrow panel truncated mid-token — render
 *  relative time instead, falling through to the raw string if it doesn't parse. */
function formatWhen(iso: string): string {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? ago(t) : iso
}

const ROW = 'rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2.5'
const ACTION_BTN =
  'shrink-0 rounded-md bg-[var(--accent)] px-2.5 py-1 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50'

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <div className="mt-3 px-0.5 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)] first:mt-0">
      {children}
    </div>
  )
}

// ── Binding candidates — the falsification loop's mouth ──────────────────────
//
// reflect() clusters recurring corrections into binding_candidates and returns
// them; this panel used to read `taste_counts` and `stream_size` off that result
// for a toast and DISCARD `r.binding_candidates` entirely. POST /state/bind-candidate
// had zero callers. So the whole loop — cluster, confirm, falsify by recurrence —
// was complete except for the one step only a human can take.
//
// Nothing here auto-binds, by design: the route 400s unless a human supplies an
// explicit rule. The draft below is a starting point for that human, not a
// pre-approval.

export interface BindingCandidate {
  count: number
  theme: string[]
  sample: string
}

/** The editable rule draft for a candidate. The sample IS the recurring correction,
 *  so it is the honest starting text; the theme is the fallback when a cluster
 *  carries no sample. Empty when there is nothing to draft from — a draft that
 *  looked confirmable but was not would just produce a 400. */
export function defaultRuleFor(c: BindingCandidate): string {
  if (c.sample && c.sample.trim()) return c.sample.trim()
  if (c.theme.length > 0) return c.theme.join(' ')
  return ''
}

/** Exactly the route's own gate (`candidate.theme[]` non-empty AND a non-blank
 *  `rule`), so the Confirm button is disabled precisely when the POST would 400
 *  rather than letting the operator discover the refusal by clicking. */
export function canConfirmBinding(c: BindingCandidate, rule: string): boolean {
  return c.theme.length > 0 && rule.trim().length > 0
}

/** The strength line under a candidate: the recurrence count is WHY it surfaced. */
export function bindingCandidateLine(c: BindingCandidate): string {
  return `${c.count} correction${c.count === 1 ? '' : 's'} in this cluster`
}

/** Stable per-render key. reflect() is deterministic over an append-only stream and
 *  two clusters can share a theme, so the index is part of the key. */
function candidateKey(c: BindingCandidate, i: number): string {
  return `${i}:${c.theme.join('|')}`
}

/** `embedded` — rendered inside the Status hub, where the active tab already names this
 *  surface. Suppresses the redundant title only; the Refresh action stays. */
export function BrainStatusPanel({ embedded = false }: { embedded?: boolean } = {}): React.ReactElement {
  // Graph counts. These used to read the brain-store (`s.data`) — but the ONLY writers of
  // that store are the graph surfaces (BrainExplorerPanel / NodeWindow / brain-shell), and this
  // panel is not one of them. So opening Status without first opening the Explorer rendered
  // "○ Degraded — open the brain to load · 0 nodes · 0 links" on a healthy 2103-node brain:
  // a false-negative health readout on the one line the panel exists to show. The old
  // `forceTick` could not fix it either — re-rendering unchanged data changes nothing.
  //
  // Fetch COUNTS ONLY, and re-fetch on `brain:updated` (the pattern GraphReportPanel
  // already uses), so Rebuild visibly moves the numbers instead of leaving them frozen.
  // /state/brain-graph/summary, not the full graph: this panel displays two integers, and
  // the full route is ~1.5MB whose JSON.parse was a measured renderer main-thread stall on
  // every Status open (the same cost brain-shell throttled for window focus at its 15s
  // floor — this call site fetched the whole payload unthrottled until 2026-08-21).
  // TRI-STATE, deliberately. `undefined` = not yet known (loading or failed); `null` is not used.
  // The first version of this fix fell back to the brain-store on fetch failure, which swapped a
  // false NEGATIVE for a false POSITIVE: with the Explorer already open the store holds 2000+
  // nodes, so a DEAD backend rendered "● Connected · 2,103 nodes". For a panel whose whole job is
  // to be "the error log the brain never had", claiming health on a dead engine is the strictly
  // worse direction. It also showed "Degraded · 0 nodes" for the duration of every initial fetch.
  const [graph, setGraph] = useState<{ nodes: number; links: number } | undefined>(undefined)
  const [graphErr, setGraphErr] = useState(false)
  const loadGraph = useCallback(async (): Promise<void> => {
    try {
      const g = await fetchBrainGraphSummary()
      setGraph(g)
      setGraphErr(false)
    } catch {
      setGraph(undefined)
      setGraphErr(true) // say "unreachable" — never borrow the Explorer's stale counts
    }
  }, [])
  useEffect(() => {
    void loadGraph()
    const off = brainApi()?.onUpdated?.(() => void loadGraph())
    return () => off?.()
  }, [loadGraph])

  const nodeCount = graph?.nodes ?? 0
  const linkCount = graph?.links ?? 0
  // Only OUR fetch can report health. Unknown (loading) and unreachable are distinct from empty.
  const graphKnown = graph !== undefined
  const connected = graphKnown && nodeCount > 0

  // ── Scheduled loops ────────────────────────────────────────────────────────
  const [schedules, setSchedules] = useState<Schedule[] | null>(null)
  const [schedError, setSchedError] = useState<string | null>(null)
  // Whether the loop runner can actually FIRE these (backgroundAutonomy AND loopsEnabled).
  // When off, a computed "due" is not a promise of execution — render it as waiting instead.
  const [runnerEnabled, setRunnerEnabled] = useState(true)

  // ── Learning ───────────────────────────────────────────────────────────────
  const [taste, setTaste] = useState<Taste | null>(null)
  const [learn, setLearn] = useState<LearnLoop | null>(null)

  // ── Sources ────────────────────────────────────────────────────────────────
  const [conns, setConns] = useState<Connection[] | null>(null)

  // ── Binding candidates (from the last reflect) ─────────────────────────────
  const [candidates, setCandidates] = useState<BindingCandidate[]>([])
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState(0)
  const [binding, setBinding] = useState<string | null>(null)

  // ── Per-action busy flags ──────────────────────────────────────────────────
  const [reindexing, setReindexing] = useState(false)
  const [reflecting, setReflecting] = useState(false)
  const [runningLoop, setRunningLoop] = useState<string | null>(null)
  const [syncing, setSyncing] = useState<string | null>(null)

  const loadSchedules = useCallback(async (): Promise<void> => {
    try {
      const { schedules: rows, runnerEnabled: canRun } = await fetchSchedulesWithRunner()
      setSchedules(rows)
      setRunnerEnabled(canRun)
      setSchedError(null)
    } catch (e) {
      setSchedules([])
      setSchedError(e instanceof Error ? e.message : 'could not reach the loop engine')
    }
  }, [])

  const loadLearning = useCallback(async (): Promise<void> => {
    try {
      setTaste(await fetchTaste())
    } catch {
      setTaste(null)
    }
    try {
      setLearn(await fetchLearnLoop())
    } catch {
      setLearn(null)
    }
  }, [])

  const loadSources = useCallback(async (): Promise<void> => {
    try {
      const r = await connApi()?.list?.()
      setConns(r?.success ? (r.data ?? []) : [])
    } catch {
      setConns([])
    }
  }, [])

  const refreshAll = useCallback((): void => {
    void loadSchedules()
    void loadLearning()
    void loadSources()
    void loadGraph()
  }, [loadSchedules, loadLearning, loadSources, loadGraph])

  useEffect(() => {
    refreshAll()
  }, [refreshAll])

  // ── Actions ────────────────────────────────────────────────────────────────
  const rebuild = async (): Promise<void> => {
    setReindexing(true)
    try {
      const r = await brainApi()?.reindex?.()
      // Two bugs lived here. (1) The guard was `if (r && r.success === false)`, so an ABSENT
      // bridge — `r === undefined` — fell through to the success branch: a dead IPC channel was
      // indistinguishable from a completed rebuild. (2) The handler returns the note count it
      // re-indexed and the toast threw it away for a static string, which is the whole reason
      // this button felt like it did nothing.
      if (!r) {
        toast.error('Rebuild unavailable — the brain bridge is not connected')
      } else if (r.success === false) {
        toast.error(r.error || 'Rebuild failed')
      } else {
        const n = r.data?.count
        toast.success(
          typeof n === 'number' ? `Re-indexed ${n.toLocaleString()} notes` : 'Rebuilt the brain index'
        )
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Rebuild failed')
    } finally {
      setReindexing(false)
    }
  }

  const runLoop = async (name: string): Promise<void> => {
    setRunningLoop(name)
    try {
      const r = await scheduleAction({ action: 'run', name })
      if (r?.ok) {
        toast.success(r.message || `Ran ${name}`)
      } else {
        // Read `message` FIRST, not `error`. The route collapses both of its fields into one
        // wire key — `{ ok, message: out.message ?? out.error ?? '' }` — so the reason for a
        // failure always arrives as `message`, and reading only `error` silently discarded it in
        // favour of the generic string. The red/green signal was right and the explanation was
        // being thrown away one line later, which is the same defect one layer up.
        toast.error(r?.message || r?.error || `Could not run ${name}`)
      }
      void loadSchedules()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not run ${name}`)
    } finally {
      setRunningLoop(null)
    }
  }

  const reflect = async (): Promise<void> => {
    setReflecting(true)
    try {
      const r = await runReflect()
      const rules = r?.taste_counts?.correction_rules ?? 0
      // KEEP the candidates. This line used to be absent: reflect returned the
      // clustered binding_candidates and the panel read only the two numbers it
      // needed for the toast, silently dropping the one output a human can act on.
      const cands = r?.binding_candidates ?? []
      setCandidates(cands)
      setRuleDrafts(Object.fromEntries(cands.map((c, i) => [candidateKey(c, i), defaultRuleFor(c)])))
      toast.success(`Reflected: ${r?.stream_size ?? 0} verdicts, ${rules} taste rules compiled`)
      void loadLearning()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Reflect failed')
    } finally {
      setReflecting(false)
    }
  }

  const confirmBinding = async (c: BindingCandidate, key: string): Promise<void> => {
    const rule = ruleDrafts[key] ?? ''
    if (!canConfirmBinding(c, rule)) return
    setBinding(key)
    try {
      const r = await bindCandidate(c, rule.trim())
      if (!r.ok) {
        toast.error(r.error || 'Could not confirm that rule')
        return
      }
      // Confirmed candidates leave the list — the row's purpose is discharged, and
      // leaving it would invite a duplicate bind of the same cluster.
      setCandidates((prev) => prev.filter((_, i) => candidateKey(prev[i], i) !== key))
      setConfirmed((n) => n + 1)
      toast.success('Rule bound — it will be falsified if the correction stops recurring')
    } finally {
      setBinding(null)
    }
  }

  const syncSource = async (c: Connection): Promise<void> => {
    setSyncing(c.id)
    try {
      const r = await connApi()?.sync?.(c.id)
      // Same absent-bridge hole as Rebuild had: `r === undefined` skipped both guards below and
      // reported a successful sync. This one already surfaced its count, so only the guard was
      // missing.
      if (!r) {
        toast.error(`Sync unavailable — the connections bridge is not connected`)
      } else if (r.success === false) {
        toast.error(r.error || `Could not sync ${c.label}`)
      } else if (r?.data && r.data.ok === false) {
        toast.error(r.data.error || `Could not sync ${c.label}`)
      } else {
        toast.success(`Synced ${c.label}${r?.data?.count != null ? `: ${r.data.count} items` : ''}`)
      }
      void loadSources()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : `Could not sync ${c.label}`)
    } finally {
      setSyncing(null)
    }
  }

  const tasteRules = taste?.correction_rules?.length ?? 0
  const pending = learn?.proposals_pending ?? 0
  // Sources worth showing: enabled or already configured (the ones that can drift).
  const liveSources = useMemo(
    () => (conns ?? []).filter((c) => c.enabled || c.configured),
    [conns]
  )

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        {!embedded && (
          <span className="font-semibold text-[var(--text-primary)]">{t('Brain status')}</span>
        )}
        <button
          onClick={refreshAll}
          className="ml-auto rounded-md border border-[var(--panel-border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {t('Refresh')}
        </button>
      </div>

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {/* 5. Engine — the at-a-glance health line. THREE states, not two: a panel that only
            knows "connected / degraded" has to call one of them while it is still loading, and
            will call a dead backend healthy if it borrows a cached count from elsewhere. */}
        <div className="flex items-center gap-2 px-0.5 py-1 text-[12px]">
          {connected ? (
            <>
              <span style={{ color: 'var(--success)' }}>●</span>
              <span className="text-[var(--text-primary)]">{t('Connected')}</span>
              <span className="text-[var(--text-muted)]">· brain loaded</span>
            </>
          ) : graphErr ? (
            <>
              <span style={{ color: 'var(--error, var(--warning))' }}>●</span>
              <span className="text-[var(--text-primary)]">{t('Unreachable')}</span>
              <span className="text-[var(--text-muted)]">— the brain engine did not answer</span>
            </>
          ) : !graphKnown ? (
            <>
              <span style={{ color: 'var(--text-muted)' }}>○</span>
              <span className="text-[var(--text-muted)]">Checking the engine…</span>
            </>
          ) : (
            <>
              <span style={{ color: 'var(--warning)' }}>○</span>
              <span className="text-[var(--text-primary)]">{t('Degraded')}</span>
              <span className="text-[var(--text-muted)]">— the engine answered with an empty graph</span>
            </>
          )}
        </div>

        {/* 1. Knowledge graph */}
        <SectionTitle>{t('Knowledge graph')}</SectionTitle>
        <div className={ROW}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-[var(--text-primary)]">
                {graphKnown ? `${nodeCount.toLocaleString()} nodes` : graphErr ? 'unreachable' : '…'}
              </span>
              {graphKnown && (
                <span className="text-[var(--text-muted)]"> · {linkCount.toLocaleString()} links</span>
              )}
            </span>
            <button onClick={() => void rebuild()} disabled={reindexing} className={ACTION_BTN}>
              {reindexing ? 'Rebuilding…' : 'Rebuild'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            {t('Re-indexes your notes into the graph. Run this if the field looks stale.')}
          </p>
        </div>

        {/* 2. Scheduled loops */}
        <SectionTitle>{t('Scheduled loops')}</SectionTitle>
        {schedules === null ? (
          <div className="px-0.5 py-1 text-[12px] text-[var(--text-muted)]">Loading…</div>
        ) : schedError ? (
          <div className={ROW}>
            <span className="text-[12px] text-[var(--warning)]">{schedError}</span>
          </div>
        ) : schedules.length === 0 ? (
          <div className={ROW}>
            <span className="text-[12px] text-[var(--text-muted)]">{t('No scheduled loops.')}</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="px-0.5 text-[11px] text-[var(--text-muted)]">
              {schedules.length} loop{schedules.length === 1 ? '' : 's'}
            </div>
            {!runnerEnabled && (
              <div className="px-0.5 text-[11px] text-[var(--text-muted)]">
                The loop runner is off — these never fire on their own. Turn on Background
                autonomy and Loops in Settings, or use Run to fire one now.
              </div>
            )}
            {schedules.map((s) => {
              const key = s.name
              return (
                <div key={key} className={ROW}>
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
                      {s.name || s.schedule || 'loop'}
                      {s.due && runnerEnabled && (
                        <span className="ml-1.5 text-[11px] font-medium text-[var(--warning)]">due</span>
                      )}
                      {s.due && !runnerEnabled && (
                        <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">waiting — runner off</span>
                      )}
                      {s.paused && (
                        <span className="ml-1.5 text-[11px] text-[var(--text-muted)]">paused</span>
                      )}
                    </span>
                    <button
                      onClick={() => void runLoop(s.name)}
                      disabled={runningLoop === s.name}
                      className={ACTION_BTN}
                    >
                      {runningLoop === s.name ? 'Running…' : 'Run'}
                    </button>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                    {s.schedule && <span>{s.schedule}</span>}
                    {s.last && <span>· last fired {formatWhen(s.last)}</span>}
                    {!s.enabled && <span>· disabled</span>}
                  </div>
                </div>
              )
            })}
          </div>
        )}

        {/* 3. Learning */}
        <SectionTitle>{t('Learning')}</SectionTitle>
        <div className={ROW}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-[var(--text-primary)]">
                {tasteRules} taste rule{tasteRules === 1 ? '' : 's'}
              </span>
              {pending > 0 && (
                <span className="text-[var(--text-muted)]"> · {pending} pending</span>
              )}
            </span>
            <button onClick={() => void reflect()} disabled={reflecting} className={ACTION_BTN}>
              {reflecting ? 'Reflecting…' : 'Reflect now'}
            </button>
          </div>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">
            {t('Compiles your verdicts into taste.')}
          </p>
        </div>

        {/* 3b. Binding candidates — clusters of corrections that recurred often
            enough to be worth turning into a rule. reflect() has always returned
            these; this panel used to throw them away, so the only step of the
            falsification loop a human can take had nowhere to happen. Nothing
            binds without an explicit confirm. */}
        {(candidates.length > 0 || confirmed > 0) && (
          <>
            <SectionTitle>{t('Rules worth binding')}</SectionTitle>
            {candidates.length === 0 ? (
              <div className={ROW}>
                <span className="text-[12px] text-[var(--text-muted)]">
                  {confirmed} bound this session — nothing else is recurring often enough yet.
                </span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {candidates.map((c, i) => {
                  const key = candidateKey(c, i)
                  const draft = ruleDrafts[key] ?? ''
                  return (
                    <div key={key} className={ROW}>
                      <div className="flex flex-wrap items-center gap-1">
                        {c.theme.map((t) => (
                          <span
                            key={t}
                            className="rounded bg-[var(--bg-tertiary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
                          >
                            {t}
                          </span>
                        ))}
                        <span className="ml-auto text-[11px] text-[var(--text-muted)]">
                          {bindingCandidateLine(c)}
                        </span>
                      </div>
                      {c.sample && (
                        <p className="mt-1 text-[11px] italic text-[var(--text-muted)]">“{c.sample}”</p>
                      )}
                      <div className="mt-1.5 flex items-center gap-2">
                        <input
                          value={draft}
                          onChange={(e) =>
                            setRuleDrafts((d) => ({ ...d, [key]: e.target.value }))
                          }
                          placeholder="the rule to bind"
                          className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-1.5 py-1 text-[11px] text-[var(--text-primary)]"
                        />
                        <button
                          onClick={() => void confirmBinding(c, key)}
                          disabled={binding === key || !canConfirmBinding(c, draft)}
                          className={ACTION_BTN}
                        >
                          {binding === key ? 'Binding…' : 'Confirm'}
                        </button>
                      </div>
                      <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                        Confirming records the rule and starts checking it — if the correction stops
                        recurring, the binding is falsified rather than kept.
                      </p>
                    </div>
                  )
                })}
              </div>
            )}
          </>
        )}

        {/* 4. Sources */}
        <SectionTitle>{t('Sources')}</SectionTitle>
        {conns === null ? (
          <div className="px-0.5 py-1 text-[12px] text-[var(--text-muted)]">Loading…</div>
        ) : liveSources.length === 0 ? (
          <div className={ROW}>
            <span className="text-[12px] text-[var(--text-muted)]">
              No sources connected — add them in Settings → Sources.
            </span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {liveSources.map((c) => (
              <div key={c.id} className={ROW}>
                <div className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium text-[var(--text-primary)]">
                    {c.label}
                    {c.enabled && (
                      <span className="ml-1.5 rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                        on
                      </span>
                    )}
                  </span>
                  <button
                    onClick={() => void syncSource(c)}
                    disabled={syncing === c.id}
                    className={ACTION_BTN}
                  >
                    {syncing === c.id ? 'Syncing…' : 'Sync'}
                  </button>
                </div>
                <div className="mt-1 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                  <span>synced {ago(c.lastSyncMs)}</span>
                  {c.lastCount != null && <span>· {c.lastCount} items</span>}
                  {c.lastError && <span className="text-[var(--error)]">· {c.lastError}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
