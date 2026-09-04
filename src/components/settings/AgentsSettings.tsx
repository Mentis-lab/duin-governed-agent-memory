import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useId, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { invoke, query } from '@/lib/ipc-client'
import { panelError, panelLoading, panelReady, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'

// Agents — the operator's side of the Brain API: which OTHER tools may connect to DUIN.
//
// THREE THINGS THIS SURFACE DECIDES, and the copy has to keep them apart:
//   1. ADMISSION — approve or deny a pairing request, trimming the planes it asked for.
//      Trim-only: you can hand back less than was requested, never more, because widening
//      would grant authority the agent never asked for and you never reviewed side by side.
//   2. STANDING — pause, revoke, or reissue a credential that already exists. Revocation is
//      permanent by policy: the old token is still sitting in the agent's config, so
//      "un-revoking" would resurrect a credential you already declared dead.
//   3. BOUNDS — the read scope, write scope and hourly quota a grant carries. Enforced on
//      every call from the day they shipped; this is their only editor.
//
// Revoked principals stay listed: the preload exposes no remove/forget call for a principal
// (executive.principals has list / create / setStatus / reissue / updateGrant only), so a
// "Forget" button would have nothing to call. Recorded as a cross-lane request.

export type ExecutivePlane = string

export interface PairingRequestView {
  pairingId: string
  name: string
  kind: string
  requestedPlanes: ExecutivePlane[]
  observedExe: string | null
  createdAt: string
  expiresAt: string
}

export interface PrincipalView {
  id: string
  name: string
  kind: string
  planes: ExecutivePlane[]
  tokenId: string
  status: 'active' | 'paused' | 'revoked'
  lastSeenAt: string | null
  callCount: number
  scope?: string[]
  writeScope?: string
  quota?: { callsPerHour: number; charsPerHour: number }
  usage?: { windowStartedAt: string; calls: number; chars: number }
}

interface Envelope<T> {
  success: boolean
  data?: T
  error?: string
}

type GrantPatch = {
  scope?: string[] | null
  writeScope?: string | null
  quota?: { callsPerHour: number; charsPerHour: number } | null
}

interface ExecutiveApi {
  pairings: {
    list: () => Promise<Envelope<{ pairings: PairingRequestView[] }>>
    approve: (pairingId: string, grantPlanes?: string[]) => Promise<Envelope<unknown>>
    deny: (pairingId: string) => Promise<Envelope<unknown>>
  }
  principals: {
    list: () => Promise<Envelope<{ principals: PrincipalView[] }>>
    create: (input: { name: string; kind?: string; planes?: string[] }) => Promise<
      Envelope<{ principal: PrincipalView; token: string }>
    >
    setStatus: (id: string, status: 'active' | 'paused' | 'revoked') => Promise<Envelope<unknown>>
    reissue: (id: string) => Promise<Envelope<{ token: string }>>
    updateGrant: (id: string, patch: GrantPatch) => Promise<Envelope<unknown>>
  }
}

function execApi(): ExecutiveApi | null {
  return (window as unknown as { api?: { executive?: ExecutiveApi } }).api?.executive ?? null
}

/** Bind an optional preload method for query()/invoke(); `undefined` makes them report the missing handler. */
function bound<A extends unknown[], R>(
  fn: ((...args: A) => Promise<R>) | undefined,
  ...args: A
): (() => Promise<R>) | undefined {
  return fn ? () => fn(...args) : undefined
}

/** The exec MCP mount of the in-process brain, quoted in the token box. The port follows
 *  DUIN_BRAIN_PORT in main, but the preload exposes neither the port nor the URL to the
 *  renderer, so this literal is the default port until it does. */
const EXEC_MCP_URL = 'http://127.0.0.1:8799/exec/mcp'

/** The env var the plugin's .mcp.json reads. Kept next to the snippet that quotes it so the
 *  two cannot drift into naming different variables. */
const TOKEN_ENV = 'DUIN_BRAIN_TOKEN'

export type PlaneCopy = { label: string; detail: string; write?: boolean }

/** What each plane actually buys, in the operator's words rather than the vocabulary's. An
 *  approval card that lists `beliefs.read` without saying what it hands over is asking for
 *  consent to a string. t() runs at CALL time (planeCopy) so a language switch re-renders the
 *  labels; the keys stay literal for the coverage scan. */
const PLANE_COPY: Record<string, { label: () => string; detail: () => string; write?: boolean }> = {
  'context.read': {
    label: () => t('Read context'),
    detail: () => t('Salience brief and grounded search across your vault.')
  },
  'beliefs.read': {
    label: () => t('Read beliefs'),
    detail: () => t('Your promoted operator model — what DUIN has learned about how you decide.')
  },
  'goals.read': { label: () => t('Read goals'), detail: () => t('Shared fleet goal state.') },
  'goals.write': {
    label: () => t('Write goals'),
    detail: () => t('Register and update goals. Completing one still needs you.'),
    write: true
  },
  'judgment.precheck': { label: () => t('Precheck judgment'), detail: () => t('Advisory forecasts. Reads only.') },
  'learning.submit': {
    label: () => t('Teach'),
    detail: () => t('Offer beliefs about you. They stay quarantined until you promote them.'),
    write: true
  },
  'memory.write': {
    label: () => t('Write notes'),
    detail: () => t('Leave notes in a bounded folder. Kept out of retrieval.'),
    write: true
  }
}

export function planeCopy(p: string): PlaneCopy {
  // An unknown plane still renders as itself rather than vanishing: a grant the UI cannot
  // describe must still be visible, because the alternative is an agent holding authority
  // that no screen shows.
  const entry = PLANE_COPY[p]
  if (!entry) return { label: p, detail: '' }
  return { label: entry.label(), detail: entry.detail(), ...(entry.write ? { write: true } : {}) }
}

/** Everything an operator can grant here, and what a fresh form ticks.
 *
 *  Both DERIVED from PLANE_COPY rather than re-typed. The default is "the planes that are not
 *  writes", which is the same rule the store's DEFAULT_PLANES encodes — so a new plane added
 *  above joins the form automatically, and joins it unticked if it writes. */
export const GRANTABLE: string[] = Object.keys(PLANE_COPY)
export const DEFAULT_GRANT: string[] = GRANTABLE.filter((p) => !PLANE_COPY[p].write)

/** Sort order for the roster: usable agents first, then paused, then the permanent dead. */
export function byLiveliness(
  a: Pick<PrincipalView, 'status'>,
  b: Pick<PrincipalView, 'status'>
): number {
  const rank = (s: PrincipalView['status']): number => (s === 'active' ? 0 : s === 'paused' ? 1 : 2)
  return rank(a.status) - rank(b.status)
}

/** The stored status as a word — the raw enum never reaches the row. */
export function principalStatusLabel(status: PrincipalView['status']): string {
  switch (status) {
    case 'active':
      return t('Active')
    case 'paused':
      return t('Paused')
    case 'revoked':
      return t('Revoked')
    default: {
      const unhandled: never = status
      return String(unhandled)
    }
  }
}

export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return t('never')
  const parsed = Date.parse(iso)
  if (Number.isNaN(parsed)) return t('unknown')
  const mins = Math.floor((now - parsed) / 60000)
  if (mins < 1) return t('just now')
  if (mins < 60) return tf('{n}m ago', { n: mins })
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return tf('{n}h ago', { n: hrs })
  return tf('{n}d ago', { n: Math.floor(hrs / 24) })
}

