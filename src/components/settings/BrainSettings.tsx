import { t } from '@/lib/i18n'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import { Toggle } from '@/components/ui/Toggle'
import { useSettingsStore } from '@/stores/settings-store'
import { toast } from '@/stores/toast-store'

// Brain settings — point DUIN at an agent/DUIN brain.
//
// The brain is the connector that powers the `duin-brain` model (the default
// for new conversations). This panel persists two URLs to the app settings
// store (mirroring every other settings tab via useSettingsStore.updateSettings,
// which calls window.api.settings.set):
//   - brainUrl       — the AG-UI chat endpoint (default http://127.0.0.1:8799/agui)
//   - brainGraphUrl  — an optional live graph endpoint for the Brain view
//                      (empty = the bundled demo graph)
//
// "Test connection" probes the endpoint in the MAIN process (no renderer CORS)
// via window.api.brain.testConnection, which GETs the derived /health and falls
// back to a trivial POST. It's non-blocking — the rest of the panel stays usable.

// Must match DEFAULT_BRAIN in electron/services/duin-bridge.ts. This used to say
// :8765 — the retired python sidecar's stub port — so the panel displayed, and
// on blur RE-SAVED, a value that resolveBrainUrl() silently throws away and
// coerces back to :8799. Behaviour was already :8799; only the display lied.
const DEFAULT_BRAIN_URL = 'http://127.0.0.1:8799/agui'

type TestState = { ok: boolean; detail: string } | null

// Narrow accessor for the local-brain preload surface (pickFolder / reindex /
// localStatus / import). Typed inline so this component doesn't depend on the
// main process's preload type across the tsconfig boundary.
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
type BrainApi = {
  pickFolder?: () => Promise<{ success: boolean; data?: string | null; error?: string }>
  reindex?: () => Promise<{ success: boolean; data?: { ok: boolean; count: number }; error?: string }>
  localStatus?: () => Promise<{ success: boolean; data?: { indexed: number }; error?: string }>
  status?: () => Promise<{ success: boolean; data?: BrainStatus; error?: string }>
  build?: () => Promise<{ success: boolean; data?: BuildResult; error?: string }>
  moatBackups?: () => Promise<{
    success: boolean
    data?: Array<{ label: string; name: string; path: string; size: number; mtimeMs: number }>
    error?: string
  }>
  restoreMoat?: (label?: string) => Promise<{ success: boolean; data?: { restored: string[]; skipped?: Array<{ label: string; reason: string }> }; error?: string }>
  detectImports?: () => Promise<{ success: boolean; data?: DetectedSystem[]; error?: string }>
  import?: (payload: {
    adapterId: string
    sourceDir: string
    mode: 'link' | 'copy'
  }) => Promise<{ success: boolean; data?: ImportSummary; error?: string }>
  scaffoldHarness?: (args: {
    srcDir: string
    outDir?: string
  }) => Promise<{ success: boolean; data?: ScaffoldResult; error?: string }>
}

type ScaffoldResult = {
  ok: boolean
  counts: Record<string, number>
  tracks: string[]
  diagnosisPath: string
  error?: string
}

function getBrainApi(): BrainApi | undefined {
  return (window as unknown as { api?: { brain?: BrainApi } }).api?.brain
}

