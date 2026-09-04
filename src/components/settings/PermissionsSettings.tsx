import { useCallback, useEffect, useMemo, useState } from 'react'
import { t, tf } from '@/lib/i18n'
import { Button } from '@/components/ui/Button'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { toast } from '@/stores/toast-store'
import type { PermissionPolicy, PolicyScope, PolicyUsage } from '@/lib/types'

// Persistent approval policies. Lists every persisted policy, grouped by scope. The user can
// delete a single row or clear an entire scope. New policies are written via the approval
// modal during normal use — this surface is the inspect/cleanup side of the same store.
//
// When the main process cannot reach its DB (corrupt userData, denied filesystem permissions,
// etc.) it falls back to an in-memory layer. We surface that fallback with a banner so the
// user knows their answers will reset on next launch and can investigate.
//
// Full computer access — the permission a first-timer comes here looking for — is a General
// setting, so the page points there instead of pretending it is not a permission.

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

const SCOPES: PolicyScope[] = ['conversation', 'workspace', 'global']

function scopeLabel(scope: PolicyScope): string {
  if (scope === 'conversation') return t('Conversation')
  if (scope === 'workspace') return t('Workspace')
  return t('Global')
}

function scopeDescription(scope: PolicyScope): string {
  if (scope === 'conversation') return t('Sticky for a single chat thread. Cleared when you delete the thread.')
  if (scope === 'workspace') return t('Sticky for one folder. Cleared when you remove the policy here.')
  return t('Sticky across every folder. The broadest scope.')
}

function formatDecision(decision: 'allow' | 'deny'): string {
  return decision === 'allow' ? t('Allow') : t('Deny')
}

function formatSubject(p: PermissionPolicy): string {
  return p.subjectKind === 'tool'
    ? tf('Tool: {subject}', { subject: p.subject })
    : tf('Risk: {subject}', { subject: p.subject })
}

