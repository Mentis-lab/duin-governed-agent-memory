import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { Toggle } from '@/components/ui/Toggle'
import { PanelState } from '@/components/ui/PanelState'
import {
  NumberRow,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection,
  useSavedFlash
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError, type IpcEnvelope } from '@/lib/result'
import { useSettingsStore } from '@/stores/settings-store'
import { ChannelStatusBadge } from './channels/ChannelStatusBadge'
import { ChannelCapabilities } from './channels/ChannelCapabilities'
import { ChannelSetupSteps } from './channels/ChannelSetupSteps'
import { ChannelFieldInput } from './channels/ChannelFieldInput'
import { channelState, type ChannelDefinition } from './channels/channel-types'

// Channels — the conversational half of connectivity. A channel runs a two-way turn: an
// inbound message from Telegram / Discord / Feishu goes through the pairing gate, then a
// brain turn WITHOUT the operator's exec authority, then the reply goes back out.
//
// TWO GATES, deliberately separate, and the copy has to keep them separate or the
// operator will mis-read one for the other:
//   1. ENABLE (the row's toggle) decides whether the adapter connects at all.
//   2. PAIRING decides which external user may talk to it. Deny-first: an unknown
//      user is 'pending' until explicitly approved, so enabling a channel does NOT
//      open it to whoever finds the bot.
// A channel also only comes up when it is CONFIGURED (its secret is present) — the
// gateway declines otherwise, which is why enabling an unconfigured channel is
// allowed and simply says "waiting for credentials" rather than being refused.
//
// A THIRD, separate identity lives at the bottom of the page: the designated OPERATOR
// (settings.operator) — the one (channel, user) whose reply may approve an action DUIN
// proposes while the operator is away, bounded by settings.approvalTimeoutMs. "Approved
// to chat" (pairing) is deliberately not the same thing; approving a gated action needs
// this stronger designation. Both keys are read by main (act-approval) and had no UI.

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
  list: () => Promise<IpcEnvelope<ChannelSummary[]>>
  /** Optional so an older main process degrades to summary-only rows rather than
   *  throwing — the pane still works, it just cannot describe a channel. */
  listDefinitions?: () => Promise<IpcEnvelope<ChannelDefinition[]>>
  setEnabled: (id: string, enabled: boolean) => Promise<IpcEnvelope<boolean>>
  listCredentials?: (id: string) => Promise<IpcEnvelope<ChannelCredential[]>>
  setCredential?: (
    id: string,
    keychainKey: string,
    value: string
  ) => Promise<IpcEnvelope<{ configured: boolean }>>
  pair: (id: string, externalUserId: string) => Promise<IpcEnvelope<{ status: string; code: string | null }>>
  approve: (id: string, opts: { userId?: string; code?: string }) => Promise<IpcEnvelope<{ userId: string }>>
  revoke: (id: string, externalUserId: string) => Promise<IpcEnvelope<boolean>>
  onUpdated?: (cb: () => void) => () => void
}

function channelsApi(): ChannelsApi | undefined {
  return (window as unknown as { api?: { channels?: ChannelsApi } }).api?.channels
}

/** Bind an optional preload method for query()/invoke(); `undefined` makes them report the missing handler. */
function bound<A extends unknown[], R>(
  fn: ((...args: A) => Promise<R>) | undefined,
  ...args: A
): (() => Promise<R>) | undefined {
  return fn ? () => fn(...args) : undefined
}

/**
 * The one-line state under a channel's name.
 *
 * Pure + exported because this repo's vitest env is node-only with no jsdom, so pane
 * behaviour is unit-tested through helpers rather than by rendering (the same convention
 * as LoopSettings / FoundationsSettings).
 *
 * The distinction that matters: ENABLED and RUNNING are not the same thing. An enabled
 * channel with no credentials never starts, and reporting it as "on" would be a lie the
 * operator only discovers when no message ever arrives.
 */