export type QuotaFormResult =
  | { ok: true; quota: { callsPerHour: number; charsPerHour: number } | null }
  | { ok: false; reason: string }

/**
 * Map the two budget fields to a quota patch. THE decision in this pane.
 *
 * Blank means "use the default", and 0 means "let it make no calls at all". Those are
 * opposite intentions, and a form that collapsed them — the natural `Number('') === 0` —
 * would silently ban an agent the moment someone cleared a field to undo an experiment.
 * `null` is the reset signal the store understands; a zero is passed through as a real zero.
 *
 * Non-numeric input is rejected HERE rather than at the store. `inputMode="numeric"` is a
 * keyboard hint, not a constraint, so "abc" is typeable on a desktop; `Number('abc')` is NaN,
 * and NaN survives the IPC layer's `typeof === 'number'` check to be refused deep in
 * updatePrincipalGrant as "out of range" — a confusing error for a typo.
 */
export function quotaPatchFromForm(calls: string, chars: string): QuotaFormResult {
  const c = calls.trim()
  const ch = chars.trim()
  if (c === '' && ch === '') return { ok: true, quota: null }
  for (const [field, raw] of [
    [t('Calls / hour'), c],
    [t('Characters / hour'), ch]
  ] as const) {
    if (raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) return { ok: false, reason: tf('{field} must be a number.', { field }) }
    if (n < 0) return { ok: false, reason: tf('{field} cannot be negative.', { field }) }
  }
  // One field filled and one blank still means "I am setting a budget"; the blank half falls
  // back to 0 rather than to the default, because a half-set budget with an unbounded half is
  // not a budget. The copy above the fields says so.
  return { ok: true, quota: { callsPerHour: Number(c || 0), charsPerHour: Number(ch || 0) } }
}

