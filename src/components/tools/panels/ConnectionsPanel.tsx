import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { PanelEmptyState } from '@/components/ui/PanelEmptyState'
import { Toggle } from '@/components/ui/Toggle'

// Connections — the INGEST side of integrations. Each source (Slack, Gmail,
// Google Calendar, Notion, Feishu, RSS) can be enabled to periodically pull its
// content into the brain (searchable + graphed + foresight-visible). Reach (the
// agent calling these as tools) is configured under Customize → Connectors; this
// is the "feed my brain" surface.
//
// Every source is now self-serve connectable IN THIS PANEL. Previously only Slack
// had an inline flow and the others printed a dead "set up under Customize →
// Connectors" hint pointing nowhere — so their enable toggle sat permanently
// disabled and the whole surface read as broken. Now: token-paste sources (Slack,
// Notion) get a token field, Google (Gmail+Calendar) gets a one-click OAuth flow,
// RSS gets a feed-URL editor, and CLI sources (Feishu) state exactly
// what external step they need with a re-check button.

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
  list?: () => Promise<{ success: boolean; data?: Connection[] }>
  sync?: (id: string) => Promise<{ success: boolean; data?: { ok: boolean; count: number; error?: string } }>
  setEnabled?: (id: string, enabled: boolean) => Promise<{ success: boolean }>
  setSlackToken?: (token: string) => Promise<{ success: boolean; error?: string }>
  setNotionToken?: (token: string) => Promise<{ success: boolean; error?: string }>
  getRssFeeds?: () => Promise<{ success: boolean; data?: string[] }>
  setRssFeeds?: (feeds: string[]) => Promise<{ success: boolean; error?: string }>
  saveGoogleCreds?: (clientId: string, clientSecret: string) => Promise<{ success: boolean; error?: string }>
  connectGoogle?: () => Promise<{ success: boolean; error?: string }>
  onUpdated?: (cb: () => void) => () => void
}
function connApi(): ConnApi | undefined {
  return (window as unknown as { api?: { connections?: ConnApi } }).api?.connections
}

