import { t, tf } from '@/lib/i18n'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Toggle } from '@/components/ui/Toggle'
import { PanelState } from '@/components/ui/PanelState'
import {
  SettingsLink,
  SettingsLoadError,
  SettingsLoading,
  SettingsPage,
  SettingsRow,
  SettingsSection
} from '@/components/ui/settings'
import { useDirtyGuard } from '@/hooks/useDirtyGuard'
import { invoke, query } from '@/lib/ipc-client'
import { panelFromResult, panelLoading, type PanelStatus } from '@/lib/panel-state'
import { describeError } from '@/lib/result'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'

// Brain settings — the notes folder the built-in brain reads, and (Advanced) an external brain.
//
// `duin-brain` is the no-pin sentinel for a conversation (no pinned model); the brain is the
// connector behind it. This panel persists to the app settings store via
// useSettingsStore.updateSettings (which calls window.api.settings.set):
//   - localBrainNotesDir — the folder the built-in brain indexes
//   - brainUrl          — the chat endpoint of an external brain (blank = the built-in brain)
//   - brainGraphUrl     — an optional brain ORIGIN for the graph. Main keeps only its origin
//                         (main.ts did-finish-load → window.__DUIN_BASE) and chat follows it
//                         when brainUrl is blank (ipc/chat.ts). Nothing fetches a graph from
//                         it as a URL, so the copy below describes an origin, not a feed.
//
// "Test connection" probes the endpoint in the MAIN process (no renderer CORS) via
// window.api.brain.testConnection. It is non-blocking — the rest of the panel stays usable.

// Must match DEFAULT_BRAIN in electron/services/duin-bridge.ts. This used to say :8765 — the
// retired python sidecar's stub port — so the panel displayed, and on blur RE-SAVED, a value
// that resolveBrainUrl() silently throws away and coerces back to :8799.
const DEFAULT_BRAIN_URL = 'http://127.0.0.1:8799/agui'
const LOCAL_BRAIN_ORIGIN = new URL(DEFAULT_BRAIN_URL).origin

/**
 * Whether a saved chat endpoint points AWAY from the built-in brain. Pure.
 *
 * "Use external brain" used to pre-fill DEFAULT_BRAIN_URL — the local brain's own address —
 * so one click flipped the panel into external mode (Build / Restore / status hidden, "the
 * folder is ignored") while nothing had changed. A URL on the local origin IS the local
 * brain, whatever its path, so it counts as local here.
 */
export function isExternalBrainUrl(raw: string): boolean {
  const url = raw.trim()
  if (url === '') return false
  try {
    return new URL(url).origin !== LOCAL_BRAIN_ORIGIN
  } catch {
    return url !== DEFAULT_BRAIN_URL
  }
}

/** '' when the draft can be saved (blank, or a full http(s) URL); otherwise the inline error. */
export function endpointError(raw: string): string {
  const url = raw.trim()
  if (url === '') return ''
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return t('Enter a full address starting with http:// or https://')
    }
    return ''
  } catch {
    return t('Enter a full address starting with http:// or https://')
  }
}

type TestState = { ok: boolean; detail: string } | null