/**
 * What this agent has spent in the CURRENT window, or '' when it has spent nothing yet.
 *
 * Returns empty rather than "0 calls" for a principal with no usage row: a fresh grant has
 * not been used, and printing a zero implies a measurement was taken when none was. The
 * window is rolling and server-side, so this is the last read, not a live meter.
 */
export function usageLine(p: Pick<PrincipalView, 'usage' | 'quota'>): string {
  if (!p.usage || (p.usage.calls === 0 && p.usage.chars === 0)) return ''
  const ceiling = p.quota ? `/${p.quota.callsPerHour}` : ''
  return tf('{used} calls used this hour', { used: `${p.usage.calls}${ceiling}` })
}

/** The one-line "what can this agent actually do" summary. Absent scope/quota are DEFAULTS,
 *  never absences — rendering a blank would tell the operator an agent is unbounded when the
 *  server is in fact bounding it. */
export function grantSummary(p: Pick<PrincipalView, 'scope' | 'quota'>): {
  reads: string
  budget: string
} {
  return {
    reads: p.scope?.length ? p.scope.join(', ') : t('your whole vault'),
    budget: p.quota
      ? tf('{calls} calls / {chars} chars per hour', {
          calls: p.quota.callsPerHour,
          chars: p.quota.charsPerHour.toLocaleString()
        })
      : t('the default hourly budget')
  }
}

