import { app, BrowserWindow, ipcMain, session, shell, screen, clipboard, crashReporter } from 'electron'
// Dev/QA only: expose CDP on a port when BF_DEBUG_PORT is set. No effect in normal runs.
if (process.env.BF_DEBUG_PORT) app.commandLine.appendSwitch('remote-debugging-port', process.env.BF_DEBUG_PORT)
// Dev/QA only: DUIN_USER_DATA_DIR=<absolute path> runs an isolated instance beside an installed DUIN
// (own userData + sessionData; the single-instance lock is keyed on userData, so it is per dir). Must
// precede crashReporter.start() and requestSingleInstanceLock() below, the first userData consumers.
applyUserDataDirOverride(app, process.env.DUIN_USER_DATA_DIR)
// Capture NATIVE crashes (e.g. an onnxruntime segfault in the embeddings
// worker_thread, which JS uncaughtException handlers can't see and which
// silently kills the whole app). Dumps land in <userData>/Crashpad/reports —
// local only, never uploaded — so an "app vanished during embedding" report
// becomes an analysable .dmp instead of nothing.
crashReporter.start({ uploadToServer: false, compress: true })
import { LOCAL_BRAIN_ORIGIN } from './shared/brain-port'
import { basename, extname, join } from 'path'
import { pathToFileURL } from 'url'
import { PRODUCT_NAME } from './brand'
import { applyUserDataDirOverride } from './services/user-data-dir-override'
import { readFileSync } from 'fs'
import { is } from '@electron-toolkit/utils'
import { registerAllIpcHandlers } from './ipc'
import { instrumentIpcMain, startMainStallMonitor } from './services/main-stall-monitor'
import { runWhenIdle } from './services/idle-scheduler'
import { setWorkflowChatRunner, abortAllWorkflows } from './ipc/workflows'
import { abortAllLive as abortAllLiveForks } from './services/subagent-runner'
import { reconcileStaleRuns } from './services/agent-run-store'
import { agenticForkRunner } from './services/agentic-fork-runner'
import {
  closeDb,
  startPeriodicCheckpoint,
  scheduleStartupIntegrityCheck,
  cancelStartupIntegrityCheck
} from './services/database'
import { startBackupRunner } from './services/backup-runner'
import { runBackendHealthMonitor } from './services/backend-health-monitor'
import { runCoherenceHealthMonitor } from './services/brain/coherence-health-monitor'
import { runCompoundingHealthMonitor } from './services/brain/compounding-health-monitor'
// SP-6 — startup GC for the HY3 tool-result spill directory (D3).
import { gcSpillDir } from './services/tool-result-spill'
import { destroy as destroyArtifactSandbox } from './services/artifact-sandbox'
import { ptyKillAll } from './services/pty-manager'
import { destroyAll as destroyBrowserTabs } from './services/browser-manager'
import { destroyAllDevServers } from './services/dev-server-manager'
import { destroyAllBackgroundShells } from './services/shell-tool'
import { destroyAllMonitors } from './services/monitor-service'
import { fireHooks } from './services/hooks-runner'
import { checkBrainVault } from './services/brain/brain-state-dir'
import { ensureFoundationSoul } from './services/brain/okf-scaffold'
import { seedDefaultHooks } from './services/hooks-seed'
import {
  setUserDataPathProvider as setProviderUserDataPath,
  resolveWorkflowTierModel
} from './services/providers/registry'
import { setTierModelResolver } from './services/workflow-budget'
import {
  setDebugTraceUserDataPath,
  trace,
  flushTrace
} from './services/debug-trace'
import { startAutomations, stopAutomations } from './services/automations-runner'
import { startLoopWakeups, stopLoopWakeups } from './services/loop-runner'
import { startLoopController, stopLoopController } from './services/loop-controller'
import { recoverInterruptedAutomationRuns } from './services/automations-store'
// Side-effect import: registers the goal->loop transition handler (default-off; a
// goal-owned loop only wakes when BOTH backgroundAutonomy and loopsEnabled are on).
import './services/goal-automation-loop-bridge'
import { startLoopScheduler, stopLoopScheduler } from './services/loop-scheduler'
import { startCalibrationTick, stopCalibrationTick } from './services/brain/calibration-tick'
import { startClaimMetabolismTick, stopClaimMetabolismTick } from './services/brain/claim-metabolism-tick'
import { startSelfImproveTick, stopSelfImproveTick } from './services/brain/self-improve-tick'
import { startMeasureTick, stopMeasureTick } from './services/brain/measure-tick'
import { startTransferAbTick, stopTransferAbTick } from './services/brain/transfer-ab-tick'
import { startConstructionFloor, stopConstructionFloor } from './services/local-brain/notes-watcher'
import { mcpManager } from './services/mcp-manager'
import { ensureNodeReplDefaultServer } from './services/node-repl-default-server'
import { initializeSkillLoader, shutdownSkillLoader } from './services/skill-loader'
import { initializePluginLoader, shutdownPluginLoader } from './services/plugin-loader'
import { clearAllStaging } from './services/plugin-install-remote'
import { initializeFilterLoader, shutdownFilterLoader } from './services/snip'
import { initializeMemoryStore, shutdownMemoryStore } from './services/memory-store'
import { backfillSessionsFts } from './services/conversation-store'
import {
  initializeSlashCommandLoader,
  shutdownSlashCommandLoader
} from './services/slash-commands'
import { shutdownReviewWatcher } from './ipc/review'
import {
  destroyTray,
  handleWindowClose,
  initializeTray,
  refreshTrayMenu,
  revealWindow,
  markQuitRequested
} from './services/tray'
import { registerGlobalShortcuts } from './services/shortcuts'
import { initializeUpdater, quitAndInstall, checkNow, downloadUpdate } from './services/updater'
import { readSettings, patchSettings } from './services/settings-helper'
import {
  startLocalBrain,
  getBrainExecToken,
  getBrainControlToken,
  stopLocalBrain,
  setLocalBrainSettingsReader,
  setLocalBrainSettingsWriter
} from './services/local-brain/server'
import {
  setLocalBrainUserDataPath,
  closeLocalBrainStore
} from './services/local-brain/index-store'
import { enableBrainPersistence } from './services/brain'
import { setGuardTelemetry } from './services/guarded'
import { recordEvent } from './services/event-log'
import { isAllowedNavigationTarget, isExternalOpenTarget } from './services/window-guard'
import { startFeedbackBridge, stopFeedbackBridge } from './services/feedback-bridge'
import { setOperatorModelPath, setOperatorLifecycleHook, setOperatorEventHook, setMeasureHook, setMaterializeHook, setOperatorChangeHook, getOperatorFacts } from './services/brain/operator-model'
import { makeMaterializeHook } from './services/brain/concept-materialize'
import {
  startSeamAutoReconcile,
  stopSeamAutoReconcile,
  scheduleSeamReconcile,
  makeProductionSeamDeps
} from './services/brain/seam-reconcile'
import { scheduleReindex } from './services/local-brain/notes-watcher'
import { measureOne } from './services/brain/judgment-measure-live'
import { seedFromVault, hasColdStarted, markColdStarted } from './services/brain/cold-start-seed'
import { setCapabilityLedgerPath, seedCapabilities } from './services/ans/capability-ledger'
import { registerExecutorCapability } from './services/executor/executor-capability'
import { setActionLedgerPath } from './services/ans/action-ledger'
import { setSuccessStorePath } from './services/brain/success-miner'
import {
  rehydrateMoatFromVault,
  projectMoatToVault,
  rehydrateMemoryFromVault,
  projectMemoryToVault
} from './services/moat-durability'
import {
  importBrainTablesFromVault,
  exportBrainTablesToVault
} from './services/brain/brain-db-durability'
import { startLearnBridge, stopLearnBridge, forwardCorrection } from './services/learn-bridge'
import { initializeSubagentTypeLoader } from './services/subagent-types'
import { loadVaultSubagents } from './services/vault-agents-loader'
import { setConnectionsPath, startConnectorSync } from './services/connectors/connections-store'
import { setChannelsPath } from './services/channels/channels-store'
import { setPairingPath } from './services/channels/pairing-store'
import { registerForFullDiskAccessListing } from './services/mac-permissions'
import { setDeliveryQueuePath } from './services/proactive/delivery-queue'
import { setPendingInteractionsPath } from './services/proactive/pending-interactions'
import { setNoticesPath, setNoticesChangeListener } from './services/proactive/notices-store'
import { broadcastNoticesChanged } from './ipc/notices'
import { startGateway, stopGateway } from './services/channels/gateway'
import { setConstructPaths } from './services/brain/construct'
import {
  formatHeadlessResult,
  isHeadlessCliArgv,
  runHeadlessFromArgv
} from './services/headless-runner'
import { buildDoctorReport, renderDoctorReport } from './services/doctor'
import { isDoctorArgv, parseDoctorArgs, collectDoctorReadings } from './services/doctor-collect'
import { messageOf } from './services/guarded'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
const splashStart = Date.now()
// How long the splash is guaranteed to stay up, measured from module load.
// This is a brand beat, not a loading bar — when it was 3000 the app spent most
// of every launch waiting out a timer it had already finished the work for.
// Keep it long enough that the splash reads as deliberate rather than a flash.
const SPLASH_MIN_MS = 600
let suppressBoundsPersist = false
let boundsPersistTimer: NodeJS.Timeout | null = null