export function channelStatusLine(c: ChannelSummary): string {
  if (!c.enabled) {
    return c.configured
      ? t('Off — credentials are in place; turn it on to connect.')
      : t('Off — no credentials yet, so turning it on will not connect it until they are set.')
  }
  if (!c.configured) return t('On, but waiting for credentials — it cannot connect until they are set.')
  if (c.lastError) return tf('On — last attempt failed: {error}', { error: c.lastError })
  if (c.startedAt) return tf('Connected since {time}', { time: new Date(c.startedAt).toLocaleString() })
  return t('On — connecting…')
}

/** Whether the pairing controls are worth showing at all for a channel: a channel
 *  that cannot connect has nobody to pair with yet. */
export function showsPairingControls(c: ChannelSummary): boolean {
  return c.enabled && c.configured
}

/**
 * The lark-cli Feishu adapter (electron/services/channels/channel-definitions.ts, FEISHU_CLI).
 * Its definition says it is being replaced by the app-credential version; the pane renders it
 * LAST with a Legacy badge and hides it once it is off with nothing configured. Main is not
 * changed here — the row still works for the bridge that depends on it.
 */
export const LEGACY_CHANNEL_IDS: ReadonlySet<string> = new Set(['feishu'])

export function isLegacyChannel(id: string): boolean {
  return LEGACY_CHANNEL_IDS.has(id)
}

/** Hidden entirely: a legacy channel that is off and has no credentials is retired, not offered. */
export function hidesLegacyChannel(c: ChannelSummary): boolean {
  return isLegacyChannel(c.id) && !c.enabled && !c.configured
}

/** Registry order, minus retired legacy rows, with the remaining legacy rows sunk to the bottom. */
export function orderChannelsForDisplay(list: ChannelSummary[]): ChannelSummary[] {
  return list
    .filter((c) => !hidesLegacyChannel(c))
    .sort((a, b) => Number(isLegacyChannel(a.id)) - Number(isLegacyChannel(b.id)))
}

/** The setup guide opens by itself only when the operator owes the channel something: it is
 *  ON and not yet configured. Everywhere else it is a closed disclosure. */
export function setupGuideOpenByDefault(c: ChannelSummary): boolean {
  return c.enabled && !c.configured
}

type RowNotice = { text: string; tone: 'info' | 'error' }
/** How long a row notice stays up. Errors and confirmations clear on their own; a pairing
 *  code is sticky because the operator has to relay it. Any notice clears on the row's next action. */
const NOTICE_TTL_MS = 6000

const EMPTY_OPERATOR = { channelId: '', userId: '' }
const DEFAULT_APPROVAL_TIMEOUT_MIN = 5

// `secretPlaceholder` lived here and is gone: ChannelFieldInput's `fieldPlaceholder` does the
// same job for BOTH credential kinds and is the one the pane renders.