export function AgentsSettings(): React.ReactElement | null {
  // TWO reads, TWO states. They used to share one error slot, so a persistent
  // principals.list failure was wiped by every successful pairings.list poll and the
  // Connected list sat empty with the error flickering in and out.
  const [pairings, setPairings] = useState<PanelStatus<PairingRequestView[]>>(panelLoading())
  const [principals, setPrincipals] = useState<PanelStatus<PrincipalView[]>>(panelLoading())
  const [busy, setBusy] = useState<string | null>(null)
  const [trim, setTrim] = useState<Record<string, string[]>>({})
  const [freshToken, setFreshToken] = useState<{ id: string; token: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const loadPairings = useCallback(async (): Promise<void> => {
    const r = await query('pairing requests', bound(execApi()?.pairings.list))
    setPairings(r.ok ? panelReady(r.data.pairings) : panelError(r.error, r.cause))
  }, [])
  const loadPrincipals = useCallback(async (): Promise<void> => {
    const r = await query('connected agents', bound(execApi()?.principals.list))
    setPrincipals(r.ok ? panelReady(r.data.principals) : panelError(r.error, r.cause))
  }, [])
  const load = useCallback((): void => {
    void loadPairings()
    void loadPrincipals()
  }, [loadPairings, loadPrincipals])

  useEffect(() => {
    load()
    // Requests arrive from an agent process, not from this window, and they expire in 15
    // minutes — so a pane that only loaded once would show a stale or empty list exactly
    // when someone is standing by waiting to be let in.
    const timer = setInterval(load, 10_000)
    return () => clearInterval(timer)
  }, [load])

  if (!execApi()) return null // desktop-only surface

  /** Returns whether the call actually landed. Callers that change the UI on completion —
   *  closing the limits editor, for one — need to distinguish "saved" from "failed", or a
   *  rejected save looks exactly like a successful one. */
  const run = async (
    key: string,
    label: string,
    call: (() => Promise<Envelope<unknown>>) | undefined,
    fallback: string
  ): Promise<boolean> => {
    setBusy(key)
    try {
      await invoke(label, call)
      return true
    } catch (e) {
      toast.error(describeError(e, fallback))
      return false
    } finally {
      setBusy(null)
      load()
    }
  }

  const pendingCount = pairings.phase === 'ready' ? pairings.data.length : 0

  return (
    <SettingsPage
      purpose={t('Other tools — Codex, a bridge, another agent — can connect to DUIN and use what it knows about you. Nobody is admitted by default: each gets its own token and only the access you grant, and everything it reads is logged and rate-limited.')}
    >
      {/* ── 0 · ADD ───────────────────────────────────────────────────── */}
      <SettingsSection label={t('Add an agent')}>
        <AddAgent
          busy={busy === '__new'}
          onCreate={async (input) => {
            setBusy('__new')
            try {
              const r = await invoke('create agent', bound(execApi()?.principals.create, input))
              return r.token
            } catch (e) {
              toast.error(describeError(e, t('Could not create the agent')))
              return null
            } finally {
              setBusy(null)
              load()
            }
          }}
        />
      </SettingsSection>

      {/* ── 1 · ADMISSION ─────────────────────────────────────────────── */}
      <SettingsSection label={pendingCount > 0 ? tf('Waiting for you ({n})', { n: pendingCount }) : t('Waiting for you')}>
        <PanelState
          state={pairings}
          loading={<SettingsLoading what={t('pairing requests')} />}
          error={(message, retry) => (
            <SettingsLoadError what={t('pairing requests')} message={message} onRetry={retry} />
          )}
          onRetry={() => void loadPairings()}
          empty={
            <p className="text-[12px] text-[var(--text-muted)]">
              {t('No agent is asking for access. Requests appear here and expire after 15 minutes — ignoring one is a safe way to decline, since asking again is cheap.')}
            </p>
          }
        >
          {(list) =>
            list.map((p) => {
              const granted = trim[p.pairingId] ?? p.requestedPlanes
              const rowBusy = busy === p.pairingId
              return (
                <SettingsRow
                  key={p.pairingId}
                  label={
                    <>
                      {p.name} <span className="font-normal text-[var(--text-muted)]">({p.kind})</span>
                    </>
                  }
                  hint={
                    <>
                      {tf('Asked {when}. It can read nothing until you approve.', { when: ago(p.createdAt) })}
                      {p.observedExe && (
                        <span className="mt-1 block break-all font-mono text-[10px]">{p.observedExe}</span>
                      )}
                    </>
                  }
                  control={
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="primary"
                        disabled={rowBusy || granted.length === 0}
                        onClick={() =>
                          void run(
                            p.pairingId,
                            'approve pairing',
                            bound(execApi()?.pairings.approve, p.pairingId, granted),
                            t('Could not approve that request')
                          )
                        }
                      >
                        {t('Approve')}
                      </Button>
                      <Button
                        size="sm"
                        disabled={rowBusy}
                        onClick={() =>
                          void run(
                            p.pairingId,
                            'deny pairing',
                            bound(execApi()?.pairings.deny, p.pairingId),
                            t('Could not deny that request')
                          )
                        }
                      >
                        {t('Deny')}
                      </Button>
                    </div>
                  }
                >
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {t('It asked for these. Untick anything you would rather not hand over — you can give less than was asked for, never more.')}
                  </p>
                  <div className="mt-1.5 space-y-1.5">
                    {p.requestedPlanes.map((plane) => (
                      <PlaneCheckbox
                        key={plane}
                        plane={plane}
                        checked={granted.includes(plane)}
                        showId
                        onToggle={() =>
                          setTrim((prev) => ({
                            ...prev,
                            [p.pairingId]: granted.includes(plane)
                              ? granted.filter((g) => g !== plane)
                              : [...granted, plane]
                          }))
                        }
                      />
                    ))}
                  </div>
                  {granted.length === 0 && (
                    <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
                      {t('Nothing ticked — that is a denial, not an approval.')}
                    </p>
                  )}
                </SettingsRow>
              )
            })
          }
        </PanelState>
      </SettingsSection>

      {/* ── 2 · STANDING + 3 · BOUNDS ─────────────────────────────────── */}
      <SettingsSection label={t('Connected')}>
        <PanelState
          state={principals}
          loading={<SettingsLoading what={t('connected agents')} />}
          error={(message, retry) => (
            <SettingsLoadError what={t('connected agents')} message={message} onRetry={retry} />
          )}
          onRetry={() => void loadPrincipals()}
          empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No agent has been admitted yet.')}</p>}
        >
          {(list) =>
            // Revocation is permanent by policy, so revoked rows accumulate forever and can
            // only ever outnumber the live ones. Sink them to the bottom rather than letting
            // the list decay into mostly-dead entries the operator has to read past.
            list
              .slice()
              .sort(byLiveliness)
              .map((pr) => (
                <PrincipalRow
                  key={pr.id}
                  principal={pr}
                  busy={busy === pr.id}
                  editing={editing === pr.id}
                  onToggleEdit={() => setEditing(editing === pr.id ? null : pr.id)}
                  freshToken={freshToken?.id === pr.id ? freshToken.token : null}
                  onDismissToken={() => setFreshToken(null)}
                  onSetStatus={(s) =>
                    void run(
                      pr.id,
                      'change agent status',
                      bound(execApi()?.principals.setStatus, pr.id, s),
                      t('Could not change that agent')
                    )
                  }
                  onReissue={async () => {
                    setBusy(pr.id)
                    try {
                      const r = await invoke('reissue token', bound(execApi()?.principals.reissue, pr.id))
                      setFreshToken({ id: pr.id, token: r.token })
                    } catch (e) {
                      toast.error(describeError(e, t('Could not reissue the token')))
                    } finally {
                      setBusy(null)
                      load()
                    }
                  }}
                  onSaveGrant={(patch) => {
                    void run(
                      pr.id,
                      'update agent limits',
                      bound(execApi()?.principals.updateGrant, pr.id, patch),
                      t('Could not save those limits')
                    ).then((ok) => {
                      // Only on success. Closing regardless would hide the failure behind a
                      // collapsed editor and lose what the operator typed.
                      if (ok) setEditing(null)
                    })
                  }}
                />
              ))
          }
        </PanelState>
      </SettingsSection>
    </SettingsPage>
  )
}

/** One grantable plane as a labelled checkbox: the label, a "writes" mark, the plane id. */
function PlaneCheckbox({
  plane,
  checked,
  onToggle,
  showId = false
}: {
  plane: string
  checked: boolean
  onToggle: () => void
  showId?: boolean
}): React.ReactElement {
  const copy = planeCopy(plane)
  const id = useId()
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <input id={id} type="checkbox" checked={checked} onChange={onToggle} className="mt-0.5" />
      <label htmlFor={id}>
        <span className="text-[var(--text-primary)]">{copy.label}</span>
        {copy.write && (
          <span className="ml-1.5 rounded bg-[var(--warning)]/20 px-1 py-px text-[10px] text-[var(--text-primary)]">
            {t('writes')}
          </span>
        )}
        {showId && <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">{plane}</span>}
        {copy.detail && <span className="block text-[11px] text-[var(--text-muted)]">{copy.detail}</span>}
      </label>
    </div>
  )
}

function PrincipalRow({
  principal,
  busy,
  editing,
  onToggleEdit,
  freshToken,
  onDismissToken,
  onSetStatus,
  onReissue,
  onSaveGrant
}: {
  principal: PrincipalView
  busy: boolean
  editing: boolean
  onToggleEdit: () => void
  freshToken: string | null
  onDismissToken: () => void
  onSetStatus: (s: 'active' | 'paused' | 'revoked') => void
  onReissue: () => void
  onSaveGrant: (patch: GrantPatch) => void
}): React.ReactElement {
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const revoked = principal.status === 'revoked'

  // Disarm the revoke confirmation whenever anything else about this row changes — opening
  // the limits editor, a status flip, a background refresh. A destructive button that stays
  // armed indefinitely after the operator has moved on is one stray click from permanent.
  useEffect(() => {
    setConfirmRevoke(false)
  }, [editing, principal.status, principal.id])

  const summary = grantSummary(principal)
  const usage = usageLine(principal)
  const body = (confirmRevoke && !revoked) || freshToken !== null || (editing && !revoked)

  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>{principal.name}</span>
          <span className="text-[11px] font-normal text-[var(--text-muted)]">({principal.kind})</span>
          <span
            className={
              principal.status === 'active'
                ? 'text-[11px] font-normal text-[var(--success)]'
                : 'text-[11px] font-normal text-[var(--text-muted)]'
            }
          >
            {principalStatusLabel(principal.status)}
          </span>
          <span className="font-mono text-[10px] font-normal text-[var(--text-muted)]">{principal.tokenId}</span>
        </span>
      }
      hint={
        <>
          <span className="block">
            {tf('Last seen {when} · {calls} calls · {planes}', {
              when: ago(principal.lastSeenAt),
              calls: principal.callCount,
              planes: principal.planes.map((p) => planeCopy(p).label).join(', ') || t('nothing granted')
            })}
          </span>
          {/* Spend against the ceiling, not just the ceiling. A limit you cannot watch being
              approached is a setting; a limit you can is a control — and "has this agent been
              hammering the vault?" is the question this pane exists to answer. */}
          <span className="block">
            {tf('Reads {reads} · {budget}', { reads: summary.reads, budget: summary.budget })}
            {usage && ` · ${usage}`}
          </span>
        </>
      }
      control={
        !revoked ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onSetStatus(principal.status === 'paused' ? 'active' : 'paused')}
            >
              {principal.status === 'paused' ? t('Resume') : t('Pause')}
            </Button>
            <Button size="sm" disabled={busy} onClick={onToggleEdit}>
              {editing ? t('Close') : t('Limits')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={onReissue}>
              {t('Reissue token')}
            </Button>
            {confirmRevoke ? (
              <Button size="sm" variant="danger" disabled={busy} onClick={() => onSetStatus('revoked')}>
                {t('Revoke for good')}
              </Button>
            ) : (
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRevoke(true)}>
                {t('Revoke')}
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {body ? (
        <div className="space-y-2">
          {confirmRevoke && !revoked && (
            <p className="text-[11px] text-[var(--text-muted)]">
              {t('Permanent — its token is still in the agent\'s config, so this cannot be undone. Pair again to re-admit it.')}
            </p>
          )}
          {freshToken && (
            <div className="space-y-1 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2">
              <p className="text-[11px] text-[var(--text-primary)]">
                {t('New token — shown once. The previous one stopped working immediately.')}
              </p>
              <code className="block break-all font-mono text-[11px] text-[var(--text-secondary)]">{freshToken}</code>
              <Button size="sm" variant="ghost" onClick={onDismissToken}>
                {t('Done')}
              </Button>
            </div>
          )}
          {editing && !revoked && <GrantEditor principal={principal} busy={busy} onSave={onSaveGrant} />}
        </div>
      ) : null}
    </SettingsRow>
  )
}

/**
 * The limits editor, deliberately its OWN component mounted only while open.
 *
 * It used to be an inline block inside PrincipalRow, whose useState initialisers ran once at
 * first mount and never re-synced — and the row stays mounted for the life of the pane. So the
 * fields froze at whatever the grant was when the list first rendered, while the summary line
 * above them tracked the server. Mounting on open makes "the form shows what the server
 * currently holds" true by construction rather than by remembering to sync.
 */
function GrantEditor({
  principal,
  busy,
  onSave
}: {
  principal: PrincipalView
  busy: boolean
  onSave: (patch: GrantPatch) => void
}): React.ReactElement {
  const initial = {
    scope: (principal.scope ?? []).join('\n'),
    writeScope: principal.writeScope ?? '',
    calls: principal.quota ? String(principal.quota.callsPerHour) : '',
    chars: principal.quota ? String(principal.quota.charsPerHour) : ''
  }
  const [scopeText, setScopeText] = useState(initial.scope)
  const [writeScope, setWriteScope] = useState(initial.writeScope)
  const [calls, setCalls] = useState(initial.calls)
  const [chars, setChars] = useState(initial.chars)
  const ids = useId()

  const quota = quotaPatchFromForm(calls, chars)
  const dirty =
    scopeText !== initial.scope ||
    writeScope !== initial.writeScope ||
    calls !== initial.calls ||
    chars !== initial.chars
  useDirtyGuard(`settings:agents:limits:${principal.id}`, t('the agent limits editor'), dirty)

  const fieldLabel = 'block text-[11px] text-[var(--text-muted)]'

  return (
    <div className="space-y-2 border-t border-[var(--panel-border)] pt-2">
      <div>
        <label htmlFor={`${ids}-scope`} className={fieldLabel}>
          {t('Readable folders — one per line. Leave empty for the whole vault.')}
        </label>
        <textarea
          id={`${ids}-scope`}
          value={scopeText}
          onChange={(e) => setScopeText(e.target.value)}
          rows={3}
          placeholder={t('03 Projects/DUIN')}
          className="mt-1 w-full resize-y rounded-md border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </div>
      <div>
        <label htmlFor={`${ids}-write`} className={fieldLabel}>
          {t('Folder it may write notes into — empty for the default agent inbox.')}
        </label>
        <Input
          id={`${ids}-write`}
          value={writeScope}
          onChange={(e) => setWriteScope(e.target.value)}
          placeholder={t('.brain/agent-inbox')}
          className="mt-1 font-mono"
        />
      </div>
      <div className="flex gap-2">
        <div className="flex-1">
          <label htmlFor={`${ids}-calls`} className={fieldLabel}>
            {t('Calls / hour')}
          </label>
          <Input
            id={`${ids}-calls`}
            value={calls}
            inputMode="numeric"
            onChange={(e) => setCalls(e.target.value)}
            placeholder={t('default')}
            className="mt-1 font-mono"
          />
        </div>
        <div className="flex-1">
          <label htmlFor={`${ids}-chars`} className={fieldLabel}>
            {t('Characters / hour')}
          </label>
          <Input
            id={`${ids}-chars`}
            value={chars}
            inputMode="numeric"
            onChange={(e) => setChars(e.target.value)}
            placeholder={t('default')}
            className="mt-1 font-mono"
          />
        </div>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        {t('Leaving a budget blank restores the default — it does not mean zero. Set it to 0 to stop the agent making any call at all.')}
      </p>
      {!quota.ok && (
        <p role="alert" className="text-[11px] text-[var(--error)]">
          {quota.reason}
        </p>
      )}
      <Button
        size="sm"
        variant="primary"
        disabled={busy || !quota.ok}
        onClick={() => {
          if (!quota.ok) return
          const scope = scopeText
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
          onSave({
            scope: scope.length ? scope : null,
            writeScope: writeScope.trim() ? writeScope.trim() : null,
            quota: quota.quota
          })
        }}
      >
        {t('Save limits')}
      </Button>
    </div>
  )
}

/**
 * Operator-initiated admission: name an agent, pick what it may do, get a token.
 *
 * The pairing flow below this waits for an agent to ASK, which is right for something showing
 * up uninvited and backwards when you already know what you want to connect. Minting here
 * grants nothing extra: the planes are chosen deliberately rather than trimmed from a request,
 * and the plaintext token still exists exactly once, in the response that fills this box.
 */
function AddAgent({
  busy,
  onCreate
}: {
  busy: boolean
  onCreate: (input: { name: string; kind: string; planes: string[] }) => Promise<string | null>
}): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState('cli-agent')
  const [planes, setPlanes] = useState<string[]>([...DEFAULT_GRANT])
  const [token, setToken] = useState<string | null>(null)
  const ids = useId()
  useDirtyGuard('settings:agents:new', t('the new agent form'), open && token === null && name.trim() !== '')

  const reset = (): void => {
    setToken(null)
    setName('')
    setPlanes([...DEFAULT_GRANT])
    setOpen(false)
  }

  if (token) {
    return (
      <SettingsRow
        label={tf('Token for "{name}" — shown once', { name })}
        hint={t('Nothing stores this in readable form, so if you lose it you reissue rather than look it up. Set it where the agent will run, then start the agent:')}
        control={
          <Button size="sm" onClick={reset}>
            {t('Done')}
          </Button>
        }
      >
        <code className="block break-all rounded-md bg-[var(--bg-secondary)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
          {TOKEN_ENV}={token}
        </code>
        <p className="mt-2 text-[12px] text-[var(--text-muted)]">
          {tf('The agent connects to {url}. DUIN must be running for the connection to work.', { url: EXEC_MCP_URL })}
        </p>
      </SettingsRow>
    )
  }

  if (!open) {
    // The binding is absent on any build whose preload predates it. Say so instead of
    // rendering a button that throws a raw TypeError on click — the pairing flow below still
    // works, so the pane is degraded, not broken.
    if (typeof execApi()?.principals?.create !== 'function') {
      return (
        <p className="text-[12px] text-[var(--text-muted)]">
          {t('Minting tokens needs a newer DUIN build. An agent can still connect by asking — see below.')}
        </p>
      )
    }
    return <Button onClick={() => setOpen(true)}>{t('Add an agent')}</Button>
  }

  return (
    <SettingsRow label={t('New agent')} hint={t('Name it, pick what it may do, and get a token to paste where it runs.')}>
      <div className="space-y-3">
        <div>
          <label htmlFor={`${ids}-name`} className="block text-[11px] text-[var(--text-muted)]">
            {t('Name — how it appears here and in the audit log.')}
          </label>
          <Input
            id={`${ids}-name`}
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            placeholder={t('codex')}
            className="mt-1"
          />
        </div>
        <div>
          <label htmlFor={`${ids}-kind`} className="block text-[11px] text-[var(--text-muted)]">
            {t('Kind')}
          </label>
          <Select id={`${ids}-kind`} value={kind} onChange={(e) => setKind(e.target.value)} className="mt-1 w-full">
            <option value="cli-agent">{t('CLI agent')}</option>
            <option value="bridge">{t('Bridge')}</option>
            <option value="team-agent">{t('Team agent')}</option>
            <option value="device">{t('Device')}</option>
          </Select>
        </div>
        <div className="space-y-1.5">
          <p className="text-[11px] text-[var(--text-muted)]">{t('What it may do. Grant the least that works.')}</p>
          {GRANTABLE.map((plane) => (
            <PlaneCheckbox
              key={plane}
              plane={plane}
              checked={planes.includes(plane)}
              onToggle={() =>
                setPlanes((ps) => (ps.includes(plane) ? ps.filter((p) => p !== plane) : [...ps, plane]))
              }
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="primary"
            disabled={busy || !name.trim() || planes.length === 0}
            onClick={() => {
              void onCreate({ name: name.trim(), kind, planes }).then((minted) => {
                // Only show the box on success. Clearing the form on a failure would throw
                // away what was typed and leave the error with nothing to correct.
                if (minted) setToken(minted)
              })
            }}
          >
            {t('Create token')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
            {t('Cancel')}
          </Button>
          {planes.length === 0 && (
            <span className="text-[11px] text-[var(--text-muted)]">
              {t('Nothing ticked — the agent could authenticate and do nothing.')}
            </span>
          )}
        </div>
      </div>
    </SettingsRow>
  )
}
