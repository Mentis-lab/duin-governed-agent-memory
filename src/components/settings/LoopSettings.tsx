import { t } from '@/lib/i18n'
import { useState, useEffect } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { Toggle } from '@/components/ui/Toggle'

// Loop Phase gap-closure — the Settings UI for autonomous loops. Previously the
// loop keys were settings.json-only. These values are read fresh by the loop
// controller + IPC (loop-config.ts) on every tick / create, so no IPC patch is
// needed beyond settings:set. Loops are a deliberate extension past the Opus
// 4.5 era-lock and ship OFF by default.

const DEFAULTS = {
  loopMaxIterations: 25,
  loopMaxWallclockMin: 30, // 1_800_000 ms
  loopTokenBudget: 500000,
  loopMaxConcurrent: 1,
  loopMinIntervalSeconds: 30
}

interface NumberRowProps {
  id: string
  label: string
  hint: string
  value: number
  onCommit: (n: number) => void
  defaultValue: number
  min: number
  unit: string
}

function NumberRow({ id, label, hint, value, onCommit, defaultValue, min, unit }: NumberRowProps) {
  const [draft, setDraft] = useState<string>(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = (): void => {
    const raw = Number(draft)
    if (!Number.isFinite(raw)) {
      setDraft(String(value))
      return
    }
    if (raw === 0 && min > 0 && unit.includes('0 =')) {
      onCommit(0)
      return
    }
    const clamped = Math.max(min, Math.round(raw))
    setDraft(String(clamped))
    onCommit(clamped)
  }

  return (
    <label
      htmlFor={id}
      className="flex flex-col gap-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3 text-[12px] text-[var(--text-secondary)]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-[var(--text-primary)]">{label}</span>
        <button
          type="button"
          onClick={() => {
            setDraft(String(defaultValue))
            onCommit(defaultValue)
          }}
          className="font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)] underline-offset-2 hover:underline"
        >
          reset · {defaultValue}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          className="w-28 rounded border border-[var(--border)] bg-[var(--bg-secondary)] px-2 py-1 font-mono text-[12px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none"
        />
        <span className="font-mono text-[11px] text-[var(--text-muted)]">{unit}</span>
      </div>
      <span className="mt-1 block text-[12px] leading-relaxed text-[var(--text-muted)]">{hint}</span>
    </label>
  )
}

/** One switch arms FOUR things: the automations runner, the loop runner, the goal-automation
 *  bridge, and the RSI self-improve loop that rewrites DUIN's own retrieval config. Only the first
 *  three were legible from the toggle's label, and the fourth is the one an operator would most
 *  want to be asked about — its first write lands ~60 seconds after boot, not on some distant
 *  schedule. Naming the consequence is the point; a toggle that silently starts a program editing
 *  its own configuration is not informed consent.
 *
 *  Exported (with the predicate below) so it is unit-testable — this repo's vitest env is node-only
 *  with no jsdom, so pane behaviour lives in pure helpers by convention. */
export const AUTONOMY_CONFIRM_MESSAGE =
  'Turn on background autonomy?\n\n' +
  'This lets scheduled loops run unattended and execute tools that write files in your vault.\n\n' +
  "It also starts DUIN's self-improvement loop, which edits its OWN configuration files under " +
  '<vault>/.duin/ on a timer — the first write lands about a minute after the app starts. Those ' +
  'changes are limited to two bounded retrieval settings, are snapshotted before every write, and ' +
  'can be undone.\n\n' +
  'You can turn this off again at any time.'

/** Confirm on the way ON only. A kill switch you have to argue with is not a kill switch, so
 *  turning autonomy OFF must always be one click. */
export function autonomyChangeNeedsConfirm(next: boolean): boolean {
  return next === true
}

export function LoopSettings() {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const enabled = settings.loopsEnabled ?? false
  const autonomy = settings.backgroundAutonomy ?? false
  const maxIterations = settings.loopMaxIterations ?? DEFAULTS.loopMaxIterations
  const maxWallclockMin = Math.round((settings.loopMaxWallclockMs ?? 1_800_000) / 60_000)
  const tokenBudget = settings.loopTokenBudget ?? DEFAULTS.loopTokenBudget
  const maxConcurrent = settings.loopMaxConcurrent ?? DEFAULTS.loopMaxConcurrent
  const minIntervalSeconds = settings.loopMinIntervalSeconds ?? DEFAULTS.loopMinIntervalSeconds

  const confirmAutonomy = (v: boolean): void => {
    if (autonomyChangeNeedsConfirm(v) && typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(AUTONOMY_CONFIRM_MESSAGE)) return
    }
    void updateSettings({ backgroundAutonomy: v })
  }

  return (
    <div className="space-y-5">
      <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Loops')}</h3>
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        Recurring loops run a turn on a cadence — <span className="font-mono">interval</span>,{' '}
        <span className="font-mono">self-paced</span>, or autonomous{' '}
        <span className="font-mono">work-the-backlog</span> — and can keep going with the window
        closed. They are a deliberate extension past the Opus 4.5 era target and ship{' '}
        <span className="font-medium text-[var(--text-secondary)]">off by default</span>. Start one
        with <code className="rounded bg-[var(--bg-tertiary)] px-1">/loop &lt;task&gt;</code>,{' '}
        <code className="rounded bg-[var(--bg-tertiary)] px-1">/loop 5m &lt;task&gt;</code>, or{' '}
        <code className="rounded bg-[var(--bg-tertiary)] px-1">/loop --auto &lt;mission&gt;</code>;
        manage them in the right-panel Loops pill.
      </p>

      {/* Master toggle */}
      <div className="flex w-full items-center justify-between rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
        <span className="flex flex-col">
          <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Enable loops')}</span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {enabled ? 'On — loops can be created and will run.' : 'Off — /loop and loop creation are refused.'}
          </span>
        </span>
        <Toggle checked={enabled} onChange={(v) => void updateSettings({ loopsEnabled: v })} aria-label={t('Enable loops')} />
      </div>

      {/* Background autonomy — the headless agentic executor kill switch. */}
      <div className="flex w-full items-center justify-between rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
        <span className="flex flex-col">
          <span className="text-[12px] font-medium text-[var(--text-primary)]">{t('Background autonomy')}</span>
          <span className="text-[11px] text-[var(--text-muted)]">
            {autonomy
              ? 'On — scheduled loops run agentically and may WRITE files in your vault unattended (tool-scoped, vault-jailed). DUIN also tunes its own retrieval config in .duin/ on a timer; every change is snapshotted and undoable.'
              : 'Off — background runs never execute tools, and DUIN never edits its own config. Off by default.'}
          </span>
        </span>
        <Toggle checked={autonomy} onChange={confirmAutonomy} aria-label={t('Background autonomy')} />
      </div>

      <section className={`space-y-3 ${enabled ? '' : 'opacity-60'}`}>
        <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
          {t('Ceilings (applied to every new loop)')}
        </h4>
        <NumberRow
          id="loopMaxIterations"
          label={t('Max iterations')}
          hint="Hard stop: a loop ends after this many iterations regardless of backlog. The primary runaway guard."
          value={maxIterations}
          onCommit={(n) => void updateSettings({ loopMaxIterations: n })}
          defaultValue={DEFAULTS.loopMaxIterations}
          min={1}
          unit="iterations"
        />
        <NumberRow
          id="loopMaxWallclock"
          label={t('Max wall-clock')}
          hint="Hard stop: a loop ends once this much real time has elapsed since it started."
          value={maxWallclockMin}
          onCommit={(n) => void updateSettings({ loopMaxWallclockMs: Math.max(1, n) * 60_000 })}
          defaultValue={DEFAULTS.loopMaxWallclockMin}
          min={1}
          unit="minutes"
        />
        <NumberRow
          id="loopTokenBudget"
          label={t('Token budget')}
          hint="Soft guard: a loop stops once the estimated tokens spent crosses this. Estimated from the sent context + reply (iteration + wall-clock are the hard caps). 0 = iteration-bounded only."
          value={tokenBudget}
          onCommit={(n) => void updateSettings({ loopTokenBudget: n })}
          defaultValue={DEFAULTS.loopTokenBudget}
          min={0}
          unit="tokens (0 = off)"
        />
        <NumberRow
          id="loopMaxConcurrent"
          label={t('Max concurrent loops')}
          hint="How many loops may advance per scheduler tick. 1 keeps providers from being hammered by parallel loops."
          value={maxConcurrent}
          onCommit={(n) => void updateSettings({ loopMaxConcurrent: n })}
          defaultValue={DEFAULTS.loopMaxConcurrent}
          min={1}
          unit="loops"
        />
        <NumberRow
          id="loopMinInterval"
          label={t('Runaway floor')}
          hint="A loop (or the model via loop_control) cannot schedule its next iteration sooner than this. Prevents a tight self-scheduling spin."
          value={minIntervalSeconds}
          onCommit={(n) => void updateSettings({ loopMinIntervalSeconds: n })}
          defaultValue={DEFAULTS.loopMinIntervalSeconds}
          min={1}
          unit="seconds"
        />
      </section>

      <CapabilityBreaker />
      <GovernanceSection />
    </div>
  )
}

