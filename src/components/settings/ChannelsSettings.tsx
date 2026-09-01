import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Toggle } from '@/components/ui/Toggle'
import { ChannelStatusBadge } from './channels/ChannelStatusBadge'
import { ChannelCapabilities } from './channels/ChannelCapabilities'
import { ChannelSetupSteps } from './channels/ChannelSetupSteps'
import { ChannelFieldInput } from './channels/ChannelFieldInput'
import { channelState, type ChannelDefinition } from './channels/channel-types'

// Channels — the CONVERSATIONAL half of connectivity, and until now the half with
// no mouth. Where Connections (ConnectionsPanel) PULLs a source into the brain,
// a channel runs a two-way turn: an inbound message from Telegram / Discord /
// Feishu goes through the pairing gate, then a DE-PRIVILEGED brain turn, then the
// reply goes back out.
//
// Why this pane exists: channels-store.setChannelEnabled and gateway.restartChannel
// were both fully written and had ZERO callers. The channels IPC surface was
// list/pair/approve/revoke only, so the sole way to turn a channel on was to hand-
// edit userData/channels.json — a file that does not exist on a default install.
// The enable path was not obscure, it was unreachable.
//
// TWO GATES, deliberately separate, and the copy has to keep them separate or the
// operator will mis-read one for the other:
//   1. ENABLE (this pane's toggle) decides whether the adapter connects at all.
//   2. PAIRING decides which external user may talk to it. Deny-first: an unknown
//      user is 'pending' until explicitly approved, so enabling a channel does NOT
//      open it to whoever finds the bot.
// A channel also only comes up when it is CONFIGURED (its secret is present) — the
// gateway declines otherwise, which is why enabling an unconfigured channel is
// allowed and simply says "waiting for credentials" rather than being refused.

export interface ChannelSummary {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  lastError: string | null
  startedAt: number | null
}

export interface ChannelCredential {
  keychainKey: string
  label: string
  kind: 'secret' | 'text'
  placeholder?: string
  help?: string
  hasValue: boolean
  value?: string
}

interface ChannelsApi {
  list: () => Promise<{ success: boolean; data?: ChannelSummary[]; error?: string }>
  /** Optional so an older main process degrades to summary-only rows rather than
   *  throwing — the pane still works, it just cannot describe a channel. */
  listDefinitions?: () => Promise<{
    success: boolean
    data?: ChannelDefinition[]
    error?: string
  }>
  setEnabled: (id: string, enabled: boolean) => Promise<{ success: boolean; error?: string }>
  listCredentials?: (
    id: string
  ) => Promise<{ success: boolean; data?: ChannelCredential[]; error?: string }>
  setCredential?: (
    id: string,
    keychainKey: string,
    value: string
  ) => Promise<{ success: boolean; data?: { configured: boolean }; error?: string }>
  pair: (
    id: string,
    externalUserId: string
  ) => Promise<{ success: boolean; data?: { status: string; code: string | null }; error?: string }>
  approve: (
    id: string,
    opts: { userId?: string; code?: string }
  ) => Promise<{ success: boolean; data?: { userId: string }; error?: string }>
  revoke: (id: string, externalUserId: string) => Promise<{ success: boolean; error?: string }>
  onUpdated?: (cb: () => void) => () => void
}

function channelsApi(): ChannelsApi | undefined {
  return (window as unknown as { api?: { channels?: ChannelsApi } }).api?.channels
}

/**
 * The one-line state under a channel's name.
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so
 * pane behaviour is unit-tested through helpers rather than by rendering (the
 * same convention as LoopSettings / FoundationsSettings).
 *
 * The distinction that matters: ENABLED and RUNNING are not the same thing. An
 * enabled channel with no credentials never starts, and reporting it as "on"
 * would be a lie the operator only discovers when no message ever arrives.
 */