// Narrow accessor for the brain preload surface. Typed inline so this component doesn't
// depend on the main process's preload type across the tsconfig boundary.
type DetectedSystem = {
  adapter: string
  label: string
  dir: string
  contains: { identity: boolean; memory: number; skills: number; agents: number; hooks: number }
}
type ImportSummary = {
  ok: boolean
  mode: 'link' | 'copy'
  summary: { identity: boolean; memory: number; skills: number; agents: number; hooks: number; linked: boolean }
  /** Trash-relative path where a pre-existing hand-written `.brain/identity.md` was
   *  preserved before this import overwrote it. Absent when nothing was replaced. */
  replaced?: string
  error?: string
}
type BrainStatus = { notesIndexed: number; graphNodes: number; graphEdges: number; hasModel: boolean }
type BuildResult = {
  entities: number
  edges: number
  status: 'built' | 'kept-cache' | 'no-model' | 'model-error'
}
type Backup = { label: string; name: string; path: string; size: number; mtimeMs: number }
type ScaffoldResult = {
  ok: boolean
  counts: Record<string, number>
  tracks: string[]
  diagnosisPath: string
  error?: string
}
type Envelope<T> = { success: boolean; data?: T; error?: string }
type BrainApi = {
  pickFolder?: () => Promise<Envelope<string | null>>
  reindex?: () => Promise<Envelope<{ ok: boolean; count: number }>>
  status?: () => Promise<Envelope<BrainStatus>>
  build?: () => Promise<Envelope<BuildResult>>
  moatBackups?: () => Promise<Envelope<Backup[]>>
  restoreMoat?: (
    label?: string
  ) => Promise<Envelope<{ restored: string[]; skipped?: Array<{ label: string; reason: string }> }>>
  detectImports?: () => Promise<Envelope<DetectedSystem[]>>
  import?: (payload: { adapterId: string; sourceDir: string; mode: 'link' | 'copy' }) => Promise<Envelope<ImportSummary>>
  scaffoldHarness?: (args: { srcDir: string; outDir?: string }) => Promise<Envelope<ScaffoldResult>>
  testConnection?: (endpoint: string) => Promise<Envelope<{ ok: boolean; detail: string }>>
  onUpdated?: (cb: () => void) => () => void
}

function getBrainApi(): BrainApi | undefined {
  return (window as unknown as { api?: { brain?: BrainApi } }).api?.brain
}

/** Bind an optional preload method for query()/invoke(); `undefined` makes them report the missing handler. */
function bound<A extends unknown[], R>(
  fn: ((...args: A) => Promise<R>) | undefined,
  ...args: A
): (() => Promise<R>) | undefined {
  return fn ? () => fn(...args) : undefined
}

function statusLine(s: BrainStatus): string {
  const notes = s.notesIndexed === 1 ? t('1 note indexed') : tf('{n} notes indexed', { n: s.notesIndexed })
  const graph = tf('{entities} entities / {links} links built', { entities: s.graphNodes, links: s.graphEdges })
  return `${notes} · ${graph}`
}