// PS2 — handle returned by startPeriodicCheckpoint(). Stored at module
// scope so will-quit can stop the timer before closeDb() runs. Without
// stopping it, an interval tick could fire mid-shutdown against a
// closed DB.
let stopPeriodicCheckpoint: (() => void) | null = null
// PS5 — handle returned by startBackupRunner(). Same lifecycle contract:
// the will-quit handler stops the timer before closeDb() so the
// 30-second delayed first-tick can't fire against a closed handle.
let stopBackupRunner: (() => void) | null = null
// B2 — handle for the backend-health monitor interval. Same lifecycle contract as the
// backup runner: will-quit stops the timer before closeDb() so a tick can't fire against
// a closed handle.
let stopBackendHealthMonitor: (() => void) | null = null
// Coherence Health monitor interval — same lifecycle contract as the backend-health monitor
// (will-quit stops the timer before closeDb()). This is the scheduled "learning-liveness monitor"
// the Coherence Map flagged as its highest-leverage gap.
let stopCoherenceHealthMonitor: (() => void) | null = null
// Loop firing now lives in the TS agentic scheduler (services/loop-scheduler.ts):
// it reads loops.yaml + loops-state.json, computes due loops, and runs each
// through the headless agentic executor (real artifacts). It replaced the old
// ~15-min POST /state/loop-tick text-gen job — single scheduler, no double-fire.
// start/stop are wired in startup + will-quit below.

// Duplicate-launch protection. GUI launches must run as a single Electron
// process — two parallel processes would each open their own SQLite handle
// on lamprey.db, spin up their own MCP clients, and race on the same userData
// dirs. Headless CLI invocations (duin --duin-headless ...) are exempted: each
// is a one-shot run that exits cleanly, and the user may legitimately fan
// them out in parallel from a shell. For GUI launches, the second process
// exits immediately and the existing window restores + focuses.
if (!isHeadlessCliArgv(process.argv)) {
  const gotTheLock = app.requestSingleInstanceLock()
  if (!gotTheLock) {
    app.quit()
    process.exit(0)
  }
  app.on('second-instance', () => {
    // Relaunching the shortcut must UN-HIDE the window, not merely focus it. With
    // Settings -> "Minimize to tray on close" on, tray.ts's handleWindowClose HIDES the window
    // (win.hide()) instead of closing it — and a hidden window is not a minimized one, so the old
    // `if (isMinimized()) restore(); focus()` did literally nothing: focus() cannot show a hidden
    // window. The user double-clicked the shortcut and got no window, no taskbar button, no error.
    // revealWindow covers both concealed states; pass mainWindow explicitly rather than letting the
    // tray resolve a window itself, since during boot that can land on the splash window.
    if (mainWindow) revealWindow(mainWindow)
  })
}

function reportToRenderer(channel: 'app:error' | 'app:warning', message: string): void {
  try {
    mainWindow?.webContents.send(channel, { message })
  } catch {
    // window may already be destroyed during shutdown
  }
}

// electron-updater's internal HTTP path raises a secondary "write after end"
// stream error when a release is missing latest.yml — and the original 404
// itself can also escape its promise chain. Both surface here as unhandled
// rejections / exceptions, get forwarded to the renderer, and pop the
// scary stack trace in the right panel. None of it is actionable for the
// user: it just means "no update available right now." Suppress the
// renderer push for anything that originated in electron-updater or the
// known stream-close pattern; the log channel still records it.
function extractErrorMeta(reason: unknown): { msg: string; stack: string; code: string } {
  if (reason instanceof Error) {
    return {
      msg: reason.message ?? '',
      stack: reason.stack ?? '',
      code: (reason as { code?: unknown }).code === undefined ? '' : String((reason as { code?: unknown }).code)
    }
  }
  // Some libraries (electron-updater included) reject with plain objects that
  // carry .message / .code / .stack without being an Error instance. The old
  // version of this check fell back to String(reason) which yields
  // "[object Object]" and skipped the regex.
  if (reason && typeof reason === 'object') {
    const obj = reason as Record<string, unknown>
    const rawMsg = typeof obj.message === 'string' ? obj.message : ''
    return {
      msg: rawMsg || String(reason),
      stack: typeof obj.stack === 'string' ? obj.stack : '',
      code: typeof obj.code === 'string' ? obj.code : ''
    }
  }
  return { msg: String(reason ?? ''), stack: '', code: '' }
}

function isUpdaterNoise(reason: unknown): boolean {
  const { msg, stack, code } = extractErrorMeta(reason)
  // Stack-based: any frame that originated inside electron-updater, the
  // ElectronHttpExecutor (its HTTP adapter), or the SimpleURLLoaderWrapper
  // (Electron's net.request stream wrapper) is updater plumbing — never the
  // app's own code path.
  if (/electron-updater|ElectronHttpExecutor|SimpleURLLoaderWrapper|app-update\.yml|latest\.yml/i.test(stack)) {
    return true
  }
  // Message-based: the GitHub 404 emits a verbose blob that always contains
  // either the releases-download URL or the "double check your auth token"
  // canned message from createHttpError.
  if (/releases\/download\/v[\d.]+\/latest\.yml/i.test(msg)) return true
  if (/Please double check that your authentication token is correct/i.test(msg)) return true
  if (/HttpError:\s*\d+/i.test(msg)) return true
  // Stream lifecycle: the secondary error electron-updater emits when its
  // ClientRequest is destroyed during the 404 path. No application-layer
  // "write after end" exists in this app — every Node stream we use is one
  // we own, and we don't write to closed sockets. Anything matching is
  // library plumbing.
  if (/write after end/i.test(msg)) return true
  if (/Cannot call write after a stream was destroyed/i.test(msg)) return true
  if (code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'ERR_STREAM_DESTROYED') return true
  // EPIPE on background HTTP from updater shouldn't kill the app either.
  if (code === 'EPIPE' && /electron-updater|update/i.test(stack)) return true
  return false
}

process.on('unhandledRejection', (reason) => {
  const { msg } = extractErrorMeta(reason)
  if (isUpdaterNoise(reason)) {
    console.warn('[updater] suppressed unhandled rejection:', msg)
    return
  }
  console.error('[main] unhandledRejection:', msg)
  reportToRenderer('app:error', `Unhandled error: ${msg}`)
})

process.on('uncaughtException', (err) => {
  const { msg } = extractErrorMeta(err)
  if (isUpdaterNoise(err)) {
    console.warn('[updater] suppressed uncaught exception:', msg)
    return
  }
  console.error('[main] uncaughtException:', msg)
  reportToRenderer('app:error', `Unhandled error: ${msg}`)
})

const DEFAULT_BOUNDS = { x: undefined as number | undefined, y: undefined as number | undefined, width: 1280, height: 800 }
const MIN_WIDTH = 800
const MIN_HEIGHT = 600