function CredentialFields({
  channelId,
  channelLabel,
  busy,
  onNotice
}: {
  channelId: string
  channelLabel: string
  busy: boolean
  onNotice: (notice: RowNotice) => void
}): React.ReactElement | null {
  const [state, setState] = useState<PanelStatus<ChannelCredential[]>>(panelLoading())
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)

  // A failed read used to return early and leave `fields` null, so the whole credential
  // section vanished under a badge saying "Needs credentials" — a dead end. Now it is a
  // panel state with a retry.
  const load = useCallback(async (): Promise<void> => {
    const r = await query('channel credentials', bound(channelsApi()?.listCredentials, channelId))
    setState(panelFromResult(r))
    // Non-secret fields are editable, so seed the box with what is stored.
    if (r.ok) {
      setDrafts(
        Object.fromEntries(r.data.filter((f) => f.kind === 'text').map((f) => [f.keychainKey, f.value ?? '']))
      )
    }
  }, [channelId])

  useEffect(() => {
    void load()
  }, [load])

  const fields = state.phase === 'ready' ? state.data : []
  // A typed-but-unsaved secret, or an edited text field, is a draft a tab switch must ask about.
  const dirty = fields.some((f) =>
    f.kind === 'secret' ? (drafts[f.keychainKey] ?? '') !== '' : (drafts[f.keychainKey] ?? '') !== (f.value ?? '')
  )
  useDirtyGuard(
    `settings:channels:${channelId}:credentials`,
    tf('the {channel} credentials', { channel: channelLabel }),
    dirty
  )

  const save = async (field: ChannelCredential, raw: string): Promise<void> => {
    setSaving(field.keychainKey)
    try {
      await invoke('save channel credential', bound(channelsApi()?.setCredential, channelId, field.keychainKey, raw))
      // A secret is write-only: clear the box rather than leave the plaintext on screen.
      if (field.kind === 'secret') setDrafts((d) => ({ ...d, [field.keychainKey]: '' }))
      onNotice({
        text: raw ? tf('{field} saved.', { field: field.label }) : tf('{field} cleared.', { field: field.label }),
        tone: 'info'
      })
      void load()
    } catch (e) {
      onNotice({ text: describeError(e, t('Could not save that value')), tone: 'error' })
    } finally {
      setSaving(null)
    }
  }

  // A channel with no credential slots has nothing to show here.
  if (state.phase === 'ready' && state.data.length === 0) return null

  return (
    <div className="mt-3 space-y-2 border-t border-[var(--panel-border)] pt-3">
      <p className="text-[12px] text-[var(--text-muted)]">
        {t('What it needs to connect.')} {t('Stored encrypted on this computer and sent only to that provider.')}
      </p>
      <PanelState
        state={state}
        loading={<SettingsLoading what={t('the credentials')} />}
        error={(message, retry) => <SettingsLoadError what={t('the credentials')} message={message} onRetry={retry} />}
        onRetry={() => void load()}
        empty={null}
      >
        {(list) => (
          <div className="space-y-2">
            {list.map((f) => {
              const draft = drafts[f.keychainKey] ?? ''
              const locked = busy || saving !== null
              return (
                <div key={f.keychainKey} className="flex items-end gap-2">
                  <ChannelFieldInput
                    field={f}
                    value={draft}
                    disabled={locked}
                    onChange={(v) => setDrafts((d) => ({ ...d, [f.keychainKey]: v }))}
                    onSubmit={() => void save(f, draft.trim())}
                  />
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={locked || !draft.trim()}
                    onClick={() => void save(f, draft.trim())}
                  >
                    {saving === f.keychainKey ? t('Saving…') : t('Save')}
                  </Button>
                  {f.hasValue && (
                    <Button size="sm" variant="danger" disabled={locked} onClick={() => void save(f, '')}>
                      {t('Clear')}
                    </Button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </PanelState>
    </div>
  )
}

function ChannelRow({
  c,
  definition,
  busy,
  notice,
  onToggle,
  onPair,
  onApprove,
  onRevoke,
  onNotice
}: {
  c: ChannelSummary
  /** What this channel IS. Absent only if a registered adapter has no definition —
   *  the drift the main-process tests already fail on, so in practice always present. */
  definition?: ChannelDefinition
  busy: boolean
  notice?: RowNotice
  /** Resolves true when the write landed — that is what earns the Saved mark. */
  onToggle: (next: boolean) => Promise<boolean>
  onPair: (userId: string) => void
  onApprove: (opts: { userId?: string; code?: string }) => void
  onRevoke: (userId: string) => void
  onNotice: (notice: RowNotice) => void
}): React.ReactElement {
  const [userId, setUserId] = useState('')
  const [code, setCode] = useState('')
  const { saved, flash } = useSavedFlash()
  const legacy = isLegacyChannel(c.id)

  return (
    <SettingsRow
      label={
        <span className="flex flex-wrap items-center gap-2">
          <span>{c.label}</span>
          {legacy && (
            <span className="rounded border border-[var(--panel-border)] px-1.5 py-0.5 font-mono text-[10px] font-normal uppercase tracking-wider text-[var(--text-muted)]">
              {t('Legacy')}
            </span>
          )}
          {/* The badge and the line below read the SAME reduced state, so they cannot
              disagree about the one distinction this pane exists to keep: enabled is
              not running. */}
          <ChannelStatusBadge state={channelState(c)} />
        </span>
      }
      hint={
        <>
          {legacy ? (
            // The definition's own description says "the version below"; this row now
            // renders last, so the renderer states the relationship the right way round.
            <span className="block">
              {t('Uses your own lark-cli login. Replaced by the Feishu / Lark (app) channel above.')}
            </span>
          ) : definition ? (
            <span className="block">{definition.description}</span>
          ) : null}
          <span className="block">{channelStatusLine(c)}</span>
        </>
      }
      saved={saved}
      control={
        <Toggle
          checked={c.enabled}
          disabled={busy}
          aria-label={tf('Enable {channel}', { channel: c.label })}
          onChange={(next) => {
            void onToggle(next).then((ok) => {
              if (ok) flash()
            })
          }}
        />
      }
    >
      {notice && (
        <p
          role={notice.tone === 'error' ? 'alert' : undefined}
          className={
            notice.tone === 'error' ? 'text-[12px] text-[var(--error)]' : 'text-[12px] text-[var(--text-secondary)]'
          }
        >
          {notice.text}
        </p>
      )}

      {definition && <ChannelCapabilities capabilities={definition.capabilities} />}

      {/* The guide is a disclosure so eight expanded guides no longer make a four-screen
          page. It opens by itself only while the channel is on and still needs its
          credentials — the moment the operator needs to know where the token comes from. */}
      {definition && (
        <details className="mt-3" open={setupGuideOpenByDefault(c)}>
          <summary className="cursor-pointer text-[12px] text-[var(--text-secondary)]">{t('Setup guide')}</summary>
          <ChannelSetupSteps definition={definition} />
        </details>
      )}

      <CredentialFields channelId={c.id} channelLabel={c.label} busy={busy} onNotice={onNotice} />

      {showsPairingControls(c) && (
        <div className="mt-3 space-y-2 border-t border-[var(--panel-border)] pt-3">
          <p className="text-[12px] text-[var(--text-muted)]">
            {t('Who may talk to it. Nobody is trusted by default: start pairing for a user id to get a one-time code, or approve them directly.')}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('External user id')}
              placeholder={t('their user id on this channel')}
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className="max-w-xs"
            />
            <Button size="sm" disabled={busy || !userId.trim()} onClick={() => onPair(userId.trim())}>
              {t('Start pairing')}
            </Button>
            <Button size="sm" disabled={busy || !userId.trim()} onClick={() => onApprove({ userId: userId.trim() })}>
              {t('Approve')}
            </Button>
            <Button size="sm" variant="danger" disabled={busy || !userId.trim()} onClick={() => onRevoke(userId.trim())}>
              {t('Revoke')}
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label={t('Pairing code')}
              placeholder={t('pairing code')}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="max-w-xs"
            />
            <Button size="sm" disabled={busy || !code.trim()} onClick={() => onApprove({ code: code.trim() })}>
              {t('Approve by code')}
            </Button>
          </div>
        </div>
      )}
    </SettingsRow>
  )
}

/** The designated operator — settings.operator — as a channel Select and a user-id draft. */
function ApprovalOperatorRow({ channels }: { channels: ChannelSummary[] }): React.ReactElement {
  const operator = useSettingsStore((s) => s.settings.operator ?? EMPTY_OPERATOR)
  const updateSettings = useSettingsStore((s) => s.updateSettings)
  const [userDraft, setUserDraft] = useState(operator.userId)
  const [focused, setFocused] = useState(false)
  const { saved, flash } = useSavedFlash()

  // Follow the stored value while the operator is not typing.
  useEffect(() => {
    if (!focused) setUserDraft(operator.userId)
  }, [operator.userId, focused])

  const write = (next: { channelId: string; userId: string }): void => {
    void updateSettings({ operator: next }).then((ok) => {
      if (ok) flash()
    })
  }
  const commitUser = (): void => {
    const next = userDraft.trim()
    if (next === operator.userId) return
    write({ channelId: operator.channelId, userId: next })
  }
  const known = channels.some((c) => c.id === operator.channelId)

  return (
    <SettingsRow
      label={t('Who may approve')}
      hint={t('The channel DUIN listens on, and the user id of that person there.')}
      saved={saved}
      control={
        <Select
          aria-label={t('Approval channel')}
          value={operator.channelId}
          onChange={(e) => write({ channelId: e.target.value, userId: operator.userId })}
        >
          <option value="">{t('Not set')}</option>
          {channels.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
          {/* A stored id the list does not carry (a hidden legacy row, a removed adapter)
              still shows as itself rather than snapping to "Not set". */}
          {operator.channelId && !known && <option value={operator.channelId}>{operator.channelId}</option>}
        </Select>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="channels-approval-user-id" className="text-[12px] text-[var(--text-secondary)]">
          {t('User id')}
        </label>
        <Input
          id="channels-approval-user-id"
          value={userDraft}
          placeholder={t('their id on that channel')}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false)
            commitUser()
          }}
          onChange={(e) => setUserDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commitUser()
            } else if (e.key === 'Escape') {
              setUserDraft(operator.userId)
            }
          }}
          className="max-w-xs font-mono"
        />
        {userDraft.trim() !== operator.userId && (
          <span className="text-[10px] text-[var(--text-muted)]">{t('Saves when you leave the box')}</span>
        )}
      </div>
    </SettingsRow>
  )
}

export function ChannelsSettings(): React.ReactElement | null {
  const [channels, setChannels] = useState<PanelStatus<ChannelSummary[]>>(panelLoading())
  const [definitions, setDefinitions] = useState<Map<string, ChannelDefinition>>(new Map())
  const [busy, setBusy] = useState<string | null>(null)
  const [notices, setNotices] = useState<Record<string, RowNotice>>({})
  const noticeTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const approvalTimeoutMs = useSettingsStore((s) => s.settings.approvalTimeoutMs)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const load = useCallback(async (): Promise<void> => {
    const r = await query('channels', bound(channelsApi()?.list))
    setChannels(panelFromResult(r))
  }, [])

  // Definitions are static for the life of the process — what a channel IS does not
  // change while the app runs, only how it is doing. So they load ONCE, separately from
  // the summary refresh that fires on every enable/error/start. A failure here is not
  // fatal and deliberately does not fail the pane: the rows still work from summaries
  // alone, just without the description and setup guide, and blocking the whole pane
  // over missing help text would be the worse trade.
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
    void load()
    // channels-store broadcasts 'channels:updated' on every state change (enable, error,
    // started), so a channel that comes up or fails on its own refreshes this pane
    // without a poll.
    return channelsApi()?.onUpdated?.(() => void load())
  }, [load])

  const clearNotice = useCallback((id: string): void => {
    const timer = noticeTimers.current[id]
    if (timer) {
      clearTimeout(timer)
      delete noticeTimers.current[id]
    }
    setNotices((prev) => {
      if (!(id in prev)) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  // A notice clears on the row's next action and — unless sticky — after NOTICE_TTL_MS.
  // `notices[id]` used to be written and never cleared, so "Approved x." sat under a row
  // for the rest of the session.
  const setNotice = useCallback(
    (id: string, notice: RowNotice, sticky = false): void => {
      const timer = noticeTimers.current[id]
      if (timer) clearTimeout(timer)
      setNotices((prev) => ({ ...prev, [id]: notice }))
      if (!sticky) noticeTimers.current[id] = setTimeout(() => clearNotice(id), NOTICE_TTL_MS)
    },
    [clearNotice]
  )

  useEffect(() => {
    const timers = noticeTimers.current
    return () => {
      for (const timer of Object.values(timers)) clearTimeout(timer)
    }
  }, [])

  if (!channelsApi()) return null // desktop-only surface

  /** Run one write for a row: busy while it runs, its failure shown ON THE ROW (not in a
   *  pane-level slot the operator has to hunt for), and the list refreshed after. */
  const act = async <T,>(
    id: string,
    label: string,
    call: (() => Promise<IpcEnvelope<T>>) | undefined,
    onOk?: (data: T) => { text: string; sticky?: boolean } | undefined
  ): Promise<boolean> => {
    setBusy(id)
    clearNotice(id)
    try {
      const data = await invoke(label, call)
      const next = onOk?.(data)
      if (next) setNotice(id, { text: next.text, tone: 'info' }, next.sticky)
      return true
    } catch (e) {
      setNotice(id, { text: describeError(e, t('That did not work')), tone: 'error' })
      return false
    } finally {
      setBusy(null)
      void load()
    }
  }

  const visible = channels.phase === 'ready' ? orderChannelsForDisplay(channels.data) : []
  const timeoutMinutes = Math.max(
    1,
    Math.round((approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MIN * 60_000) / 60_000)
  )

  return (
    <SettingsPage
      purpose={t('Chat with DUIN from Telegram, Discord, Slack, Feishu, WeCom, DingTalk or email. A message from a channel can read and answer but cannot run commands as you. Nobody is admitted until you pair them.')}
    >
      <SettingsSection label={t('Channels')}>
        <PanelState
          state={channels}
          loading={<SettingsLoading what={t('channels')} />}
          error={(message, retry) => <SettingsLoadError what={t('channels')} message={message} onRetry={retry} />}
          onRetry={() => void load()}
          isEmpty={(list) => orderChannelsForDisplay(list).length === 0}
          empty={<p className="text-[12px] text-[var(--text-muted)]">{t('No channels are registered in this build.')}</p>}
        >
          {(list) =>
            orderChannelsForDisplay(list).map((c) => (
              <ChannelRow
                key={c.id}
                c={c}
                definition={definitions.get(c.id)}
                busy={busy === c.id}
                notice={notices[c.id]}
                onToggle={(next) => act(c.id, 'switch channel', bound(channelsApi()?.setEnabled, c.id, next))}
                onPair={(userId) =>
                  void act(c.id, 'start pairing', bound(channelsApi()?.pair, c.id, userId), (d) => ({
                    text: d.code
                      ? tf('Pairing code for {user}: {code} — give it to them, or approve by code below.', {
                          user: userId,
                          code: d.code
                        })
                      : tf('{user} is {status}.', { user: userId, status: d.status }),
                    // The operator has to relay the code, so it must not vanish mid-copy.
                    sticky: Boolean(d.code)
                  }))
                }
                onApprove={(opts) =>
                  void act(c.id, 'approve pairing', bound(channelsApi()?.approve, c.id, opts), (d) => ({
                    text: tf('Approved {user}.', { user: d?.userId ?? '' })
                  }))
                }
                onRevoke={(userId) =>
                  void act(c.id, 'revoke pairing', bound(channelsApi()?.revoke, c.id, userId), () => ({
                    text: t('Revoked.')
                  }))
                }
                onNotice={(n) => setNotice(c.id, n)}
              />
            ))
          }
        </PanelState>
      </SettingsSection>

      <SettingsSection
        label={t('Approvals from a channel')}
        description={t('Only this person may approve an action DUIN proposes while you are away; after the timeout the action is declined.')}
      >
        <ApprovalOperatorRow channels={visible} />
        <NumberRow
          label={t('Approval timeout')}
          hint={t('How long DUIN waits for an answer before it declines the action.')}
          value={timeoutMinutes}
          spec={{ min: 1, max: 1440, integer: true }}
          defaultValue={DEFAULT_APPROVAL_TIMEOUT_MIN}
          unit={t('minutes')}
          onCommit={(minutes) => updateSettings({ approvalTimeoutMs: minutes * 60_000 })}
        />
      </SettingsSection>
    </SettingsPage>
  )
}
