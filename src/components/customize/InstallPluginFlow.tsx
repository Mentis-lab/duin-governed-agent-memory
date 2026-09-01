import { t } from '@/lib/i18n'
import { useEffect, useMemo, useState } from 'react'
import { IconButton } from '@/components/ui/IconButton'
import { Button } from '@/components/ui/Button'
import type { PluginManifest, RequirementResult } from '@/lib/types'
import { toast } from '@/stores/toast-store'
import { usePluginsStore } from '@/stores/plugins-store'

export type InstallPluginFlowTab = 'directory' | 'manifest' | 'bundled' | 'url'

/** Renderer mirror of `electron/services/plugin-install-remote.ts`. */
export interface StagedConnector {
  id: string
  name: string
  transport: string
  commandLine?: string
  url?: string
  envKeys: string[]
  missing: RequirementResult[]
}

export interface StagedPlugin {
  stageId: string
  sourceUrl: string
  id: string
  name: string
  description: string
  version: string
  author?: string
  homepage?: string
  connectors: StagedConnector[]
  skills: string[]
  slashCommands: string[]
  missing: RequirementResult[]
  alreadyInstalled: boolean
}

/**
 * What the operator is actually being asked to approve.
 *
 * A plugin's connectors.json can declare an MCP stdio server, and an MCP stdio
 * server is a command line DUIN spawns. So the honest summary of "install this
 * plugin from a URL" is the list of command lines it would run — and if that list is
 * empty, saying so plainly is just as important, because most plugins are only text
 * and treating them all as dangerous is how a warning stops being read.
 *
 * Exported for test: node-only vitest env, so this pane's judgement lives in a pure
 * helper rather than a jsdom render.
 */
export function summarizeRisk(staged: StagedPlugin): {
  spawns: StagedConnector[]
  headline: string
  severe: boolean
} {
  const spawns = staged.connectors.filter((c) => c.transport === 'stdio' && c.commandLine)
  if (spawns.length === 0) {
    const remote = staged.connectors.filter((c) => c.url)
    if (remote.length > 0) {
      return {
        spawns,
        severe: false,
        headline: `Contacts ${remote.length} remote server${remote.length === 1 ? '' : 's'}. Runs nothing on this machine.`
      }
    }
    return {
      spawns,
      severe: false,
      headline: 'Text only — skills and commands. Runs nothing on this machine.'
    }
  }
  return {
    spawns,
    severe: true,
    headline: `Runs ${spawns.length} command${spawns.length === 1 ? '' : 's'} on this machine.`
  }
}

/** Everything missing across the plugin and its connectors, de-duplicated by label. */
export function collectMissing(staged: StagedPlugin): RequirementResult[] {
  const seen = new Map<string, RequirementResult>()
  for (const m of staged.missing) seen.set(m.label, m)
  for (const c of staged.connectors) {
    for (const m of c.missing) if (!seen.has(m.label)) seen.set(m.label, m)
  }
  return [...seen.values()]
}

interface InstallPluginFlowProps {
  onClose: () => void
  /** Which tab is selected on first paint. Defaults to 'directory'. */
  initialTab?: InstallPluginFlowTab
}

type Tab = InstallPluginFlowTab

const MANIFEST_PLACEHOLDER = `{
  "id": "my-plugin",
  "name": "My Plugin",
  "description": "One-sentence summary.",
  "version": "0.1.0",
  "category": "Custom",
  "files": {
    "skills/example.md": "---\\nname: example\\ndescription: A skill that does something useful.\\n---\\n\\nWhen invoked, do the thing."
  }
}`

/**
 * The review screen. Its whole job is to be accurate about one question: what will
 * this run on my machine?
 *
 * So the command lines are rendered VERBATIM and never truncated, the "runs nothing"
 * case is stated as plainly as the "runs 3 commands" case, and missing requirements
 * appear here rather than after installation — a plugin needing a tool you do not
 * have is something to learn before it is on disk, not after it silently does nothing.
 */