function clampBoundsToScreen(bounds: { x?: number; y?: number; width: number; height: number }) {
  const displays = screen.getAllDisplays()
  // Find a display whose workArea overlaps the saved bounds.
  const target =
    displays.find((d) => {
      if (bounds.x === undefined || bounds.y === undefined) return false
      const wa = d.workArea
      const inside =
        bounds.x + bounds.width > wa.x &&
        bounds.x < wa.x + wa.width &&
        bounds.y + bounds.height > wa.y &&
        bounds.y < wa.y + wa.height
      return inside
    }) ?? screen.getPrimaryDisplay()
  const wa = target.workArea
  const width = Math.min(Math.max(MIN_WIDTH, bounds.width), wa.width)
  const height = Math.min(Math.max(MIN_HEIGHT, bounds.height), wa.height)
  const x = bounds.x === undefined ? undefined : Math.min(Math.max(bounds.x, wa.x), wa.x + wa.width - width)
  const y = bounds.y === undefined ? undefined : Math.min(Math.max(bounds.y, wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}

function readSavedBounds(): typeof DEFAULT_BOUNDS {
  const settings = readSettings() as {
    windowBounds?: { x?: number; y?: number; width?: number; height?: number }
  }
  const raw = settings.windowBounds
  if (!raw || typeof raw.width !== 'number' || typeof raw.height !== 'number') {
    return DEFAULT_BOUNDS
  }
  return clampBoundsToScreen({
    x: typeof raw.x === 'number' ? raw.x : undefined,
    y: typeof raw.y === 'number' ? raw.y : undefined,
    width: raw.width,
    height: raw.height
  })
}

function schedulePersistBounds(win: BrowserWindow): void {
  if (suppressBoundsPersist) return
  if (boundsPersistTimer) clearTimeout(boundsPersistTimer)
  boundsPersistTimer = setTimeout(() => {
    if (win.isDestroyed()) return
    if (win.isMinimized() || win.isMaximized() || win.isFullScreen()) return
    const b = win.getBounds()
    patchSettings({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
  }, 500)
}

function resolveSplashPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'splash.png')
  return join(app.getAppPath(), 'ASSETS', 'DUIN Splash.png')
}

function resolveAppIconPath(): string {
  // Use the PNG for the runtime WINDOW/taskbar icon — Electron's nativeImage
  // decodes PNG reliably across platforms, whereas a PNG-compressed .ico can
  // fail to decode for the window icon and leave the taskbar button BLANK
  // (the tray already uses icon.png successfully — see tray.ts). The multi-res
  // .ico is still used for the exe + installer (handled by electron-builder).
  if (app.isPackaged) return join(process.resourcesPath, 'icon.png')
  return join(app.getAppPath(), 'resources', 'icon.png')
}

function createSplashWindow(): void {
  const splashPath = resolveSplashPath()
  splashWindow = new BrowserWindow({
    width: 540,
    height: 540,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  // The splash HTML is served from a data: URL. Recent Chromium blocks
  // file:// requests originating from data: documents, so we can't reference
  // splashPath via <img src="file://..."> — it silently fails to load.
  // Inline the PNG bytes as a base64 data:image/png src instead.
  let imgSrc = ''
  try {
    const bytes = readFileSync(splashPath)
    const ext = extname(splashPath).toLowerCase().slice(1) || 'png'
    const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`
    imgSrc = `data:${mime};base64,${bytes.toString('base64')}`
  } catch (err) {
    console.error('[main] splash image read failed:', (err as Error).message, splashPath)
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden;height:100vh;width:100vw;display:flex;align-items:center;justify-content:center}
    img{max-width:100%;max-height:100%;object-fit:contain;animation:fade-in 600ms ease-out both}
    @keyframes fade-in{from{opacity:0;transform:scale(0.96)}to{opacity:1;transform:scale(1)}}
  </style></head><body>${imgSrc ? `<img src="${imgSrc}" alt="DUIN"/>` : ''}</body></html>`
  splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  splashWindow.once('ready-to-show', () => splashWindow?.show())
}

function closeSplashWhenReady(): void {
  const elapsed = Date.now() - splashStart
  const wait = Math.max(0, SPLASH_MIN_MS - elapsed)
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.close()
      splashWindow = null
    }
    mainWindow?.show()
  }, wait)
}

function createWindow(): void {
  const bounds = readSavedBounds()
  const packagedRendererPath = join(__dirname, '../renderer/index.html')
  const trustedRendererUrl =
    is.dev && process.env['ELECTRON_RENDERER_URL']
      ? process.env['ELECTRON_RENDERER_URL']
      : pathToFileURL(packagedRendererPath).href

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: PRODUCT_NAME,
    backgroundColor: '#0d0d0d',
    icon: resolveAppIconPath(),
    show: false,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    closeSplashWhenReady()
  })

  // RENDERER PROCESS DEATH. Distinct from a renderer JS error, which src/main.tsx's
  // ErrorBoundary already catches and shows a reload button for. When the renderer
  // PROCESS dies, no JS runs at all: the window is simply blank, nothing is logged, and
  // it reads as "the app crashed". Nothing observed this for the main window — only
  // artifact-sandbox did, for its own WebContentsView.
  //
  // Boot is when it is most likely, which matches the report: indexing, the embedder
  // worker loading a model, and the graph's first paint all land in the same few
  // seconds. `oom` is the reason to expect from that, and it is worth knowing rather
  // than guessing — so log the reason and exit code, then recover.
  //
  // ONE automatic reload. A renderer that dies again immediately is failing for a
  // reason a reload cannot fix, and a reload loop turns one bad frame into a spinning
  // window that is harder to diagnose than a blank one.
  let rendererReloadedAfterCrash = false
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    const reason = details?.reason ?? 'unknown'
    const code = details?.exitCode
    console.error(`[main] renderer process gone: reason=${reason} exitCode=${code}`)
    void import('./services/event-log')
      .then(({ recordEvent }) =>
        recordEvent({
          // guarded.failure is the existing generic-failure type; the payload names
          // the surface. Adding an event type would edit a contract other lanes read.
          type: 'guarded.failure',
          actorKind: 'system',
          severity: 'error',
          entityKind: 'window',
          entityId: 'main',
          payload: {
            surface: 'renderer-process',
            reason,
            exitCode: code,
            recovered: !rendererReloadedAfterCrash
          }
        })
      )
      .catch(() => undefined)
    // 'clean-exit' is a normal teardown (quit, reload) — not a crash to recover from.
    if (reason === 'clean-exit' || rendererReloadedAfterCrash) return
    rendererReloadedAfterCrash = true
    try {
      mainWindow?.webContents.reload()
    } catch {
      /* the window may already be destroyed — nothing left to recover */
    }
  })

  // The embeddings worker runs as a utilityProcess and its native crashes (onnxruntime)
  // are invisible to JS handlers — the file header explains why crashReporter exists for
  // exactly this. Logging the event too means a vanished embedder is diagnosable from
  // the log alone, without extracting a .dmp.
  app.on('child-process-gone', (_event, details) => {
    console.error(
      `[main] child process gone: type=${details?.type} reason=${details?.reason} exitCode=${details?.exitCode}` +
        (details?.name ? ` name=${details.name}` : '')
    )
  })

  // Tier-1 parity — tell the renderer which brain origin to read GRAPH/state from.
  // An explicit external brain (Settings → Brain: brainUrl, or the graph-only
  // brainGraphUrl) overrides the local-first default; with neither set we inject
  // nothing and the renderer falls back to the in-process local brain (:8799,
  // see src/duin/lib/state.ts BASE). Runs after every load (incl. reloads) so a
  // settings change that triggers a reload re-applies. Best-effort; a malformed
  // URL is ignored (renderer keeps the local default).
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      const s = readSettings() as { brainUrl?: unknown; brainGraphUrl?: unknown }
      const raw =
        (typeof s.brainUrl === 'string' && s.brainUrl.trim()) ||
        (typeof s.brainGraphUrl === 'string' && s.brainGraphUrl.trim()) ||
        // M1 (single front): no explicit external brain configured → the renderer
        // reads from the in-process local brain, which serves the entire /state|/graph
        // surface natively in TS. Injected explicitly so a DUIN_BRAIN_PORT override
        // reaches the renderer too (its compiled fallback is the default port).
        LOCAL_BRAIN_ORIGIN
      if (!raw) return
      let origin: string
      try {
        origin = new URL(raw).origin
      } catch {
        return // malformed — leave __DUIN_BASE unset (local default wins)
      }
      mainWindow?.webContents
        .executeJavaScript(`window.__DUIN_BASE = ${JSON.stringify(origin)};`)
        .catch(() => {})
    } catch {
      // settings unreadable — local default wins
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    // SECURITY: only hand http(s) URLs to the OS opener; deny file://, smb://,
    // ms-*: and other local/dangerous schemes.
    if (isExternalOpenTarget(details.url)) shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // SECURITY: pin top-level navigation. A navigation to a remote origin — or to arbitrary local
  // HTML — would inherit the full window.api contextBridge surface (chat, files, hooks, shell).
  // Use the SAME shared predicate canvas-window.ts uses (one owner), pinned to the packaged
  // renderer dir so a file: link that escaped the renderer's own interception cannot load
  // off-app content into this full-preload window (F1). Dev server stays allowed.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigationTarget(url, trustedRendererUrl)) event.preventDefault()
  })
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigationTarget(url, trustedRendererUrl)) event.preventDefault()
  })

  mainWindow.on('move', () => mainWindow && schedulePersistBounds(mainWindow))
  mainWindow.on('resize', () => mainWindow && schedulePersistBounds(mainWindow))

  mainWindow.on('close', (e) => {
    if (!mainWindow) return
    handleWindowClose(mainWindow, e)
  })

  // 'close' can be intercepted (hide-to-tray); 'closed' means Electron actually DESTROYED the
  // window. Drop the module ref then — otherwise `mainWindow` stays truthy forever while pointing
  // at a dead object, and every consumer tests bare truthiness (second-instance above, and
  // activeWindow() in services/tray.ts + services/shortcuts.ts via getMainWindow), so they call
  // isVisible()/focus() on it and throw 'Object has been destroyed'.
  //
  // What made this invisible: with the shipped default minimizeToTray:false the window really is
  // destroyed on close, and on darwin `window-all-closed` deliberately does NOT quit — so the
  // process lives on holding a dead ref, and the resulting throw is swallowed by the top-level
  // uncaughtException handler (whose own report targets the same destroyed webContents). The tray
  // icon and the global hotkey just silently stop working, with nothing logged.
  //
  // Identity-check before clearing: app.on('activate') can already have built a REPLACEMENT window
  // by the time this fires, and an unconditional `mainWindow = null` would erase the live one.
  const closingWindow = mainWindow
  closingWindow.on('closed', () => {
    if (mainWindow === closingWindow) mainWindow = null
  })

  mainWindow.on('show', () => refreshTrayMenu())
  mainWindow.on('hide', () => refreshTrayMenu())
  mainWindow.on('minimize', () => refreshTrayMenu())
  mainWindow.on('restore', () => refreshTrayMenu())
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizedChanged', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizedChanged', false)
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(packagedRendererPath)
  }
}

