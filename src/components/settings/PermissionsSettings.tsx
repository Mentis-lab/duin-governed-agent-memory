import { t } from '@/lib/i18n'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { query } from '@/lib/ipc-client'
import { toast } from '@/stores/toast-store'
import type {
  PermissionPolicy,
  PolicyScope,
  PolicyUsage
} from '@/lib/types'

// Persistent approval policies. Lists every persisted policy, grouped by
// scope. The user can delete a single row or clear an entire scope. New
// policies are written via the approval modal during normal use — this
// surface is the inspect/cleanup side of the same store.
//
// When the main process cannot reach its DB (corrupt userData, denied
// filesystem permissions, etc.) it falls back to an in-memory layer. We
// surface that fallback with a banner so the user knows their answers
// will reset on next launch and can investigate.

type PolicyListData = {
  policies: PermissionPolicy[]
  memoryFallback: boolean
  /** Per-policy activity. Absent on an older main process — the rows just
   *  render without the usage line rather than claiming zero. */
  usage?: PolicyUsage[]
  /** Set when the usage aggregate failed but the policy list succeeded. */
  usageError?: string | null
}

type ListResponse = {
  success: boolean
  data?: PolicyListData
  error?: string
}

interface PermissionsApi {
  listPolicies: () => Promise<ListResponse>
  deletePolicy: (id: string) => Promise<{ success: boolean; error?: string }>
  clearScope: (scope: PolicyScope) => Promise<{ success: boolean; error?: string }>
}

function getApi(): PermissionsApi | null {
  if (typeof window === 'undefined') return null
  const api = (window as unknown as { api?: { permissions?: PermissionsApi } }).api
  return api?.permissions ?? null
}

const SCOPE_LABEL: Record<PolicyScope, string> = {
  conversation: 'Conversation',
  workspace: 'Workspace',
  global: 'Global'
}

const SCOPE_DESCRIPTION: Record<PolicyScope, string> = {
  conversation:
    'Sticky for a single chat thread. Cleared when you delete the thread.',
  workspace: 'Sticky for one folder. Cleared when you remove the policy here.',
  global: 'Sticky across every folder. The broadest scope.'
}

function formatDecision(decision: 'allow' | 'deny'): string {
  return decision === 'allow' ? 'Allow' : 'Deny'
}

function formatSubject(p: PermissionPolicy): string {
  const prefix = p.subjectKind === 'tool' ? 'Tool' : 'Risk'
  return `${prefix}: ${p.subject}`
}

function formatScopeMeta(p: PermissionPolicy): string | null {
  if (p.scope === 'conversation' && p.conversationId) {
    return `Conversation ${p.conversationId.slice(0, 8)}…`
  }
  if (p.scope === 'workspace' && p.workspacePath) {
    return p.workspacePath
  }
  return null
}

/**
 * Relative time for "last acted", deliberately FINER than formatAge below.
 * A grant that fired four minutes ago and one that last fired twenty hours ago
 * both read "today" on the coarse scale, and those are not the same fact when
 * you are deciding whether to revoke.
 */
function formatLastUsed(epochMs: number): string {
  const delta = Date.now() - epochMs
  const minute = 60_000
  const hour = 3_600_000
  const day = 86_400_000
  if (delta < minute) return 'just now'
  if (delta < hour) {
    const m = Math.floor(delta / minute)
    return m === 1 ? '1 minute ago' : `${m} minutes ago`
  }
  if (delta < day) {
    const h = Math.floor(delta / hour)
    return h === 1 ? '1 hour ago' : `${h} hours ago`
  }
  return formatAge(epochMs)
}

/**
 * The line that turns a grant into something you can judge. A standing policy
 * is a decision you delegated; this is what it has decided since.
 *
 * `undefined` usage means the main process did not report any (older build) —
 * render nothing rather than assert "never used", which is a claim about a
 * security surface we cannot make from a missing field.
 */
export function formatUsage(usage: PolicyUsage | undefined): string | null {
  if (!usage) return 'Never used'
  const calls = usage.n === 1 ? '1 call' : `${usage.n} calls`
  const denied = usage.denied > 0 ? `, ${usage.denied} denied` : ''
  return `Decided ${calls}${denied} on its own · last ${formatLastUsed(usage.lastAt)}`
}