export function channelStatusLine(c: ChannelSummary): string {
  if (!c.enabled) {
    return c.configured
      ? 'Off — the adapter is not connected. Credentials are in place.'
      : 'Off — and no credentials yet, so turning it on will not connect it until they are set.'
  }
  if (!c.configured) return 'On, but waiting for credentials — it cannot connect until they are set.'
  if (c.lastError) return `On — last attempt failed: ${c.lastError}`
  if (c.startedAt) return `Connected since ${new Date(c.startedAt).toLocaleString()}`
  return 'On — connecting…'
}

/** Whether the pairing controls are worth showing at all for a channel: a channel
 *  that cannot connect has nobody to pair with yet. */
export function showsPairingControls(c: ChannelSummary): boolean {
  return c.enabled && c.configured
}

const inputCls =
  'flex-1 rounded border border-[var(--border)] bg-[var(--bg-primary)] px-1.5 py-1 text-[11px] text-[var(--text-primary)] focus:border-[var(--accent)] focus:outline-none'
const btnCls =
  'shrink-0 rounded border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50'

// `secretPlaceholder` lived here and is gone: ChannelFieldInput's `fieldPlaceholder`
// does the same job for BOTH credential kinds and is the one the pane now renders.
// Leaving the superseded copy exported would be a second answer to "what does this box
// say when a secret is stored", and the two would drift the first time either changed.

function CredentialFields({
  channelId,
  busy,
  onSaved,
  onError
}: {
  channelId: string
  busy: boolean
  onSaved: (message: string) => void
  onError: (message: string) => void
}): React.ReactElement | null {
  const [fields, setFields] = useState<ChannelCredential[] | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const load = (): void => {
    const api = channelsApi()
    if (!api?.listCredentials) {
      setFields([])
      return
    }
    void api
      .listCredentials(channelId)
      .then((r) => {
        if (!r.success || !r.data) return
        setFields(r.data)
        // Non-secret fields are editable, so seed the box with what is stored.
        setDrafts(
          Object.fromEntries(
            r.data.filter((f) => f.kind === 'text').map((f) => [f.keychainKey, f.value ?? ''])
          )
        )
      })
      .catch(() => setFields([]))
  }

  useEffect(load, [channelId])

  const save = async (field: ChannelCredential, raw: string): Promise<void> => {
    const api = channelsApi()
    if (!api?.setCredential) return
    const r = await api.setCredential(channelId, field.keychainKey, raw)
    if (!r.success) {
      onError(r.error ?? 'Could not save that value')
      return
    }
    // A secret is write-only: clear the box rather than leave the plaintext on screen.
    if (field.kind === 'secret') setDrafts((d) => ({ ...d, [field.keychainKey]: '' }))
    onSaved(raw ? `${field.label} saved.` : `${field.label} cleared.`)
    load()
  }

  if (!fields || fields.length === 0) return null

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-2">
      <p className="text-[11px] text-[var(--text-muted)]">
        What it needs to connect. Stored in the OS keychain, never in the vault or a settings
        file.
      </p>
      {fields.map((f) => (
        <div key={f.keychainKey} className="space-y-1">
          <div className="flex items-center gap-1.5">
            <ChannelFieldInput
              field={f}
              value={drafts[f.keychainKey] ?? ''}
              disabled={busy}
              onChange={(v) => setDrafts((d) => ({ ...d, [f.keychainKey]: v }))}
              onSubmit={() => void save(f, (drafts[f.keychainKey] ?? '').trim())}
            />
            <button
              type="button"
              className={btnCls}
              disabled={busy}
              onClick={() => void save(f, (drafts[f.keychainKey] ?? '').trim())}
            >
              {t('Save')}
            </button>
            {f.hasValue && (
              <button
                type="button"
                className={btnCls}
                disabled={busy}
                onClick={() => void save(f, '')}
              >
                {t('Clear')}
              </button>
            )}
          </div>
          {f.help && <p className="text-[10px] text-[var(--text-muted)]">{f.help}</p>}
        </div>
      ))}
    </div>
  )
}