export function BrainSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [brainUrl, setBrainUrl] = useState('')
  const [graphUrl, setGraphUrl] = useState('')
  const [testing, setTesting] = useState(false)
  const [testState, setTestState] = useState<TestState>(null)
  const chatEndpointRef = useRef<HTMLInputElement>(null)

  const [reindexing, setReindexing] = useState(false)
  // Rich brain status (notes indexed + graph counts + whether a model is available).
  const [status, setStatus] = useState<PanelStatus<BrainStatus>>(panelLoading())
  const [building, setBuilding] = useState(false)
  const [buildMsg, setBuildMsg] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [backups, setBackups] = useState<PanelStatus<Backup[]>>(panelLoading())

  // "Import from Codex" — null until the operator asks; then a read with its own states.
  const [detected, setDetected] = useState<PanelStatus<DetectedSystem[]> | null>(null)
  const [importingKey, setImportingKey] = useState<string | null>(null)
  // The endpoint fields are the advanced "connect an external brain" path — collapsed by
  // default so the panel leads with the one folder control.
  const [showAdvanced, setShowAdvanced] = useState(false)

  const notesDir = settings.localBrainNotesDir ?? ''
  // The built-in brain powers chat and the graph only while no EXTERNAL endpoint is saved.
  const usingExternalBrain = isExternalBrainUrl(settings.brainUrl ?? '')

  // Seed the endpoint drafts from persisted settings once they load.
  useEffect(() => {
    if (!loaded) return
    setBrainUrl(settings.brainUrl ?? '')
    setGraphUrl(settings.brainGraphUrl ?? '')
  }, [loaded, settings.brainUrl, settings.brainGraphUrl])

  const refreshStatus = useCallback(async (): Promise<void> => {
    const r = await query('brain status', bound(getBrainApi()?.status))
    setStatus(panelFromResult(r))
  }, [])

  // Memory backups — how many exist and when the newest was taken.
  const refreshBackups = useCallback(async (): Promise<void> => {
    const r = await query('memory backups', bound(getBrainApi()?.moatBackups))
    setBackups(panelFromResult(r))
  }, [])

  // Pull the status on load while the local brain is active, and re-pull whenever the
  // index or graph changes (reindex, build, import) via the brain:updated broadcast.
  useEffect(() => {
    if (!loaded || usingExternalBrain) return
    void refreshStatus()
    void refreshBackups()
    const off = getBrainApi()?.onUpdated?.(() => {
      void refreshStatus()
      void refreshBackups()
    })
    return () => {
      if (off) off()
    }
  }, [loaded, usingExternalBrain, notesDir, refreshStatus, refreshBackups])

  const runReindex = async (): Promise<void> => {
    setReindexing(true)
    try {
      const r = await invoke('reindex notes', bound(getBrainApi()?.reindex))
      toast.success(r.count === 1 ? t('Indexed 1 note file') : tf('Indexed {n} note files', { n: r.count }))
      void refreshStatus()
    } catch (e) {
      toast.error(describeError(e, t('Could not reindex the notes folder')))
    } finally {
      setReindexing(false)
    }
  }

  // "Build my brain" — one model pass over the raw indexed notes. Key-gated: status 'no-model'
  // shows the connect-a-model hint instead of an error. On success main broadcasts
  // brain:updated, which the onUpdated listener turns into a refresh.
  const handleBuild = async (): Promise<void> => {
    setBuilding(true)
    setBuildMsg(t('Building…'))
    try {
      const r = await invoke('build brain', bound(getBrainApi()?.build))
      if (r.status === 'no-model') {
        setBuildMsg(t('Connect an AI model to build from raw notes.'))
      } else if (r.status === 'model-error') {
        setBuildMsg(t('Your AI provider rejected the request — check your account balance or quota.'))
        toast.error(t('Brain build failed: your AI provider rejected the request (check balance or quota).'))
      } else if (r.status === 'kept-cache') {
        // The run finished but a clobber guard refused to overwrite the existing graph
        // (dropped/truncated batches would have blanked it). Nothing changed, so this is
        // neither a success nor a provider failure.
        setBuildMsg(t('Kept your existing graph — this run came back incomplete, so nothing was overwritten.'))
        toast.warning(t('Brain build incomplete — your existing graph was kept.'))
      } else {
        setBuildMsg(tf('Built {entities} entities, {links} links', { entities: r.entities, links: r.edges }))
        toast.success(tf('Brain built: {entities} entities, {links} links', { entities: r.entities, links: r.edges }))
      }
      void refreshStatus()
    } catch (e) {
      setBuildMsg(null)
      toast.error(describeError(e, t('Could not build the brain')))
    } finally {
      setBuilding(false)
    }
  }

  const handleRestore = async (): Promise<void> => {
    if (
      !window.confirm(
        t('Restore your memory from the newest automatic backup? This replaces what DUIN has learned and the graph with that snapshot.')
      )
    ) {
      return
    }
    setRestoring(true)
    try {
      const r = await invoke('restore memory', bound(getBrainApi()?.restoreMoat))
      const skipped = r.skipped ?? []
      if (r.restored.length > 0) {
        const base = tf('Restored: {items}. Restart DUIN to fully reload the graph.', { items: r.restored.join(', ') })
        // A PARTIAL restore must not read as a complete one: name what had a backup but
        // could not be written back, rather than letting it vanish from the report.
        if (skipped.length > 0) {
          toast.warning(
            tf('{base} NOT restored: {items} — {reason}', {
              base,
              items: skipped.map((s) => s.label).join(', '),
              reason: skipped[0].reason
            })
          )
        } else {
          toast.success(base)
        }
        void refreshStatus()
      } else if (skipped.length > 0) {
        toast.error(
          tf('Nothing was restored. {items} have backups but could not be written back — {reason}', {
            items: skipped.map((s) => s.label).join(', '),
            reason: skipped[0].reason
          })
        )
      } else {
        toast.info(t('No backup found to restore yet.'))
      }
    } catch (e) {
      toast.error(describeError(e, t('Could not restore the backup')))
    } finally {
      setRestoring(false)
    }
  }

  // Active-brain switch. The built-in brain powers chat + graph ONLY while no external
  // endpoint is saved; these two affordances make that explicit and switchable.
  const handleUseLocalBrain = async (): Promise<void> => {
    if (!usingExternalBrain) return
    const saved = await updateSettings({ brainUrl: '', brainGraphUrl: '' })
    if (!saved) return
    setBrainUrl('')
    setGraphUrl('')
    setTestState(null)
    toast.success(t('Now using your local brain. Restart DUIN to point the graph at it.'))
  }

  const handleUseExternalBrain = (): void => {
    // Reveal the endpoint fields and put the cursor in the first one. The field is seeded
    // EMPTY: nothing is persisted until Save, and no address is suggested — the local
    // brain's own address is exactly the one that must not be typed here.
    setShowAdvanced(true)
    setTimeout(() => chatEndpointRef.current?.focus(), 0)
  }

  const handleChooseFolder = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.pickFolder) {
      toast.error(t('Choosing a folder is only available in the desktop app.'))
      return
    }
    const r = await api.pickFolder()
    if (!r.success) {
      toast.error(r.error ?? t('Could not open the folder picker'))
      return
    }
    if (r.data == null) return // cancelled
    // Persist via the same updateSettings path every other field uses. Main auto-indexes
    // + (key-gated) auto-builds the graph on this change and broadcasts brain:updated, so
    // picking a folder "just works" with no manual Reindex step.
    setReindexing(true)
    const saved = await updateSettings({ localBrainNotesDir: r.data })
    if (!saved) {
      setReindexing(false)
      return
    }
    // The brain folder IS the connected folder — point the agent's working directory at it
    // too, so the composer's folder chip reflects what you connected.
    try {
      await (
        window as unknown as { api?: { files?: { setWorkdir?: (p: string) => Promise<unknown> } } }
      ).api?.files?.setWorkdir?.(r.data)
    } catch {
      /* non-fatal — the workdir is a convenience mirror of the brain folder */
    }
    toast.success(t('Notes folder linked and indexed; the brain build continues in the background'))
    setReindexing(false)
  }

  const handleDetectImports = async (): Promise<void> => {
    setDetected(panelLoading())
    const r = await query('Codex setups', bound(getBrainApi()?.detectImports))
    setDetected(panelFromResult(r))
  }

  const handleImport = async (sys: DetectedSystem, mode: 'link' | 'copy'): Promise<void> => {
    const key = `${sys.adapter}:${sys.dir}:${mode}`
    setImportingKey(key)
    try {
      const r = await invoke(
        'import setup',
        bound(getBrainApi()?.import, { adapterId: sys.adapter, sourceDir: sys.dir, mode })
      )
      if (!r.ok) {
        toast.error(r.error ?? t('Import failed'))
        return
      }
      const s = r.summary
      const bits = [
        s.identity ? t('identity') : null,
        s.memory ? tf('{n} memories', { n: s.memory }) : null,
        s.skills ? tf('{n} skills', { n: s.skills }) : null,
        s.agents ? tf('{n} agents', { n: s.agents }) : null,
        s.hooks ? tf('{n} hooks', { n: s.hooks }) : null
      ].filter(Boolean)
      const name = sys.label.split(' at ')[0]
      // `replaced` means a pre-existing hand-written .brain/identity.md was overwritten by
      // this import. It was snapshotted into <vault>/.trash first — say so, because an
      // alteration the operator can't see isn't traceable.
      toast.success(
        (mode === 'link' ? tf('Linked {name}', { name }) : tf('Imported {name}', { name })) +
          (bits.length ? ` — ${bits.join(', ')}` : '') +
          (r.replaced ? ' ' + tf('(previous identity saved to {path})', { path: r.replaced }) : '')
      )
    } catch (e) {
      toast.error(describeError(e, t('Import failed')))
    } finally {
      setImportingKey(null)
    }
  }

  // Scaffold — turn a folder of raw notes into a brain folder, IN PLACE by default (the
  // brain folder IS the harness). The source starts as the notes folder chosen above.
  const [scaffoldSrc, setScaffoldSrc] = useState('')
  const [scaffoldOut, setScaffoldOut] = useState('')
  const [useSeparateOut, setUseSeparateOut] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [scaffoldResult, setScaffoldResult] = useState<ScaffoldResult | null>(null)
  const seededFrom = useRef('')
  useEffect(() => {
    // Follow the notes folder until the operator picks a different source by hand.
    if (!notesDir) return
    if (scaffoldSrc === '' || scaffoldSrc === seededFrom.current) {
      seededFrom.current = notesDir
      setScaffoldSrc(notesDir)
    }
  }, [notesDir, scaffoldSrc])

  const pickScaffoldFolder = async (which: 'src' | 'out'): Promise<void> => {
    const api = getBrainApi()
    if (!api?.pickFolder) {
      toast.error(t('Choosing a folder is only available in the desktop app.'))
      return
    }
    const r = await api.pickFolder()
    if (!r.success) {
      toast.error(r.error ?? t('Could not open the folder picker'))
      return
    }
    if (r.data == null) return // cancelled
    if (which === 'src') setScaffoldSrc(r.data)
    else setScaffoldOut(r.data)
  }

  const handleScaffold = async (): Promise<void> => {
    if (!scaffoldSrc.trim()) {
      toast.error(t('Choose a notes folder to scaffold.'))
      return
    }
    if (useSeparateOut && !scaffoldOut.trim()) {
      toast.error(t('Choose an output folder, or turn off the separate output folder to build in place.'))
      return
    }
    setScaffolding(true)
    setScaffoldResult(null)
    try {
      // outDir omitted ⇒ in place. Only send a separate outDir when the operator opted in.
      const r = await invoke(
        'scaffold brain folder',
        bound(getBrainApi()?.scaffoldHarness, {
          srcDir: scaffoldSrc.trim(),
          outDir: useSeparateOut ? scaffoldOut.trim() : undefined
        })
      )
      if (!r.ok) {
        toast.error(r.error ?? t('Scaffold failed'))
        return
      }
      setScaffoldResult(r)
      toast.success(
        tf('Scaffolded — {notes} notes filed, {tracks} tracks', {
          notes: r.counts.notes ?? 0,
          tracks: r.tracks.length
        })
      )
    } catch (e) {
      toast.error(describeError(e, t('Scaffold failed')))
    } finally {
      setScaffolding(false)
    }
  }

  const chatError = endpointError(brainUrl)
  const graphError = endpointError(graphUrl)
  const dirty =
    brainUrl.trim() !== (settings.brainUrl ?? '') || graphUrl.trim() !== (settings.brainGraphUrl ?? '')
  useDirtyGuard('settings:brain:endpoints', t('the brain endpoint fields'), dirty)

  const handleSave = async (): Promise<void> => {
    if (chatError || graphError) return
    const saved = await updateSettings({
      brainUrl: brainUrl.trim(),
      brainGraphUrl: graphUrl.trim()
    })
    // The graph reads its origin once per load (main.ts did-finish-load), so it keeps the
    // old brain until the app relaunches. Say so, or the operator watches for a change
    // that cannot happen yet.
    if (saved) toast.success(t('Brain settings saved. Restart DUIN to point the graph at the new brain.'))
  }

  const handleTest = async (): Promise<void> => {
    const endpoint = brainUrl.trim() || DEFAULT_BRAIN_URL
    setTesting(true)
    setTestState(null)
    const r = await query('brain connection test', bound(getBrainApi()?.testConnection, endpoint))
    setTestState(r.ok ? r.data : { ok: false, detail: r.error })
    setTesting(false)
  }

  const restoreDisabled = restoring || backups.phase !== 'ready' || backups.data.length === 0

  return (
    <SettingsPage
      purpose={t('Point DUIN at a folder of your notes. It indexes them, builds a graph it reasons over, and keeps both in sync as you edit.')}
    >
      <SettingsSection label={t('Active brain')}>
        <SettingsRow
          label={t('Which brain answers')}
          hint={
            usingExternalBrain
              ? tf('External brain at {url}. Chat and the graph come from it; the notes folder below is ignored.', {
                  url: settings.brainUrl ?? ''
                })
              : t('The built-in brain, reading the notes folder below.')
          }
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant={usingExternalBrain ? 'secondary' : 'primary'}
                aria-pressed={!usingExternalBrain}
                disabled={!usingExternalBrain}
                onClick={() => void handleUseLocalBrain()}
              >
                {t('Use local brain')}
              </Button>
              <Button
                size="sm"
                variant={usingExternalBrain ? 'primary' : 'secondary'}
                aria-pressed={usingExternalBrain}
                onClick={handleUseExternalBrain}
              >
                {t('Use external brain')}
              </Button>
            </div>
          }
        />
      </SettingsSection>

      <SettingsSection label={t('Notes folder')}>
        <SettingsRow
          label={t('Folder')}
          hint={t('A folder of Markdown notes. DUIN indexes it so chat is grounded in your notes and the graph shows them.')}
          control={
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleChooseFolder()}>
                {t('Choose folder…')}
              </Button>
              <Button size="sm" onClick={() => void runReindex()} disabled={reindexing || !notesDir}>
                {reindexing ? t('Reindexing…') : t('Reindex')}
              </Button>
            </div>
          }
        >
          <div className="space-y-2">
            <Input
              readOnly
              aria-label={t('Notes folder path')}
              value={notesDir}
              placeholder={t('No folder selected')}
              className="font-mono"
            />
            {usingExternalBrain ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('Using an external brain — the notes folder is ignored while its endpoint is set.')}
              </p>
            ) : !notesDir ? (
              <p className="text-[12px] text-[var(--text-muted)]">
                {t('No folder yet — the graph is empty until you choose one.')}
              </p>
            ) : (
              <PanelState
                state={status}
                loading={<SettingsLoading what={t('the brain status')} />}
                error={(message, retry) => (
                  <SettingsLoadError what={t('the brain status')} message={message} onRetry={retry} />
                )}
                onRetry={() => void refreshStatus()}
                empty={<p className="text-[12px] text-[var(--text-muted)]">{t('Nothing indexed yet.')}</p>}
              >
                {(s) => <p className="text-[12px] text-[var(--text-secondary)]">{statusLine(s)}</p>}
              </PanelState>
            )}
          </div>
        </SettingsRow>

        {!usingExternalBrain && (
          <>
            <SettingsRow
              label={t('Build the graph')}
              hint={t('One pass of your AI model over the indexed notes, to build the graph DUIN reasons over.')}
              control={
                <Button size="sm" variant="primary" onClick={() => void handleBuild()} disabled={building || !notesDir}>
                  {building ? t('Building…') : t('Build my brain')}
                </Button>
              }
            >
              {buildMsg ? (
                <p className="text-[12px] text-[var(--text-muted)]">{buildMsg}</p>
              ) : status.phase === 'ready' && !status.data.hasModel ? (
                <p className="text-[12px] text-[var(--text-muted)]">
                  {t('Connect an AI model to build from raw notes.')}{' '}
                  <SettingsLink tab="api">{t('Open API Keys')}</SettingsLink>
                </p>
              ) : null}
            </SettingsRow>

            <SettingsRow
              label={t('Restore memory from backup')}
              hint={t('A backup is taken before every reindex. Restoring replaces what DUIN has learned with the newest one.')}
              control={
                <Button size="sm" onClick={() => void handleRestore()} disabled={restoreDisabled}>
                  {restoring ? t('Restoring…') : t('Restore')}
                </Button>
              }
            >
              <PanelState
                state={backups}
                loading={<SettingsLoading what={t('backups')} />}
                error={(message, retry) => (
                  <SettingsLoadError what={t('the backups')} message={message} onRetry={retry} />
                )}
                onRetry={() => void refreshBackups()}
                empty={
                  <p className="text-[12px] text-[var(--text-muted)]">
                    {t('No automatic backups yet — one is taken before each reindex.')}
                  </p>
                }
              >
                {(list) => {
                  const newest = Math.max(...list.map((b) => b.mtimeMs))
                  return (
                    <p className="text-[12px] text-[var(--text-muted)]">
                      {list.length === 1 ? t('1 backup available') : tf('{n} backups available', { n: list.length })}
                      {' · '}
                      {tf('newest {time}', { time: new Date(newest).toLocaleString() })}
                    </p>
                  )
                }}
              </PanelState>
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection label={t('Import from Codex')}>
        <SettingsRow
          label={t('Bring in your Codex AGENTS.md')}
          hint={t('Already use Codex? DUIN can bring in your AGENTS.md as its identity file. Link keeps reading the original; Copy makes a snapshot in your vault.')}
          control={
            <Button size="sm" onClick={() => void handleDetectImports()} disabled={detected?.phase === 'loading'}>
              {detected?.phase === 'loading' ? t('Scanning…') : t('Look for a Codex setup')}
            </Button>
          }
        >
          {detected && (
            <PanelState
              state={detected}
              loading={<SettingsLoading what={t('Codex setups')} />}
              error={(message, retry) => (
                <SettingsLoadError what={t('Codex setups')} message={message} onRetry={retry} />
              )}
              onRetry={() => void handleDetectImports()}
              empty={
                <p className="text-[12px] text-[var(--text-muted)]">
                  {t('Nothing to import — no Codex setup was found in ~/.codex or an AGENTS.md in your vault.')}
                </p>
              }
            >
              {(list) => (
                <ul className="space-y-2">
                  {list.map((sys) => {
                    const c = sys.contains
                    const summary = [
                      c.identity ? t('identity') : null,
                      c.memory ? tf('{n} memories', { n: c.memory }) : null,
                      c.skills ? tf('{n} skills', { n: c.skills }) : null,
                      c.agents ? tf('{n} agents', { n: c.agents }) : null,
                      c.hooks ? tf('{n} hooks', { n: c.hooks }) : null
                    ].filter(Boolean)
                    const linkKey = `${sys.adapter}:${sys.dir}:link`
                    const copyKey = `${sys.adapter}:${sys.dir}:copy`
                    return (
                      <li
                        key={`${sys.adapter}:${sys.dir}`}
                        className="rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2"
                      >
                        <div className="font-mono text-[12px] text-[var(--text-primary)]">{sys.label}</div>
                        <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                          {summary.length
                            ? tf('Contains: {items}', { items: summary.join(' · ') })
                            : t('Nothing importable found')}
                        </div>
                        <div className="mt-1.5 flex gap-2">
                          <Button size="sm" onClick={() => void handleImport(sys, 'link')} disabled={importingKey != null}>
                            {importingKey === linkKey ? t('Linking…') : t('Link')}
                          </Button>
                          <Button size="sm" onClick={() => void handleImport(sys, 'copy')} disabled={importingKey != null}>
                            {importingKey === copyKey ? t('Copying…') : t('Copy')}
                          </Button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </PanelState>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection label={t('Scaffold')}>
        <SettingsRow
          label={t('Organise a folder of notes into a brain folder')}
          hint={
            <>
              {t('Turns a plain folder of notes into a DUIN brain folder, in place.')}{' '}
              {t('Notes move into a few standard folders; nothing is deleted until its copy is verified.')}{' '}
              {t('It also writes the foundation files (BRAIN, ME, GOALS, VAULT-MAP) and a DIAGNOSIS.md next to them.')}{' '}
              {t('With an AI model connected it drafts your tracks, a short bio, and the people and projects in your notes.')}
            </>
          }
          control={
            <Button
              size="sm"
              variant="primary"
              onClick={() => void handleScaffold()}
              disabled={scaffolding || !scaffoldSrc || (useSeparateOut && !scaffoldOut)}
            >
              {scaffolding ? t('Scaffolding…') : t('Scaffold')}
            </Button>
          }
        >
          <div className="space-y-2">
            <div className="flex gap-2">
              <Input
                readOnly
                aria-label={t('Folder to scaffold')}
                value={scaffoldSrc}
                placeholder={t('Your notes folder')}
                className="font-mono"
              />
              <Button size="sm" onClick={() => void pickScaffoldFolder('src')}>
                {t('Choose folder…')}
              </Button>
            </div>
            <label
              htmlFor="brain-scaffold-separate-out"
              className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]"
            >
              <Toggle
                id="brain-scaffold-separate-out"
                checked={useSeparateOut}
                onChange={setUseSeparateOut}
                aria-label={t('Scaffold into a separate output folder')}
              />
              <span>{t('Scaffold into a separate output folder instead (leaves your source untouched)')}</span>
            </label>
            {useSeparateOut && (
              <div className="flex gap-2">
                <Input
                  readOnly
                  aria-label={t('Output folder')}
                  value={scaffoldOut}
                  placeholder={t('Output folder')}
                  className="font-mono"
                />
                <Button size="sm" onClick={() => void pickScaffoldFolder('out')}>
                  {t('Choose output…')}
                </Button>
              </div>
            )}
            {scaffoldResult?.ok && (
              <div className="space-y-1 rounded-md border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2 text-[12px]">
                <div className="font-mono text-[11px] text-[var(--text-primary)]">
                  {useSeparateOut && scaffoldOut
                    ? tf('Scaffolded into {folder}', { folder: scaffoldOut })
                    : tf('Scaffolded in place — {folder}', { folder: scaffoldSrc })}
                </div>
                <div className="text-[var(--text-secondary)]">
                  {Object.entries(scaffoldResult.counts)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(' · ')}
                </div>
                {scaffoldResult.tracks.length > 0 && (
                  <div className="text-[var(--text-secondary)]">
                    {tf('Tracks: {list}', { list: scaffoldResult.tracks.join(' · ') })}
                  </div>
                )}
                <div className="text-[11px] text-[var(--text-muted)]">
                  {t('Diagnosis:')} <span className="font-mono">{scaffoldResult.diagnosisPath}</span>
                </div>
              </div>
            )}
          </div>
        </SettingsRow>
      </SettingsSection>

      {/* Advanced — an external brain. The Save row lives INSIDE the disclosure: it only
          ever saves these two fields, so a Save button sitting under a collapsed section
          read as "save the page" and did nothing visible. */}
      <details open={showAdvanced} onToggle={(e) => setShowAdvanced(e.currentTarget.open)} className="group">
        <summary className="cursor-pointer list-none text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]">
          <span aria-hidden className="mr-1.5 inline-block transition-transform group-open:rotate-90">
            ▸
          </span>
          {t('Advanced — connect an external brain')}
        </summary>
        <div className="mt-3">
          <SettingsSection
            label={t('External brain')}
            description={t('Point chat and the graph at a brain running elsewhere. Leave both fields blank to use the built-in brain on this computer.')}
          >
            <SettingsRow
              label={t('Chat endpoint')}
              hint={t('The address DUIN sends chat to. Leave blank for the built-in brain (or the DUIN_BRAIN_URL environment variable when set).')}
            >
              <div className="space-y-1">
                <div className="flex gap-2">
                  <Input
                    id="brain-chat-endpoint"
                    ref={chatEndpointRef}
                    aria-label={t('Chat endpoint')}
                    aria-invalid={chatError !== ''}
                    value={brainUrl}
                    onChange={(e) => {
                      setBrainUrl(e.target.value)
                      setTestState(null)
                    }}
                    placeholder={t('https://your-brain.example/agui')}
                    className="font-mono"
                  />
                  <Button size="sm" onClick={() => void handleTest()} disabled={testing || chatError !== ''}>
                    {testing ? t('Testing…') : t('Test connection')}
                  </Button>
                </div>
                {chatError && <p className="text-[12px] text-[var(--error)]">{chatError}</p>}
                {testState && (
                  <p className={`text-[12px] ${testState.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
                    {testState.ok ? t('Connected') : t('Unreachable')} — {testState.detail}
                  </p>
                )}
              </div>
            </SettingsRow>

            <SettingsRow
              label={t('Graph origin (optional)')}
              hint={t('Brain origin used for the graph; chat follows it unless a chat endpoint is set above.')}
            >
              <div className="space-y-1">
                <Input
                  id="brain-graph-origin"
                  aria-label={t('Graph origin')}
                  aria-invalid={graphError !== ''}
                  value={graphUrl}
                  onChange={(e) => setGraphUrl(e.target.value)}
                  placeholder={t('https://your-brain.example')}
                  className="font-mono"
                />
                {graphError && <p className="text-[12px] text-[var(--error)]">{graphError}</p>}
              </div>
            </SettingsRow>

            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => void handleSave()}
                disabled={!dirty || chatError !== '' || graphError !== ''}
              >
                {t('Save')}
              </Button>
              {dirty && (
                <span className="font-mono text-[12px] text-[var(--text-muted)]">{t('Unsaved changes')}</span>
              )}
            </div>
          </SettingsSection>
        </div>
      </details>
    </SettingsPage>
  )
}
