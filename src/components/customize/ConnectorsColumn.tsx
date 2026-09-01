import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/Button'
import type { McpServerConfig, McpResource, McpResourceContent } from '@/lib/types'
import { useMcpStore } from '@/stores/mcp-store'
import { Toggle } from '@/components/ui/Toggle'
import { transportLabel } from '@/lib/mcp-transport'
import { toast } from '@/stores/toast-store'
import { ensurePlaintextConsentIfNeeded } from '@/lib/keychain-consent'
import {
  classifyMcpResourceContent,
  canOpenMcpResourceExternally
} from '@/lib/mcp-resource-preview'
import { AddConnectorFlow } from './AddConnectorFlow'

type ServerWithStatus = McpServerConfig & { error?: string }

/**
 * One line an operator can act on.
 *
 * 'Unavailable' is deliberately not styled as an error. An error is "this broke" and
 * invites a retry; unavailable is "this was never installable here" and invites an
 * install. They ask for different actions, so they must not look the same — and the
 * sub-line carries the requirement's own hint, which is the only place that says how
 * to get the missing thing.
 *
 * Exported for test: this repo's vitest env is node-only, so pane behaviour is
 * verified through pure helpers rather than a jsdom render (see ChannelsSettings).
 */
export function statusBadge(server: ServerWithStatus): {
  dotClass: string
  label: string
  sub?: string
} {
  switch (server.status) {
    case 'connected':
      return { dotClass: 'bg-[var(--success)]', label: 'Connected' }
    case 'connecting':
      return { dotClass: 'bg-[var(--warning)] animate-pulse', label: 'Connecting' }
    case 'unavailable':
      return {
        dotClass: 'bg-[var(--text-muted)] ring-1 ring-[var(--warning)]',
        label: 'Unavailable',
        sub: describeMissingRequirements(server) ?? server.error
      }
    case 'error':
      return { dotClass: 'bg-[var(--error)]', label: 'Error', sub: server.error }
    default: {
      // A DISCONNECTED row whose requirements are already known to be unmet should
      // say so now rather than after the operator enables it and waits. The probe
      // result rides along on the listing, so this costs nothing.
      const missing = describeMissingRequirements(server)
      return missing
        ? { dotClass: 'bg-[var(--text-muted)]', label: 'Needs setup', sub: missing }
        : { dotClass: 'bg-[var(--text-muted)]', label: 'Disconnected' }
    }
  }
}

/** "npx — Install Node.js (nodejs.org)…; GITHUB_TOKEN — Create a token…" */
export function describeMissingRequirements(server: ServerWithStatus): string | undefined {
  const missing = server.missing
  if (!missing || missing.length === 0) return undefined
  return missing.map((m) => (m.detail ? `${m.label} — ${m.detail}` : m.label)).join('; ')
}

function authBadge(auth: McpServerConfig['auth']): string | null {
  if (auth === 'google-oauth') return 'google-oauth'
  if (auth === 'oauth') return 'oauth'
  return null
}

// ── Part B — first-class Google connect ────────────────────────────────────
// Rendered ALWAYS, independent of any google-oauth MCP server row. The boot
// purge deletes the placeholder google-oauth catalog server, so gating this
// card on such a row (the old `needsGoogleOAuth` check) left Google reach
// permanently unreachable. Connect calls window.api.mcp.setupGoogleOAuth()
// directly; connected-state comes from the read-only mcp:googleAuthStatus probe.

interface GoogleAuthStatus {
  connected: boolean
  expired: boolean
  expiresAt: number | null
}