function ChannelRow({
  c,
  definition,
  busy,
  onToggle,
  onPair,
  onApprove,
  onRevoke,
  onCredentialSaved,
  onCredentialError,
  notice
}: {
  c: ChannelSummary
  /** What this channel IS. Absent only if a registered adapter has no definition —
   *  the drift the main-process tests already fail on, so in practice always present. */
  definition?: ChannelDefinition
  busy: boolean
  onToggle: (next: boolean) => void
  onPair: (userId: string) => void
  onApprove: (opts: { userId?: string; code?: string }) => void
  onRevoke: (userId: string) => void
  onCredentialSaved: (message: string) => void
  onCredentialError: (message: string) => void
  notice?: string
}): React.ReactElement {
  const [userId, setUserId] = useState('')
  const [code, setCode] = useState('')

  return (
    <div className="rounded border border-[var(--border)] bg-[var(--bg-primary)] p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
              {c.label}
            </span>
            {/* The badge and the line below now read the SAME reduced state, so they
                cannot disagree about the one distinction this pane exists to keep:
                enabled is not running. */}
            <ChannelStatusBadge state={channelState(c)} />
          </span>
          {definition && (
            <span className="text-[11px] text-[var(--text-secondary)]">{definition.description}</span>
          )}
          <span className="text-[11px] text-[var(--text-muted)]">{channelStatusLine(c)}</span>
        </span>
        <Toggle
          checked={c.enabled}
          disabled={busy}
          onChange={onToggle}
          aria-label={`Enable ${c.label}`}
        />
      </div>

      {notice && <p className="mt-2 text-[11px] text-[var(--text-secondary)]">{notice}</p>}

      {definition && <ChannelCapabilities capabilities={definition.capabilities} />}

      {/* Setup guidance shows while the channel is NOT yet configured — that is when the
          operator needs to know where the token comes from and whether this channel can
          receive at all without a public endpoint. Once it is connected the steps are
          noise, so they collapse away rather than permanently occupying the row. */}
      {definition && !c.configured && <ChannelSetupSteps definition={definition} />}

      <CredentialFields
        channelId={c.id}
        busy={busy}
        onSaved={(m) => onCredentialSaved(m)}
        onError={(m) => onCredentialError(m)}
      />

      {showsPairingControls(c) && (
        <div className="mt-3 space-y-2 border-t border-[var(--border)] pt-2">
          <p className="text-[11px] text-[var(--text-muted)]">
            Who may talk to it. Nobody is trusted by default — start pairing for an external user id
            to mint a single-use code, or approve them directly.
          </p>
          <div className="flex items-center gap-1.5">
            <input
              className={inputCls}
              placeholder="external user id"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
            />
            <button
              type="button"
              className={btnCls}
              disabled={busy || !userId.trim()}
              onClick={() => onPair(userId.trim())}
            >
              {t('Start pairing')}
            </button>
            <button
              type="button"
              className={btnCls}
              disabled={busy || !userId.trim()}
              onClick={() => onApprove({ userId: userId.trim() })}
            >
              {t('Approve')}
            </button>
            <button
              type="button"
              className={btnCls}
              disabled={busy || !userId.trim()}
              onClick={() => onRevoke(userId.trim())}
            >
              {t('Revoke')}
            </button>
          </div>
          <div className="flex items-center gap-1.5">
            <input
              className={inputCls}
              placeholder="pairing code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button
              type="button"
              className={btnCls}
              disabled={busy || !code.trim()}
              onClick={() => onApprove({ code: code.trim() })}
            >
              {t('Approve by code')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function ChannelsSettings(): React.ReactElement | null {
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null)
  const [definitions, setDefinitions] = useState<Map<string, ChannelDefinition>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [notices, setNotices] = useState<Record<string, string>>({})

  const load = (): void => {
    const api = channelsApi()
    if (!api) return
    void api
      .list()
      .then((r) => {
        if (r.success && r.data) setChannels(r.data)
        else setErr(r.error ?? 'Could not read channels')
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  // Definitions are static for the life of the process — what a channel IS does not
  // change while the app runs, only how it is doing. So they load ONCE, separately from
  // the summary refresh that fires on every enable/error/start. A failure here is not
  // fatal and deliberately does not set `err`: the rows still work from summaries alone,
  // just without the description and setup guidance, and blocking the whole pane over
  // missing help text would be the worse trade.
  useEffect(() => {
    const api = channelsApi()
    if (!api?.listDefinitions) return
    void api
      .listDefinitions()
      .then((r) => {
        if (r.success && r.data) {
          setDefinitions(new Map(r.data.map((d) => [d.id, d as ChannelDefinition])))
        }
      })
      .catch(() => {
        /* rows degrade to summary-only; see above */
      })
  }, [])

  useEffect(() => {
    load()
    // channels-store already broadcasts 'channels:updated' on every state change
    // (enable, error, started) — so a channel that comes up or fails on its own
    // refreshes this pane without a poll.
    return channelsApi()?.onUpdated?.(load)
  }, [])

  if (!channelsApi()) return null // desktop-only surface

  const run = async (id: string, fn: () => Promise<{ success: boolean; error?: string }>, ok?: string) => {
    setBusy(id)
    setErr(null)
    try {
      const r = await fn()
      if (!r.success) setErr(r.error ?? 'That did not work')
      else if (ok) setNotices((n) => ({ ...n, [id]: ok }))
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      load()
    }
  }

  return (
    <div className="space-y-5">
      <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Channels')}</h3>
      <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
        Two-way surfaces. An inbound message runs a{' '}
        <span className="font-medium text-[var(--text-secondary)]">de-privileged</span> brain turn —
        it can read and answer, but never carries the exec authority a chat turn in this window
        does — and the reply goes back out on the same surface. Every channel ships{' '}
        <span className="font-medium text-[var(--text-secondary)]">off</span>, and turning one on
        does not open it to anyone: each external user stays unauthorised until you pair them.
      </p>

      {err && <p className="text-[11px] text-[var(--text-danger,#e5484d)]">{err}</p>}
      {channels === null && <p className="text-[11px] text-[var(--text-muted)]">Loading…</p>}
      {channels !== null && channels.length === 0 && (
        <p className="text-[11px] text-[var(--text-muted)]">{t('No channels are registered in this build.')}</p>
      )}

      <div className="space-y-3">
        {(channels ?? []).map((c) => (
          <ChannelRow
            key={c.id}
            c={c}
            definition={definitions.get(c.id)}
            busy={busy === c.id}
            notice={notices[c.id]}
            onToggle={(next) => void run(c.id, () => channelsApi()!.setEnabled(c.id, next))}
            onPair={(userId) =>
              void run(c.id, async () => {
                const r = await channelsApi()!.pair(c.id, userId)
                if (r.success) {
                  setNotices((n) => ({
                    ...n,
                    [c.id]: r.data?.code
                      ? `Pairing code for ${userId}: ${r.data.code} — give it to them, or approve by code below.`
                      : `${userId} is ${r.data?.status ?? 'pending'}.`
                  }))
                }
                return r
              })
            }
            onApprove={(opts) =>
              void run(c.id, async () => {
                const r = await channelsApi()!.approve(c.id, opts)
                if (r.success) {
                  setNotices((n) => ({ ...n, [c.id]: `Approved ${r.data?.userId ?? ''}.` }))
                }
                return r
              })
            }
            onRevoke={(userId) =>
              void run(c.id, () => channelsApi()!.revoke(c.id, userId), 'Revoked.')
            }
            onCredentialSaved={(m) => {
              setNotices((n) => ({ ...n, [c.id]: m }))
              load()
            }}
            onCredentialError={(m) => setErr(m)}
          />
        ))}
      </div>
    </div>
  )
}