function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

app.whenReady().then(() => {
  // Match electron-builder's appId so Windows associates pinned taskbar /
  // start-menu entries with this app's icon and JumpLists. Without this,
  // Windows can group the running window under a different AUMID and show
  // a stale cached icon.
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.duin.app')
  }

  // `doctor` — the one-command answer to "is this install actually working?". Runs on the
  // same headless boot as `run` (it needs the userData-backed stores hydrated below), but
  // exits with the 0/1/2 contract a CI step or a wrapper script can branch on.
  if (isDoctorArgv(process.argv)) {
    void (async () => {
      let exitCode: 0 | 1 | 2 = 0
      try {
        setProviderUserDataPath(() => app.getPath('userData'))
        setLocalBrainUserDataPath(app.getPath('userData'))
        const opts = parseDoctorArgs(process.argv)
        const readings = await collectDoctorReadings(opts, {
          providersWithKeys: async () => {
            const { PROVIDERS } = await import('./services/providers/registry')
            const keychain = await import('./services/keychain')
            return Object.values(PROVIDERS)
              .filter((p) => !p.hidden && keychain.hasKey(p.id))
              .map((p) => p.id)
          },
          liveProbe: async () => {
            // Deliberately the SMALLEST real completion: the point is to prove a model
            // answers, which listing models (free) never did — that is exactly how the
            // 402 outage stayed invisible behind a healthy-looking Settings pane.
            const { routeModel, chatOnce } = await import('./services/providers/registry')
            const modelId = routeModel('chat')
            if (!modelId) return { ok: false, error: 'no model is routable with the stored keys' }
            try {
              await chatOnce([{ role: 'user', content: 'ping' }], modelId)
              return { ok: true, provider: modelId }
            } catch (e) {
              return { ok: false, provider: modelId, error: e instanceof Error ? e.message : String(e) }
            }
          },
          channelsWaiting: () => []
        })
        const report = buildDoctorReport(readings)
        exitCode = report.exitCode
        process.stdout.write(
          (opts.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report)) + '\n'
        )
      } catch (err) {
        exitCode = 1
        process.stderr.write(`doctor failed: ${err instanceof Error ? err.message : String(err)}\n`)
      } finally {
        app.exit(exitCode)
      }
    })()
    return
  }

  if (isHeadlessCliArgv(process.argv)) {
    void (async () => {
      let exitCode = 0
      try {
        // Hydrate the userData-backed stores HERE too. The GUI boot sets these far
        // below, and this branch runs the whole headless invocation and exits without
        // ever reaching those lines — so in a `--headless` run each store was left in
        // its unhydrated module-level state, silently:
        //   provider  — chatStream's inactivity watchdog could not read settings.json
        //   debugTrace— the diagnostic trace had nowhere to write
        //   localBrain— index-store throws 'userDataPath not set', so every notes-index
        //               read fails and embedForRecall returns [] (grounding empty)
        //   pairing   — listPairings() reads an empty map, which is what the operator
        //               fallback in approval-roundtrip resolves against, so every
        //               irreversible ACT action denies 'no-operator'
        //   pending   — createInteraction has no store to write the approval into
        // Same stores, same settings, different boot path.
        setProviderUserDataPath(() => app.getPath('userData'))
        setDebugTraceUserDataPath(() => app.getPath('userData'))
        setLocalBrainUserDataPath(app.getPath('userData'))
        setPairingPath(app.getPath('userData'))
        setPendingInteractionsPath(app.getPath('userData'))
        initializeMemoryStore()
        const { result, json } = await runHeadlessFromArgv(process.argv)
        const text = formatHeadlessResult(result, json)
        if (result.success) {
          process.stdout.write(text + '\n')
        } else {
          exitCode = 1
          process.stderr.write(text + '\n')
        }
      } catch (err) {
        exitCode = 1
        const result = {
          success: false as const,
          error: err instanceof Error ? err.message : String(err)
        }
        process.stderr.write(formatHeadlessResult(result, process.argv.includes('--json')) + '\n')
      } finally {
        stopLoopScheduler()
        stopCalibrationTick()
        stopClaimMetabolismTick()
        stopSelfImproveTick()
        stopMeasureTick()
        stopTransferAbTick()
        stopConstructionFloor()
        stopLoopController()
        stopLoopWakeups()
        stopAutomations()
        // Idempotent no-op in headless (the GUI-only monitor timers were never armed here); guarded so
        // a future headless wiring of either monitor tears down cleanly on the same path.
        if (stopBackendHealthMonitor) {
          stopBackendHealthMonitor()
          stopBackendHealthMonitor = null
        }
        if (stopCoherenceHealthMonitor) {
          stopCoherenceHealthMonitor()
          stopCoherenceHealthMonitor = null
        }
        shutdownMemoryStore()
        stopSeamAutoReconcile()
        closeDb()
        app.exit(exitCode)
      }
    })()
    return
  }

  // PS2 — schedule periodic WAL checkpoint for the GUI lifetime.
  // First tick fires 5 minutes after startup; by then any first-IPC has
  // already opened the DB. The interval keeps the WAL bounded during
  // long live sessions; will-quit calls stopPeriodicCheckpoint + closeDb
  // (which runs a final TRUNCATE) for the graceful exit path.
  stopPeriodicCheckpoint = startPeriodicCheckpoint()
  // PS5 — schedule daily db.backup() snapshot with 14-day retention.
  // First tick is delayed 30 seconds (in the runner) so startup isn't
  // slowed and the first backup happens once the app is settled.
  // Subsequent ticks fire every 24 hours.
  stopBackupRunner = startBackupRunner()

  // B2 (backend-hardening) — schedule the backend-health monitor on an HOURLY clock.
  // NOT cheap, despite what this comment used to claim: the integrity pragmas were
  // MEASURED at ~2.1s on the live DBs (PLANNING/DUIN_PERF_LAUNCH_HANDOFF.md:37), on
  // the main thread — a guaranteed hourly input freeze. Two changes, 2026-08-21:
  // the pragma pair is now quick_check (see checkDbIntegrity), and each tick waits
  // for operator idle (60s hands-off, forced through after 3h) so the block lands
  // when nobody is typing. Fire-and-forget + fully failure-swallowed inside the
  // monitor; the first tick is delayed 60s so it never competes with launch.
  // Opt-out: DUIN_BACKEND_HEALTH_MONITOR=0 makes each tick an immediate no-op.
  {
    const runBackendHealth = (): void => {
      runWhenIdle(
        'backend-health',
        () => {
          const raw = readSettings().localBrainNotesDir
          const vaultDir = typeof raw === 'string' && raw.trim() !== '' ? raw : null
          void runBackendHealthMonitor({ userDataDir: app.getPath('userData'), vaultDir })
        },
        { idleMs: 60_000, maxDelayMs: 3 * 60 * 60_000 }
      )
    }
    const firstBackendHealth = setTimeout(runBackendHealth, 60_000)
    firstBackendHealth.unref?.()
    const backendHealthTimer = setInterval(runBackendHealth, 60 * 60 * 1000)
    backendHealthTimer.unref?.()
    stopBackendHealthMonitor = () => {
      clearTimeout(firstBackendHealth)
      clearInterval(backendHealthTimer)
    }
  }

  // Coherence Health monitor — the APEX meta-benchmark, self-policing on a DAILY clock.
  // Rationale for the daily (not hourly) cadence: coherence is heavier + slower-moving than the
  // backend monitor. It re-scores the whole Coherence Map + rolls up the three subsystem-benchmark
  // ledgers, and the wiring it measures (design→code→runtime) changes on the timescale of commits,
  // not minutes — so an hourly re-score would just rewrite an identical line and add alert noise. A
  // daily line is a cheap, honest time-series of when a loop actually connects or a benchmark moves.
  // This IS the "learning-liveness monitor" (map's highest-leverage gap): a scheduled instrument that
  // notices when the compounding/learning loops stop turning. Fire-and-forget + fully failure-swallowed
  // inside the monitor; the first tick is delayed 90s (AFTER backend's +60s so the two never collide at
  // launch). Opt-out: DUIN_COHERENCE_HEALTH_MONITOR=0 makes each tick an immediate no-op.
  {
    const runCoherenceHealth = (): void => {
      const raw = readSettings().localBrainNotesDir
      const vaultDir = typeof raw === 'string' && raw.trim() !== '' ? raw : null
      // Refresh the compounding ledger FIRST, then re-score coherence. Before this,
      // compounding-health-history.jsonl had NO scheduled writer (coherence-map gap), so
      // coherence's LIVENESS compounding rollup stayed null. Writing it here (a) feeds that
      // rollup a live number and (b) makes the compounding benchmark self-policing daily.
      // Both monitors swallow their own errors; the await only orders the ledger write
      // before the read that consumes it.
      void (async () => {
        await runCompoundingHealthMonitor(vaultDir)
        await runCoherenceHealthMonitor({ vaultDir })
      })()
    }
    const firstCoherenceHealth = setTimeout(runCoherenceHealth, 90_000)
    firstCoherenceHealth.unref?.()
    const coherenceHealthTimer = setInterval(runCoherenceHealth, 24 * 60 * 60 * 1000)
    coherenceHealthTimer.unref?.()
    stopCoherenceHealthMonitor = () => {
      clearTimeout(firstCoherenceHealth)
      clearInterval(coherenceHealthTimer)
    }
  }

  // SP-6 (Sweet Spot Phase, 2026-06-10) — GC the HY3 tool-result spill
  // directory (D3: it previously grew unbounded — zero deletion call sites).
  // Deferred 10s so it never competes with launch; best-effort by contract.
  setTimeout(() => {
    try {
      const outcome = gcSpillDir()
      if (outcome.deletedByAge > 0 || outcome.deletedBySize > 0) {
        console.info(
          `[spill-gc] swept tool-results: ${outcome.deletedByAge} aged out, ` +
            `${outcome.deletedBySize} trimmed for size, ` +
            `${Math.round(outcome.remainingBytes / 1024)} KiB remaining`
        )
      }
    } catch (err) {
      console.error('[spill-gc] sweep failed:', err)
    }
  }, 10_000)

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.includes('lamprey-artifact')) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': ["default-src 'self' 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; img-src 'self' data:;"]
        }
      })
    } else {
      callback({ responseHeaders: details.responseHeaders })
    }
  })

  ipcMain.handle('ping', () => 'pong')
  // Deliver the per-launch /agui execution token to the trusted renderer ONLY (over IPC, never
  // to an unauthenticated HTTP caller) so its agentic turns can run host-exec / destructive tools
  // through the deny-first gate (agui-guard.ts). Any process without this token is refused.
  ipcMain.handle('brain:exec-token', () => getBrainExecToken())
  ipcMain.handle('brain:control-token', () => getBrainControlToken())
  ipcMain.handle('shell:openExternal', (_event, url: string) => {
    if (typeof url === 'string' && (url.startsWith('https://') || url.startsWith('http://'))) {
      shell.openExternal(url)
    }
  })

  ipcMain.handle('update:restart', async () => {
    // Was `await quitAndInstall(); return { success: true }`. quitAndInstall REFUSES unless this
    // session verified a completed DUIN download, and the banner's Restart button is on screen for
    // the entire download (update-available fires, THEN the ~100-300 MB fetch starts), so the
    // refusal is reachable by an ordinary click. Hard-coding success:true made it unreportable.
    // Mirrors update:check below.
    const result = await quitAndInstall()
    return result.ok ? { success: true, data: null } : { success: false, error: result.error }
  })

  ipcMain.handle('update:check', async () => {
    const result = await checkNow()
    return result.ok ? { success: true, data: null } : { success: false, error: result.error }
  })

  // Release M11: the updater is notify-only until builds are signed; the banner's Download
  // button is the operator's explicit step. Same envelope shape as check/restart.
  ipcMain.handle('update:download', async () => {
    const result = await downloadUpdate()
    return result.ok ? { success: true, data: null } : { success: false, error: result.error }
  })

  ipcMain.handle('clipboard:writeText', (_event, text: string) => {
    if (typeof text !== 'string') return { success: false, error: 'text must be a string' }
    clipboard.writeText(text)
    return { success: true, data: null }
  })

  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize()
    return { success: true, data: null }
  })

  ipcMain.handle('window:maximizeToggle', () => {
    if (!mainWindow) return { success: true, data: false }
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return { success: true, data: mainWindow.isMaximized() }
  })

  ipcMain.handle('window:close', () => {
    mainWindow?.close()
    return { success: true, data: null }
  })

  ipcMain.handle('window:isMaximized', () => {
    return { success: true, data: mainWindow?.isMaximized() ?? false }
  })

  // Reload the webContents that ASKED, not the module-global mainWindow. Detached Canvas/Node
  // windows (services/canvas/canvas-window.ts) load the SAME renderer bundle behind the SAME
  // preload, so src/main.tsx wraps them in the same <ErrorBoundary label="the application shell">
  // and its "Reload window" button (reloadWindow in src/lib/global-errors.ts) lands here from them
  // too. Reloading mainWindow refreshed a window the operator may not even have on screen while the
  // surface that actually crashed stayed on its crash fallback. What hid it: the call still
  // answered {success:true}, and reloadWindow's location.reload() fallback only runs on a throw —
  // so the recovery button reported success and recovered nothing. event.sender rather than
  // BrowserWindow.fromWebContents(event.sender): the sender is always the caller and always
  // reloadable, whereas fromWebContents is null for a WebContentsView-hosted page and would
  // reintroduce the same silent success.
  ipcMain.handle('window:reload', (event) => {
    event.sender.reload()
    return { success: true, data: null }
  })

  ipcMain.handle('window:toggleDevTools', () => {
    mainWindow?.webContents.toggleDevTools()
    return { success: true, data: null }
  })

  ipcMain.handle('app:getDataDir', () => {
    const userData = app.getPath('userData')
    return {
      success: true,
      data: {
        userData,
        dbPath: join(userData, 'lamprey.db')
      }
    }
  })

  ipcMain.handle('app:openPath', async (_event, p: string) => {
    try {
      if (typeof p !== 'string' || !p) return { success: false, error: 'path required' }
      // SECURITY: shell.openPath runs the OS file association — refuse executable
      // file types and UNC paths so it can't be used to launch a program.
      const DANGEROUS =
        /\.(exe|bat|cmd|com|scr|ps1|psm1|hta|msi|msix|vbs|vbe|js|jse|jar|wsf|wsh|lnk|reg|cpl|pif)$/i
      if (p.replace(/\//g, '\\').startsWith('\\\\')) {
        return { success: false, error: 'UNC paths are not allowed.' }
      }
      if (DANGEROUS.test(p)) {
        return { success: false, error: 'Refusing to open an executable file type.' }
      }
      const { shell } = await import('electron')
      const err = await shell.openPath(p)
      if (err) return { success: false, error: err }
      return { success: true, data: null }
    } catch (e) {
      return { success: false, error: messageOf(e) ?? 'openPath failed' }
    }
  })

  ipcMain.handle('app:getWorkingFolder', () => {
    // In dev, app.getAppPath() returns the project root (e.g. "Lamprey Harness").
    // In a packaged build it returns the path to app.asar — fall back to the
    // executable's parent folder, which is the install directory the user sees.
    let raw = app.getAppPath()
    let name = basename(raw)
    if (name === 'app.asar' || name === 'app') {
      raw = join(app.getPath('exe'), '..')
      name = basename(raw)
      if (!name) name = app.getName()
    }
    return { success: true, data: { name, fullPath: raw } }
  })

  // T1 — let chatStream's inactivity watchdog read settings.json without
  // dragging an electron import into provider-layer tests.
  setProviderUserDataPath(() => app.getPath('userData'))
  // DBG1 — wire the diagnostic trace writer's userData path. Tracing itself is
  // opt-in via `debugTrace: true` in settings.json; `forceDebugTraceOn()` stays
  // exported from debug-trace.ts as the escape hatch for a debug build.
  setDebugTraceUserDataPath(() => app.getPath('userData'))
  // macOS only lists an app under Full Disk Access once it has ATTEMPTED a protected
  // read. DUIN never touched one in a normal session, so it never appeared in System
  // Settings and there was no switch for the user to turn on. Best-effort probe.
  registerForFullDiskAccessListing()
  trace('main.boot', {
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    userData: app.getPath('userData')
  })
  app.on('before-quit', () => {
    trace('main.before-quit')
    // Tell the tray interceptor a quit is under way. EVERY quit path fires this event —
    // Cmd+Q, the app menu, autoUpdater.quitAndInstall(), the tray's own item — whereas the
    // flag used to be set only by the tray menu, so with minimize-to-tray on every other
    // path had its window close intercepted and hidden and the app never quit.
    markQuitRequested()
    // Abort any live agentic work so no subagent/workflow keeps making model
    // calls or running tools (incl. file writes) detached from the dying app.
    try {
      abortAllWorkflows('quit')
      abortAllLiveForks('quit')
      void stopGateway()
    } catch (e) { console.debug('[main] best-effort shutdown:', messageOf(e)) }
    flushTrace()
  })

  // Crash recovery: any agent_runs row still 'running' is an orphan from a
  // previous hard exit — mark it aborted so it can't show as a forever-live task.
  reconcileStaleRuns()

  // Main-thread stall attribution. instrumentIpcMain wraps every handler
  // registered AFTER it, so it must precede registerAllIpcHandlers; the
  // heartbeat catches whatever the wraps don't. Read at GET /debug/stalls.
  instrumentIpcMain(ipcMain)
  startMainStallMonitor()

  registerAllIpcHandlers()

  // M5 — wire the agentic fork runner: forkAgent (workflows/subagents) now runs
  // a real model→tool loop (was unregistered → the Workflow tool threw). Tools
  // are capability-gated (fail-closed, sandbox-bypass denied) via tool-exec.
  try {
    setWorkflowChatRunner({
      runner: agenticForkRunner,
      defaultModel: (readSettings().defaultModel as string) || 'glm-5.3'
    })
    // B5 fix — TIER_MODEL_MAP (workflow-budget.ts) ships hardcoded to literal DeepSeek
    // ids as a last-resort default, so every built-in workflow's
    // `agent(prompt, {model:'cheap'|'pro'})` call silently required a DeepSeek key
    // regardless of which provider the operator configured. Register the LIVE resolver
    // rather than snapshotting both tiers here: resolveWorkflowTierModel reads state
    // that does not exist yet at this instant — `ollamaModels` is only filled by the
    // async detectOllama() probe that startLocalBrain fires further down this same
    // function, and a provider key may be pasted during onboarding minutes from now.
    // A snapshot therefore resolved null for BOTH tiers on every launch of a keyless
    // local-Ollama install and pinned workflows to DeepSeek for the whole session.
    // Each agent() call now re-resolves; null still means "leave the shipped default".
    setTierModelResolver(resolveWorkflowTierModel)
  } catch (err) {
    console.error('[main] agentic fork runner registration failed:', (err as Error)?.message)
  }

  try {
    createSplashWindow()
  } catch (err) {
    console.error('[main] Splash window init error:', (err as Error).message)
  }

  try {
    initializeSkillLoader()
  } catch (err) {
    console.error('[main] Skill loader init error:', (err as Error).message)
  }

  // Customize C7 — plugin manifest loader. Bootstraps bundled plugins
  // from resources/plugins/ into userData/plugins/ on first run; then
  // serves all subsequent reads from userData with chokidar hot-reload.
  try {
    initializePluginLoader()
    // Plugin staging is scratch for a review that is happening RIGHT NOW. A stage
    // surviving a quit or a crash is an abandoned review, not a pending decision —
    // and leaving cloned third-party trees under userData across restarts would
    // accumulate code the operator declined, in a directory next to the one that
    // loads. Cleared after the loader boots so an in-flight commit is never racing
    // a delete of its own source.
    clearAllStaging()
  } catch (err) {
    console.error('[main] Plugin loader init error:', (err as Error).message)
  }

  // Snip Phase K10 — load YAML filters under resources/snip-filters/
  // (built-in) and userData/snip/filters/ (user); chokidar hot-reload.
  try {
    initializeFilterLoader()
  } catch (err) {
    console.error('[main] Snip filter loader init error:', (err as Error).message)
  }

  // Track 2 / C4 — slash commands. Watches userData/slash-commands for
  // live edits; bootstraps the bundled built-ins on first run.
  try {
    initializeMemoryStore()
  } catch (err) {
    console.error('[main] Memory store init error:', (err as Error).message)
  }

  // Deferred off the boot path. This no-ops once the FTS table is populated, but
  // the one launch that does rebuild it walks every conversation title and every
  // user/assistant message body in a row-by-row insert loop — unbounded, on the
  // main thread, with the window not yet created. Search is the only consumer and
  // it degrades to "no results yet" for a few seconds, which beats a blank screen.
  setTimeout(() => {
    try {
      const fts = backfillSessionsFts(false)
      if (fts.rebuilt) console.log(`[main] sessions FTS backfilled: ${fts.rows} rows`)
    } catch (err) {
      console.error('[main] Sessions FTS backfill error:', (err as Error).message)
    }
  }, 6_000).unref?.()

  try {
    initializeSlashCommandLoader()
  } catch (err) {
    console.error('[main] Slash-command loader init error:', (err as Error).message)
  }

  try {
    // First run: seed the default hook rows so the engine isn't firing into an
    // empty table. Idempotent — only seeds once, never duplicates user hooks.
    const seed = seedDefaultHooks()
    if (seed.seeded > 0) console.log(`[main] seeded ${seed.seeded} default hooks`)
    void fireHooks('sessionStart')
    // Boot recovery: any automation_runs left 'running' by a crash/quit are marked
    // 'interrupted' so they never block a fresh idempotency claim on next fire.
    try {
      const recovered = recoverInterruptedAutomationRuns()
      if (recovered > 0) console.log(`[main] recovered ${recovered} interrupted automation run(s)`)
    } catch (err) {
      console.error('[main] automation-run recovery failed:', (err as Error).message)
    }
    startAutomations()
    startLoopWakeups()
    startLoopController()
    // Loops fire through the TS agentic scheduler (produces real artifacts),
    // NOT the python text-gen tick — single scheduler, no double-fire.
    startLoopScheduler()
    // Grounding guard (cohesion Axis-2): if localBrainNotesDir points at a legacy vault with no
    // .duin state dir, the brain would read EMPTY native state silently — surface it loudly at boot.
    try {
      const groundingWarn = checkBrainVault((readSettings().localBrainNotesDir as string) || null)
      if (groundingWarn) console.warn(groundingWarn)
    } catch { /* never block boot */ }
    // SOUL.md backfill — scaffoldOkf runs only on folder-pick, so a vault adopted before
    // SOUL.md existed would never get one. Create-if-missing only; never clobbers.
    try {
      const soul = ensureFoundationSoul((readSettings().localBrainNotesDir as string) || null)
      if (soul.created) console.log('[foundation] created SOUL.md in vault root')
      if (soul.error) console.warn('[foundation] SOUL.md backfill failed:', soul.error)
    } catch { /* never block boot */ }
    // Advance the calibration loop on a clock: resolve+score fired forecasts even
    // if nobody opens the forecasts panel (day-grained eval windows; idempotent).
    startCalibrationTick(() => {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d : null
    })
    // Advance the world-state-gated claim-metabolism on the same clock (DUIN_CLAIM_METABOLISM_LIVE,
    // default ON → persists ledger retirements every 15 min; =0 disables — see claim-metabolism-tick.ts).
    startClaimMetabolismTick(() => {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d : null
    })
    // Adjudicate in-flight engine self-improvement changes on the same clock: a change kept
    // only if its target engine did not regress on the held-out window, else rolled back +
    // its class demoted. HARD no-op unless backgroundAutonomy is on (self-improve-tick.ts);
    // DUIN_RSI_TICK_MS=0 disables entirely.
    startSelfImproveTick(() => {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d : null
    })
    // P6 — populate the BEHAVIORAL-efficacy (A/B measured-lift) signal on a clock, so
    // efficacy-weighted demotion + the govern grant arm stop being inert (nothing gets
    // promoted, so the on-promote measure hook never fires). Conservative (6h), batch-capped,
    // LOCAL-FIRST + provider-agnostic (see measure-tick.ts); DUIN_MEASURE_TICK=0 disables. The
    // operator-fact store is process-global (setOperatorModelPath), so no vault getter is needed.
    startMeasureTick()
    // Populate the MOAT-FIT signal (transfer pilot #4b) on a clock, so the RSI bench's
    // named-skill-lift slot reads a measured number instead of the null it carried while the
    // grader only ever fired on a manual /debug/transfer-ab POST. Daily + measurement-only
    // (mutates no moat state); DUIN_TRANSFER_AB_TICK=0 disables — see transfer-ab-tick.ts.
    startTransferAbTick(() => {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d : null
    })
    // Put a FLOOR under construction. Every other producer here is already on a clock;
    // construction alone fired only off a chokidar vault-file edit, so a quiet vault
    // stalled it indefinitely — measured 10 days on 2026-07-30, which simultaneously
    // froze Brain Health (it runs only after a construction rebuild) and pinned the
    // graph's `entity`-kind share at 63%, since typed kinds arrive from construction
    // and nowhere else. Schedules only, so the existing debounce and 20-minute min-gap
    // still apply; DUIN_CONSTRUCTION_FLOOR_HOURS=0 disables it.
    startConstructionFloor(() => {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d : null
    })
  } catch (err) {
    console.error('[main] hooks/automations/loops init error:', (err as Error).message)
  }

  mcpManager.initialize()
    .then(() => ensureNodeReplDefaultServer())
    .catch((err) => {
      console.error('[main] MCP initialization error:', messageOf(err))
    })

  // In-process local brain. Speaks the AG-UI contract on 127.0.0.1:8799 so the
  // duin-bridge connector has a default brain to talk to with NO external
  // server: notes-RAG → tool card → grounded provider streaming + /graph.
  // Wire the userData path (for its own sqlite + the shared embeddings worker)
  // and the settings reader before starting.
  // Anti-swallow telemetry (DUIN_BRAIN_UNIFICATION_SPEC.md §4): guarded()'s
  // UNEXPECTED failures land in the event log — loud + queryable — instead of a
  // silent catch. Wire first so it covers the whole boot sequence.
  setGuardTelemetry((label, err) => {
    try {
      recordEvent({
        type: 'guarded.failure',
        actorKind: 'system',
        severity: 'error',
        payload: { label, message: err instanceof Error ? err.message : String(err) }
      })
    } catch (e) { console.debug('[main] event-log itself unavailable; guarded already console.errord:', messageOf(e)) }
  })
  setLocalBrainUserDataPath(app.getPath('userData'))
  setLocalBrainSettingsReader(() => readSettings())
  setLocalBrainSettingsWriter((p) => patchSettings(p)) // /state/config persistence
  // Portability (audit A2/A5/A7): the moat JSON stores (operator model, success
  // traces, earned-autonomy ledger) must survive reinstall. Resolve the vault dir and
  // RESTORE them from the vault projection BEFORE the stores read — so a fresh install
  // over an existing/synced vault recovers the accrued moat instead of starting empty.
  // (On a full reinstall the vault path setting is also lost, so we ALSO rehydrate when
  // the notes dir is (re)set — see setMoatVaultRehydrateHook wiring below.)
  const readMoatVaultDir = (): string | null => {
    try {
      const d = readSettings().localBrainNotesDir
      return typeof d === 'string' && d.trim() ? d.trim() : null
    } catch {
      return null
    }
  }
  rehydrateMoatFromVault(app.getPath('userData'), readMoatVaultDir())
  // A1 — "Remember this" durable knowledge (userData/lamprey-memory/**.md) is off-vault;
  // restore it from the vault projection on a fresh install over an existing/synced vault.
  rehydrateMemoryFromVault(app.getPath('userData'), readMoatVaultDir())
  // A3/A4/A6 — decisions + calibration ledger + insight affinity live in lamprey.db with
  // no vault copy. Restore them from the vault projection into any table still empty (a
  // fresh install). getDb() lazy-inits the schema, so this is safe here.
  importBrainTablesFromVault(readMoatVaultDir())
  // F1 — operator-learning store (the brain accrues a model of the operator).
  setOperatorModelPath(app.getPath('userData'))
  setMeasureHook((id) => void measureOne(id).catch(() => {})) // item 13 — incremental measure on promote
  // Live LearningPanel — push the fact set to all windows after any mutation (human veto
  // AND the automatic capture/govern loop). Debounced so a govern-loop batch of persists
  // coalesces into one broadcast; getAllWindows() is [] pre-window, so early boot is a no-op.
  {
    let opTimer: ReturnType<typeof setTimeout> | null = null
    setOperatorChangeHook(() => {
      if (opTimer) return
      opTimer = setTimeout(() => {
        opTimer = null
        try {
          const facts = getOperatorFacts()
          for (const win of BrowserWindow.getAllWindows()) win.webContents.send('operator:changed', facts)
        } catch (err) {
          console.debug('[main] operator:changed broadcast skipped:', (err as Error)?.message)
        }
      }, 200)
      opTimer.unref?.()
    })
  }
  // The SEAM — on promote, materialize a portable OKF concept into the vault's .brain/memory
  // (ON by default since W3 2026-09-02; DUIN_SEAM_MATERIALIZE=0 disables; fire-and-forget). Provisional
  // facts project too, with status:. Resolves the vault dir at call time.
  // Every governed transition ALSO schedules the debounced FULL projection (lineage + entity
  // edges + index) via seam-reconcile, and a one-shot boot pass self-heals the transitions
  // that never fire this hook (evictToCap, flag-off periods) — see seam-reconcile.ts.
  const seamNotesDir = (): string | null => {
    const d = readSettings().localBrainNotesDir
    return typeof d === 'string' && d ? d : null
  }
  setMaterializeHook(makeMaterializeHook(seamNotesDir, (action) => scheduleSeamReconcile(action)))
  startSeamAutoReconcile(makeProductionSeamDeps(seamNotesDir, (dir) => scheduleReindex(dir)))
  // Cold-start FILL (first-run guarded): warm the operator-fact store from the operator's OWN
  // vault Rules cards so the govern/verify metabolism has fuel on day one instead of an empty
  // loop. Deterministic, keyless, idempotent, veto-respecting. Safe now that the govern jury
  // ABSTAINS on a parse-miss (won't mass-revert freshly-seeded provisional facts). Runs once;
  // retries on a later boot only if no cards were found yet.
  // PER-VAULT gate (was a global `coldStartSeeded` install flag): the marker now
  // lives in the vault's own `.brain/state/cold-start.json`, so a SECOND operator's
  // vault seeds independently instead of being blocked by the first install's flag.
  // Migration for the current operator: an existing install carries the legacy
  // global flag but no per-vault marker — treat that flag as "this (current) vault
  // already seeded" and migrate it forward WITHOUT re-seeding, so their boot is
  // untouched and their vault isn't re-processed.
  try {
    const s = readSettings()
    const nd = typeof s.localBrainNotesDir === 'string' ? s.localBrainNotesDir.trim() : ''
    if (nd && !hasColdStarted(nd)) {
      if (s.coldStartSeeded) {
        // Legacy global flag set, per-vault marker absent → migrate, don't re-seed.
        markColdStarted(nd)
        console.log('[main] cold-start: migrated legacy global flag → per-vault marker')
      } else {
        const seeded = seedFromVault(nd)
        if (seeded.read > 0) {
          markColdStarted(nd, { added: seeded.added, provisional: seeded.provisional, read: seeded.read })
          console.log(`[main] cold-start seed: +${seeded.added} facts (${seeded.provisional} provisional)`)
        }
      }
    }
  } catch (err) {
    console.error('[main] cold-start seed error:', (err as Error)?.message)
  }
  // ANS earned-autonomy governor — the capability ledger (rungs + ratify record).
  setCapabilityLedgerPath(app.getPath('userData'))
  seedCapabilities()
  registerExecutorCapability() // delegate_task earns its trusted-afk autonomy via keep/discard
  setActionLedgerPath(app.getPath('userData')) // item 23 — safe-undo ledger + snapshot dir
  // Positive-signal learning — the success-trace store (endorsements → exemplars).
  setSuccessStorePath(app.getPath('userData'))
  // Mirror the moat stores to the vault on a slow cadence + at shutdown so the durable
  // vault copy stays fresh (they change slowly; userData stays runtime-authoritative).
  const flushMoat = (): void => {
    const vault = readMoatVaultDir()
    projectMoatToVault(app.getPath('userData'), vault)
    projectMemoryToVault(app.getPath('userData'), vault)
    exportBrainTablesToVault(app.getPath('userData'), vault)
  }
  const moatFlushTimer = setInterval(flushMoat, 5 * 60_000)
  moatFlushTimer.unref?.()
  app.on('before-quit', flushMoat)
  // Learning weld (organ #3): every human verdict (promote/veto in LearningPanel)
  // is forwarded into the vault metabolism's operator-authored corrections stream
  // (.duin/_state/corrections.jsonl) so reflect/taste turn on DUIN's OWN usage —
  // not the operator's session hooks. Best-effort, keyless-first; see learn-bridge.ts.
  setOperatorLifecycleHook((fact, action, reason) => {
    void forwardCorrection(fact, action, reason)
  })
  // Remember-loop telemetry. Before this the loop emitted nothing: 0 of 34,807
  // event rows matched any fact/promotion/correction term, so "is it turning?" was
  // only answerable by diffing file mtimes.
  setOperatorEventHook((type, payload) => {
    recordEvent({
      type: type as Parameters<typeof recordEvent>[0]['type'],
      actorKind: 'system',
      payload
    })
  })
  // "Build my brain" — cache path (keyed by the notes dir) for the LLM-inferred
  // entities/edges/classifications, so they load on boot without re-running.
  setConstructPaths(app.getPath('userData'), () => {
    const dir = readSettings().localBrainNotesDir
    return typeof dir === 'string' && dir.trim() ? dir : null
  })
  startLocalBrain().catch((err) => {
    console.error('[main] Local brain start error:', (err as Error)?.message)
  })
  // Consumption bridge (DUIN nervous system, organ #2): periodically drain
  // recorded feedback seeds into the engine — staging them in an app-owned ledger
  // so the pump works keyless. Best-effort; never blocks boot.
  try {
    startFeedbackBridge()
  } catch (err) {
    console.error('[main] Feedback bridge start error:', (err as Error)?.message)
  }
  // Learning weld (organ #3): backfill the human verdicts already in
  // operator-model.json once, then drain pending corrections to the engine when
  // it's up. Closes capture → corrections.jsonl → reflect → taste.
  try {
    startLearnBridge(() => getOperatorFacts())
  } catch (err) {
    console.error('[main] Learn bridge start error:', (err as Error)?.message)
  }
  // Subagent types: register the vault's .duin/agents/*.md as real, dispatchable
  // fork types (forkAgent executes their tools post-M5), then revive the
  // userData/subagent-types discovery loader (it was defined but never wired, so
  // a user file shadowing a vault agent still wins — loaded second on purpose).
  try {
    const agentsVault = readSettings().localBrainNotesDir
    if (typeof agentsVault === 'string' && agentsVault.trim()) loadVaultSubagents(agentsVault)
    initializeSubagentTypeLoader()
  } catch (err) {
    console.error('[main] Vault agents load error:', (err as Error)?.message)
  }
  // Integrations (ingest) — per-source state + periodic sync of enabled,
  // configured connectors (Slack / Gmail / Calendar) into the brain.
  try {
    setConnectionsPath(app.getPath('userData'))
    startConnectorSync()
  } catch (err) {
    console.error('[main] Connector sync init error:', (err as Error)?.message)
  }
  // Channels (conversational connectivity) — load persisted per-channel state +
  // per-user pairing trust. No concrete channels are auto-started in Stage 1;
  // this just hydrates the stores so the pairing gate + UI have their state.
  try {
    setChannelsPath(app.getPath('userData'))
    setPairingPath(app.getPath('userData'))
    // Proactive substrate: the persisted delivery dead-letter queue + the
    // awaiting-reply interaction store. Hydrated here so a redelivery pending
    // from a previous run resumes on the automations tick.
    setDeliveryQueuePath(app.getPath('userData'))
    setPendingInteractionsPath(app.getPath('userData'))
    setNoticesPath(app.getPath('userData'))
    // The store stays free of electron imports so it unit-tests off Electron; the owner
    // supplies the broadcast rather than the store reaching for BrowserWindow itself.
    setNoticesChangeListener(broadcastNoticesChanged)
    // Reach — start the channel gateway. No-op unless the operator has enabled
    // a configured channel; every inbound turn is deny-first + de-privileged.
    void startGateway().catch((err) =>
      console.error('[main] Channel gateway start error:', (err as Error)?.message)
    )
  } catch (err) {
    console.error('[main] Channels init error:', (err as Error)?.message)
  }
  // Durable brain state (decisions + calibration ledger) in the app's SQLite;
  // also hydrates the made-decisions register from disk. Best-effort.
  try {
    enableBrainPersistence()
  } catch (err) {
    console.error('[main] Brain persistence enable error:', (err as Error)?.message)
  }

  createWindow()

  // PS4 — the DB integrity scan is linear in database size and used to run
  // inline on the first getDb(), inside the synchronous block above. Now that
  // the window exists, let it run on its own.
  scheduleStartupIntegrityCheck()

  initializeTray({ getWindow: getMainWindow })
  registerGlobalShortcuts({ getWindow: getMainWindow })
  initializeUpdater({ getWindow: getMainWindow }).catch((err) => {
    console.error('[main] Updater init failed:', messageOf(err))
  })

  // macOS Dock-icon activate — the same "un-hide the app" request as 'second-instance' above, and
  // it had the same hole. The zero-windows guard alone MISSES the hide-to-tray state this app
  // creates: with "Minimize to tray on close" on, handleWindowClose (services/tray.ts) HIDES the
  // main window instead of destroying it, so it is still a live window — getAllWindows().length is
  // 1, the `=== 0` branch never fires, and this path had no show()/focus() fallback at all, so a
  // Dock click did literally nothing.
  //
  // What made it invisible: this is the exact boilerplate every Electron sample ships, and it IS
  // correct for the default minimizeToTray:false where close really destroys the window. Reveal an
  // existing window first (revealWindow covers hidden AND minimized); create only when there is
  // genuinely nothing left to reveal. isDestroyed() because a dead BrowserWindow is still truthy
  // and every method on it throws — falling through to createWindow() is the right answer then.
  app.on('activate', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      revealWindow(mainWindow)
      return
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  if (boundsPersistTimer) {
    clearTimeout(boundsPersistTimer)
    boundsPersistTimer = null
  }
  suppressBoundsPersist = true
  // PS2 — stop the periodic checkpoint before closing the DB. Order
  // matters: an interval tick that lands after `db.close()` would error
  // on the dropped handle.
  if (stopPeriodicCheckpoint) {
    stopPeriodicCheckpoint()
    stopPeriodicCheckpoint = null
  }
  // PS4 — same reason: a deferred integrity scan that fires after closeDb()
  // would run against a dropped handle.
  cancelStartupIntegrityCheck()
  // PS5 — same lifecycle for the backup runner.
  if (stopBackupRunner) {
    stopBackupRunner()
    stopBackupRunner = null
  }
  // B2 — stop the backend-health monitor timer before closeDb().
  if (stopBackendHealthMonitor) {
    stopBackendHealthMonitor()
    stopBackendHealthMonitor = null
  }
  // Same lifecycle for the coherence-health monitor timer.
  if (stopCoherenceHealthMonitor) {
    stopCoherenceHealthMonitor()
    stopCoherenceHealthMonitor = null
  }
  mcpManager.shutdown().catch(() => {})
  shutdownSkillLoader()
  shutdownPluginLoader()
  shutdownFilterLoader()
  shutdownMemoryStore()
  shutdownSlashCommandLoader()
  destroyArtifactSandbox()
  destroyTray()
  ptyKillAll()
  destroyBrowserTabs()
  destroyAllDevServers()
  destroyAllBackgroundShells()
  destroyAllMonitors()
  void stopLocalBrain().catch(() => {})
  stopFeedbackBridge()
  stopLearnBridge()
  closeLocalBrainStore()
  stopAutomations()
  stopLoopWakeups()
  stopLoopController()
  stopLoopScheduler()
  // P6 — stop the scheduled measure pass for the GUI lifetime (idempotent no-op if never started).
  stopMeasureTick()
  stopTransferAbTick()
  stopConstructionFloor()
  stopSeamAutoReconcile()
  void shutdownReviewWatcher()
  // closeDb() also runs a final TRUNCATE checkpoint before closing the
  // handle (PS2). That covers graceful exits. The periodic checkpoint
  // bounds the WAL during long live sessions and is the safety net for
  // ungraceful exits (force-kill, OOM) where closeDb() never runs.
  closeDb()
})
