import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import { toast } from '@/stores/toast-store'
import { useMcpStore } from '@/stores/mcp-store'
import { CONNECTORS_CATALOG, type CatalogEntry } from '@/data/connectors-catalog'
import { transportLabel } from '@/lib/mcp-transport'

interface AddConnectorFlowProps {
  onClose: () => void
}

type Tab = 'catalog' | 'custom' | 'json'

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'connector'
  )
}

/** The auth half of what the Custom tab persists for a remote connector. */
interface RemoteAuthFields {
  auth: 'oauth'
  oauthClientId?: string
  oauthClientSecret?: string
}

/**
 * `auth` is ALWAYS 'oauth' here, deliberately: it ARMS the OAuth capability, it is
 * not a claim that this particular server demands a login.
 *
 * This used to be an inline `auth: clientId.trim() ? 'oauth' : 'none'` — credential
 * PRESENCE as the switch, which is the exact opposite of what the Advanced panel
 * below tells the user ("Most servers register DUIN automatically. Only fill these
 * in if the server gave you credentials."). Follow that instruction, leave both
 * fields blank, and the connector was persisted as 'none'. mcp-manager.connectHttp
 * constructs a McpOAuthProvider only under `auth === 'oauth'`, and connectWithRetry's
 * 401 recovery is gated on that same object (`if (oauthProvider && !authExchanged &&
 * isUnauthorized)`), so a hosted OAuth server's 401 merely burned the three retries
 * and left the row permanently red on "Unauthorized": no dynamic client registration,
 * no :9877 loopback, no consent window. The whole generic-OAuth subsystem was
 * unreachable from the only UI that adds remote servers — it could be turned on only
 * by hand-writing "auth": "oauth" in the JSON-paste tab.
 *
 * What made it invisible: the ternary LOOKS like it handles OAuth, and it does — but
 * only on the one path the UI explicitly tells users to skip.
 *
 * Arming it unconditionally costs a server that needs no auth nothing, because the
 * MCP SDK's auth machinery is purely 401/403-triggered: StreamableHTTPClientTransport
 * `_commonHeaders` attaches a Bearer only when `tokens()` already holds one, and
 * `auth()` runs solely inside its `response.status === 401 && this._authProvider`
 * branches. An anonymous server sees a byte-identical request and no browser opens.
 */
export function remoteConnectorAuthFields(
  clientId: string,
  clientSecret: string
): RemoteAuthFields {
  const id = clientId.trim()
  // The credentials stay exactly what the UI promises — OPTIONAL pre-registration for
  // the servers that hand you a client id instead of issuing one. ipc/mcp.ts stashes
  // them under the keychain key McpOAuthProvider.clientInformation() reads, which is
  // what lets the SDK skip dynamic registration. They never gate the flow.
  if (!id) return { auth: 'oauth' }
  const secret = clientSecret.trim()
  return { auth: 'oauth', oauthClientId: id, ...(secret ? { oauthClientSecret: secret } : {}) }
}

const PLACEHOLDER_JSON = `{
  "id": "my-mcp-server",
  "name": "My MCP Server",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@scope/my-mcp-server"],
  "auth": "none",
  "enabled": true
}`

