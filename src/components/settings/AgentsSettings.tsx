import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'

// Agents — the OPERATOR's side of the Brain API membrane.
//
// Why this pane exists, in the same shape as ChannelsSettings next door: the main-process IPC
// (executive:pairings:approve and five siblings) and its preload bindings were both fully
// written and had ZERO renderer callers. The pairing notice told the operator to "approve in
// Connected Agents" — a screen that had never been built — so the only way to admit an agent
// was to call approvePairing() against the store by hand. The approval path was not obscure,
// it was unreachable.
//
// THREE THINGS THIS SURFACE DECIDES, and the copy has to keep them apart:
//   1. ADMISSION — approve or deny a pairing request, trimming the planes it asked for.
//      Trim-only: you can hand back less than was requested, never more, because widening
//      would grant authority the agent never asked for and you never reviewed side by side.
//   2. STANDING — pause, revoke, or reissue a credential that already exists. Revocation is
//      permanent by policy: the old token is still sitting in the agent's config, so
//      "un-revoking" would resurrect a credential you already declared dead.
//   3. BOUNDS — the read scope, write scope and hourly quota a grant carries. These were
//      enforced on every call from the day they shipped, but had no editor at all, so the
//      only way to scope an agent was to hand-edit executive-principals.json.

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
    updateGrant: (
      id: string,
      patch: {
        scope?: string[] | null
        writeScope?: string | null
        quota?: { callsPerHour: number; charsPerHour: number } | null
      }
    ) => Promise<Envelope<unknown>>
  }
}

function execApi(): ExecutiveApi | null {
  return (window as unknown as { api?: { executive?: ExecutiveApi } }).api?.executive ?? null
}

/** What each plane actually buys, in the operator's words rather than the vocabulary's.
 *  An approval card that lists `beliefs.read` without saying what it hands over is asking
 *  for consent to a string. */
const PLANE_COPY: Record<string, { label: string; detail: string; write?: boolean }> = {
  'context.read': { label: 'Read context', detail: 'Salience brief and grounded search across your vault.' },
  'beliefs.read': { label: 'Read beliefs', detail: 'Your promoted operator model — what DUIN has learned about how you decide.' },
  'goals.read': { label: 'Read goals', detail: 'Shared fleet goal state.' },
  'goals.write': { label: 'Write goals', detail: 'Register and update goals. Completing one still needs you.', write: true },
  'judgment.precheck': { label: 'Precheck judgment', detail: 'Advisory forecasts. Reads only.' },
  'learning.submit': { label: 'Teach', detail: 'Offer beliefs about you. They stay quarantined until you promote them.', write: true },
  'memory.write': { label: 'Write notes', detail: 'Leave notes in a bounded folder. Kept out of retrieval.', write: true }
}

export function planeCopy(p: string): { label: string; detail: string; write?: boolean } {
  // An unknown plane still renders as itself rather than vanishing: a grant the UI cannot
  // describe must still be visible, because the alternative is an agent holding authority
  // that no screen shows.
  return PLANE_COPY[p] ?? { label: p, detail: '' }
}

/** Everything an operator can grant here, and what a fresh form ticks.
 *
 *  Both DERIVED from PLANE_COPY rather than re-typed. The default is "the planes that are not
 *  writes", which is the same rule the store's DEFAULT_PLANES encodes — so a new plane added
 *  above joins the form automatically, and joins it unticked if it writes. A hand-kept second
 *  list here would be the third copy of the vocabulary in this codebase; the first two already
 *  drifted (a plane was grantable but not requestable for three days). */
export const GRANTABLE: string[] = Object.keys(PLANE_COPY)
export const DEFAULT_GRANT: string[] = GRANTABLE.filter((p) => !PLANE_COPY[p].write)

/** Sort order for the roster: usable agents first, then paused, then the permanent dead. */
export function byLiveliness(
  a: Pick<PrincipalView, 'status'>,
  b: Pick<PrincipalView, 'status'>
): number {
  const rank = (s: PrincipalView['status']): number =>
    s === 'active' ? 0 : s === 'paused' ? 1 : 2
  return rank(a.status) - rank(b.status)
}