export interface BreakerCap {
  id: string
  title: string
  rung: string
  floorRung: string
  trust: number
  coldStart: boolean
  reverts: number
  willTrip: boolean
  tripsTo: string | null
  canRearm: boolean
}

function getAutonomyApi():
  | {
      state: () => Promise<{ success: boolean; data?: { capabilities: BreakerCap[] }; error?: string }>
      rearm: (id: string) => Promise<{ success: boolean; data?: { ok: boolean; reason?: string }; error?: string }>
    }
  | undefined {
  return (window as unknown as { api?: { brain?: { autonomy?: never } } }).api?.brain
    ?.autonomy as never
}

export const RUNG_LABEL: Record<string, string> = {
  reflexive: 'Runs on its own',
  stage: 'Prepares, waits for you',
  hold: 'Held — will not act'
}

/**
 * Which capabilities the operator is offered a re-arm for.
 *
 * Exported and pure because this repo's vitest env has no jsdom, so pane behaviour is tested
 * through helpers rather than by rendering (same convention as FoundationsSettings).
 *
 * The filter is `canRearm` — "sitting below its floor" — NOT "has reverts on record". A
 * capability can carry a long revert history and still be fully armed, and offering to re-arm
 * something already at its floor is the `already-armed` refusal surfaced as a button.
 */