function formatScopeMeta(p: PermissionPolicy): string | null {
  if (p.scope === 'conversation' && p.conversationId) {
    return tf('Conversation {id}…', { id: p.conversationId.slice(0, 8) })
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
  if (delta < minute) return t('just now')
  if (delta < hour) {
    const m = Math.floor(delta / minute)
    return m === 1 ? t('1 minute ago') : tf('{n} minutes ago', { n: m })
  }
  if (delta < day) {
    const h = Math.floor(delta / hour)
    return h === 1 ? t('1 hour ago') : tf('{n} hours ago', { n: h })
  }
  return formatAge(epochMs)
}

/**
 * The line that turns a grant into something you can judge. A standing policy
 * is a decision you delegated; this is what it has decided since.
 *
 * `undefined` usage with a KNOWN index means the policy has never fired.
 */
export function formatUsage(usage: PolicyUsage | undefined): string | null {
  if (!usage) return t('Never used')
  const calls = usage.n === 1 ? t('1 call') : tf('{n} calls', { n: usage.n })
  const when = formatLastUsed(usage.lastAt)
  return usage.denied > 0
    ? tf('Decided {calls}, {denied} denied, on its own · last {when}', { calls, denied: usage.denied, when })
    : tf('Decided {calls} on its own · last {when}', { calls, when })
}

function formatAge(epochMs: number): string {
  const delta = Date.now() - epochMs
  const day = 86_400_000
  if (delta < day) return t('today')
  const days = Math.floor(delta / day)
  if (days === 1) return t('1 day ago')
  if (days < 30) return tf('{n} days ago', { n: days })
  const months = Math.floor(days / 30)
  if (months === 1) return t('1 month ago')
  return tf('{n} months ago', { n: months })
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

function DecisionChip({ decision }: { decision: 'allow' | 'deny' }): React.ReactElement {
  const tone =
    decision === 'allow'
      ? 'border-[var(--success)]/40 text-[var(--success)]'
      : 'border-[var(--error)]/40 text-[var(--error)]'
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${tone}`}>
      {formatDecision(decision)}
    </span>
  )
}

export function PermissionsSettings(): React.ReactElement {
  // U1. A failed read used to leave `policies` at [] and render "No conversation policies." —
  // an authoritative claim, on a SECURITY surface, that the operator has granted nothing.
  // PanelState makes the failed read its own branch.
  const [state, setState] = useState<PanelStatus<PolicyListData>>(panelLoading())
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setState(panelFromResult(await query<PolicyListData>(t('tool permissions'), getApi()?.listPolicies)))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const data = state.phase === 'ready' ? state.data : null
  // `null` = unknown (older build, or the aggregate failed): rows omit the line. A Map that
  // is present but lacks a policy id = genuinely zero calls.
  const usage = useMemo(() => (data ? buildUsageIndex(data) : null), [data])

  const grouped = useMemo(() => {
    const result: Record<PolicyScope, PermissionPolicy[]> = { conversation: [], workspace: [], global: [] }
    for (const p of data?.policies ?? []) result[p.scope].push(p)
    for (const scope of SCOPES) result[scope].sort((a, b) => b.updatedAt - a.updatedAt)
    return result
  }, [data])

  const handleDelete = async (id: string): Promise<void> => {
    const api = getApi()
    if (!api) return
    setBusy(id)
    try {
      await invoke(t('delete policy'), () => api.deletePolicy(id))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not delete that policy.')))
    } finally {
      setBusy(null)
    }
  }

  const handleClearScope = async (scope: PolicyScope): Promise<void> => {
    const api = getApi()
    if (!api) return
    const count = grouped[scope].length
    if (count === 0) return
    const name = scopeLabel(scope).toLowerCase()
    const question =
      count === 1
        ? tf('Remove the one {scope} policy? DUIN will ask again the next time it uses that tool.', { scope: name })
        : tf('Remove all {n} {scope} policies? DUIN will ask again the next time it uses these tools.', {
            n: count,
            scope: name
          })
    if (!window.confirm(question)) return
    setBusy(`scope:${scope}`)
    try {
      await invoke(t('clear policies'), () => api.clearScope(scope))
      await refresh()
    } catch (e) {
      toast.error(describeError(e, t('Could not clear those policies.')))
    } finally {
      setBusy(null)
    }
  }

  return (
    <SettingsPage
      purpose={t('Answers you chose to keep from the approval dialog: which tools DUIN may use without asking, and where. Delete a row and DUIN asks again.')}
    >
      <p className="text-[12px] text-[var(--text-muted)]">
        {t('Looking for Full computer access? That switch is on the General tab.')}{' '}
        <SettingsLink tab="general">{t('Open General')}</SettingsLink>
      </p>

      {data?.memoryFallback && (
        <SettingsRow
          tone="warning"
          label={t('Persistence unavailable.')}
          hint={t('Policies are held in memory only and reset on the next launch. Check the main process log for the underlying error.')}
        />
      )}
      {data?.usageError && (
        <SettingsRow
          tone="warning"
          label={t('Activity unavailable.')}
          hint={tf(
            'The policies below are correct and in effect, but their usage counts could not be read ({error}). A row showing no activity is not evidence that the policy is unused.',
            { error: data.usageError }
          )}
        />
      )}

      <PanelState
        state={state}
        loading={<SettingsLoading what={t('your permission policies')} />}
        error={(message, retry) => (
          <SettingsLoadError
            what={t('your permission policies')}
            message={`${message} ${t('Any policies you saved are still in effect.')}`}
            onRetry={retry}
          />
        )}
        empty={
          <SettingsRow
            label={t('No saved policies yet.')}
            hint={t('Pick "This conversation", "This workspace", or "Always" in the approval dialog to add one.')}
          />
        }
        isEmpty={(d) => d.policies.length === 0}
        onRetry={() => void refresh()}
      >
        {() => (
          <>
            {SCOPES.map((scope) => {
              const rows = grouped[scope]
              const clearing = busy === `scope:${scope}`
              return (
                <SettingsSection
                  key={scope}
                  label={scopeLabel(scope)}
                  description={scopeDescription(scope)}
                  actions={
                    <>
                      <span className="font-mono text-[11px] text-[var(--text-muted)]">{rows.length}</span>
                      <Button size="sm" disabled={rows.length === 0 || clearing} onClick={() => void handleClearScope(scope)}>
                        {clearing ? t('Clearing…') : t('Clear all')}
                      </Button>
                    </>
                  }
                >
                  {rows.length === 0 ? (
                    <p className="text-[12px] text-[var(--text-muted)]">{t('No policies at this scope.')}</p>
                  ) : (
                    rows.map((policy) => {
                      const scopeMeta = formatScopeMeta(policy)
                      const isBusy = busy === policy.id
                      const u = usage?.get(policy.id)
                      const usageLine = usage ? formatUsage(u) : null
                      return (
                        <SettingsRow
                          key={policy.id}
                          label={
                            <span className="flex items-center gap-2">
                              <DecisionChip decision={policy.decision} />
                              <span className="truncate font-mono text-[12px]">{formatSubject(policy)}</span>
                            </span>
                          }
                          hint={
                            <>
                              {scopeMeta && <span className="block truncate font-mono text-[11px]">{scopeMeta}</span>}
                              <span className="block">{tf('Updated {when}', { when: formatAge(policy.updatedAt) })}</span>
                              {usageLine && (
                                <span
                                  className={
                                    'block ' +
                                    (u && u.denied > 0
                                      ? 'text-[var(--warning)]'
                                      : u
                                        ? 'text-[var(--text-secondary)]'
                                        : 'italic')
                                  }
                                >
                                  {usageLine}
                                </span>
                              )}
                            </>
                          }
                          control={
                            <Button size="sm" variant="danger" disabled={isBusy} onClick={() => void handleDelete(policy.id)}>
                              {isBusy ? t('Removing…') : t('Delete')}
                            </Button>
                          }
                        />
                      )
                    })
                  )}
                </SettingsSection>
              )
            })}
          </>
        )}
      </PanelState>

      <SettingsSection label={t('How policies apply')}>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          {t('Policies are matched in order: conversation, workspace, then global. Within a level, a Deny beats an Allow. A Risk policy (Network, Destructive, Secret) covers every tool with that risk, so one row can silence prompts across several tools.')}
        </p>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          {t('The activity line counts only the calls a policy decided without asking you. A row reading "Never used" costs nothing to delete. Individual decisions are in the Activity tab of the Automations hub.')}
        </p>
      </SettingsSection>
    </SettingsPage>
  )
}