function GoogleConnectCard() {
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [saving, setSaving] = useState(false)
  const [oauthBusy, setOauthBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [auth, setAuth] = useState<GoogleAuthStatus | null>(null)
  const [showCreds, setShowCreds] = useState(false)

  const refreshAuth = async (): Promise<void> => {
    try {
      const r = await window.api.mcp.googleAuthStatus()
      if (r.success && r.data) setAuth(r.data)
    } catch {
      // read-only probe; ignore transient failures
    }
  }

  useEffect(() => {
    void refreshAuth()
  }, [])

  const onSaveCreds = async (): Promise<void> => {
    if (!clientId.trim() || !clientSecret.trim()) return
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) return
    setSaving(true)
    try {
      const result = await window.api.settings.saveGoogleCredentials(
        clientId.trim(),
        clientSecret.trim()
      )
      if (result.success) {
        toast.success('Google credentials saved')
        setStatus('Credentials saved. Click Connect Google to authorize.')
      } else {
        toast.error(`Failed to save credentials: ${result.error}`)
      }
    } finally {
      setSaving(false)
    }
  }

  const onAuthorize = async (): Promise<void> => {
    const consent = await ensurePlaintextConsentIfNeeded()
    if (!consent) {
      toast.error('Google connect cancelled: plaintext storage not authorised.')
      return
    }
    setOauthBusy(true)
    setStatus(null)
    try {
      const result = await window.api.mcp.setupGoogleOAuth()
      if (result.success) {
        setStatus('Connected.')
        toast.success('Google account connected')
        await refreshAuth()
      } else {
        setStatus(`Error: ${result.error}`)
        toast.error(`Google OAuth failed: ${result.error}`)
      }
    } catch (err) {
      setStatus('OAuth flow failed')
      toast.error(`OAuth flow failed: ${(err as Error).message ?? 'unknown error'}`)
    } finally {
      setOauthBusy(false)
    }
  }

  const connectedLabel = auth?.connected
    ? auth.expired
      ? 'Connected — token expired, reconnect to refresh'
      : 'Connected'
    : 'Not connected'
  const dotClass = auth?.connected
    ? auth.expired
      ? 'bg-[var(--warning)]'
      : 'bg-[var(--success)]'
    : 'bg-[var(--text-muted)]'

  return (
    <div className="space-y-2 border-t border-[var(--panel-border)] bg-[var(--bg-tertiary)]/30 px-3 py-3">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`} />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
          {t('Google')}
        </span>
        <span className="text-[11px] text-[var(--text-secondary)]">
          Gmail · Drive · Calendar (shared grant)
        </span>
        <button
          onClick={() => setShowCreds((v) => !v)}
          className="ml-auto text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
        >
          {showCreds ? 'hide credentials' : 'credentials'}
        </button>
      </div>
      <div className="text-[11px] text-[var(--text-secondary)]">{connectedLabel}</div>

      {showCreds && (
        <div className="space-y-2">
          <input
            type="password"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="client_id"
            className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder="client_secret"
            className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 font-mono text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            onClick={() => void onSaveCreds()}
            disabled={saving || !clientId.trim() || !clientSecret.trim()}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] hover:border-[var(--accent)] disabled:opacity-50"
          >
            {t('Save credentials')}
          </button>
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          className="border-[var(--accent)]"
          onClick={() => void onAuthorize()}
          disabled={oauthBusy}
        >
          {oauthBusy ? 'Waiting…' : auth?.connected ? 'Reconnect Google' : 'Connect Google'}
        </Button>
      </div>
      {status && (
        <p
          className={`text-[11px] ${
            status.startsWith('Error') ? 'text-[var(--error)]' : 'text-[var(--text-secondary)]'
          }`}
        >
          {status}
        </p>
      )}
    </div>
  )
}

// ── MR — resource preview modal ────────────────────────────────────────────
// Reads one exact resource URI, then renders it through the SAFE preview policy
// (text as escaped React text, raster-only inline images, everything else
// metadata-only). External open is gated on credential-free HTTP(S) + a
// native hostname-consent dialog in the main process.

interface ResourcePreviewProps {
  serverId: string
  resource: McpResource
  onClose: () => void
}

function ResourcePreview({ serverId, resource, onClose }: ResourcePreviewProps) {
  const [contents, setContents] = useState<McpResourceContent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoading(true)
      setError(null)
      try {
        const r = await window.api.mcp.readResource(serverId, resource.uri)
        if (cancelled) return
        if (r.success && r.data) setContents(r.data)
        else setError(r.error ?? 'Failed to read resource')
      } catch (err) {
        if (!cancelled) setError((err as Error).message ?? 'Failed to read resource')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [serverId, resource.uri])

  const openExternal = async (): Promise<void> => {
    const r = await window.api.mcp.openResource(serverId, resource.uri)
    if (!r.success && r.error) toast.error(r.error)
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--app-bg)] shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-2 border-b border-[var(--panel-border)] px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-[13px] font-medium text-[var(--text-primary)]">
              {resource.title || resource.name || resource.uri}
            </div>
            <div className="truncate font-mono text-[11px] text-[var(--text-muted)]">
              {resource.uri}
            </div>
          </div>
          {canOpenMcpResourceExternally(resource.uri) && (
            <button
              onClick={() => void openExternal()}
              className="shrink-0 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
            >
              {t('Open externally')}
            </button>
          )}
          <button
            onClick={onClose}
            className="shrink-0 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
          >
            {t('Close')}
          </button>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {loading && <div className="text-[12px] text-[var(--text-muted)]">Loading…</div>}
          {error && <div className="text-[12px] text-[var(--error)]">{error}</div>}
          {contents?.map((content, i) => {
            const item = classifyMcpResourceContent(content)
            if (item.kind === 'text') {
              return (
                <pre
                  key={i}
                  className="mb-2 whitespace-pre-wrap break-words rounded bg-[var(--bg-tertiary)] p-2 font-mono text-[11px] text-[var(--text-primary)]"
                >
                  {item.text}
                </pre>
              )
            }
            if (item.kind === 'image') {
              return (
                <img
                  key={i}
                  src={item.dataUrl}
                  alt={resource.name || resource.uri}
                  className="mb-2 max-h-[50vh] max-w-full rounded border border-[var(--panel-border)]"
                />
              )
            }
            return (
              <div
                key={i}
                className="mb-2 rounded border border-[var(--panel-border)] bg-[var(--bg-tertiary)] p-2 text-[11px] text-[var(--text-secondary)]"
              >
                <div className="font-mono">{item.mimeType}</div>
                {item.byteEstimate != null && <div>~{item.byteEstimate} bytes (binary, not previewed)</div>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── MR — per-server Resources expander ─────────────────────────────────────
function ResourcesExpander({ serverId }: { serverId: string }) {
  const [open, setOpen] = useState(false)
  const slice = useMcpStore((s) => s.resourceSlices[serverId])
  const loadResources = useMcpStore((s) => s.loadResources)
  const [preview, setPreview] = useState<McpResource | null>(null)

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next && !slice?.loaded && !slice?.loading) void loadResources(serverId)
  }

  return (
    <div className="mt-1">
      <button
        onClick={toggle}
        className="text-[11px] text-[var(--text-muted)] hover:text-[var(--text-primary)]"
      >
        {open ? '▾' : '▸'} Resources
        {slice?.loaded ? ` (${slice.resources.length})` : ''}
      </button>
      {open && (
        <div className="mt-1 space-y-1 pl-3">
          {slice?.loading && <div className="text-[11px] text-[var(--text-muted)]">Loading…</div>}
          {slice?.error && <div className="text-[11px] text-[var(--error)]">{slice.error}</div>}
          {slice?.loaded && !slice.error && slice.resources.length === 0 && (
            <div className="text-[11px] text-[var(--text-muted)]">{t('No resources exposed.')}</div>
          )}
          {slice?.resources.map((r) => (
            <button
              key={r.uri}
              onClick={() => setPreview(r)}
              className="block w-full truncate rounded border border-transparent px-1 py-0.5 text-left text-[11px] text-[var(--text-secondary)] hover:border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
              title={r.uri}
            >
              {r.title || r.name || r.uri}
            </button>
          ))}
          {slice?.templates && slice.templates.length > 0 && (
            <div className="pt-1 text-[11px] text-[var(--text-muted)]">
              {slice.templates.length} template{slice.templates.length === 1 ? '' : 's'}
            </div>
          )}
        </div>
      )}
      {preview && (
        <ResourcePreview serverId={serverId} resource={preview} onClose={() => setPreview(null)} />
      )}
    </div>
  )
}

export function ConnectorsColumn() {
  const servers = useMcpStore((s) => s.servers)
  const loadServers = useMcpStore((s) => s.loadServers)
  const reconnect = useMcpStore((s) => s.reconnect)
  const setEnabled = useMcpStore((s) => s.setEnabled)
  const removeServer = useMcpStore((s) => s.removeServer)
  const [filter, setFilter] = useState('')
  const [addOpen, setAddOpen] = useState(false)

  const onRemove = async (server: McpServerConfig) => {
    if (!confirm(`Remove the "${server.name}" connector?`)) return
    await removeServer(server.id)
  }

  useEffect(() => {
    void loadServers()
  }, [loadServers])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return servers
    return servers.filter(
      (s) => s.name.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)
    )
  }, [servers, filter])

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex shrink-0 items-center gap-2 border-b border-[var(--panel-border)] px-3 py-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={`Filter ${servers.length} connector${servers.length === 1 ? '' : 's'}…`}
          className="min-w-0 flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
        <button
          onClick={() => setAddOpen(true)}
          className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[12px] hover:border-[var(--accent)]"
          title={t('Add a connector')}
        >
          + Add
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-2">
        {filtered.length === 0 && (
          <div className="px-3 py-6 text-center text-[12px] text-[var(--text-muted)]">
            {servers.length === 0
              ? 'No connectors configured yet.'
              : 'No connectors match this filter.'}
          </div>
        )}
        {filtered.map((server) => {
          const badge = statusBadge(server)
          const auth = authBadge(server.auth)
          return (
            <div
              key={server.id}
              className="group mb-1 flex items-start gap-2 rounded border border-transparent p-2 hover:border-[var(--panel-border)] hover:bg-[var(--bg-tertiary)]"
            >
              <span className={`mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full ${badge.dotClass}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                    {server.name}
                  </span>
                  {(() => {
                    const t = transportLabel(server.transport, server.url)
                    return (
                      <span
                        title={`${t.hint} (${server.transport})`}
                        className="rounded bg-[var(--bg-tertiary)] px-1 py-0 text-[11px] text-[var(--text-muted)]"
                      >
                        {t.label}
                      </span>
                    )
                  })()}
                  {auth && (
                    <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
                      {auth}
                    </span>
                  )}
                  {server.pluginId && (
                    <span
                      className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]"
                      title={`From plugin: ${server.pluginId}`}
                    >
                      plugin: {server.pluginId}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px] text-[var(--text-secondary)]">
                  {badge.label}
                  {badge.sub ? ` — ${badge.sub}` : ''}
                </div>
                {server.status === 'connected' && <ResourcesExpander serverId={server.id} />}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {/* Reconnect stays live while `connecting` — a server that spawns but
                    never completes the handshake would otherwise strand the row in a
                    state whose only control is disabled. */}
                <button
                  onClick={() => void reconnect(server.id)}
                  className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1 text-[11px] hover:border-[var(--accent)]"
                >
                  {t('Reconnect')}
                </button>
                {!server.pluginId && (
                  <>
                    <Toggle
                      checked={server.enabled}
                      onChange={() => void setEnabled(server.id, !server.enabled)}
                      aria-label={server.enabled ? 'Disable connector' : 'Enable connector'}
                    />
                    <button
                      onClick={() => void onRemove(server)}
                      className="rounded p-1 text-[11px] text-[var(--text-secondary)] opacity-0 hover:bg-[var(--bg-primary)] hover:text-[var(--error)] group-hover:opacity-100"
                      title={t('Remove this connector')}
                      aria-label={t('Remove')}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <polyline points="3 6 5 6 21 6" />
                        <path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Part B — always-rendered, first-class Google connect grant. */}
      <GoogleConnectCard />

      <div className="shrink-0 border-t border-[var(--panel-border)] px-3 py-1.5">
        <button
          onClick={() => void window.api?.mcp?.openConfigFolder?.()}
          className="text-[11px] text-[var(--text-muted)] underline-offset-2 hover:text-[var(--text-primary)] hover:underline"
          title={t('Open the folder holding mcp-servers.json')}
        >
          {t('Open config folder')}
        </button>
      </div>

      {addOpen && <AddConnectorFlow onClose={() => setAddOpen(false)} />}
    </div>
  )
}