export function ago(iso: string | null, now: number = Date.now()): string {
  if (!iso) return 'never'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 'unknown'
  const mins = Math.floor((now - t) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

export type QuotaFormResult =
  | { ok: true; quota: { callsPerHour: number; charsPerHour: number } | null }
  | { ok: false; reason: string }

/**
 * Map the two budget fields to a quota patch. THE load-bearing decision in this pane.
 *
 * Blank means "use the default", and 0 means "let it make no calls at all". Those are
 * opposite intentions, and a form that collapsed them — the natural `Number('') === 0` —
 * would silently ban an agent the moment someone cleared a field to undo an experiment.
 * `null` is the reset signal the store understands; a zero is passed through as a real zero.
 *
 * Non-numeric input is rejected HERE rather than at the store. `inputMode="numeric"` is a
 * keyboard hint, not a constraint, so "abc" is typeable on a desktop; `Number('abc')` is NaN,
 * and NaN survives the IPC layer's `typeof === 'number'` check to be refused deep in
 * updatePrincipalGrant as "out of range" — a confusing error for a typo. Catch it at the form,
 * where the field that caused it is visible.
 */
export function quotaPatchFromForm(calls: string, chars: string): QuotaFormResult {
  const c = calls.trim()
  const ch = chars.trim()
  if (c === '' && ch === '') return { ok: true, quota: null }
  for (const [label, raw] of [
    ['Calls / hour', c],
    ['Characters / hour', ch]
  ] as const) {
    if (raw === '') continue
    const n = Number(raw)
    if (!Number.isFinite(n)) return { ok: false, reason: `${label} must be a number.` }
    if (n < 0) return { ok: false, reason: `${label} cannot be negative.` }
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
  return `${p.usage.calls}${ceiling} calls used this hour`
}

/** The one-line "what can this agent actually do" summary. Absent scope/quota are DEFAULTS,
 *  never absences — rendering a blank would tell the operator an agent is unbounded when the
 *  server is in fact bounding it. */
export function grantSummary(p: Pick<PrincipalView, 'scope' | 'quota'>): {
  reads: string
  budget: string
} {
  return {
    reads: p.scope?.length ? p.scope.join(', ') : 'your whole vault',
    budget: p.quota
      ? `${p.quota.callsPerHour} calls / ${p.quota.charsPerHour.toLocaleString()} chars per hour`
      : 'the default hourly budget'
  }
}

export function AgentsSettings(): React.ReactElement | null {
  const [pairings, setPairings] = useState<PairingRequestView[] | null>(null)
  const [principals, setPrincipals] = useState<PrincipalView[] | null>(null)
  // TWO error lifetimes, and they must not share a slot. An ACTION error ("could not approve")
  // has to stay until the operator acts again; a READ error ("could not list agents") should
  // clear the moment a later poll succeeds. Conflating them was a live bug: run() refreshes in
  // its finally, so a successful refresh wiped the failure message a few milliseconds after it
  // appeared, and the action looked like it had worked.
  const [actionErr, setActionErr] = useState<string | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [trim, setTrim] = useState<Record<string, string[]>>({})
  const [freshToken, setFreshToken] = useState<{ id: string; token: string } | null>(null)
  const [editing, setEditing] = useState<string | null>(null)

  const load = (): void => {
    const api = execApi()
    if (!api) return
    void api.pairings
      .list()
      .then((r) => {
        if (r.success && r.data) {
          setPairings(r.data.pairings)
          // Clear on success. This pane re-reads every 10s, so a sticky read error would sit
          // there forever after one transient failure — training the operator to ignore the
          // one place errors appear.
          setLoadErr(null)
        } else setLoadErr(r.error ?? 'Could not read pairing requests')
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
    void api.principals
      .list()
      .then((r) => {
        if (r.success && r.data) setPrincipals(r.data.principals)
        else setLoadErr(r.error ?? 'Could not read connected agents')
      })
      .catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)))
  }

  useEffect(() => {
    load()
    // Requests arrive from an agent process, not from this window, and they expire in 15
    // minutes — so a pane that only loaded once would show a stale or empty list exactly
    // when someone is standing by waiting to be let in.
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [])

  if (!execApi()) return null // desktop-only surface

  /** Returns whether the call actually landed. Callers that change the UI on completion —
   *  closing the limits editor, for one — need to distinguish "saved" from "failed", or a
   *  rejected save looks exactly like a successful one and the operator walks away believing
   *  a bound is in place that is not. */
  const run = async (key: string, fn: () => Promise<Envelope<unknown>>): Promise<boolean> => {
    setBusy(key)
    setActionErr(null)
    try {
      const r = await fn()
      if (!r.success) {
        setActionErr(r.error ?? 'That did not work')
        return false
      }
      return true
    } catch (e) {
      setActionErr(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(null)
      load()
    }
  }

  const pendingCount = pairings?.length ?? 0

  return (
    <div className="space-y-5">
      <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Agents')}</h3>
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        Other agents — Claude Code, Codex, a bridge — can mount DUIN and borrow its judgment:
        your context, your beliefs, your goals. Nobody is admitted by default. Each one
        authenticates as its own{' '}
        <span className="font-medium text-[var(--text-secondary)]">principal</span> with a
        revocable token, and can only do what the{' '}
        <span className="font-medium text-[var(--text-secondary)]">planes</span> you grant allow.
        Everything they read is logged and counted against an hourly budget.
      </p>

      {actionErr && (
        <p className="text-[11px] text-[var(--text-danger,#e5484d)]">{actionErr}</p>
      )}
      {loadErr && (
        <p className="text-[11px] text-[var(--text-muted)]">
          Could not refresh: {loadErr}. Showing the last good read.
        </p>
      )}

      {/* ── 0 · ADD ───────────────────────────────────────────────────── */}
      <AddAgent
        busy={busy === '__new'}
        onCreate={async (input) => {
          setBusy('__new')
          setActionErr(null)
          try {
            const r = await execApi()!.principals.create(input)
            if (r.success && r.data) return r.data.token
            setActionErr(r.error ?? 'Could not create the agent')
            return null
          } catch (e) {
            setActionErr(e instanceof Error ? e.message : String(e))
            return null
          } finally {
            setBusy(null)
            load()
          }
        }}
      />

      {/* ── 1 · ADMISSION ─────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">
          Waiting for you{pendingCount > 0 ? ` (${pendingCount})` : ''}
        </h4>
        {pairings === null && <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>}
        {pairings?.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            No agent is asking for access. Requests appear here and expire after 15 minutes —
            ignoring one is a safe way to decline, since asking again is cheap.
          </p>
        )}
        {pairings?.map((p) => {
          const granted = trim[p.pairingId] ?? p.requestedPlanes
          return (
            <div
              key={p.pairingId}
              className="space-y-3 rounded-md border border-[var(--border-strong,var(--border))] p-3"
            >
              <div>
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                  {p.name}{' '}
                  <span className="font-normal text-[var(--text-muted)]">({p.kind})</span>
                </p>
                <p className="text-[11px] text-[var(--text-muted)]">
                  Asked {ago(p.createdAt)}. It can read nothing until you approve.
                </p>
                {p.observedExe && (
                  <p className="mt-1 break-all font-mono text-[10px] text-[var(--text-muted)]">
                    {p.observedExe}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <p className="text-[11px] text-[var(--text-muted)]">
                  It asked for these. Untick anything you would rather not hand over — you can
                  give less than was asked for, never more.
                </p>
                {p.requestedPlanes.map((plane) => {
                  const copy = planeCopy(plane)
                  const on = granted.includes(plane)
                  return (
                    <label key={plane} className="flex items-start gap-2 text-[12px]">
                      <input
                        type="checkbox"
                        checked={on}
                        aria-label={copy.label}
                        onChange={() =>
                          setTrim((t) => ({
                            ...t,
                            [p.pairingId]: on
                              ? granted.filter((g) => g !== plane)
                              : [...granted, plane]
                          }))
                        }
                        className="mt-0.5"
                      />
                      <span>
                        <span className="text-[var(--text-primary)]">{copy.label}</span>
                        {copy.write && (
                          <span className="ml-1.5 rounded bg-[var(--bg-warning,#7a5b00)] px-1 py-px text-[10px] text-[var(--text-primary)]">
                            writes
                          </span>
                        )}
                        <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">
                          {plane}
                        </span>
                        {copy.detail && (
                          <span className="block text-[11px] text-[var(--text-muted)]">
                            {copy.detail}
                          </span>
                        )}
                      </span>
                    </label>
                  )
                })}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={busy === p.pairingId || granted.length === 0}
                  onClick={() =>
                    void run(p.pairingId, () =>
                      execApi()!.pairings.approve(p.pairingId, granted)
                    )
                  }
                  className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] disabled:opacity-40"
                >
                  {t('Approve')}
                </button>
                <button
                  type="button"
                  disabled={busy === p.pairingId}
                  onClick={() => void run(p.pairingId, () => execApi()!.pairings.deny(p.pairingId))}
                  className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-muted)] disabled:opacity-40"
                >
                  {t('Deny')}
                </button>
                {granted.length === 0 && (
                  <span className="text-[11px] text-[var(--text-muted)]">
                    {t('Nothing ticked — that is a denial, not an approval.')}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </section>

      {/* ── 2 · STANDING + 3 · BOUNDS ─────────────────────────────────── */}
      <section className="space-y-3">
        <h4 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('Connected')}</h4>
        {principals === null && <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>}
        {principals?.length === 0 && (
          <p className="text-[11px] text-[var(--text-muted)]">
            {t('No agent has been admitted yet.')}
          </p>
        )}
        {/* Revocation is permanent by policy, so revoked rows accumulate forever and can only
            ever outnumber the live ones. Sink them to the bottom rather than letting the list
            decay into mostly-dead entries the operator has to read past. */}
        {principals?.slice().sort(byLiveliness).map((pr) => (
          <PrincipalRow
            key={pr.id}
            principal={pr}
            busy={busy === pr.id}
            editing={editing === pr.id}
            onToggleEdit={() => setEditing(editing === pr.id ? null : pr.id)}
            freshToken={freshToken?.id === pr.id ? freshToken.token : null}
            onDismissToken={() => setFreshToken(null)}
            onSetStatus={(s) => void run(pr.id, () => execApi()!.principals.setStatus(pr.id, s))}
            onReissue={async () => {
              setBusy(pr.id)
              setActionErr(null)
              try {
                const r = await execApi()!.principals.reissue(pr.id)
                if (r.success && r.data) setFreshToken({ id: pr.id, token: r.data.token })
                else setActionErr(r.error ?? 'Could not reissue')
              } catch (e) {
                setActionErr(e instanceof Error ? e.message : String(e))
              } finally {
                setBusy(null)
                load()
              }
            }}
            onSaveGrant={(patch) => {
              void run(pr.id, () => execApi()!.principals.updateGrant(pr.id, patch)).then((ok) => {
                // Only on success. Closing regardless would hide the error banner behind a
                // collapsed editor and lose what the operator typed.
                if (ok) setEditing(null)
              })
            }}
          />
        ))}
      </section>
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
  onSaveGrant: (patch: {
    scope?: string[] | null
    writeScope?: string | null
    quota?: { callsPerHour: number; charsPerHour: number } | null
  }) => void
}): React.ReactElement {
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const revoked = principal.status === 'revoked'

  // Disarm the revoke confirmation whenever anything else about this row changes — opening
  // the limits editor, a status flip, a background refresh. A destructive button that stays
  // armed indefinitely after the operator has moved on is one stray click from permanent.
  useEffect(() => {
    setConfirmRevoke(false)
  }, [editing, principal.status, principal.id])

  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-[13px] font-medium text-[var(--text-primary)]">{principal.name}</span>
        <span className="text-[11px] text-[var(--text-muted)]">({principal.kind})</span>
        <span
          className={
            principal.status === 'active'
              ? 'text-[11px] text-[var(--text-success,#30a46c)]'
              : 'text-[11px] text-[var(--text-muted)]'
          }
        >
          {principal.status}
        </span>
        <span className="ml-auto font-mono text-[10px] text-[var(--text-muted)]">
          {principal.tokenId}
        </span>
      </div>

      <p className="text-[11px] text-[var(--text-muted)]">
        Last seen {ago(principal.lastSeenAt)} · {principal.callCount} calls ·{' '}
        {principal.planes.map((p) => planeCopy(p).label).join(', ') || 'no planes'}
      </p>

      <p className="text-[11px] text-[var(--text-muted)]">
        Reads <span className="text-[var(--text-secondary)]">{grantSummary(principal).reads}</span>
        {' · '}
        <span className="text-[var(--text-secondary)]">{grantSummary(principal).budget}</span>
        {/* Spend against the ceiling, not just the ceiling. A limit you cannot watch being
            approached is a setting; a limit you can is a control — and "has this agent been
            hammering the vault?" is the question this pane exists to answer. */}
        {usageLine(principal) && (
          <>
            {' · '}
            <span className="text-[var(--text-secondary)]">{usageLine(principal)}</span>
          </>
        )}
      </p>

      {freshToken && (
        <div className="space-y-1 rounded border border-[var(--border-strong,var(--border))] p-2">
          <p className="text-[11px] text-[var(--text-primary)]">
            {t('New token — shown once. The previous one stopped working immediately.')}
          </p>
          <code className="block break-all font-mono text-[11px] text-[var(--text-secondary)]">
            {freshToken}
          </code>
          <button
            type="button"
            onClick={onDismissToken}
            className="text-[11px] text-[var(--text-muted)] underline"
          >
            {t('Done')}
          </button>
        </div>
      )}

      {!revoked && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onSetStatus(principal.status === 'paused' ? 'active' : 'paused')}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-40"
          >
            {principal.status === 'paused' ? 'Resume' : 'Pause'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onToggleEdit}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-40"
          >
            {editing ? 'Close' : 'Limits'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onReissue}
            className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] disabled:opacity-40"
          >
            {t('Reissue token')}
          </button>
          {confirmRevoke ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => onSetStatus('revoked')}
                className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-danger,#e5484d)] disabled:opacity-40"
              >
                {t('Revoke for good')}
              </button>
              <span className="text-[11px] text-[var(--text-muted)]">
                Permanent — its token is still in the agent&apos;s config, so this cannot be undone.
                Pair again to re-admit it.
              </span>
            </>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={() => setConfirmRevoke(true)}
              className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-muted)] disabled:opacity-40"
            >
              {t('Revoke')}
            </button>
          )}
        </div>
      )}

      {editing && !revoked && (
        <GrantEditor principal={principal} busy={busy} onSave={onSaveGrant} />
      )}
    </div>
  )
}