export function BrainSettings(): React.ReactElement {
  const settings = useSettingsStore((s) => s.settings)
  const loaded = useSettingsStore((s) => s.loaded)
  const updateSettings = useSettingsStore((s) => s.updateSettings)

  const [brainUrl, setBrainUrl] = useState('')
  const [graphUrl, setGraphUrl] = useState('')
  const [testing, setTesting] = useState(false)
  const [testState, setTestState] = useState<TestState>(null)

  const [reindexing, setReindexing] = useState(false)
  const [indexedCount, setIndexedCount] = useState<number | null>(null)

  // Rich brain status (notes indexed + graph node/edge counts + whether a model
  // is available) for the status line + "Build my brain" affordance.
  const [status, setStatus] = useState<BrainStatus | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildMsg, setBuildMsg] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [backupCount, setBackupCount] = useState<number | null>(null)
  const [latestBackupAt, setLatestBackupAt] = useState<number | null>(null)

  // "Import existing setup" — absorb a Codex agent system into the `.brain/`
  // harness root so DUIN is instantly grounded in who the user is.
  const [detecting, setDetecting] = useState(false)
  const [detected, setDetected] = useState<DetectedSystem[] | null>(null)
  const [importingKey, setImportingKey] = useState<string | null>(null)
  // Endpoint config is for the advanced "connect an external governed brain"
  // path — hidden by default so the panel leads with the one folder control.
  const [showAdvanced, setShowAdvanced] = useState(false)

  const notesDir = settings.localBrainNotesDir ?? ''
  // The local brain only powers chat/graph when no external brain endpoint is
  // configured. Once brainUrl is set, the external brain owns everything.
  const usingExternalBrain = (settings.brainUrl ?? '').trim() !== ''

  // Seed local drafts from persisted settings once they load.
  useEffect(() => {
    if (!loaded) return
    setBrainUrl(settings.brainUrl ?? '')
    setGraphUrl(settings.brainGraphUrl ?? '')
  }, [loaded, settings.brainUrl, settings.brainGraphUrl])

  // Surface the current indexed-note count for the status line.
  useEffect(() => {
    if (!loaded || usingExternalBrain) return
    void getBrainApi()
      ?.localStatus?.()
      .then((r) => {
        if (r?.success && r.data) setIndexedCount(r.data.indexed)
      })
      .catch(() => {
        /* desktop-only; ignore in web */
      })
  }, [loaded, usingExternalBrain, notesDir])

  const refreshStatus = (): void => {
    void getBrainApi()
      ?.status?.()
      .then((r) => {
        if (r?.success && r.data) {
          setStatus(r.data)
          setIndexedCount(r.data.notesIndexed)
        }
      })
      .catch(() => {
        /* desktop-only; ignore in web */
      })
  }

  // Pull the rich status (graph counts + hasModel) on load + when the local
  // brain is active, and re-pull whenever the brain index/graph changes
  // (reindex, build, import) via the brain:updated broadcast.
  useEffect(() => {
    if (!loaded || usingExternalBrain) return
    refreshStatus()
    void refreshBackups()
    const api = (window as unknown as { api?: { brain?: { onUpdated?: (cb: () => void) => () => void } } }).api
    const off = api?.brain?.onUpdated?.(() => {
      refreshStatus()
      void refreshBackups()
    })
    return () => {
      if (off) off()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, usingExternalBrain, notesDir])

  const runReindex = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.reindex) {
      toast.error('Reindex is only available in the desktop app.')
      return
    }
    setReindexing(true)
    try {
      const r = await api.reindex()
      if (r.success && r.data) {
        setIndexedCount(r.data.count)
        toast.success(`Indexed ${r.data.count} note file${r.data.count === 1 ? '' : 's'}`)
      } else {
        toast.error(r.error ?? 'Reindex failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setReindexing(false)
    }
  }

  // "Build my brain" — one LLM construction pass over the raw indexed notes.
  // Key-gated: status 'no-model' shows the connect-a-model hint instead of an
  // error. On success the main process broadcasts brain:updated, which our
  // onUpdated listener turns into a refreshStatus().
  const handleBuild = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.build) {
      toast.error('Build is only available in the desktop app.')
      return
    }
    setBuilding(true)
    setBuildMsg('Building…')
    try {
      const r = await api.build()
      if (r.success && r.data) {
        if (r.data.status === 'no-model') {
          setBuildMsg('Connect an AI model in API Keys to build from raw notes.')
        } else if (r.data.status === 'model-error') {
          setBuildMsg('Your AI provider rejected the request — check your account balance or quota.')
          toast.error('Brain build failed: your AI provider rejected the request (check balance/quota).')
        } else if (r.data.status === 'kept-cache') {
          // The run finished but a clobber guard refused to overwrite the existing graph
          // (dropped/truncated batches would have blanked it). Nothing changed, so this is
          // neither a success nor a provider failure. It reported as 'built' before, which
          // showed the user a SUCCESS toast reading "Built 0 entities, 0 links".
          setBuildMsg('Kept your existing graph — this run came back incomplete, so nothing was overwritten.')
          toast.warning('Brain build incomplete — your existing graph was kept.')
        } else {
          setBuildMsg(`Built ${r.data.entities} entities, ${r.data.edges} links`)
          toast.success(`Brain built: ${r.data.entities} entities, ${r.data.edges} links`)
        }
        refreshStatus()
      } else {
        setBuildMsg(null)
        toast.error(r.error ?? 'Build my brain failed')
      }
    } catch (err) {
      setBuildMsg(null)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBuilding(false)
    }
  }

  // Moat recovery — how many auto-backups exist and when the newest was taken.
  const refreshBackups = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.moatBackups) return
    try {
      const r = await api.moatBackups()
      if (r.success && r.data) {
        setBackupCount(r.data.length)
        setLatestBackupAt(r.data.length > 0 ? Math.max(...r.data.map((b) => b.mtimeMs)) : null)
      }
    } catch {
      /* non-fatal */
    }
  }

  const handleRestore = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.restoreMoat) {
      toast.error('Restore is only available in the desktop app.')
      return
    }
    if (!window.confirm('Restore your memory from the most recent automatic backup? This replaces the current claim ledger and construction graph with the last good snapshot.')) {
      return
    }
    setRestoring(true)
    try {
      const r = await api.restoreMoat()
      const skipped = r.data?.skipped ?? []
      if (r.success && r.data && r.data.restored.length > 0) {
        const base = `Restored: ${r.data.restored.join(', ')}. Relaunch to fully reload the graph.`
        // A PARTIAL restore must not read as a complete one: name what had a backup
        // but could not be written back, rather than letting it vanish from the report.
        if (skipped.length > 0) {
          toast.warning(
            `${base} NOT restored: ${skipped.map((s) => s.label).join(', ')} — ${skipped[0].reason}`
          )
        } else {
          toast.success(base)
        }
        refreshStatus()
      } else if (r.success && skipped.length > 0) {
        toast.error(
          `Nothing was restored. ${skipped.map((s) => s.label).join(', ')} have backups but could not be written back — ${skipped[0].reason}`
        )
      } else if (r.success) {
        toast.info('No backup found to restore yet.')
      } else {
        toast.error(r.error ?? 'Restore failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setRestoring(false)
    }
  }

  // Active-brain switch. The local brain (over the notes folder) powers chat +
  // graph ONLY when brainUrl is empty; once set, the external brain owns
  // everything. These two affordances make that explicit + switchable.
  const handleUseLocalBrain = async (): Promise<void> => {
    if (!usingExternalBrain) return
    const saved = await updateSettings({ brainUrl: '', brainGraphUrl: '' })
    if (!saved) return
    setBrainUrl('')
    setGraphUrl('')
    setTestState(null)
    toast.success('Now using your local brain (over your notes folder)')
  }

  const handleUseExternalBrain = (): void => {
    // Reveal the endpoint fields and seed the default so the user can fill it
    // in; nothing is persisted until they Save (keeps the existing flow intact).
    setShowAdvanced(true)
    if (brainUrl.trim() === '') setBrainUrl(DEFAULT_BRAIN_URL)
  }

  const handleChooseFolder = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.pickFolder) {
      toast.error('Folder picker is only available in the desktop app.')
      return
    }
    const r = await api.pickFolder()
    if (!r.success) {
      toast.error(r.error ?? 'Folder picker failed')
      return
    }
    if (r.data == null) return // cancelled
    // Persist via the same updateSettings path every other field uses. The main
    // process auto-indexes + (key-gated) auto-builds the graph on this change and
    // broadcasts brain:updated, which our onUpdated listener turns into a status
    // refresh — so picking a folder "just works" with no manual Reindex step.
    setReindexing(true)
    const saved = await updateSettings({ localBrainNotesDir: r.data })
    if (!saved) {
      setReindexing(false)
      return
    }
    // The brain folder IS the connected folder — point the agent's working
    // directory at it too, so the composer's folder chip reflects what you
    // connected (not a stale prior workdir like "legacy").
    try {
      await (window as unknown as {
        api?: { files?: { setWorkdir?: (p: string) => Promise<unknown> } }
      }).api?.files?.setWorkdir?.(r.data)
    } catch {
      /* non-fatal — workdir is a convenience mirror of the brain folder */
    }
    toast.success('Notes folder linked and indexed; brain build continues in the background')
    setReindexing(false)
  }

  const handleDetectImports = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.detectImports) {
      toast.error('Import is only available in the desktop app.')
      return
    }
    setDetecting(true)
    try {
      const r = await api.detectImports()
      if (r.success) {
        setDetected(r.data ?? [])
        if ((r.data ?? []).length === 0) {
          toast.info('No existing agent setups found (looked for ~/.codex).')
        }
      } else {
        toast.error(r.error ?? 'Detect failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setDetecting(false)
    }
  }

  const handleImport = async (sys: DetectedSystem, mode: 'link' | 'copy'): Promise<void> => {
    const api = getBrainApi()
    if (!api?.import) {
      toast.error('Import is only available in the desktop app.')
      return
    }
    const key = `${sys.adapter}:${sys.dir}:${mode}`
    setImportingKey(key)
    try {
      const r = await api.import({ adapterId: sys.adapter, sourceDir: sys.dir, mode })
      if (r.success && r.data?.ok) {
        const s = r.data.summary
        const bits = [
          s.identity ? 'identity' : null,
          s.memory ? `${s.memory} memor${s.memory === 1 ? 'y' : 'ies'}` : null,
          s.skills ? `${s.skills} skill${s.skills === 1 ? '' : 's'}` : null,
          s.agents ? `${s.agents} agent${s.agents === 1 ? '' : 's'}` : null,
          s.hooks ? `${s.hooks} hook${s.hooks === 1 ? '' : 's'}` : null
        ].filter(Boolean)
        // `replaced` means a pre-existing hand-written .brain/identity.md was overwritten by
        // this import. It was snapshotted into <vault>/.trash first — say so, because an
        // alteration the operator can't see isn't traceable, and this is the only place
        // the copy happened.
        toast.success(
          `${mode === 'link' ? 'Linked' : 'Imported'} ${sys.label.split(' at ')[0]}` +
            (bits.length ? ` — ${bits.join(', ')}` : '') +
            (r.data.replaced ? ` (previous identity saved to ${r.data.replaced})` : '')
        )
      } else {
        toast.error(r.data?.error ?? r.error ?? 'Import failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setImportingKey(null)
    }
  }

  // "Scaffold a new harness" — build a full OKF harness from a folder of raw
  // notes (auto-file by kind + foundation files + starter rules + DIAGNOSIS.md).
  // IN-PLACE by default: the brain folder IS the harness, so the output folder
  // is OPTIONAL. Leave it blank to scaffold the source folder in place (notes
  // moved into pillar folders); set a separate output folder for the legacy
  // copy-out. Both pickers reuse the existing pickFolder dialog.
  const [scaffoldSrc, setScaffoldSrc] = useState('')
  const [scaffoldOut, setScaffoldOut] = useState('')
  const [useSeparateOut, setUseSeparateOut] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [scaffoldResult, setScaffoldResult] = useState<ScaffoldResult | null>(null)

  const pickScaffoldFolder = async (which: 'src' | 'out'): Promise<void> => {
    const api = getBrainApi()
    if (!api?.pickFolder) {
      toast.error('Folder picker is only available in the desktop app.')
      return
    }
    const r = await api.pickFolder()
    if (!r.success) {
      toast.error(r.error ?? 'Folder picker failed')
      return
    }
    if (r.data == null) return // cancelled
    if (which === 'src') setScaffoldSrc(r.data)
    else setScaffoldOut(r.data)
  }

  const handleScaffold = async (): Promise<void> => {
    const api = getBrainApi()
    if (!api?.scaffoldHarness) {
      toast.error('Scaffold is only available in the desktop app.')
      return
    }
    if (!scaffoldSrc.trim()) {
      toast.error('Choose a source notes folder.')
      return
    }
    if (useSeparateOut && !scaffoldOut.trim()) {
      toast.error('Choose an output folder, or uncheck "separate output folder" to build in place.')
      return
    }
    setScaffolding(true)
    setScaffoldResult(null)
    try {
      // outDir omitted ⇒ in-place (the brain folder IS the harness). Only send a
      // separate outDir when the user explicitly opted into copy-out.
      const r = await api.scaffoldHarness({
        srcDir: scaffoldSrc.trim(),
        outDir: useSeparateOut ? scaffoldOut.trim() : undefined
      })
      if (r.success && r.data?.ok) {
        setScaffoldResult(r.data)
        const noteCount = r.data.counts.notes ?? 0
        toast.success(
          `Harness scaffolded — ${noteCount} note${noteCount === 1 ? '' : 's'} filed, ${r.data.tracks.length} track${r.data.tracks.length === 1 ? '' : 's'}`
        )
      } else {
        toast.error(r.data?.error ?? r.error ?? 'Scaffold failed')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setScaffolding(false)
    }
  }

  const handleSave = async () => {
    const saved = await updateSettings({
      brainUrl: brainUrl.trim(),
      brainGraphUrl: graphUrl.trim()
    })
    if (saved) toast.success('Brain settings saved')
  }

  const handleTest = async () => {
    const ep = brainUrl.trim() || DEFAULT_BRAIN_URL
    setTesting(true)
    setTestState(null)
    try {
      const api = (window as unknown as { api?: { brain?: { testConnection?: (e: string) => Promise<{ success: boolean; data?: { ok: boolean; detail: string }; error?: string }> } } }).api
      const probe = api?.brain?.testConnection
      if (!probe) {
        setTestState({ ok: false, detail: 'Test unavailable outside the desktop app.' })
        return
      }
      const r = await probe(ep)
      if (r.success && r.data) {
        setTestState(r.data)
      } else {
        setTestState({ ok: false, detail: r.error ?? 'Test failed.' })
      }
    } catch (err) {
      setTestState({ ok: false, detail: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const dirty =
    brainUrl.trim() !== (settings.brainUrl ?? '') ||
    graphUrl.trim() !== (settings.brainGraphUrl ?? '')

  return (
    <div className="space-y-5">
      <div>
        <h3 className="font-mono text-[16px] font-semibold text-[var(--text-primary)]">{t('Brain')}</h3>
        <p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">
          Point DUIN at a folder of your notes and it builds your brain — a living
          graph it reasons over, generated automatically and kept in sync as you
          edit. The <span className="font-mono text-[12px]">{t('DUIN brain')}</span> is the
          default for every conversation. Advanced users can connect an external
          governed brain instead.
        </p>
      </div>

      {/* Active brain — which brain powers chat + the graph right now */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="font-mono text-[12px] font-semibold text-[var(--text-primary)]">
              {t('Active brain')}
            </div>
            <div className="mt-0.5 text-[12px] text-[var(--text-secondary)]">
              {usingExternalBrain ? (
                <>
                  External brain ·{' '}
                  <span className="font-mono text-[11px] text-[var(--text-muted)]">
                    {settings.brainUrl}
                  </span>
                </>
              ) : (
                'Local brain (over your notes folder)'
              )}
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() => void handleUseLocalBrain()}
              disabled={!usingExternalBrain}
              className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                !usingExternalBrain
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--panel-border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t('Use local brain')}
            </button>
            <button
              type="button"
              onClick={() => handleUseExternalBrain()}
              className={`rounded border px-2.5 py-1 text-[11px] transition-colors ${
                usingExternalBrain
                  ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                  : 'border-[var(--panel-border)] bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
            >
              {t('Use external brain')}
            </button>
          </div>
        </div>
        <p className="text-[11px] leading-relaxed text-[var(--text-muted)]">
          {usingExternalBrain
            ? 'An external brain URL overrides your local notes folder — chat + the graph come from the external brain. Switch to the local brain to use your notes folder again.'
            : 'Your local brain reads the notes folder below. Set an external brain URL (Advanced) to override it.'}
        </p>
      </div>

      {/* Local brain — notes folder */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <label className="block font-mono text-[12px] font-semibold text-[var(--text-primary)]">
          {t('Local brain — notes folder')}
        </label>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Point the built-in brain at a folder of notes (markdown). It indexes
          them so chat is grounded in your notes and the Brain graph shows them.
          Leave blank to use the demo graph.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={notesDir}
            readOnly
            placeholder={t('No folder selected')}
            className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none"
          />
          <Button variant="secondary"
            onClick={() => void handleChooseFolder()}
          >
            Choose folder…
          </Button>
          <Button variant="secondary"
            onClick={() => void runReindex()}
            disabled={reindexing}
          >
            {reindexing ? 'Reindexing…' : 'Reindex'}
          </Button>
        </div>
        {usingExternalBrain ? (
          <div className="text-[12px] text-[var(--text-muted)]">
            {t('Using external brain — the notes folder is ignored while a brain endpoint is set.')}
          </div>
        ) : (
          <>
            {/* Rich status line — what's indexed + what's been built. */}
            <div className="text-[12px] text-[var(--text-secondary)]">
              {(() => {
                const folder = notesDir || 'demo graph'
                const n = status?.notesIndexed ?? indexedCount ?? 0
                const parts = [
                  `Local brain · ${folder}`,
                  `${n} note${n === 1 ? '' : 's'} indexed`
                ]
                if (status) {
                  parts.push(`${status.graphNodes} entit${status.graphNodes === 1 ? 'y' : 'ies'} / ${status.graphEdges} link${status.graphEdges === 1 ? '' : 's'} built`)
                }
                return parts.join(' · ')
              })()}
            </div>

            {/* Build my brain — one-click graph generation from raw prose. */}
            <div className="flex items-center gap-2">
              <Button variant="primary"
                onClick={() => void handleBuild()}
                disabled={building}
              >
                {building ? 'Building…' : 'Build my brain'}
              </Button>
              {buildMsg && (
                <span className="text-[12px] text-[var(--text-muted)]">{buildMsg}</span>
              )}
              {!buildMsg && status && !status.hasModel && (
                <span className="text-[12px] text-[var(--text-muted)]">
                  {t('Connect an AI model in API Keys to build from raw notes.')}
                </span>
              )}
            </div>

            {/* Moat recovery — restore memory from the automatic pre-reindex backups. */}
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => void handleRestore()}
                disabled={restoring || backupCount === 0}
              >
                {restoring ? 'Restoring…' : 'Restore memory from backup'}
              </Button>
              <span className="text-[12px] text-[var(--text-muted)]">
                {backupCount === null
                  ? ''
                  : backupCount === 0
                    ? 'No automatic backups yet — one is taken before each reindex.'
                    : `${backupCount} backup${backupCount === 1 ? '' : 's'} available${latestBackupAt ? ` · newest ${new Date(latestBackupAt).toLocaleString()}` : ''}`}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Import an existing agent system into the .brain/ harness root */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <label className="block font-mono text-[12px] font-semibold text-[var(--text-primary)]">
          {t('Import existing setup')}
        </label>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Already use Codex? Absorb your existing identity, memory,
          skills, and hooks into DUIN&apos;s <span className="font-mono">.brain/</span> so
          every answer is grounded in who you are.{' '}
          <span className="font-mono">{t('Link')}</span> keeps reading your original files live;{' '}
          <span className="font-mono">{t('Copy')}</span> snapshots them into the vault.
        </p>
        <Button variant="secondary"
          onClick={() => void handleDetectImports()}
          disabled={detecting}
        >
          {detecting ? 'Scanning…' : 'Detect existing setups'}
        </Button>

        {detected != null && detected.length === 0 && (
          <div className="text-[12px] text-[var(--text-muted)]">
            {t('No existing agent setups found.')}
          </div>
        )}

        {detected != null && detected.length > 0 && (
          <ul className="space-y-2">
            {detected.map((sys) => {
              const c = sys.contains
              const summary = [
                c.identity ? 'identity' : null,
                c.memory ? `${c.memory} memory` : null,
                c.skills ? `${c.skills} skills` : null,
                c.agents ? `${c.agents} agents` : null,
                c.hooks ? `${c.hooks} hooks` : null
              ].filter(Boolean)
              const linkKey = `${sys.adapter}:${sys.dir}:link`
              const copyKey = `${sys.adapter}:${sys.dir}:copy`
              return (
                <li
                  key={`${sys.adapter}:${sys.dir}`}
                  className="rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2"
                >
                  <div className="font-mono text-[12px] text-[var(--text-primary)]">{sys.label}</div>
                  <div className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                    {summary.length ? `Contains: ${summary.join(' · ')}` : 'Nothing importable found'}
                  </div>
                  <div className="mt-1.5 flex gap-2">
                    <Button variant="secondary"
                      onClick={() => void handleImport(sys, 'link')}
                      disabled={importingKey != null}
                    >
                      {importingKey === linkKey ? 'Linking…' : 'Link'}
                    </Button>
                    <Button variant="secondary"
                      onClick={() => void handleImport(sys, 'copy')}
                      disabled={importingKey != null}
                    >
                      {importingKey === copyKey ? 'Copying…' : 'Copy'}
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {/* Scaffold a new harness from a folder of raw notes */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <label className="block font-mono text-[12px] font-semibold text-[var(--text-primary)]">
          {t('Scaffold your brain folder')}
        </label>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          Scaffold a plain folder of notes into a structured DUIN harness, in place —
          the brain folder <span className="italic">is</span> the harness. Every note is
          moved into newcomer-friendly pillar folders (read → write → verify → delete, so
          a file is never lost), and foundation files (<span className="font-mono">BRAIN</span> ·{' '}
          <span className="font-mono">ME</span> · <span className="font-mono">GOALS</span> ·{' '}
          <span className="font-mono">VAULT-MAP</span>), starter rules, and a{' '}
          <span className="font-mono">{t('DIAGNOSIS.md')}</span> are written alongside them. With an AI
          model configured it also synthesizes your strategic tracks, a bio, and
          people/orgs/projects from your prose; with none it falls back to heuristics.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={scaffoldSrc}
            readOnly
            placeholder={t('Your brain / notes folder')}
            className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none"
          />
          <Button variant="secondary"
            onClick={() => void pickScaffoldFolder('src')}
          >
            Choose folder…
          </Button>
        </div>
        <label className="flex items-center gap-2 text-[12px] text-[var(--text-secondary)]">
          <Toggle
            checked={useSeparateOut}
            onChange={setUseSeparateOut}
            aria-label={t('Scaffold into a separate output folder')}
          />
          {t('Scaffold into a separate output folder instead (leaves your source untouched)')}
        </label>
        {useSeparateOut && (
          <div className="flex gap-2">
            <input
              type="text"
              value={scaffoldOut}
              readOnly
              placeholder={t('Output harness folder')}
              className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none"
            />
            <Button variant="secondary"
              onClick={() => void pickScaffoldFolder('out')}
            >
              Choose output…
            </Button>
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button variant="primary"
            onClick={() => void handleScaffold()}
            disabled={scaffolding || !scaffoldSrc || (useSeparateOut && !scaffoldOut)}
          >
            {scaffolding ? 'Scaffolding…' : 'Scaffold'}
          </Button>
          {scaffoldResult?.ok && (
            <span className="text-[12px] text-[var(--text-muted)]">
              {scaffoldResult.counts.notes ?? 0} notes filed
            </span>
          )}
        </div>

        {scaffoldResult?.ok && (
          <div className="space-y-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] p-2 text-[12px]">
            <div className="font-mono text-[11px] text-[var(--text-primary)]">
              {useSeparateOut && scaffoldOut
                ? `Scaffolded into ${scaffoldOut}`
                : `Scaffolded in place — ${scaffoldSrc}`}
            </div>
            <div className="text-[var(--text-secondary)]">
              {Object.entries(scaffoldResult.counts)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            </div>
            {scaffoldResult.tracks.length > 0 && (
              <div className="text-[var(--text-secondary)]">
                Tracks: {scaffoldResult.tracks.join(' · ')}
              </div>
            )}
            <div className="text-[11px] text-[var(--text-muted)]">
              Diagnosis: <span className="font-mono">{scaffoldResult.diagnosisPath}</span>
            </div>
          </div>
        )}
      </div>

      {/* Advanced — external governed brain (hidden by default) */}
      <button
        type="button"
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 text-[12px] text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
      >
        <span className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`}>▸</span>
        {t('Advanced — connect an external brain')}
      </button>

      {showAdvanced && (
      <>
      {/* Brain chat endpoint */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <label className="block font-mono text-[12px] font-semibold text-[var(--text-primary)]">
          {t('Brain endpoint (AG-UI)')}
        </label>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          The chat endpoint the brain serves. Leave blank to use the{' '}
          <span className="font-mono">DUIN_BRAIN_URL</span> environment variable,
          then the localhost default.
        </p>
        <div className="flex gap-2">
          <input
            type="text"
            value={brainUrl}
            onChange={(e) => {
              setBrainUrl(e.target.value)
              setTestState(null)
            }}
            placeholder={DEFAULT_BRAIN_URL}
            className="flex-1 rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <Button variant="secondary"
            onClick={() => void handleTest()}
            disabled={testing}
          >
            {testing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
        {testState && (
          <div
            className={`text-[12px] ${testState.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}
          >
            {testState.ok ? '✓ Connected' : '✗ Unreachable'} — {testState.detail}
          </div>
        )}
      </div>

      {/* Optional live graph endpoint */}
      <div className="space-y-2 rounded border border-[var(--panel-border)] bg-[var(--bg-primary)] p-3">
        <label className="block font-mono text-[12px] font-semibold text-[var(--text-primary)]">
          {t('Brain graph endpoint (optional)')}
        </label>
        <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
          A URL that returns the brain's causal graph as JSON for the Brain view.
          Leave blank to show the bundled demo graph.
        </p>
        <input
          type="text"
          value={graphUrl}
          onChange={(e) => setGraphUrl(e.target.value)}
          placeholder="https://your-brain.example/graph"
          className="w-full rounded border border-[var(--panel-border)] bg-[var(--bg-secondary)] px-2 py-1.5 font-mono text-[12px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
        />
      </div>
      </>
      )}

      <div className="flex items-center gap-2">
        <Button variant="primary"
          onClick={() => void handleSave()}
          disabled={!dirty}
        >
          {t('Save')}
        </Button>
        {dirty && (
          <span className="font-mono text-[12px] text-[var(--text-muted)]">{t('Unsaved changes')}</span>
        )}
      </div>
    </div>
  )
}