export function trippedCapabilities(caps: BreakerCap[]): BreakerCap[] {
  return caps.filter((c) => c.canRearm)
}

/** The one-line status under a tripped capability's title. Pure, so it is testable. */
export function breakerLine(c: BreakerCap): string {
  const parts = [
    RUNG_LABEL[c.rung] ?? c.rung,
    `${c.reverts} revert${c.reverts === 1 ? '' : 's'} on record`,
    `trust ${c.coldStart ? 'not yet earned' : c.trust.toFixed(2)}`
  ]
  if (c.willTrip && c.tripsTo) parts.push(`a new miss is pending and will drop it to ${c.tripsTo}`)
  return parts.join(' · ')
}

/**
 * The capability breaker.
 *
 * The governor trips a capability the instant it takes an unhandled miss and never restores one.
 * The restore path existed but had no caller anywhere in the renderer, so a tripped capability
 * stayed tripped forever and the only way back was a hand-written POST. Fact promotion had been
 * held that way since 2026-07-29 — by a missing button, not by a decision.
 *
 * Re-arm restores the capability's floor rung in one step, because the question this answers is
 * "have you looked at it and is it fit to run", not "what grade has it earned".
 */
function CapabilityBreaker(): React.ReactElement | null {
  const [caps, setCaps] = useState<BreakerCap[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = (): void => {
    const api = getAutonomyApi()
    if (!api) return
    void api
      .state()
      .then((r) => {
        if (r.success && r.data) setCaps(r.data.capabilities)
        else setErr(r.error ?? 'Could not read autonomy state')
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }
  useEffect(load, [])

  if (!getAutonomyApi()) return null // desktop-only surface

  const rearm = (c: BreakerCap): void => {
    const api = getAutonomyApi()
    if (!api) return
    setBusy(c.id)
    setErr(null)
    void api
      .rearm(c.id)
      .then((r) => {
        if (!r.success) setErr(r.error ?? 'Re-arm failed')
        else if (r.data && !r.data.ok) setErr(`Re-arm refused: ${r.data.reason ?? 'unknown'}`)
        load()
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  const tripped = trippedCapabilities(caps ?? [])

  return (
    <section className="space-y-3">
      <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('Capability breaker')}
      </h4>
      <p className="text-[11px] text-[var(--text-muted)]">
        A capability drops a rung automatically the moment one of its actions is reverted. Nothing
        moves it back on its own — re-arming is yours, and it restores the capability fully.
      </p>

      {err && <p className="text-[11px] text-[var(--text-danger,#e5484d)]">{err}</p>}
      {caps === null && <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>}
      {caps !== null && tripped.length === 0 && (
        <p className="text-[11px] text-[var(--text-muted)]">
          {t('Nothing is tripped — every capability is at its most autonomous allowed setting.')}
        </p>
      )}

      {tripped.map((c) => (
        <div
          key={c.id}
          className="flex w-full items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3"
        >
          <span className="flex min-w-0 flex-col">
            <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">{c.title}</span>
            <span className="text-[11px] text-[var(--text-muted)]">{breakerLine(c)}</span>
          </span>
          <button
            type="button"
            disabled={busy === c.id}
            onClick={() => rearm(c)}
            className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
          >
            {busy === c.id ? 'Re-arming…' : `Re-arm to ${RUNG_LABEL[c.floorRung] ?? c.floorRung}`}
          </button>
        </div>
      ))}
    </section>
  )
}

// ── Governance — the governor's own record, read-only except for one undo ─────
//
// /state/govern-audit, /state/improvements and /state/undo all returned real
// content and had ZERO renderer callers: an agent could query the governor's
// record over HTTP, and the operator it is a record ABOUT could not see it.
// This section is that record. It is deliberately read-only apart from the undo,
// because everything else here is either already decided (audit) or a SHADOW
// proposal that must not become a one-click apply.

export interface GovernFactRow {
  id: string
  fact: string
  status: string
  govern?: { verdict: string; juryProvider: string | null; crossModel: boolean; ts: number }
  reliability?: number
}
export interface GovernActionRow {
  id: string
  ts: number
  actionKind: string
  capabilityId: string
  status: string
}
export interface ImprovementRow {
  type: string
  targetId: string
  target: string
  rationale: string
  reversible: boolean
}

interface GovernApi {
  audit: () => Promise<{
    success: boolean
    data?: { generatedAt: number; facts: GovernFactRow[]; actions: GovernActionRow[]; undoTarget: string | null }
    error?: string
  }>
  improvements: () => Promise<{
    success: boolean
    data?: { shadow: boolean; proposals: ImprovementRow[] }
    error?: string
  }>
  undo: (actionId?: string) => Promise<{ success: boolean; data?: { actionId: string }; error?: string }>
}

function getGovernApi(): GovernApi | undefined {
  return (window as unknown as { api?: { brain?: { govern?: GovernApi } } }).api?.brain?.govern
}

/** Plain-language line for one audited rule. Pure + exported: node-only vitest. */
export function governFactLine(f: GovernFactRow): string {
  const parts: string[] = []
  if (f.govern) {
    parts.push(
      f.govern.verdict === 'confirm'
        ? 'Confirmed by the jury'
        : f.govern.verdict === 'revert'
          ? 'Reverted by the jury'
          : 'Held by the jury'
    )
    // A single-model jury grading its own model's output is a weaker check, and the
    // audit is the one place that must not quietly round it up to "verified".
    parts.push(f.govern.crossModel ? 'cross-model' : 'same-model check')
    if (f.govern.juryProvider) parts.push(f.govern.juryProvider)
  } else {
    parts.push(`status ${f.status}`)
  }
  if (typeof f.reliability === 'number') parts.push(`reliability ${f.reliability.toFixed(2)}`)
  return parts.join(' · ')
}

/**
 * The confirm text for an undo.
 *
 * revertAction does TWO things: it dispatches the inverse (restoring bytes) and it
 * fires recordFeedback('revert'), which DEMOTES the capability that took the
 * action. The second is invisible from the button and is the one an operator
 * would not have predicted, so the confirm has to say it out loud — a dialog that
 * only says "are you sure?" is a speed bump, not consent.
 */
export function undoConfirmMessage(a: GovernActionRow | undefined): string {
  const what = a ? `${a.actionKind} (${a.capabilityId})` : 'the most recent reversible action'
  return (
    `Undo ${what}?\n\n` +
    'This restores what that action changed, and it also DEMOTES the capability that ' +
    'performed it — that capability will act less autonomously until you re-arm it above.\n\n' +
    'This is recorded in the governor audit.'
  )
}

/** Which actions are worth offering an undo for: only ones still applied. */
export function undoableActions(actions: GovernActionRow[]): GovernActionRow[] {
  return actions.filter((a) => a.status === 'applied')
}

function GovernanceSection(): React.ReactElement | null {
  const [facts, setFacts] = useState<GovernFactRow[] | null>(null)
  const [actions, setActions] = useState<GovernActionRow[]>([])
  const [undoTarget, setUndoTarget] = useState<string | null>(null)
  const [proposals, setProposals] = useState<ImprovementRow[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = (): void => {
    const api = getGovernApi()
    if (!api) return
    void api
      .audit()
      .then((r) => {
        if (r.success && r.data) {
          setFacts(r.data.facts)
          setActions(r.data.actions ?? [])
          setUndoTarget(r.data.undoTarget)
        } else setErr(r.error ?? 'Could not read the govern audit')
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
    void api
      .improvements()
      .then((r) => {
        if (r.success && r.data) setProposals(r.data.proposals)
      })
      .catch(() => {}) // shadow proposals are the least important of the three
  }
  useEffect(load, [])

  if (!getGovernApi()) return null // desktop-only surface

  const undo = (a: GovernActionRow | undefined): void => {
    const api = getGovernApi()
    if (!api) return
    // The demote is the part the button does not show, so it is confirmed for.
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (!window.confirm(undoConfirmMessage(a))) return
    }
    setBusy(true)
    setErr(null)
    void api
      .undo(a?.id)
      .then((r) => {
        if (!r.success) setErr(r.error ?? 'Undo failed')
        load()
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const undoable = undoableActions(actions)

  return (
    <section className="space-y-3">
      <h4 className="font-mono text-[12px] uppercase tracking-wider text-[var(--text-muted)]">
        {t('Governance')}
      </h4>
      <p className="text-[11px] text-[var(--text-muted)]">
        What the governor has actually done: which learned rules its jury confirmed or reverted,
        which of its own writes are still reversible, and what it would like to change about itself.
        Read-only apart from the undo.
      </p>

      {err && <p className="text-[11px] text-[var(--text-danger,#e5484d)]">{err}</p>}

      {/* 1 — the audit */}
      <div className="space-y-1.5">
        <div className="font-mono text-[11px] text-[var(--text-secondary)]">{t('Adjudicated rules')}</div>
        {facts === null && <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>}
        {facts !== null && facts.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {t('The jury has not ruled on any rule yet.')}
          </p>
        )}
        {(facts ?? []).slice(0, 20).map((f) => (
          <div key={f.id} className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2">
            <div className="text-[12px] text-[var(--text-primary)]">{f.fact}</div>
            <div className="text-[11px] text-[var(--text-muted)]">{governFactLine(f)}</div>
          </div>
        ))}
      </div>

      {/* 2 — the reversible actions, and the one write on this surface */}
      <div className="space-y-1.5">
        <div className="font-mono text-[11px] text-[var(--text-secondary)]">{t('Reversible actions')}</div>
        {undoable.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {t('Nothing is currently undoable — the brain has made no reversible write since the last undo.')}
          </p>
        )}
        {undoable.map((a) => (
          <div
            key={a.id}
            className="flex w-full items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12px] text-[var(--text-primary)]">
                {a.actionKind}
                {a.id === undoTarget && (
                  <span className="ml-1.5 font-mono text-[10px] text-[var(--text-muted)]">
                    (most recent)
                  </span>
                )}
              </span>
              <span className="text-[11px] text-[var(--text-muted)]">
                {a.capabilityId} · {new Date(a.ts).toLocaleString()}
              </span>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => undo(a)}
              className="shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              {busy ? 'Undoing…' : 'Undo'}
            </button>
          </div>
        ))}
      </div>

      {/* 3 — the shadow proposals */}
      <div className="space-y-1.5">
        <div className="font-mono text-[11px] text-[var(--text-secondary)]">
          Proposed improvements{' '}
          <span className="text-[var(--text-muted)]">— shadow only, nothing here is applied</span>
        </div>
        {proposals !== null && proposals.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {t('The self-improvement pass has nothing to propose.')}
          </p>
        )}
        {(proposals ?? []).map((p) => (
          <div
            key={`${p.type}:${p.targetId}`}
            className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-2"
          >
            <div className="text-[12px] text-[var(--text-primary)]">
              <span className="font-mono text-[11px] text-[var(--text-muted)]">{p.type}</span>{' '}
              {p.target}
            </div>
            <div className="text-[11px] text-[var(--text-muted)]">{p.rationale}</div>
          </div>
        ))}
      </div>
    </section>
  )
}