/**
 * The limits editor, deliberately its OWN component mounted only while open.
 *
 * It used to be an inline block inside PrincipalRow, whose useState initialisers ran once at
 * first mount and never re-synced — and the row stays mounted for the life of the pane. So the
 * fields froze at whatever the grant was when the list first rendered, while the summary line
 * above them tracked the server. Since Save sends all three fields together, saving a quota
 * would write back the STALE scope and silently revert a change made anywhere else. Mounting
 * on open makes "the form shows what the server currently holds" true by construction rather
 * than by remembering to sync.
 */
function GrantEditor({
  principal,
  busy,
  onSave
}: {
  principal: PrincipalView
  busy: boolean
  onSave: (patch: {
    scope?: string[] | null
    writeScope?: string | null
    quota?: { callsPerHour: number; charsPerHour: number } | null
  }) => void
}): React.ReactElement {
  const [scopeText, setScopeText] = useState((principal.scope ?? []).join('\n'))
  const [writeScope, setWriteScope] = useState(principal.writeScope ?? '')
  const [calls, setCalls] = useState(principal.quota ? String(principal.quota.callsPerHour) : '')
  const [chars, setChars] = useState(principal.quota ? String(principal.quota.charsPerHour) : '')

  const quota = quotaPatchFromForm(calls, chars)

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-2">
      <label className="block text-[11px] text-[var(--text-muted)]">
        Readable folders — one per line. Leave empty for the whole vault.
        <textarea
          value={scopeText}
          aria-label={t('Readable folders')}
          onChange={(e) => setScopeText(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[11px] text-[var(--text-primary)]"
          placeholder="03 Projects/DUIN"
        />
      </label>
      <label className="block text-[11px] text-[var(--text-muted)]">
        Folder it may write notes into — empty for the default agent inbox.
        <input
          value={writeScope}
          aria-label={t('Writable folder')}
          onChange={(e) => setWriteScope(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[11px] text-[var(--text-primary)]"
          placeholder=".brain/agent-inbox"
        />
      </label>
      <div className="flex gap-2">
        <label className="flex-1 text-[11px] text-[var(--text-muted)]">
          Calls / hour
          <input
            value={calls}
            aria-label={t('Calls per hour')}
            inputMode="numeric"
            onChange={(e) => setCalls(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[11px] text-[var(--text-primary)]"
            placeholder="default"
          />
        </label>
        <label className="flex-1 text-[11px] text-[var(--text-muted)]">
          Characters / hour
          <input
            value={chars}
            aria-label={t('Characters per hour')}
            inputMode="numeric"
            onChange={(e) => setChars(e.target.value)}
            className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 font-mono text-[11px] text-[var(--text-primary)]"
            placeholder="default"
          />
        </label>
      </div>
      <p className="text-[11px] text-[var(--text-muted)]">
        Leaving a budget blank restores the default — it does not mean zero. Set it to 0 to stop
        the agent making any call at all.
      </p>
      {!quota.ok && <p className="text-[11px] text-[var(--text-danger,#e5484d)]">{quota.reason}</p>}
      <button
        type="button"
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
        className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-primary)] disabled:opacity-40"
      >
        {t('Save limits')}
      </button>
    </div>
  )
}

/** The env var the plugin's .mcp.json reads. Kept next to the snippet that quotes it so the
 *  two cannot drift into naming different variables. */
const TOKEN_ENV = 'DUIN_BRAIN_TOKEN'

/**
 * Operator-initiated admission: name an agent, pick what it may do, get a token.
 *
 * The pairing flow below this waits for an agent to ASK, which is right for something showing
 * up uninvited and backwards when you already know what you want to connect — and it left this
 * pane with no action on it in exactly that case. Minting here grants nothing extra: the planes
 * are chosen deliberately rather than trimmed from a request, and the plaintext token still
 * exists exactly once, in the response that fills this box.
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

  if (token) {
    return (
      <section className="space-y-2 rounded-md border border-[var(--border-strong,var(--border))] p-3">
        <p className="text-[13px] font-medium text-[var(--text-primary)]">
          Token for &quot;{name}&quot; — shown once
        </p>
        <p className="text-[11px] text-[var(--text-muted)]">
          Nothing stores this in readable form, so if you lose it you reissue rather than look it
          up. Set it where the agent will run, then start the agent:
        </p>
        <code className="block break-all rounded bg-[var(--bg-subtle,transparent)] p-2 font-mono text-[11px] text-[var(--text-secondary)]">
          {TOKEN_ENV}={token}
        </code>
        <p className="text-[11px] text-[var(--text-muted)]">
          The agent connects to <span className="font-mono">http://127.0.0.1:8799/exec/mcp</span>.
          DUIN must be running: the brain is in-process, so no app means no mount.
        </p>
        <button
          type="button"
          onClick={() => {
            setToken(null)
            setName('')
            setPlanes([...DEFAULT_GRANT])
            setOpen(false)
          }}
          className="rounded border border-[var(--border)] px-2 py-0.5 text-[11px] text-[var(--text-primary)]"
        >
          {t('Done')}
        </button>
      </section>
    )
  }

  if (!open) {
    // The binding is absent on any build whose preload predates it. Say so instead of
    // rendering a button that throws a raw TypeError on click — the pairing flow below still
    // works, so the pane is degraded, not broken.
    if (typeof execApi()?.principals?.create !== 'function') {
      return (
        <p className="text-[11px] text-[var(--text-muted)]">
          Minting tokens needs a newer DUIN build. An agent can still connect by asking — see
          below.
        </p>
      )
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-primary)]"
      >
        {t('Add an agent')}
      </button>
    )
  }

  return (
    <section className="space-y-3 rounded-md border border-[var(--border-strong,var(--border))] p-3">
      <label className="block text-[11px] text-[var(--text-muted)]">
        Name — how it appears here and in the audit log.
        <input
          value={name}
          aria-label={t('Agent name')}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          placeholder="claude-code"
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 text-[12px] text-[var(--text-primary)]"
        />
      </label>

      <label className="block text-[11px] text-[var(--text-muted)]">
        Kind
        <select
          value={kind}
          aria-label={t('Agent kind')}
          onChange={(e) => setKind(e.target.value)}
          className="mt-1 w-full rounded border border-[var(--border)] bg-transparent p-1 text-[12px] text-[var(--text-primary)]"
        >
          <option value="cli-agent">{t('CLI agent')}</option>
          <option value="bridge">{t('Bridge')}</option>
          <option value="team-agent">{t('Team agent')}</option>
          <option value="device">{t('Device')}</option>
        </select>
      </label>

      <div className="space-y-1.5">
        <p className="text-[11px] text-[var(--text-muted)]">{t('What it may do. Grant the least that works.')}</p>
        {GRANTABLE.map((plane) => {
          const copy = planeCopy(plane)
          const on = planes.includes(plane)
          return (
            <label key={plane} className="flex items-start gap-2 text-[12px]">
              <input
                type="checkbox"
                checked={on}
                aria-label={copy.label}
                onChange={() =>
                  setPlanes((ps) => (on ? ps.filter((p) => p !== plane) : [...ps, plane]))
                }
                className="mt-0.5"
              />
              <span>
                <span className="text-[var(--text-primary)]">{copy.label}</span>
                {copy.write && (
                  <span className="ml-1.5 rounded bg-[var(--bg-warning,#7a5b00)] px-1 py-px text-[10px] text-[var(--text-primary)]">
                    writes
                  </span>
                )}
                {copy.detail && (
                  <span className="block text-[11px] text-[var(--text-muted)]">{copy.detail}</span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={busy || !name.trim() || planes.length === 0}
          onClick={() => {
            void onCreate({ name: name.trim(), kind, planes }).then((t) => {
              // Only show the box on success. Clearing the form on a failure would throw away
              // what was typed and leave the error with nothing to correct.
              if (t) setToken(t)
            })
          }}
          className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-primary)] disabled:opacity-40"
        >
          {t('Create token')}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded border border-[var(--border)] px-2.5 py-1 text-[12px] text-[var(--text-muted)]"
        >
          {t('Cancel')}
        </button>
        {planes.length === 0 && (
          <span className="text-[11px] text-[var(--text-muted)]">
            {t('Nothing ticked — the agent could authenticate and do nothing.')}
          </span>
        )}
      </div>
    </section>
  )
}