function ago(ms: number | null): string {
  if (!ms) return 'never'
  const s = Math.floor((Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

// Which connect mechanism each source uses. Drives the inline setup UI below.
type ConnectKind = 'slack-token' | 'notion-token' | 'google-oauth' | 'rss-feeds' | 'feishu-cli'
function connectKind(id: string): ConnectKind {
  const k = id.toLowerCase()
  if (k === 'slack') return 'slack-token'
  if (k === 'notion') return 'notion-token'
  // Gmail / Drive / Calendar share ONE Google grant — the 'google-oauth' branch
  // routes them all to the shared "Connect Google" card in Customize → Connectors.
  if (/gmail|calendar|gcal|drive|google/.test(k)) return 'google-oauth'
  if (k === 'rss') return 'rss-feeds'
  // Feishu/Lark is auto-detected once lark-cli is signed in — its own kind, never
  // mislabelled as a Google connect (the pre-connectKind copy hardcoded that hint).
  if (/feishu|lark/.test(k)) return 'feishu-cli'
  return 'rss-feeds' // safe default: a URL/value editor is the least-magic fallback
}

const inputCls =
  'flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-1.5 py-0.5 text-[11px]'

export function ConnectionsPanel(): React.ReactElement {
  const [conns, setConns] = useState<Connection[] | null>(null)
  const [listError, setListError] = useState<string | null>(null) // F8: real load failure ≠ empty
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<Record<string, string>>({})
  // token-paste drafts (per source id)
  const [tokens, setTokens] = useState<Record<string, string>>({})
  // Google client-creds sub-flow (revealed only when OAuth reports creds missing)
  const [showGoogleCreds, setShowGoogleCreds] = useState(false)
  const [gClientId, setGClientId] = useState('')
  const [gClientSecret, setGClientSecret] = useState('')
  // RSS feed editor (newline-separated URLs), loaded from the persisted list
  const [rssText, setRssText] = useState('')

  const load = async (): Promise<void> => {
    try {
      const r = await connApi()?.list?.()
      if (r?.success) {
        setConns(r.data ?? [])
        setListError(null)
      } else {
        // F8: a failed list mapped to [] rendered "No connections yet" on a healthy
        // backend — a false empty. Keep the distinction.
        setConns([])
        setListError((r as { error?: string })?.error ?? 'the connections service did not answer')
      }
    } catch (e) {
      setConns([])
      setListError(e instanceof Error ? e.message : 'could not reach the connections service')
    }
  }
  useEffect(() => {
    void load()
    // prefill the RSS editor from the persisted feed list
    void connApi()
      ?.getRssFeeds?.()
      .then((r) => {
        if (r?.success && Array.isArray(r.data)) setRssText(r.data.join('\n'))
      })
      .catch(() => {})
    const off = connApi()?.onUpdated?.(() => void load())
    return () => off?.()
  }, [])

  const setErrFor = (id: string, msg: string | null): void =>
    setErr((e) => {
      const next = { ...e }
      if (msg) next[id] = msg
      else delete next[id]
      return next
    })

  const toggle = async (c: Connection): Promise<void> => {
    await connApi()?.setEnabled?.(c.id, !c.enabled)
    void load()
  }
  const syncNow = async (id: string): Promise<void> => {
    setBusy(id)
    try {
      await connApi()?.sync?.(id)
    } finally {
      setBusy(null)
      void load()
    }
  }

  // Token-paste connect (Slack / Notion): store the secret, then enable (which
  // kicks the first sync). Connect + enable in one action.
  const connectToken = async (id: string): Promise<void> => {
    const t = (tokens[id] ?? '').trim()
    if (!t) return
    setBusy(id)
    setErrFor(id, null)
    try {
      const save = id === 'slack' ? connApi()?.setSlackToken : connApi()?.setNotionToken
      const r = await save?.(t)
      if (r?.success) {
        setTokens((m) => ({ ...m, [id]: '' }))
        await connApi()?.setEnabled?.(id, true)
      } else {
        setErrFor(id, r?.error ?? 'Could not save the token')
      }
    } finally {
      setBusy(null)
      void load()
    }
  }

  // Google OAuth connect (Gmail + Calendar share one grant). Try the browser
  // consent flow directly; if the OAuth app creds aren't stored yet, reveal the
  // client-id/secret fields so the user can supply them and retry — no detour
  // through the MCP connectors screen.
  const connectGoogle = async (): Promise<void> => {
    setBusy('google')
    setErrFor('google', null)
    try {
      const r = await connApi()?.connectGoogle?.()
      if (r?.success) {
        setShowGoogleCreds(false)
      } else {
        const msg = r?.error ?? 'Google connection failed'
        if (/credentials not configured/i.test(msg)) {
          setShowGoogleCreds(true)
          setErrFor('google', 'Enter your Google OAuth client ID + secret to continue.')
        } else {
          setErrFor('google', msg)
        }
      }
    } finally {
      setBusy(null)
      void load()
    }
  }
  const saveGoogleCredsAndConnect = async (): Promise<void> => {
    const id = gClientId.trim()
    const secret = gClientSecret.trim()
    if (!id || !secret) return
    setBusy('google')
    setErrFor('google', null)
    try {
      const s = await connApi()?.saveGoogleCreds?.(id, secret)
      if (!s?.success) {
        setErrFor('google', s?.error ?? 'Could not save the client credentials')
        return
      }
      await connectGoogle()
    } finally {
      setBusy(null)
    }
  }

  // RSS connect: persist the newline-separated feed URLs; a non-empty list makes
  // the source configured, then enable it.
  const saveRssFeeds = async (): Promise<void> => {
    const feeds = rssText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    setBusy('rss')
    setErrFor('rss', null)
    try {
      const r = await connApi()?.setRssFeeds?.(feeds)
      if (r?.success) {
        if (feeds.length) await connApi()?.setEnabled?.('rss', true)
      } else {
        setErrFor('rss', r?.error ?? 'Could not save the feeds')
      }
    } finally {
      setBusy(null)
      void load()
    }
  }

  const tokenField = (id: string, placeholder: string): React.ReactElement => (
    <div className="mt-1.5 flex items-center gap-1.5">
      <input
        type="password"
        value={tokens[id] ?? ''}
        onChange={(e) => setTokens((m) => ({ ...m, [id]: e.target.value }))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void connectToken(id)
        }}
        placeholder={placeholder}
        className={inputCls}
      />
      <Button variant="secondary" onClick={() => void connectToken(id)} disabled={busy === id || !(tokens[id] ?? '').trim()}>
        {busy === id ? 'Connecting…' : 'Connect'}
      </Button>
    </div>
  )

  const renderConnect = (c: Connection): React.ReactElement => {
    const kind = connectKind(c.id)
    switch (kind) {
      case 'slack-token':
        return (
          <>
            {tokenField(c.id, 'Slack token (xoxb-… / xoxp-…)')}
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
              Create a Slack app → OAuth &amp; Permissions → Bot token. Needs channels:history + channels:read scopes.
            </p>
          </>
        )
      case 'notion-token':
        return (
          <>
            {tokenField(c.id, 'Notion integration token (secret_… / ntn_…)')}
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">
              notion.so/my-integrations → New internal integration → copy the secret, then share the pages you want ingested with it.
            </p>
          </>
        )
      case 'google-oauth':
        return (
          <div className="mt-1.5 space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Button variant="secondary" onClick={() => void connectGoogle()} disabled={busy === 'google'}>
                {busy === 'google' ? 'Connecting…' : 'Connect Google'}
              </Button>
              <span className="text-[10.5px] text-[var(--text-muted)]">Opens a browser consent screen · enables Gmail + Calendar.</span>
            </div>
            {showGoogleCreds && (
              <div className="space-y-1.5 rounded border border-[var(--panel-border)] p-1.5">
                <p className="text-[10.5px] text-[var(--text-muted)]">
                  Paste your Google OAuth desktop-app credentials (Google Cloud Console → APIs &amp; Services → Credentials).
                </p>
                <input
                  type="text"
                  value={gClientId}
                  onChange={(e) => setGClientId(e.target.value)}
                  placeholder="client_id (…apps.googleusercontent.com)"
                  className={`${inputCls} w-full`}
                />
                <input
                  type="password"
                  value={gClientSecret}
                  onChange={(e) => setGClientSecret(e.target.value)}
                  placeholder="client_secret"
                  className={`${inputCls} w-full`}
                />
                <Button
                  variant="secondary"
                  onClick={() => void saveGoogleCredsAndConnect()}
                  disabled={busy === 'google' || !gClientId.trim() || !gClientSecret.trim()}
                >
                  {busy === 'google' ? 'Connecting…' : 'Save & connect'}
                </Button>
              </div>
            )}
          </div>
        )
      case 'rss-feeds':
        return (
          <div className="mt-1.5 space-y-1.5">
            <textarea
              value={rssText}
              onChange={(e) => setRssText(e.target.value)}
              placeholder={'One feed URL per line\nhttps://example.com/feed.xml'}
              rows={3}
              className={`${inputCls} w-full resize-y font-mono`}
            />
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={() => void saveRssFeeds()} disabled={busy === 'rss'}>
                {busy === 'rss' ? 'Saving…' : 'Save feeds'}
              </Button>
              <span className="text-[10.5px] text-[var(--text-muted)]">{t('No account needed — any RSS/Atom URL.')}</span>
            </div>
          </div>
        )
      case 'feishu-cli':
        return (
          <div className="mt-1 space-y-1">
            <p className="text-[11px] text-[var(--text-secondary)]">
              Feishu/Lark ingest runs through the Lark CLI. Install it (npm i -g lark-cli) and sign in once; DUIN auto-detects it.
            </p>
            <Button variant="secondary" onClick={() => void syncNow(c.id)} disabled={busy === c.id}>
              {busy === c.id ? 'Checking…' : 'Re-check'}
            </Button>
          </div>
        )
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden p-3 text-[12px]">
      <div className="mb-2 flex items-center gap-2">
        <span className="font-semibold text-[var(--text-primary)]">{t('Connections')}</span>
        <button onClick={() => void load()} className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]">
          refresh
        </button>
      </div>
      <p className="mb-2 text-[11px] text-[var(--text-muted)]">
        Feed your brain from Slack, Gmail, Calendar, Notion, Feishu, and RSS. Connect a source below to enable it — synced
        content joins your knowledge graph + foresight. Stays on your machine.
      </p>
      <div className="flex-1 space-y-2 overflow-y-auto">
        {conns === null && <div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}
        {conns !== null && listError !== null && (
          <div className="text-[12px] text-[var(--warning)]">
            Couldn’t load your connections — {listError}. This is a read error, not an empty list.
          </div>
        )}
        {conns !== null && listError === null && conns.length === 0 && (
          <PanelEmptyState
            icon={<span className="text-[20px]">🔌</span>}
            title={t('No sources available')}
            body="Connect Slack, Gmail, Notion, or an RSS feed to feed your brain."
          />
        )}
        {conns?.map((c) => (
          <div key={c.id} className="rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] p-2.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-[var(--text-primary)]">{c.label}</span>
              {!c.configured && (
                <span className="rounded bg-[var(--text-muted)]/15 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                  not connected
                </span>
              )}
              {c.configured && c.enabled && (
                <span className="rounded bg-[var(--accent)]/15 px-1.5 py-0.5 text-[11px] font-medium text-[var(--accent)]">
                  on
                </span>
              )}
              {c.configured && !c.enabled && (
                <span className="rounded bg-[var(--text-muted)]/15 px-1.5 py-0.5 text-[11px] text-[var(--text-muted)]">
                  paused
                </span>
              )}
              <label className="ml-auto flex items-center gap-1 text-[11px] text-[var(--text-muted)]">
                <Toggle
                  checked={c.enabled}
                  disabled={!c.configured}
                  onChange={() => void toggle(c)}
                  aria-label={t('Enable connection')}
                />
                enable
              </label>
            </div>
            {/* Setup (when not yet connected) OR sync status (when connected). */}
            {!c.configured ? renderConnect(c) : (
              <div className="mt-1.5 flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
                <span>synced {ago(c.lastSyncMs)}</span>
                {c.lastCount != null && <span>· {c.lastCount} items</span>}
                {c.lastError && <span className="text-[var(--error)]">· {c.lastError}</span>}
                <Button variant="secondary" className="ml-auto" onClick={() => void syncNow(c.id)} disabled={busy === c.id}>
                  {busy === c.id ? 'Syncing…' : 'Sync now'}
                </Button>
              </div>
            )}
            {err[c.id === 'gmail' || c.id === 'gcal' ? 'google' : c.id] && (
              <p className="mt-1 text-[10.5px] text-[var(--error)]">
                {err[c.id === 'gmail' || c.id === 'gcal' ? 'google' : c.id]}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