export function AddConnectorFlow({ onClose }: AddConnectorFlowProps) {
  const [tab, setTab] = useState<Tab>('catalog')
  const [jsonText, setJsonText] = useState(PLACEHOLDER_JSON)
  const [parseError, setParseError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState({ name: '', url: '', clientId: '', clientSecret: '' })
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [customError, setCustomError] = useState<string | null>(null)
  const loadServers = useMcpStore((s) => s.loadServers)
  const existing = useMcpStore((s) => s.servers)

  const grouped = useMemo(() => {
    const map = new Map<string, CatalogEntry[]>()
    for (const e of CONNECTORS_CATALOG) {
      const arr = map.get(e.category) ?? []
      arr.push(e)
      map.set(e.category, arr)
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [])

  const existingIds = useMemo(() => new Set(existing.map((s) => s.id)), [existing])

  useEffect(() => {
    setParseError(null)
  }, [jsonText])

  const onAddFromCatalog = async (entry: CatalogEntry) => {
    if (existingIds.has(entry.id)) {
      toast.error(`Connector "${entry.id}" is already installed.`)
      return
    }
    setBusy(true)
    try {
      const result = await window.api.mcp.addServer(entry)
      if (result.success) {
        toast.success(`Added connector "${entry.name}"`)
        await loadServers()
        onClose()
      } else {
        toast.error(`Failed to add connector: ${result.error}`)
      }
    } finally {
      setBusy(false)
    }
  }

  // A named URL is all a remote MCP server needs, so that is all this asks for. The
  // OAuth pair is optional because most servers register the client dynamically; it is
  // there for the ones that hand you credentials instead.
  const onAddCustom = async () => {
    const name = custom.name.trim()
    const url = custom.url.trim()
    if (!name) {
      setCustomError('Give this connector a name.')
      return
    }
    if (!url) {
      setCustomError('Paste the server URL.')
      return
    }
    let parsedUrl: URL
    try {
      parsedUrl = new URL(url)
    } catch {
      setCustomError("That doesn't look like a URL — it should start with https://")
      return
    }
    if (!/^https?:$/.test(parsedUrl.protocol)) {
      setCustomError('Remote connectors use an http:// or https:// URL.')
      return
    }

    let id = slugify(name)
    if (existingIds.has(id)) {
      let n = 2
      while (existingIds.has(`${id}-${n}`)) n++
      id = `${id}-${n}`
    }

    setBusy(true)
    setCustomError(null)
    try {
      const result = await window.api.mcp.addServer({
        id,
        name,
        transport: 'http',
        url,
        enabled: true,
        ...remoteConnectorAuthFields(custom.clientId, custom.clientSecret)
      })
      if (result.success) {
        toast.success(`Added connector "${name}"`)
        await loadServers()
        onClose()
      } else {
        setCustomError(result.error ?? 'Could not add that connector')
      }
    } finally {
      setBusy(false)
    }
  }

  const onAddFromJson = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch (err) {
      setParseError(`Not valid JSON: ${(err as Error).message}`)
      return
    }
    // Accept either a single server object OR the standard `.mcp.json` shape:
    // `{ mcpServers: { id1: {...}, id2: {...} } }`. Real config files routinely hold
    // several servers, so add them all rather than rejecting the paste.
    let toAdd: unknown[] = [parsed]
    if (parsed && typeof parsed === 'object' && 'mcpServers' in parsed) {
      const entries = Object.entries(
        (parsed as { mcpServers: Record<string, unknown> }).mcpServers ?? {}
      )
      if (entries.length === 0) {
        setParseError('mcpServers object is empty')
        return
      }
      // Slugify the KEY, then de-duplicate exactly as the Custom tab does. addServer
      // enforces /^[a-z0-9][a-z0-9-]*$/, but the key comes from whoever wrote the
      // config, not from this user, and real ones routinely use underscores or capitals
      // ("my_server", "Slack") — those were rejected with a kebab-case error about an id
      // the user never typed and cannot edit here.
      //
      // The de-dup is not cosmetic: slugify is many-to-one, so "Slack" and "slack"
      // collapse together, and ipc/mcp.ts keys the OAuth keychain entry on the id. A
      // silent collision would hand a pasted connector the same id as an existing one.
      // (Sharing `slugify` also fixes what a bespoke helper got wrong: every
      // all-non-ASCII key collapsed to one literal id.)
      const claimed = new Set(existingIds)
      toAdd = entries.map(([key, body]) => {
        let id = slugify(key)
        if (claimed.has(id)) {
          let n = 2
          while (claimed.has(`${id}-${n}`)) n++
          id = `${id}-${n}`
        }
        claimed.add(id)
        return { ...(body as Record<string, unknown>), id }
      })
    }

    // Resolve `transport`, which addServer requires as a discriminator.
    //
    // Source order matters. `.mcp.json` — the external format people actually paste,
    // including this repo's own plugins/duin-brain/.mcp.json — spells it `type`, while
    // `transport` is DUIN's internal connectors.json spelling. Reading only `transport`
    // and then guessing from the URL meant an explicitly-declared `"type": "sse"` server
    // was stored as http whenever its URL had no '/sse' segment, and it then failed to
    // connect. Take the declaration when there is one; guess only when there is not.
    toAdd = toAdd.map((raw) => {
      const o = { ...(raw as Record<string, unknown>) }
      const declared = [o.transport, o.type].find(
        (v) => v === 'stdio' || v === 'sse' || v === 'http'
      )
      if (declared) {
        o.transport = declared
        return o
      }
      if (typeof o.url === 'string' && o.url) o.transport = o.url.includes('/sse') ? 'sse' : 'http'
      else if (typeof o.command === 'string' && o.command) o.transport = 'stdio'
      return o
    })

    setBusy(true)
    try {
      const failures: string[] = []
      let added = 0
      for (const server of toAdd) {
        const result = await window.api.mcp.addServer(server)
        if (result.success) added++
        else failures.push(result.error ?? 'unknown error')
      }
      await loadServers()
      if (added > 0) {
        toast.success(`Added ${added} connector${added === 1 ? '' : 's'}`)
      }
      if (failures.length) {
        // Keep the dialog open so a partial paste can be corrected in place.
        setParseError(
          added > 0
            ? `${failures.length} of ${toAdd.length} could not be added: ${failures.join('; ')}`
            : failures.join('; ')
        )
        return
      }
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[600px] w-[700px] flex-col overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center border-b border-[var(--panel-border)] px-4">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
            {t('Add connector')}
          </span>
          <div className="ml-3 flex items-center gap-1">
            <button
              onClick={() => setTab('catalog')}
              className={`rounded px-2 py-0.5 text-[12px] ${
                tab === 'catalog'
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {t('Catalog')}
            </button>
            <button
              onClick={() => setTab('custom')}
              className={`rounded px-2 py-0.5 text-[12px] ${
                tab === 'custom'
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {t('Custom')}
            </button>
            <button
              onClick={() => setTab('json')}
              className={`rounded px-2 py-0.5 text-[12px] ${
                tab === 'json'
                  ? 'bg-[var(--accent)] text-white'
                  : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
              }`}
            >
              {t('JSON paste')}
            </button>
          </div>
          <div className="flex-1" />
          <IconButton
            onClick={onClose}
            aria-label={t('Close')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </IconButton>
        </header>

        <div className="flex-1 overflow-y-auto p-4">
          {tab === 'catalog' && (
            <div className="space-y-4">
              {grouped.map(([category, list]) => (
                <section key={category}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {category}
                  </h3>
                  <div className="space-y-2">
                    {list.map((entry) => {
                      const installed = existingIds.has(entry.id)
                      return (
                        <div
                          key={entry.id}
                          className="flex items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3"
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="text-[12px] font-medium text-[var(--text-primary)]">
                                {entry.name}
                              </span>
                              <span
                                title={transportLabel(entry.transport, entry.url).hint}
                                className="rounded bg-[var(--bg-tertiary)] px-1 py-0 text-[11px] text-[var(--text-muted)]"
                              >
                                {transportLabel(entry.transport, entry.url).label}
                              </span>
                              {entry.auth === 'google-oauth' && (
                                <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
                                  google-oauth
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                              {entry.description}
                            </p>
                            {entry.command && (
                              <code className="mt-1 block truncate font-mono text-[11px] text-[var(--text-muted)]">
                                {entry.command} {(entry.args ?? []).join(' ')}
                              </code>
                            )}
                          </div>
                          <Button variant="primary" className="border-[var(--accent)]"
                            onClick={() => void onAddFromCatalog(entry)}
                            disabled={busy || installed}
                          >
                            {installed ? 'Installed' : 'Add'}
                          </Button>
                        </div>
                      )
                    })}
                  </div>
                </section>
              ))}
              {grouped.length === 0 && (
                <p className="text-center text-[12px] text-[var(--text-muted)]">
                  {t('Catalog is empty.')}
                </p>
              )}
            </div>
          )}

          {tab === 'custom' && (
            <div className="mx-auto max-w-[440px] space-y-3">
              <p className="text-[12px] text-[var(--text-secondary)]">
                Connect DUIN to a remote MCP server — one someone else runs and you reach
                over the web. For a server that runs on this computer, use JSON paste.
              </p>
              <label className="block text-[11px] text-[var(--text-muted)]">
                Name
                <input
                  value={custom.name}
                  onChange={(e) => setCustom((c) => ({ ...c, name: e.target.value }))}
                  placeholder={t('My connector')}
                  className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </label>
              <label className="block text-[11px] text-[var(--text-muted)]">
                Remote MCP server URL
                <input
                  value={custom.url}
                  onChange={(e) => setCustom((c) => ({ ...c, url: e.target.value }))}
                  placeholder="https://example.com/mcp"
                  spellCheck={false}
                  className="mt-1 w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </label>

              <button
                onClick={() => setAdvancedOpen((o) => !o)}
                aria-expanded={advancedOpen}
                className="flex items-center gap-1 text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              >
                <svg
                  width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden
                  className={advancedOpen ? '' : '-rotate-90'}
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
                {t('Advanced settings')}
              </button>
              {advancedOpen && (
                <div className="space-y-3">
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Most servers register DUIN automatically. Only fill these in if the
                    server gave you credentials.
                  </p>
                  <input
                    value={custom.clientId}
                    onChange={(e) => setCustom((c) => ({ ...c, clientId: e.target.value }))}
                    placeholder={t('OAuth Client ID (optional)')}
                    spellCheck={false}
                    className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                  <input
                    value={custom.clientSecret}
                    onChange={(e) => setCustom((c) => ({ ...c, clientSecret: e.target.value }))}
                    placeholder={t('OAuth Client Secret (optional)')}
                    type="password"
                    spellCheck={false}
                    className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                  />
                </div>
              )}

              <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
                Only use connectors from developers you trust. DUIN does not control which
                tools they make available, and cannot verify that they work as intended or
                that they won&rsquo;t change.
              </p>
              {customError && (
                <div className="rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1.5 text-[11px] text-[var(--error)]">
                  {customError}
                </div>
              )}
            </div>
          )}

          {tab === 'json' && (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-secondary)]">
                Paste either a single connector object or the standard
                <code className="mx-1 rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px]">.mcp.json</code>
                <code className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px]">mcpServers</code>
                wrapper. Every entry is added.
              </p>
              <textarea
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                spellCheck={false}
                rows={16}
                className="w-full resize-y rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              {parseError && (
                <div className="rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1.5 text-[11px] text-[var(--error)]">
                  {parseError}
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--panel-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)]"
          >
            {t('Cancel')}
          </button>
          <div className="flex-1" />
          {tab === 'custom' && (
            <Button variant="primary" className="border-[var(--accent)]"
              onClick={() => void onAddCustom()}
              disabled={busy}
            >
              {busy ? 'Adding…' : 'Add'}
            </Button>
          )}
          {tab === 'json' && (
            <Button variant="primary" className="border-[var(--accent)]"
              onClick={() => void onAddFromJson()}
              disabled={busy}
            >
              {busy ? 'Adding…' : 'Add connector'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