function formatAge(epochMs: number): string {
  const delta = Date.now() - epochMs
  const day = 86_400_000
  if (delta < day) return 'today'
  const days = Math.floor(delta / day)
  if (days === 1) return '1 day ago'
  if (days < 30) return `${days} days ago`
  const months = Math.floor(days / 30)
  if (months === 1) return '1 month ago'
  return `${months} months ago`
}

/**
 * Pure: turn the IPC payload into the row-level usage lookup.
 *
 * Returns `null` for "we do not know" and a Map for "we know". The distinction is the
 * whole point: a FAILED usage aggregate comes back as an empty array, which is
 * byte-identical to "every policy has zero calls". Rendering the second when the first
 * is true would print "Never used" against a grant that has fired ten thousand times —
 * the same false-authority failure as U1 (an empty list read as "you granted nothing"),
 * one field over, on the same pane.
 *
 * Exported for test: this pane follows the repo's node-only convention (see
 * ChannelsSettings.test.tsx) — behaviour lives in pure helpers, not a jsdom render.
 */
export function buildUsageIndex(data: PolicyListData): Map<string, PolicyUsage> | null {
  if (data.usageError) return null
  if (!Array.isArray(data.usage)) return null
  return new Map(data.usage.map((u) => [u.policyId, u]))
}