function StagedReview({
  staged,
  busy,
  onCommit,
  onDiscard
}: {
  staged: StagedPlugin
  busy: boolean
  onCommit: () => void
  onDiscard: () => void
}) {
  const risk = summarizeRisk(staged)
  const missing = collectMissing(staged)
  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-center gap-2">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
            {staged.name}
          </span>
          <span className="rounded bg-[var(--bg-tertiary)] px-1 font-mono text-[11px] text-[var(--text-muted)]">
            v{staged.version}
          </span>
          {staged.author && (
            <span className="text-[11px] text-[var(--text-muted)]">by {staged.author}</span>
          )}
        </div>
        {staged.description && (
          <p className="mt-1 text-[12px] text-[var(--text-secondary)]">{staged.description}</p>
        )}
        <p className="mt-1 truncate font-mono text-[11px] text-[var(--text-muted)]">
          {staged.sourceUrl}
        </p>
      </div>

      {staged.alreadyInstalled && (
        <div className="rounded border border-[var(--error)] bg-[var(--error)]/10 p-2 text-[11px] text-[var(--error)]">
          A plugin with the id <code>{staged.id}</code> is already installed. Remove it
          first — installing will not overwrite it.
        </div>
      )}

      <div
        className={`rounded border p-3 ${
          risk.severe
            ? 'border-amber-500/50 bg-amber-500/10'
            : 'border-[var(--panel-border)] bg-[var(--bg-primary)]'
        }`}
      >
        <div className="text-[12px] font-semibold text-[var(--text-primary)]">
          {risk.headline}
        </div>
        {risk.spawns.length > 0 && (
          <>
            <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
              These run as separate processes with your account&apos;s access. Read them
              before you continue — you will be asked to approve each one again.
            </p>
            <ul className="mt-2 space-y-1.5">
              {risk.spawns.map((c) => (
                <li key={c.id} className="rounded bg-[var(--bg-secondary)] p-2">
                  <div className="text-[11px] text-[var(--text-secondary)]">{c.name}</div>
                  <code className="mt-0.5 block break-all font-mono text-[11px] text-[var(--text-primary)]">
                    {c.commandLine}
                  </code>
                  {c.envKeys.length > 0 && (
                    <div className="mt-1 font-mono text-[11px] text-[var(--text-muted)]">
                      env: {c.envKeys.join(', ')}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {missing.length > 0 && (
        <div className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
          <div className="text-[12px] font-semibold text-[var(--text-primary)]">
            Needs something you don&apos;t have yet
          </div>
          <ul className="mt-1.5 space-y-1">
            {missing.map((m) => (
              <li key={m.label} className="text-[11px] text-[var(--text-secondary)]">
                <span className="font-mono text-[var(--text-primary)]">{m.label}</span>
                {m.detail ? ` — ${m.detail}` : ''}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-[var(--text-muted)]">
            {t('You can still install it. It will not work until these are present.')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 text-[11px] text-[var(--text-secondary)]">
        <div className="rounded border border-[var(--panel-border)] p-2">
          <div className="font-semibold text-[var(--text-primary)]">
            Skills ({staged.skills.length})
          </div>
          {staged.skills.length === 0 ? (
            <div className="mt-1 text-[var(--text-muted)]">{t('None')}</div>
          ) : (
            <ul className="mt-1 space-y-0.5 font-mono">
              {staged.skills.slice(0, 8).map((s) => (
                <li key={s} className="truncate">{s}</li>
              ))}
              {staged.skills.length > 8 && (
                <li className="text-[var(--text-muted)]">
                  +{staged.skills.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
        <div className="rounded border border-[var(--panel-border)] p-2">
          <div className="font-semibold text-[var(--text-primary)]">
            Commands ({staged.slashCommands.length})
          </div>
          {staged.slashCommands.length === 0 ? (
            <div className="mt-1 text-[var(--text-muted)]">{t('None')}</div>
          ) : (
            <ul className="mt-1 space-y-0.5 font-mono">
              {staged.slashCommands.slice(0, 8).map((s) => (
                <li key={s} className="truncate">{s}</li>
              ))}
              {staged.slashCommands.length > 8 && (
                <li className="text-[var(--text-muted)]">
                  +{staged.slashCommands.length - 8} more
                </li>
              )}
            </ul>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          className="border-[var(--accent)]"
          onClick={onCommit}
          disabled={busy || staged.alreadyInstalled}
        >
          {busy ? 'Installing…' : 'Install (stays off until you enable it)'}
        </Button>
        <button
          onClick={onDiscard}
          disabled={busy}
          className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)] disabled:opacity-50"
        >
          {t('Discard')}
        </button>
      </div>
    </div>
  )
}

export function InstallPluginFlow({ onClose, initialTab }: InstallPluginFlowProps) {
  const pickDirectoryAndInstall = usePluginsStore((s) => s.pickDirectoryAndInstall)

  const [tab, setTab] = useState<Tab>(initialTab ?? 'directory')
  const [manifestText, setManifestText] = useState(MANIFEST_PLACEHOLDER)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [bundled, setBundled] = useState<PluginManifest[]>([])
  const [bundledLoading, setBundledLoading] = useState(false)
  const [repoUrl, setRepoUrl] = useState('')
  const [staged, setStaged] = useState<StagedPlugin | null>(null)

  useEffect(() => {
    setError(null)
  }, [manifestText, tab])

  const loadBundled = useMemo(
    () => async () => {
      if (!window.api?.plugins?.listBundledAvailable) return
      setBundledLoading(true)
      try {
        const result = await window.api.plugins.listBundledAvailable()
        if (result.success) setBundled((result.data as PluginManifest[]) ?? [])
      } finally {
        setBundledLoading(false)
      }
    },
    []
  )

  useEffect(() => {
    if (tab === 'bundled') void loadBundled()
  }, [tab, loadBundled])

  const onInstallDirectory = async () => {
    setBusy(true)
    try {
      const r = await pickDirectoryAndInstall()
      if (r.ok) {
        onClose()
      } else if (r.error) {
        setError(r.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onInstallManifest = async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(manifestText)
    } catch (err) {
      setError(`Not valid JSON: ${(err as Error).message}`)
      return
    }
    if (!parsed || typeof parsed !== 'object') {
      setError('Manifest must be a JSON object')
      return
    }
    const obj = parsed as Record<string, unknown>
    const files = (obj.files ?? undefined) as Record<string, string> | undefined
    const manifest = { ...obj }
    delete manifest.files
    setBusy(true)
    try {
      if (!window.api?.plugins?.installFromManifest) {
        setError('Plugins API missing')
        return
      }
      const result = await window.api.plugins.installFromManifest(manifest, files)
      if (result.success) {
        toast.success(`Installed plugin "${(result.data as { id?: string })?.id ?? ''}"`)
        onClose()
      } else {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  const onStage = async () => {
    setBusy(true)
    setError(null)
    try {
      const api = window.api?.plugins as
        | { stageFromUrl?: (u: string) => Promise<{ success: boolean; data?: unknown; error?: string }> }
        | undefined
      if (!api?.stageFromUrl) {
        setError('This build does not support URL install.')
        return
      }
      const r = await api.stageFromUrl(repoUrl.trim())
      if (!r.success) {
        setError(r.error ?? 'Could not fetch that repository.')
        return
      }
      setStaged(r.data as StagedPlugin)
    } finally {
      setBusy(false)
    }
  }

  const onCommit = async () => {
    if (!staged) return
    setBusy(true)
    try {
      const api = window.api?.plugins as
        | { commitStaged?: (id: string) => Promise<{ success: boolean; data?: unknown; error?: string }> }
        | undefined
      if (!api?.commitStaged) return
      const r = await api.commitStaged(staged.stageId)
      if (!r.success) {
        // The stdio approval dialog resolving to "no" lands here. That is a
        // DECISION, not a fault — say so without dressing it as an error the
        // operator needs to fix.
        setError(r.error ?? 'Install did not complete.')
        return
      }
      toast.success(`Installed "${staged.id}" — switch it on in Plugins when you're ready`)
      setStaged(null)
      setRepoUrl('')
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const onDiscard = async () => {
    const api = window.api?.plugins as
      | { discardStaged?: (id: string) => Promise<unknown> }
      | undefined
    if (staged && api?.discardStaged) await api.discardStaged(staged.stageId)
    setStaged(null)
    setError(null)
  }

  const onInstallBundled = async (id: string) => {
    setBusy(true)
    try {
      if (!window.api?.plugins?.installBundled) return
      const result = await window.api.plugins.installBundled(id)
      if (result.success) {
        toast.success(`Installed bundled plugin "${id}"`)
        await loadBundled()
      } else {
        setError(result.error)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="flex h-[620px] w-[700px] flex-col overflow-hidden rounded-lg border border-[var(--panel-border)] bg-[var(--bg-secondary)] shadow-2xl">
        <header className="flex h-12 shrink-0 items-center border-b border-[var(--panel-border)] px-4">
          <span className="text-[14px] font-semibold text-[var(--text-primary)]">
            {t('Install plugin')}
          </span>
          <div className="ml-3 flex items-center gap-1">
            {(['url', 'directory', 'manifest', 'bundled'] as const).map((id) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`rounded px-2 py-0.5 text-[12px] capitalize ${
                  tab === id
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
                }`}
              >
                {id === 'url'
                  ? 'From URL'
                  : id === 'directory'
                    ? 'From directory'
                    : id === 'manifest'
                      ? 'Paste manifest'
                      : 'Bundled catalog'}
              </button>
            ))}
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

        <div className="flex-1 overflow-y-auto p-5">
          {tab === 'url' && !staged && (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-primary)]">
                Paste a git repository URL. DUIN clones it to a scratch folder and
                shows you what it contains — <strong>nothing is installed or run</strong>{' '}
                until you approve it on the next screen.
              </p>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                spellCheck={false}
                placeholder="https://github.com/owner/duin-plugin-example"
                className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
              <p className="text-[11px] text-[var(--text-muted)]">
                https:// and ssh:// only. Requires git on this machine. The repository
                must have a <code>plugin.json</code> at its root.
              </p>
              <Button
                variant="primary"
                className="border-[var(--accent)]"
                onClick={() => void onStage()}
                disabled={busy || !repoUrl.trim()}
              >
                {busy ? 'Fetching…' : 'Fetch and review'}
              </Button>
            </div>
          )}

          {tab === 'url' && staged && (
            <StagedReview
              staged={staged}
              busy={busy}
              onCommit={() => void onCommit()}
              onDiscard={() => void onDiscard()}
            />
          )}

          {tab === 'directory' && (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-primary)]">
                Pick a directory containing a valid <code>plugin.json</code>. DUIN will
                copy it into the plugins folder and load it immediately.
              </p>
              <p className="text-[12px] text-[var(--text-secondary)]">
                The directory must contain a top-level <code>plugin.json</code> with at
                least <code>id</code>, <code>name</code>, <code>description</code>, and
                <code> version</code>. Sibling <code>skills/</code>, <code>slash-commands/</code>,
                and <code>connectors.json</code> are picked up automatically.
              </p>
              <Button variant="primary" className="border-[var(--accent)]"
                onClick={() => void onInstallDirectory()}
                disabled={busy}
              >
                {busy ? 'Picking…' : 'Pick directory'}
              </Button>
            </div>
          )}

          {tab === 'manifest' && (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-secondary)]">
                Paste a JSON object with the manifest fields. Optionally include a{' '}
                <code>files</code> map keyed by relative path; each value becomes a file
                under the new plugin directory (e.g. <code>skills/foo.md</code>).
              </p>
              <textarea
                value={manifestText}
                onChange={(e) => setManifestText(e.target.value)}
                spellCheck={false}
                rows={18}
                className="w-full resize-y rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-2 font-mono text-[12px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
              />
            </div>
          )}

          {tab === 'bundled' && (
            <div className="space-y-3">
              <p className="text-[12px] text-[var(--text-secondary)]">
                Bundled plugins ship with DUIN. Anything you removed earlier appears
                here so you can re-install it without rebuilding the app.
              </p>
              {bundledLoading && (
                <div className="text-[12px] text-[var(--text-muted)]">Loading…</div>
              )}
              {!bundledLoading && bundled.length === 0 && (
                <div className="text-[12px] text-[var(--text-muted)]">
                  {t('No bundled plugins are missing from the installed set.')}
                </div>
              )}
              {bundled.map((entry) => (
                <div
                  key={entry.id}
                  className="flex items-start gap-3 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[12px] font-medium text-[var(--text-primary)]">
                        {entry.name}
                      </span>
                      <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                        v{entry.version}
                      </span>
                      {entry.category && (
                        <span className="rounded bg-[var(--bg-tertiary)] px-1 py-0 font-mono text-[11px] uppercase tracking-wider text-[var(--accent)]">
                          {entry.category}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--text-secondary)]">
                      {entry.description}
                    </p>
                  </div>
                  <Button variant="primary" className="border-[var(--accent)]"
                    onClick={() => void onInstallBundled(entry.id)}
                    disabled={busy}
                  >
                    {t('Install')}
                  </Button>
                </div>
              ))}
            </div>
          )}

          {error && (
            <div className="mt-3 rounded border border-[var(--error)] bg-[var(--error)]/10 px-2 py-1.5 text-[11px] text-[var(--error)]">
              {error}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 items-center gap-2 border-t border-[var(--panel-border)] px-4 py-3">
          <button
            onClick={onClose}
            className="rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] px-3 py-1.5 text-[12px] hover:border-[var(--accent)]"
          >
            {t('Close')}
          </button>
          <div className="flex-1" />
          {tab === 'manifest' && (
            <Button variant="primary" className="border-[var(--accent)]"
              onClick={() => void onInstallManifest()}
              disabled={busy}
            >
              {busy ? 'Installing…' : 'Install'}
            </Button>
          )}
        </footer>
      </div>
    </div>
  )
}