export function PermissionsSettings() {
  const [policies, setPolicies] = useState<PermissionPolicy[]>([])
  // `null` = the main process reported no usage at all (older build): rows omit
  // the line. A Map that is present but lacks a policy id = genuinely zero calls.
  const [usage, setUsage] = useState<Map<string, PolicyUsage> | null>(null)
  const [usageError, setUsageError] = useState<string | null>(null)
  const [memoryFallback, setMemoryFallback] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  // U1. A failed read used to leave `policies` at [] and render "No conversation
  // policies." — an authoritative claim, on a SECURITY surface, that the operator
  // has granted nothing. The toast scrolled away; the false claim stayed on screen.
  const [loadError, setLoadError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const r = await query<PolicyListData>('tool permissions', getApi()?.listPolicies)
      if (!r.ok) {
        setLoadError(r.error)
        toast.error(`Failed to load policies: ${r.error}`)
        return
      }
      setLoadError(null)
      setPolicies(r.data.policies)
      setMemoryFallback(Boolean(r.data.memoryFallback))
      setUsageError(r.data.usageError ?? null)
      setUsage(buildUsageIndex(r.data))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const grouped = useMemo(() => {
    const result: Record<PolicyScope, PermissionPolicy[]> = {
      conversation: [],
      workspace: [],
      global: []
    }
    for (const p of policies) {
      result[p.scope].push(p)
    }
    for (const scope of Object.keys(result) as PolicyScope[]) {
      result[scope].sort((a, b) => b.updatedAt - a.updatedAt)
    }
    return result
  }, [policies])

  const handleDelete = async (id: string) => {
    const api = getApi()
    if (!api) return
    setBusy(id)
    try {
      const response = await api.deletePolicy(id)
      if (!response.success) {
        toast.error(`Failed to delete policy: ${response.error ?? 'unknown error'}`)
        return
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  const handleClearScope = async (scope: PolicyScope) => {
    const api = getApi()
    if (!api) return
    const count = grouped[scope].length
    if (count === 0) return
    if (
      !window.confirm(
        `Remove all ${count} ${SCOPE_LABEL[scope].toLowerCase()} ${
          count === 1 ? 'policy' : 'policies'
        }? You'll be prompted again the next time the model uses these tools.`
      )
    ) {
      return
    }
    setBusy(`scope:${scope}`)
    try {
      const response = await api.clearScope(scope)
      if (!response.success) {
        toast.error(`Failed to clear scope: ${response.error ?? 'unknown error'}`)
        return
      }
      await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-6 text-[16px] text-[var(--text-primary)]">
      <div>
        <h2 className="text-[20px] font-semibold">{t('Tool permissions')}</h2>
        <p className="mt-1 text-[12px] text-[var(--text-muted)]">
          Approval decisions you've made stick to this list. Pick "Just this
          once" in the approval dialog to avoid persisting; pick "This
          conversation", "This workspace", or "Always" to add a row here.
        </p>
      </div>

      {memoryFallback && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          <strong className="font-semibold">{t('Persistence unavailable.')}</strong>{' '}
          Policies are being held in memory only and will reset on the next app
          launch. Check the main process log for the underlying error.
        </div>
      )}

      {usageError && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-3 text-[12px] text-amber-200">
          <strong className="font-semibold">{t('Activity unavailable.')}</strong> The
          policies below are correct and in effect, but their usage counts could not be
          read ({usageError}). A row showing no activity here is not evidence that the
          policy is unused.
        </div>
      )}

      {loading && (
        <div className="text-[12px] text-[var(--text-muted)]">Loading policies…</div>
      )}

      {!loading && loadError && (
        <div
          role="alert"
          className="rounded border border-red-500/40 bg-red-500/10 p-3 text-[12px] text-red-200"
        >
          <strong className="font-semibold">Couldn&apos;t read your permission policies.</strong>{' '}
          {loadError}
          <p className="mt-1 opacity-90">
            This list is showing nothing because the read FAILED — not because you have granted
            nothing. Any policies you have saved are still in effect.
          </p>
          <button
            type="button"
            onClick={() => void refresh()}
            className="mt-2 rounded border border-red-500/40 px-2 py-1 font-mono text-[11px] uppercase hover:bg-red-500/10"
          >
            {t('Retry')}
          </button>
        </div>
      )}

      {!loading &&
        !loadError &&
        (Object.keys(SCOPE_LABEL) as PolicyScope[]).map((scope) => {
          const rows = grouped[scope]
          const clearing = busy === `scope:${scope}`
          return (
            <section
              key={scope}
              className="rounded-lg border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3"
            >
              <div className="mb-3 flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-[16px] font-semibold text-[var(--text-primary)]">
                    {SCOPE_LABEL[scope]}{' '}
                    <span className="ml-1 font-mono text-[12px] text-[var(--text-muted)]">
                      ({rows.length})
                    </span>
                  </h3>
                  <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
                    {SCOPE_DESCRIPTION[scope]}
                  </p>
                </div>
                <button
                  type="button"
                  disabled={rows.length === 0 || clearing}
                  onClick={() => handleClearScope(scope)}
                  className="shrink-0 rounded border border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[11px] uppercase text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {clearing ? 'Clearing…' : 'Clear all'}
                </button>
              </div>

              {rows.length === 0 ? (
                <div className="rounded border border-dashed border-[var(--panel-border)] px-3 py-4 text-center text-[12px] text-[var(--text-muted)]">
                  No {SCOPE_LABEL[scope].toLowerCase()} policies.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {rows.map((policy) => {
                    const scopeMeta = formatScopeMeta(policy)
                    const isBusy = busy === policy.id
                    return (
                      <li
                        key={policy.id}
                        className="flex items-start justify-between gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-3 py-2"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
                                policy.decision === 'allow'
                                  ? 'border-emerald-500/30 text-emerald-300'
                                  : 'border-red-500/40 text-red-300'
                              }`}
                            >
                              {formatDecision(policy.decision)}
                            </span>
                            <span className="truncate font-mono text-[12px] text-[var(--text-primary)]">
                              {formatSubject(policy)}
                            </span>
                          </div>
                          {scopeMeta && (
                            <div className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
                              {scopeMeta}
                            </div>
                          )}
                          <div className="mt-1 text-[11px] text-[var(--text-muted)]">
                            Updated {formatAge(policy.updatedAt)}
                          </div>
                          {usage !== null &&
                            (() => {
                              const u = usage.get(policy.id)
                              const line = formatUsage(u)
                              if (!line) return null
                              return (
                                <div
                                  className={`mt-1 text-[11px] ${
                                    u && u.denied > 0
                                      ? 'text-amber-300/90'
                                      : u
                                        ? 'text-[var(--text-secondary)]'
                                        : 'text-[var(--text-muted)] italic'
                                  }`}
                                >
                                  {line}
                                </div>
                              )
                            })()}
                        </div>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => handleDelete(policy.id)}
                          className="shrink-0 rounded border border-[var(--panel-border)] bg-[var(--bg-tertiary)] px-2 py-1 font-mono text-[11px] uppercase text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {isBusy ? 'Removing…' : 'Delete'}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}

      <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3 text-[11px] text-[var(--text-muted)]">
        Policies are matched in order: conversation, workspace, then global —
        and within a level a Deny beats an Allow. Risk policies (Network,
        Destructive, Secret) match every tool that carries the same risk, so
        one row can silence prompts across several tools.
        <br />
        <br />
        The activity line counts only calls this policy decided <em>without
        asking you</em> — that is the whole point of granting it. A row reading
        &quot;Never used&quot; costs nothing to delete. Individual decisions are
        in Automations → Activity.
      </div>
    </div>
  )
}
