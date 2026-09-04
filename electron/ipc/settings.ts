import { ipcMain, BrowserWindow, dialog } from 'electron'
import { join } from 'path'
import { realpathSync } from 'fs'
import { app } from 'electron'
import { reindex, indexedCount } from '../services/local-brain/index-store'
import { globalSearch } from '../services/local-brain/global-search'
import { listMoatBackups, restoreLatestMoatDetailed } from '../services/local-brain/moat-backup'
import { buildAutonomyState } from '../services/ans/autonomy-report'
import { rearmCapability } from '../services/ans/governor'
import {
  getCausalGraph,
  runPropagate,
  getPredictedRisks,
  getWorldState,
  getInsights,
  getGenerativeInsights,
  getPeople,
  getDecisionLoop,
  recordDecision,
  recordInsightVerdict,
  setBrainSeed,
  getHomeDigest,
  recordVerdict,
  buildBrain,
  runExtractionAndBuild,
  resetExtractionBreaker
} from '../services/brain'
import type { DecisionOutcome } from '../services/brain'
import { buildGraphReportCached, buildMapCommunityAssignmentsCached, buildGraphSnapshot } from '../services/brain/graph-insight'
import { cachedBrainGraph } from '../services/local-brain/brain-native-routes'
import { recordGraphHistory } from '../services/brain/graph-history-store'
import { liveEntityEgoGraph } from '../services/brain/entity-ego'
import {
  simulateDecision,
  commitDecisionForecast,
  type DecisionSimRequest,
  type CommitForecastInput
} from '../services/brain/decision-simulator'
import * as keychain from '../services/keychain'
import { deepseekClient } from '../services/deepseek'
import {
  PROVIDERS,
  resetProviderClient,
  validateProviderKeyDetailed,
  type ProviderId
} from '../services/providers/registry'
import {
  ALL_WEB_SEARCH_PROVIDERS,
  keychainProviderFor as searchKeychainKey,
  type WebSearchProviderId
} from '../services/web-search-adapters'
// SP-1 — single source of truth for defaults. The hand-maintained literal that
// used to live here drifted from the renderer copy (D1, SP_BASELINE.md §1);
// `default-app-settings.test.ts` now locks the renderer literal against this.
import { DEFAULT_APP_SETTINGS } from '../services/default-app-settings'
import { friendly, messageOf } from '../services/guarded'
import { recordEvent } from '../services/event-log'
import { readSettingsFile, writeSettingsFile } from '../services/settings-file'
import { readSettings as readPersistedSettings } from '../services/settings-helper'
import { guardSettingsPartial, type SettingsRejection } from '../services/settings-schema'
import {
  applySettingsBundle,
  buildSettingsBundle,
  listCorruptSidecars,
  parseSettingsBundle,
  resetSettingsFile
} from '../services/settings-bundle'
import { atomicWriteFileSync } from '../services/atomic-write'
import { resolveOperatorWritePaths } from '../services/sandbox/operator-write-paths'
import { recordNotice } from '../services/proactive/notices-store'
import { readFileSync } from 'fs'
import {
  grantTrustedDirectory,
  hasTrustedDirectoryGrant
} from '../services/trusted-path-grants'
import {
  commitReadyBrainVault,
  enqueueBrainVaultMutation,
  reindexAndBuild
} from '../services/brain-vault-adoption'

const getSettingsPath = () => join(app.getPath('userData'), 'settings.json')

// Import source authority comes from main-process detection, not a renderer path.
// Refreshing detection replaces all prior capabilities.
const detectedImportSources = new Map<string, Set<string>>()

/** Broadcast `brain:updated` to every live (non-destroyed) renderer window.
 *  Single guarded loop so the ~6 call sites don't each re-implement (and some
 *  previously OMITTED) the `!isDestroyed()` guard. */
function broadcastBrainUpdated(count: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('brain:updated', { count })
  }
}

const defaultSettings = DEFAULT_APP_SETTINGS

function readSettings() {
  // UB-7 (Unburdening Phase, 2026-06-10) — the agentMode coercion that
  // lived here is gone along with every reader of the key. Stale keys in
  // existing settings.json files ride through inert.
  //
  // 'absent' and 'corrupt' both yield bare defaults so the app still runs, but
  // they are no longer indistinguishable on the WRITE side: writeSettings
  // side-cars a corrupt file instead of persisting these defaults over it.
  //
  // Through settings-helper, not readSettingsFile directly: the helper owns the one-time
  // provider-policy migration, and this reader used to bypass it, so a file still carrying
  // defaultModel / backgroundModel / brainEngine read differently depending on which
  // module asked first (settings evaluation D7).
  return { ...defaultSettings, ...readPersistedSettings() }
}

function writeSettings(settings: Record<string, unknown>): void {
  writeSettingsFile(getSettingsPath(), settings)
}

function requireRendererGrantedDirectory(value: unknown, field: string): string {
  const candidate = typeof value === 'string' ? value.trim() : ''
  if (!candidate) throw new Error(`${field} is required`)
  const resolved = realpathSync(candidate)
  const active = readSettings().localBrainNotesDir
  if (hasTrustedDirectoryGrant(resolved)) return resolved
  if (typeof active === 'string' && active) {
    try {
      if (realpathSync(active) === resolved) return resolved
    } catch { /* a stale active path grants nothing */ }
  }
  throw new Error(`${field} must be the active vault or selected with the native folder picker`)
}

function isProvider(id: unknown): id is ProviderId {
  return typeof id === 'string' && id in PROVIDERS
}

/**
 * Derive a `/health` URL from an AG-UI brain endpoint, e.g.
 * `http://127.0.0.1:8799/agui` → `http://127.0.0.1:8799/health`. Falls back to
 * appending `/health` to the origin when the path can't be parsed.
 */
function deriveHealthUrl(endpoint: string): string | null {
  try {
    const u = new URL(endpoint)
    u.pathname = '/health'
    u.search = ''
    u.hash = ''
    return u.toString()
  } catch {
    return null
  }
}

/**
 * DUIN — probe an agent/DUIN brain endpoint. Tries GET /health first;
 * if that 404s/errors, falls back to a trivial AG-UI POST. Runs in the main
 * process so it isn't subject to renderer CORS, and is bounded by a short
 * timeout so the Settings UI never hangs on a dead host.
 */
async function probeBrain(endpoint: string): Promise<{ ok: boolean; detail: string }> {
  const health = deriveHealthUrl(endpoint)
  // 1) GET /health
  if (health) {
    try {
      const r = await fetch(health, { signal: AbortSignal.timeout(5000) })
      if (r.ok) return { ok: true, detail: `Connected (GET /health → ${r.status})` }
    } catch {
      // fall through to the POST probe
    }
  }
  // 2) Trivial AG-UI POST — a brain that doesn't serve /health may still
  //    accept a turn. We only need to confirm the socket answers HTTP.
  try {
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ threadId: 'duin-healthcheck', messages: [] }),
      signal: AbortSignal.timeout(5000)
    })
    // Any HTTP response (even 4xx) means something is listening and speaking HTTP.
    return { ok: true, detail: `Reachable (POST ${endpoint} → ${r.status})` }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, detail: `Unreachable — ${msg}` }
  }
}

/**
 * (Re)index a notes dir, re-point the live watcher, broadcast brain:updated so
 * live Brain views refetch the structural graph immediately, then run the
 * key-gated temporal-extraction + "Build my brain" construction passes in the
 * background (each broadcasts again on completion). No model → both no-op.
 * Shared by the localBrain:reindex IPC and the settings:set auto-reindex.
 */
// reindexAndBuild moved to brain-vault-adoption.ts (the serialized vault coordinator) so vault
// switch, onboarding adoption, and the explicit reindex share ONE owner — its post-index build
// carries this file's former single-flight + breaker-reset + kept-cache/model-error honesty.

export function registerSettingsHandlers(): void {
  // A settings.json that is present but unreadable boots the app on defaults, which looks
  // exactly like a fresh install: the vault path is gone and onboarding comes back. Say so
  // where the operator looks (Home → Needs you) instead of on a console nobody reads. The
  // check is deferred so the notices store has loaded from disk before this row is added.
  const corruptCheck = setTimeout(() => {
    try {
      const path = getSettingsPath()
      if (readSettingsFile(path).state !== 'corrupt') return
      const sidecars = listCorruptSidecars(app.getPath('userData'))
      recordNotice({
        kind: 'watch',
        severity: 'error',
        title: 'Your settings file could not be read',
        body:
          'DUIN started with default settings, so your brain folder and preferences look missing. ' +
          (sidecars.length > 0
            ? `The unreadable file is kept at ${sidecars[0]}; restore it by hand or import a settings export.`
            : `The file at ${path} could not be parsed; import a settings export or set things up again.`),
        deepLink: 'duin://settings/persistence',
        dedupKey: 'settings-file-corrupt'
      })
    } catch (err) {
      console.debug('[settings] corrupt-file notice skipped:', messageOf(err))
    }
  }, 10_000)
  corruptCheck.unref?.()

  ipcMain.handle('brain:testConnection', async (_event, endpoint: unknown) => {
    try {
      const ep = typeof endpoint === 'string' ? endpoint.trim() : ''
      if (!ep) return { success: false, error: 'No endpoint provided.' }
      const result = await probeBrain(ep)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'Test failed.') }
    }
  })

  // DUIN — native folder picker for the local brain's notes directory.
  // Generic single-directory picker (mirrors files:pickWorkdir's dialog shape
  // but returns just the chosen path so the renderer can persist it via
  // settings:set). Returns null on cancel.
  ipcMain.handle('dialog:pickFolder', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const dlg = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (dlg.canceled || dlg.filePaths.length === 0) return { success: true, data: null }
      return { success: true, data: grantTrustedDirectory(dlg.filePaths[0]) }
    } catch (err) {
      return { success: false, error: friendly(err, 'Folder picker failed') }
    }
  })

  // DUIN — (re)index the local brain's notes folder. Reads the persisted
  // localBrainNotesDir (so the caller persists via settings:set first, then
  // triggers this) and rebuilds the in-process index. Returns the fresh count.
  ipcMain.handle('localBrain:reindex', async () => {
    try {
      const settings = readSettings()
      const dir =
        typeof settings.localBrainNotesDir === 'string' ? settings.localBrainNotesDir : ''
      const count = await reindexAndBuild(dir)
      return { success: true, data: { ok: true, count } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Reindex failed') }
    }
  })

  // "Build my brain" — one LLM construction pass over the RAW indexed notes
  // (no links/frontmatter/tags needed). Infers entities + typed edges + note
  // classifications, caches them, and broadcasts so the Brain graph + panels
  // refetch the connected field. Key-gated: no model → { status: 'no-model' }
  // and the renderer prompts the user to connect a model (Settings → API Keys).
  ipcMain.handle('brain:build', async () => {
    try {
      resetExtractionBreaker('explicit build')
      const result = await buildBrain()
      if (result.status === 'built') {
        broadcastBrainUpdated(indexedCount())
      }
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'Build my brain failed') }
    }
  })

  // The autonomy BREAKER, renderer-side.
  //
  // `runGovernorPass` trips a capability the instant it takes an unhandled miss, and nothing ever
  // restores one automatically. Until now the restore path (`rearmCapability`) was reachable only
  // by POSTing to the local brain by hand — no renderer caller, no surface, not even a display of
  // which capabilities were tripped. The ladder could fall and never climb, and that was an
  // unbuilt button rather than a decision.
  ipcMain.handle('autonomy:state', async () => {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      return { success: true as const, data: buildAutonomyState(notesDir) }
    } catch (err) {
      return { success: false as const, error: friendly(err, 'Read autonomy state failed') }
    }
  })

  // The operator's one affordance: "I looked at this and it is fit to run." Restores the floor
  // rung in a single step — deliberately not a per-rung climb, which would need a quality rate to
  // justify each step, which is the machinery that never once fired.
  ipcMain.handle('autonomy:rearm', async (_e, id: string) => {
    try {
      if (typeof id !== 'string' || !id.trim()) {
        return { success: false as const, error: 'a capability id is required' }
      }
      return { success: true as const, data: rearmCapability(id.trim()) }
    } catch (err) {
      return { success: false as const, error: friendly(err, 'Re-arm failed') }
    }
  })

  // ── The GOVERNANCE read surface ────────────────────────────────────────────
  //
  // GET /state/govern-audit, GET /state/improvements and POST /state/undo all
  // return real content and had zero renderer callers: the governor's own record —
  // which rules it confirmed or reverted, what it would like to retire, which of
  // its writes are still reversible — was reachable by an AGENT over HTTP and not
  // by the OPERATOR the record is about. These mirror the `autonomy:state` pattern
  // (call the same function the route calls, in-process, no HTTP hop) so the pane
  // works whether or not :8799 is listening.
  //
  // Dynamic imports on purpose: this is an on-open settings pane, and pulling the
  // operator-model / proposer graph into the boot chain would cost every launch.
  ipcMain.handle('govern:audit', async () => {
    try {
      const [{ buildGovernAudit }, { listActions, implicitUndoTarget }] = await Promise.all([
        import('../services/brain/operator-model'),
        import('../services/ans/action-ledger')
      ])
      // The undo affordance is only honest if the operator can see WHAT it will
      // undo before confirming, so the still-reversible actions travel with the
      // audit and the bare-undo target is named rather than inferred in the UI.
      return {
        success: true as const,
        data: {
          ...buildGovernAudit(),
          actions: listActions({ status: 'applied' }),
          undoTarget: implicitUndoTarget() ?? null
        }
      }
    } catch (err) {
      return { success: false as const, error: friendly(err, 'Read govern audit failed') }
    }
  })

  ipcMain.handle('govern:improvements', async () => {
    try {
      const [{ getImprovementProposals }, { pruneCandidatesFromStore }] = await Promise.all([
        import('../services/brain/improvement-proposer'),
        import('../services/brain/operator-model')
      ])
      // `shadow` travels with the payload so the pane can never render a proposal
      // as if it had already been applied — nothing here mutates anything.
      return { success: true as const, data: { shadow: true, proposals: getImprovementProposals(pruneCandidatesFromStore()) } }
    } catch (err) {
      return { success: false as const, error: friendly(err, 'Read improvement proposals failed') }
    }
  })

  // The ONE write on this surface. revertAction dispatches the inverse AND fires
  // the capability demote, so the renderer must confirm before calling it — see
  // GovernanceSection in LoopSettings.tsx.
  ipcMain.handle('govern:undo', async (_e, actionId: unknown) => {
    try {
      const { revertAction, implicitUndoTarget } = await import('../services/ans/action-ledger')
      const explicit = typeof actionId === 'string' && actionId.trim() ? actionId.trim() : null
      // A BARE undo skips machine-originated RSI records (implicitUndoTarget's
      // docblock explains why: reverting one fires a demote nobody asked for). An
      // explicit id still reaches them — the default changed, not the reach.
      const target = explicit ?? implicitUndoTarget()
      if (!target) return { success: false as const, error: 'There is nothing to undo.' }
      const r = revertAction(target)
      // Reporting success on a refused revert would tell the operator a demote
      // fired when none did.
      if (!r.ok) return { success: false as const, error: r.error ?? 'Undo was refused' }
      return { success: true as const, data: { actionId: target } }
    } catch (err) {
      return { success: false as const, error: friendly(err, 'Undo failed') }
    }
  })

  // Moat recovery — list the automatic backups (claim ledger + construction cache)
  // that reindexImpl snapshots into <vault>/.duin/_backups/ before each destructive
  // reindex. Lets a non-operator user (or support) see and restore a good state after
  // any clobber, instead of the moat being unrecoverable.
  ipcMain.handle('brain:moatBackups', async () => {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      return { success: true, data: listMoatBackups(notesDir) }
    } catch (err) {
      return { success: false, error: friendly(err, 'Listing backups failed') }
    }
  })

  // Restore the newest backup of each moat source (or one label) over the live state.
  // The ledger reloads on the next metabolize tick; the in-memory construction graph
  // reloads on relaunch (the renderer surfaces that).
  ipcMain.handle('brain:restoreMoat', async (_event, label: unknown) => {
    try {
      const notesDir = (readSettings().localBrainNotesDir as string) || null
      const only = typeof label === 'string' && label ? label : undefined
      // userData dir is REQUIRED: three of the moat sources (operator-model.json,
      // success-traces.json, ans-capabilities.json — the product moat) live in
      // userData, and backup-runner.ts snapshots them by passing it. Omitting it here
      // made sourcePath() return null for exactly those sources, so the only restore
      // path in the product silently skipped the moat while still reporting success.
      // Same `app.getPath('userData')` that feeds switchMoatVault — the wipe this undoes.
      const { restored, skipped } = restoreLatestMoatDetailed(
        notesDir,
        only,
        app.getPath('userData')
      )
      if (restored.length > 0) broadcastBrainUpdated(indexedCount())
      // `skipped` names labels that HAVE a backup but were not written back, so a
      // partial restore can never be presented to the user as a complete one.
      return { success: true, data: { restored, skipped } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Restore failed') }
    }
  })

  // Scaffold an OKF harness from a folder of raw notes. Walks the source,
  // auto-files every note by inferred kind, runs (key-gated) LLM passes for
  // tracks/bio + entity extraction, and writes the foundation files (BRAIN.md /
  // me / GOALS / …) + starter Rules + a DIAGNOSIS.md. IN-PLACE by default: when
  // `outDir` is omitted (or equals srcDir) the brain folder IS the harness —
  // notes are MOVED into pillar folders (read→write→verify→delete, never losing
  // a file). A DIFFERENT outDir keeps the legacy copy-out behavior. Fully
  // defensive (never throws); degrades to heuristics with no model. Dynamic
  // import keeps the scaffolder off this module's static graph.
  ipcMain.handle('brain:scaffold-harness', async (_event, payload: unknown) => {
    try {
      const p = (payload ?? {}) as { srcDir?: unknown; outDir?: unknown }
      const srcDir = requireRendererGrantedDirectory(p.srcDir, 'srcDir')
      // outDir is OPTIONAL — empty/absent ⇒ in-place (scaffolder defaults to srcDir).
      const rawOutDir = typeof p.outDir === 'string' ? p.outDir.trim() : ''
      const outDir = rawOutDir ? requireRendererGrantedDirectory(rawOutDir, 'outDir') : ''
      const { scaffoldHarness } = await import('../services/brain/scaffold-harness')
      const result = await scaffoldHarness(srcDir, outDir || undefined)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'scaffold-harness failed') }
    }
  })

  // ── `.brain/` harness root — import an existing agent system ──
  // The notes-vault root is the `.brain/` parent. All three handlers resolve it
  // from the persisted localBrainNotesDir so the renderer doesn't have to thread
  // it through.
  function notesVaultRoot(): string | null {
    const dir = readSettings().localBrainNotesDir
    return typeof dir === 'string' && dir.trim() ? dir : null
  }

  // Run every adapter's detect() over the machine + vault, so the UI can offer
  // "Claude Code at ~/.claude" with a contents summary.
  ipcMain.handle('brain:detectImports', async () => {
    try {
      const { detectAgentSystems } = await import('../services/brain/import-agent-system')
      const detected = detectAgentSystems(notesVaultRoot())
      detectedImportSources.clear()
      for (const system of detected) {
        let sources = detectedImportSources.get(system.adapter)
        if (!sources) {
          sources = new Set<string>()
          detectedImportSources.set(system.adapter, sources)
        }
        sources.add(realpathSync(system.dir))
      }
      return { success: true, data: detected }
    } catch (err) {
      return { success: false, error: friendly(err, 'detect imports failed') }
    }
  })

  // Absorb a detected system into `.brain/` (link or copy). Broadcasts so any
  // live Brain view re-reads the now-grounded identity/memory.
  ipcMain.handle('brain:import', async (_event, payload: unknown) => {
    try {
      const p = (payload ?? {}) as { adapterId?: unknown; sourceDir?: unknown; mode?: unknown }
      const adapterId = typeof p.adapterId === 'string' ? p.adapterId : ''
      const sourceDir = typeof p.sourceDir === 'string' ? p.sourceDir : ''
      const mode = p.mode === 'copy' ? 'copy' : 'link'
      if (!adapterId || !sourceDir) {
        return { success: false, error: 'adapterId and sourceDir are required' }
      }
      const resolvedSource = realpathSync(sourceDir)
      if (!detectedImportSources.get(adapterId)?.has(resolvedSource)) {
        return { success: false, error: 'Import source must be detected by DUIN in this session' }
      }
      const { importAgentSystem } = await import('../services/brain/import-agent-system')
      const result = importAgentSystem(adapterId, resolvedSource, mode, notesVaultRoot())
      if (result.ok) {
        broadcastBrainUpdated(indexedCount())
      }
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'import failed') }
    }
  })

  // Read the `.brain/` identity + memory summary for display (the panel shows
  // "identity loaded · N memories" so the user sees the grounding is live).
  ipcMain.handle('brain:loadIdentity', async () => {
    try {
      const { loadBrain } = await import('../services/brain/brain-root')
      const loaded = loadBrain(notesVaultRoot())
      if (!loaded) return { success: true, data: null }
      return {
        success: true,
        data: {
          root: loaded.root,
          hasIdentity: loaded.identity.trim().length > 0,
          identityChars: loaded.identity.length,
          memoryCount: loaded.memory.length,
          memoryChars: loaded.memory.reduce((n, s) => n + s.length, 0)
        }
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'load identity failed') }
    }
  })

  // DUIN — current local-brain status for the Settings panel: distinct
  // note files currently indexed in the in-process store.
  ipcMain.handle('localBrain:status', async () => {
    try {
      return { success: true, data: { indexed: indexedCount() } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Status read failed') }
    }
  })

  // DUIN — rich brain status for the Brain settings panel's status line:
  //   notesIndexed — distinct note files in the in-process index
  //   graphNodes/graphEdges — the structural graph MERGED with any cached
  //     "Build my brain" construction (same view the Brain map renders)
  //   hasModel — whether a callable LLM (BYO key or local Ollama) is available,
  //     so the UI can show "Build my brain" vs the "connect a model" hint.
  ipcMain.handle('brain:status', async () => {
    try {
      const { deriveGraph } = await import('../services/local-brain/graph-derive')
      const { getConstruction, applyConstruction } = await import('../services/brain/construct')
      const { routeModel } = await import('../services/providers/registry')
      const base = deriveGraph()
      const construction = getConstruction()
      const graph = construction ? applyConstruction(base as any, construction) : base
      return {
        success: true,
        data: {
          notesIndexed: indexedCount(),
          graphNodes: graph.nodes.length,
          graphEdges: graph.edges.length,
          hasModel: routeModel('extraction') != null
        }
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'Brain status read failed') }
    }
  })

  // Guided "Connect AI" setup — probe for a locally-running Ollama so the
  // onboarding step can offer keyless local models with one click. Dynamic
  // import keeps the registry off this module's static graph.
  ipcMain.handle('localBrain:detectOllama', async () => {
    try {
      const { detectOllama } = await import('../services/providers/registry')
      return { success: true, data: await detectOllama() }
    } catch (err) {
      return { success: false, error: friendly(err, 'Ollama detect failed') }
    }
  })

  // F1 — operator-learning promotion governance. The review surface lists what
  // DUIN has learned about the operator; promote elevates a candidate to a
  // governing rule, veto suppresses it (and is remembered).
  ipcMain.handle('operator:list', async () => {
    try {
      const m = await import('../services/brain/operator-model')
      return { success: true, data: m.getOperatorFacts() }
    } catch (err) {
      return { success: false, error: friendly(err, 'list failed') }
    }
  })
  // Read-only review queue: candidate facts a human may still promote (Relations) or veto
  // (Learning); learning itself is automatic. Powers the daily Home-digest "N facts waiting for
  // your review" nudge. No mutation.
  ipcMain.handle('operator:pendingReview', async () => {
    try {
      const m = await import('../services/brain/operator-model')
      return { success: true, data: m.getPendingReview() }
    } catch (err) {
      return { success: false, error: friendly(err, 'pendingReview failed') }
    }
  })
  ipcMain.handle('operator:promote', async (_e, id: unknown, reason?: unknown) => {
    try {
      const m = await import('../services/brain/operator-model')
      const why = typeof reason === 'string' ? reason : undefined
      return { success: true, data: m.promoteFact(String(id), why) }
    } catch (err) {
      return { success: false, error: friendly(err, 'promote failed') }
    }
  })
  // W5 — the human verbs. A veto or ratify from the UI settles the keyless-review card at once
  // (instead of at the next govern tick) and tells the Needs-you panel. The card is an affordance,
  // never a precondition: settling it can fail without failing the verb.
  const settleKeylessCard = async (): Promise<void> => {
    try {
      const g = await import('../services/brain/operator-govern')
      g.refreshKeylessRatifyCard()
      const n = await import('./notices')
      n.broadcastNoticesChanged()
    } catch {
      /* best-effort */
    }
  }
  ipcMain.handle('operator:veto', async (_e, id: unknown, reason?: unknown) => {
    try {
      const m = await import('../services/brain/operator-model')
      const why = typeof reason === 'string' ? reason : undefined
      const ok = m.vetoFact(String(id), why)
      await settleKeylessCard()
      return { success: true, data: ok }
    } catch (err) {
      return { success: false, error: friendly(err, 'veto failed') }
    }
  })
  // Every row including superseded/retired ones — the Learning panel's "Superseded" list.
  ipcMain.handle('operator:listAll', async () => {
    try {
      const m = await import('../services/brain/operator-model')
      return { success: true, data: m.getAllOperatorFacts() }
    } catch (err) {
      return { success: false, error: friendly(err, 'listAll failed') }
    }
  })
  ipcMain.handle('operator:awaitingRatify', async () => {
    try {
      const m = await import('../services/brain/operator-model')
      return { success: true, data: m.getAwaitingRatify() }
    } catch (err) {
      return { success: false, error: friendly(err, 'awaitingRatify failed') }
    }
  })
  ipcMain.handle('operator:ratify', async (_e, id: unknown, reason?: unknown) => {
    try {
      const m = await import('../services/brain/operator-model')
      const why = typeof reason === 'string' ? reason : undefined
      const ok = m.ratifyFact(String(id), why)
      await settleKeylessCard()
      return { success: true, data: ok }
    } catch (err) {
      return { success: false, error: friendly(err, 'ratify failed') }
    }
  })
  ipcMain.handle('operator:unveto', async (_e, id: unknown, reason?: unknown) => {
    try {
      const m = await import('../services/brain/operator-model')
      const why = typeof reason === 'string' ? reason : undefined
      return { success: true, data: m.unvetoFact(String(id), why) }
    } catch (err) {
      return { success: false, error: friendly(err, 'unveto failed') }
    }
  })
  ipcMain.handle('operator:revertSupersession', async (_e, id: unknown, reason?: unknown) => {
    try {
      const m = await import('../services/brain/operator-model')
      const why = typeof reason === 'string' ? reason : undefined
      return { success: true, data: m.revertSupersession(String(id), why) }
    } catch (err) {
      return { success: false, error: friendly(err, 'revertSupersession failed') }
    }
  })

  // Integrations (ingest) — connector sources feeding the brain.
  ipcMain.handle('connections:list', async () => {
    try {
      const m = await import('../services/connectors/connections-store')
      return { success: true, data: m.listConnections() }
    } catch (err) {
      return { success: false, error: friendly(err, 'list failed') }
    }
  })
  ipcMain.handle('connections:sync', async (_e, id: unknown) => {
    try {
      const m = await import('../services/connectors/connections-store')
      return { success: true, data: await m.syncOne(String(id)) }
    } catch (err) {
      return { success: false, error: friendly(err, 'sync failed') }
    }
  })
  // Deep backfill — re-pull one source `days` back so historical comms/pages/events
  // land in the brain, not just the rolling window. Threads sinceMs → the adapter.
  ipcMain.handle('connections:backfill', async (_e, id: unknown, days: unknown) => {
    try {
      const m = await import('../services/connectors/connections-store')
      const n = typeof days === 'number' && Number.isFinite(days) ? days : Number(days) || 30
      return { success: true, data: await m.backfillSource(String(id), n) }
    } catch (err) {
      return { success: false, error: friendly(err, 'backfill failed') }
    }
  })
  ipcMain.handle('connections:setEnabled', async (_e, id: unknown, enabled: unknown) => {
    try {
      const m = await import('../services/connectors/connections-store')
      return { success: true, data: m.setConnectionEnabled(String(id), !!enabled) }
    } catch (err) {
      return { success: false, error: friendly(err, 'setEnabled failed') }
    }
  })
  // Slack ingest has no OAuth flow — the user pastes a bot/user token, which we
  // store (safeStorage-encrypted) under the `slack-token` key the Slack adapter reads.
  ipcMain.handle('connections:setSlackToken', async (_e, token: unknown) => {
    try {
      const t = typeof token === 'string' ? token.trim() : ''
      if (!t) return { success: false, error: 'A Slack token is required' }
      const { setKey } = await import('../services/keychain')
      await setKey('slack-token', t)
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'Saving the Slack token failed') }
    }
  })
  // Notion ingest — like Slack, no OAuth: the user pastes an internal-integration
  // secret, stored (safeStorage-encrypted) under the `notion-token` key the Notion
  // adapter reads. Enabling then kicks the first sync.
  ipcMain.handle('connections:setNotionToken', async (_e, token: unknown) => {
    try {
      const t = typeof token === 'string' ? token.trim() : ''
      if (!t) return { success: false, error: 'A Notion integration token is required' }
      const { setKey } = await import('../services/keychain')
      await setKey('notion-token', t)
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'Saving the Notion token failed') }
    }
  })
  // RSS ingest — no auth; the source is a list of feed URLs the user supplies,
  // persisted in settings under `rssFeeds` (the RSS adapter re-reads it each sync).
  ipcMain.handle('connections:getRssFeeds', async () => {
    try {
      const { readSettings } = await import('../services/settings-helper')
      const raw = (readSettings() as { rssFeeds?: unknown }).rssFeeds
      const feeds = Array.isArray(raw) ? raw.filter((f): f is string => typeof f === 'string') : []
      return { success: true, data: feeds }
    } catch (err) {
      return { success: false, error: friendly(err, 'Listing feeds failed') }
    }
  })
  ipcMain.handle('connections:setRssFeeds', async (_e, feeds: unknown) => {
    try {
      const list = Array.isArray(feeds)
        ? feeds.map((f) => (typeof f === 'string' ? f.trim() : '')).filter((f) => f.length > 0)
        : []
      const { patchSettings } = await import('../services/settings-helper')
      patchSettings({ rssFeeds: list })
      return { success: true, data: list.length }
    } catch (err) {
      return { success: false, error: friendly(err, 'Saving feeds failed') }
    }
  })
  // Manual/QA ingest — push docs straight into the brain under a source
  // namespace (also the path for an "import" affordance / fixtures).
  ipcMain.handle('connections:ingest', async (_e, source: unknown, docs: unknown) => {
    try {
      const { ingestFromSource } = await import('../services/local-brain/index-store')
      const count = await ingestFromSource(String(source), Array.isArray(docs) ? (docs as never[]) : [])
      broadcastBrainUpdated(count)
      return { success: true, data: { count } }
    } catch (err) {
      return { success: false, error: friendly(err, 'ingest failed') }
    }
  })

  // Channels (conversational connectivity) — two-way surfaces (Slack/Telegram/…)
  // that run a DE-PRIVILEGED brain turn per inbound message. These handlers own
  // enumeration + the per-user pairing gate; the runtime + adapters do the rest.
  ipcMain.handle('channels:list', async () => {
    try {
      const m = await import('../services/channels/channels-store')
      return { success: true, data: m.listChannelSummaries() }
    } catch (err) {
      return { success: false, error: friendly(err, 'list failed') }
    }
  })
  // What each channel IS, as opposed to how it is currently doing. Separate from
  // channels:list on purpose: a summary describes a channel that EXISTS in the
  // registry, while a definition must be readable for one that is neither
  // configured nor started — which is exactly when the operator is deciding whether
  // to set it up. Carries the setup steps, where to get the credentials, what it
  // will be able to do, and whether it needs a public URL, so the pane can describe
  // a channel instead of showing a bare token box and hoping.
  //
  // `capabilities` is the DERIVED set (claimed AND implemented) rather than the
  // definition's declared list, so the pane can never advertise an affordance the
  // adapter does not actually have.
  ipcMain.handle('channels:listDefinitions', async () => {
    try {
      const defs = await import('../services/channels/channel-definitions')
      const reg = await import('../services/channels/index')
      const adapters = await import('../services/channels/channel-adapter')
      const { mt } = await import('../services/main-i18n')
      const byId = new Map(reg.listChannels().map((a) => [a.id, a]))
      // LOCALIZED HERE, at the boundary, not in the definitions and not in the renderer.
      //
      // Not in the definitions: those are module-level constants evaluated once at
      // import, so a language change after boot would never reach them. Doing it per
      // call means switching language re-renders in the new language with no restart.
      //
      // Not in the renderer: it would receive an English string and have to call
      // `t(value)` on it — a DYNAMIC key, invisible to every extractor, so the l10n
      // gate would go blind to exactly these strings. Localizing in main keeps the
      // English literals greppable where they are written, which is what makes them
      // translatable at all.
      //
      // `mt` shares src/locales/{zh,ja}.json with the renderer's `t`, so one translation
      // serves both processes and they cannot disagree about what a string means.
      return {
        success: true,
        data: defs.listChannelDefinitions().map((d) => {
          const adapter = byId.get(d.id)
          // DERIVED WHEN CONNECTED, DECLARED WHEN NOT — and the fallback is not a
          // shortcut. A transport-backed adapter has no transport until start(), so it
          // truthfully reports NO capabilities before then; using that alone would blank
          // the chip row for every channel the operator has not yet turned on, which is
          // exactly when they are deciding whether it does what they need. The
          // definition's declaration is the pre-connect answer ("what this platform
          // offers"), the derived set is the runtime one ("what this adapter actually
          // wired"), and the derived set wins the moment it exists.
          const derived = adapter ? adapters.channelCapabilities(adapter) : []
          return {
            ...d,
            // Everything the operator READS. `label` is deliberately NOT translated:
            // "Slack", "Feishu / Lark", "钉钉" are product names, and translating a
            // brand is how a settings list stops matching the app the operator is
            // trying to connect.
            description: mt(d.description),
            setupSteps: d.setupSteps.map((s) => mt(s)),
            credentials: d.credentials.map((c) => ({
              ...c,
              label: mt(c.label),
              ...(c.help ? { help: mt(c.help) } : {}),
              ...(c.placeholder ? { placeholder: c.placeholder } : {})
            })),
            capabilities: derived.length > 0 ? derived : d.capabilities,
            /** False when the definition has no adapter behind it — the pane greys it
             *  out rather than accepting a token for something that cannot run. */
            installed: Boolean(adapter)
          }
        })
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'listDefinitions failed') }
    }
  })
  // The ENABLE path. setChannelEnabled + restartChannel were both written and had
  // zero callers, so the only way to turn a channel on was hand-editing
  // userData/channels.json — a file that does not exist on a default install, i.e.
  // even the workaround had never been exercised. Persist-then-restart is one step
  // deliberately: persisting alone only takes effect at the next launch, and the
  // gateway is the thing that decides whether the channel may actually come up
  // (enabled AND configured). Enabling an unconfigured channel is allowed and
  // simply does not start it — the pane says so rather than the handler refusing.
  ipcMain.handle('channels:setEnabled', async (_e, channelId: unknown, enabled: unknown) => {
    try {
      const id = typeof channelId === 'string' ? channelId.trim() : ''
      if (!id) return { success: false, error: 'a channel id is required' }
      const store = await import('../services/channels/channels-store')
      if (!store.setChannelEnabled(id, enabled === true)) {
        return { success: false, error: `Unknown channel: ${id}` }
      }
      // Best-effort: the flag is already persisted and broadcast, so a restart
      // failure must not report the toggle as failed — the state IS changed and
      // the next launch will honour it.
      const { restartChannel } = await import('../services/channels/gateway')
      await restartChannel(id).catch((e: unknown) =>
        console.debug('[channels] restart after toggle is best-effort:', messageOf(e))
      )
      return { success: true, data: enabled === true }
    } catch (err) {
      return { success: false, error: friendly(err, 'Changing the channel failed') }
    }
  })
  // The values a channel needs before it can connect. Secrets report only WHETHER one is
  // stored; non-secret configuration (a Feishu watchlist) round-trips its value so the
  // operator can edit rather than retype blind.
  ipcMain.handle('channels:listCredentials', async (_e, channelId: unknown) => {
    try {
      const id = typeof channelId === 'string' ? channelId.trim() : ''
      if (!id) return { success: false, error: 'a channel id is required' }
      const store = await import('../services/channels/channels-store')
      return { success: true, data: store.listChannelCredentials(id) }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not read the channel credentials') }
    }
  })

  // Write one declared credential (empty value clears it), then restart the channel if it
  // is enabled — a credential that needs an app relaunch to take effect is half a fix.
  ipcMain.handle(
    'channels:setCredential',
    async (_e, channelId: unknown, keychainKey: unknown, value: unknown) => {
      try {
        const id = typeof channelId === 'string' ? channelId.trim() : ''
        const key = typeof keychainKey === 'string' ? keychainKey.trim() : ''
        if (!id || !key) return { success: false, error: 'a channel id and field are required' }
        const store = await import('../services/channels/channels-store')
        const res = store.setChannelCredential(id, key, typeof value === 'string' ? value.trim() : '')
        if (!res.ok) return { success: false, error: res.error }
        if (res.enabled) {
          // Best-effort, same contract as the toggle: the credential IS written, so a
          // restart failure must not report the write as failed.
          const { restartChannel } = await import('../services/channels/gateway')
          await restartChannel(id).catch((e: unknown) =>
            console.debug('[channels] restart after credential change is best-effort:', messageOf(e))
          )
        }
        return { success: true, data: { configured: res.configured } }
      } catch (err) {
        return { success: false, error: friendly(err, 'Saving the credential failed') }
      }
    }
  )

  // Begin pairing for an external user → mints a single-use code the operator
  // relays out-of-band (or approves from the UI). Deny-first: the user stays
  // 'pending' until explicitly approved.
  ipcMain.handle('channels:pair', async (_e, channelId: unknown, externalUserId: unknown) => {
    try {
      const m = await import('../services/channels/pairing-store')
      const rec = m.requestPairing(String(channelId), String(externalUserId))
      return { success: true, data: { status: rec.status, code: rec.code } }
    } catch (err) {
      return { success: false, error: friendly(err, 'pair failed') }
    }
  })
  // Approve an external user — by pairing CODE (single-use) or directly by id.
  ipcMain.handle('channels:approve', async (_e, channelId: unknown, opts: unknown) => {
    try {
      const m = await import('../services/channels/pairing-store')
      const o = (opts && typeof opts === 'object' ? opts : {}) as { userId?: unknown; code?: unknown }
      const code = typeof o.code === 'string' ? o.code : ''
      if (code) {
        const userId = m.approveByCode(String(channelId), code)
        return userId
          ? { success: true, data: { userId } }
          : { success: false, error: 'Invalid or already-used pairing code' }
      }
      const userId = typeof o.userId === 'string' ? o.userId : ''
      if (!userId) return { success: false, error: 'A userId or code is required' }
      m.approvePairing(String(channelId), userId)
      return { success: true, data: { userId } }
    } catch (err) {
      return { success: false, error: friendly(err, 'approve failed') }
    }
  })
  ipcMain.handle('channels:revoke', async (_e, channelId: unknown, externalUserId: unknown) => {
    try {
      const m = await import('../services/channels/pairing-store')
      return { success: true, data: m.revokePairing(String(channelId), String(externalUserId)) }
    } catch (err) {
      return { success: false, error: friendly(err, 'revoke failed') }
    }
  })

  // DUIN — fetch the brain graph from MAIN. The renderer's CSP is
  // connect-src 'none' (it can't fetch the local brain at :8799 directly), so
  // the Brain view loads its graph through this IPC. Node fetch here has no
  // CSP/CORS constraints. Returns the raw CausalGraph JSON, or null on any
  // failure (the renderer falls back to the bundled demo graph).
  ipcMain.handle('brain:graph', async (_event, url: unknown) => {
    try {
      const u = typeof url === 'string' ? url.trim() : ''
      if (!u) return { success: true, data: null }
      const r = await fetch(u)
      if (!r.ok) return { success: true, data: null }
      return { success: true, data: await r.json() }
    } catch {
      return { success: true, data: null }
    }
  })

  // DUIN — brain engine fast-path (Phase A: causal graph + propagation).
  // In-process, no HTTP/serialization tax; the local-brain server exposes the
  // same data at /state/* for curl debugging + external-brain parity.
  ipcMain.handle('brain:causalGraph', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: getCausalGraph(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'causal-graph failed') }
    }
  })

  ipcMain.handle(
    'brain:propagate',
    async (_event, nodeId: unknown, shiftDays: unknown, decision: unknown) => {
      try {
        const id = typeof nodeId === 'string' ? nodeId : ''
        const shift = typeof shiftDays === 'number' && Number.isFinite(shiftDays) ? shiftDays : 0
        const dec = decision === 'cleared' || decision === 'blocked' ? decision : ''
        const vaultDir = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
        return { success: true, data: runPropagate(vaultDir, id, shift, dec) }
      } catch (err) {
        return { success: false, error: friendly(err, 'propagate failed') }
      }
    }
  )

  ipcMain.handle('brain:predictedRisks', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: getPredictedRisks(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'predicted-risks failed') }
    }
  })

  ipcMain.handle('brain:worldState', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: getWorldState(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'world-state failed') }
    }
  })

  ipcMain.handle('brain:insights', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: getInsights(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'insights failed') }
    }
  })

  // Analytical + GENERATIVE insights (the LLM half). Async + key-gated: with a
  // model configured it appends higher-level insights; with none it returns the
  // analytical set unchanged. Kept separate from brain:insights so the panel can
  // render the instant analytical set first, then enrich.
  ipcMain.handle('brain:insights-generative', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: await getGenerativeInsights(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'generative insights failed') }
    }
  })

  // Right-panel "Today" home — one triaged digest (focal + brain-noticed +
  // needs-you + since-you-were-away), ranked by the home-digest scorer.
  ipcMain.handle('brain:homeDigest', async () => {
    try {
      const dir = (readSettings().localBrainNotesDir as string) || null
      return { success: true, data: getHomeDigest(dir) }
    } catch (err) {
      return { success: false, error: friendly(err, 'home digest failed') }
    }
  })

  // Structural graph report (community detection + hubs + cross-cluster bridges +
  // edge provenance). Keyless + cold-data-safe — analyses the indexed-notes graph.
  // Cached variant: the uncached build was a measured 1353ms main-thread stall
  // per surface mount (see graph-insight.ts's SWR block).
  ipcMain.handle('brain:graphReport', async () => {
    try {
      const { insight, markdown } = buildGraphReportCached()
      return { success: true, data: { insight, markdown } }
    } catch (err) {
      return { success: false, error: friendly(err, 'graph report failed') }
    }
  })

  // Global search (Cmd/Ctrl+K palette) — grouped note + graph-node hits from the
  // existing hybrid retriever. In-process (no HTTP/CSP tax), mirrors /state/search.
  ipcMain.handle('brain:search', async (_e, query: unknown) => {
    try {
      const q = typeof query === 'string' ? query : ''
      const vault = (readSettings().localBrainNotesDir as string) || ''
      return { success: true, data: await globalSearch(q, vault) }
    } catch (err) {
      return { success: false, error: friendly(err, 'search failed') }
    }
  })

  // Decision simulation — roll the grounded world model forward under each option,
  // gate ungrounded predictions, surface divergent futures + risk deltas. Read-only.
  ipcMain.handle('brain:simulateDecision', async (_e, req: DecisionSimRequest) => {
    try {
      return { success: true, data: await simulateDecision(req) }
    } catch (err) {
      return { success: false, error: friendly(err, 'decision simulation failed') }
    }
  })

  // Commit the PRE-ACT forecast for the option the operator leans toward (only the
  // chosen path, through the engine's single-writer ledger, idempotent).
  ipcMain.handle('brain:commitDecisionForecast', async (_e, input: CommitForecastInput) => {
    try {
      const res = await commitDecisionForecast(input)
      return { success: res.ok, data: res, error: res.error }
    } catch (err) {
      return { success: false, error: friendly(err, 'commit forecast failed') }
    }
  })

  // Graph growth history: record ONE structural snapshot per day (idempotent —
  // dedup by date, latest wins) to .duin/_state/graph-history.jsonl, return the
  // series (≤365). Lets the panel show the brain visibly growing. Cold-data-safe.
  ipcMain.handle('brain:graphHistory', async () => {
    try {
      const dir = readSettings().localBrainNotesDir
      if (typeof dir !== 'string' || !dir) return { success: true, data: [] }
      // Preserves unparseable lines verbatim and writes atomically — see
      // graph-history-store.ts. The ledger is the only copy of each past day's
      // counts and is not covered by moat-backup.
      const { rows } = recordGraphHistory(dir, buildGraphSnapshot())
      return { success: true, data: rows }
    } catch (err) {
      return { success: false, error: friendly(err, 'graph history failed') }
    }
  })

  // Relations surface — hydrated capped ego graph over the persistent entity plane, plus the
  // anchor's believing operator facts. IPC mirror of GET /state/entity-graph (panels are
  // IPC-path; renderer CSP blocks fetch). Keyless + cold-data-safe.
  ipcMain.handle('brain:entityGraph', async (_e, anchor: unknown, depth: unknown) => {
    try {
      const a = typeof anchor === 'string' ? anchor.trim() : ''
      if (!a) return { success: false, error: 'anchor is required' }
      const d = typeof depth === 'number' && Number.isFinite(depth) ? depth : 1
      const dir = readSettings().localBrainNotesDir
      const notesDir = typeof dir === 'string' && dir ? dir : null
      return { success: true, data: liveEntityEgoGraph(notesDir, a, d) }
    } catch (err) {
      return { success: false, error: friendly(err, 'entity graph failed') }
    }
  })

  // Per-node community assignment (id → cluster + color) for coloring the brain
  // graph by detected community. Keyless + cold-data-safe. Cached — same SWR
  // contract and reason as brain:graphReport above.
  ipcMain.handle('brain:graphCommunities', async () => {
    try {
      // On the MAP graph (the one the colours are painted on), with typed weights: see
      // mapCommunityAssignments. The map JSON is the same cached bytes /state/brain-graph serves.
      const vault = (readSettings().localBrainNotesDir as string) || ''
      return { success: true, data: buildMapCommunityAssignmentsCached(() => cachedBrainGraph(vault).json) }
    } catch (err) {
      return { success: false, error: friendly(err, 'graph communities failed') }
    }
  })

  // Person entities derived from the SAME data the Brain graph uses: constructed
  // `person:*` nodes (inferred from raw prose) + person-notes (frontmatter/tag/
  // folder). The People panel merges these with the user's manual entries.
  ipcMain.handle('brain:people', async () => {
    try {
      return { success: true, data: getPeople() }
    } catch (err) {
      return { success: false, error: friendly(err, 'people failed') }
    }
  })

  // Push the onboarding-interview seed brain (nodes/edges built in the renderer).
  // Passing an empty/absent nodes array clears the seed. Broadcasts so live
  // Brain views refetch and show the seeded graph immediately.
  ipcMain.handle('brain:setSeed', async (_event, nodes: unknown, edges: unknown) => {
    try {
      const ns = Array.isArray(nodes) ? (nodes as any[]) : null
      const es = Array.isArray(edges) ? (edges as any[]) : []
      setBrainSeed(ns, es)
      broadcastBrainUpdated(ns?.length ?? 0)
      return { success: true, data: { ok: true, nodes: ns?.length ?? 0 } }
    } catch (err) {
      return { success: false, error: friendly(err, 'setSeed failed') }
    }
  })

  ipcMain.handle('brain:recordVerdict', async (_event, id: unknown, outcome: unknown, note: unknown) => {
    try {
      const pid = typeof id === 'string' ? id : ''
      const valid = ['happened', 'averted', 'false_alarm', 'unobserved']
      const oc = typeof outcome === 'string' && valid.includes(outcome) ? outcome : null
      if (!pid || !oc) return { success: false, error: 'id and a valid outcome required' }
      const n = typeof note === 'string' ? note : undefined
      return { success: true, data: recordVerdict(pid, oc as any, n) }
    } catch (err) {
      return { success: false, error: friendly(err, 'recordVerdict failed') }
    }
  })

  // Record the user's verdict on a cross-cutting insight. Reads + writes the
  // SAME in-process brain getInsights() reads (mirrors brain:recordDecision), so
  // the id always matches the insight the panel showed — fixing the read-brain ≠
  // write-brain split where the verdict hit the python sidecar's different id set.
  ipcMain.handle('brain:insightVerdict', async (_event, id: unknown, verdict: unknown) => {
    try {
      const iid = typeof id === 'string' ? id : ''
      const VERDICTS = ['useful', 'dismissed', 'acted', 'inaccurate'] as const
      const v =
        typeof verdict === 'string' && (VERDICTS as readonly string[]).includes(verdict)
          ? (verdict as 'useful' | 'dismissed' | 'acted' | 'inaccurate')
          : null
      if (!iid || !v) {
        return {
          success: false,
          error: 'id and verdict (useful|dismissed|acted|inaccurate) required'
        }
      }
      recordInsightVerdict(iid, v)
      return { success: true, data: { success: true } }
    } catch (err) {
      return { success: false, error: friendly(err, 'insightVerdict failed') }
    }
  })

  ipcMain.handle('brain:decisionLoop', async () => {
    try {
      const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
      return { success: true, data: getDecisionLoop(vd) }
    } catch (err) {
      return { success: false, error: friendly(err, 'decision-loop failed') }
    }
  })

  ipcMain.handle(
    'brain:recordDecision',
    async (_event, nodeId: unknown, choice: unknown, note: unknown) => {
      try {
        const id = typeof nodeId === 'string' ? nodeId : ''
        const OUTCOMES = ['cleared', 'blocked', 'done', 'dismissed', 'cancelled'] as const
        const ch =
          typeof choice === 'string' && (OUTCOMES as readonly string[]).includes(choice)
            ? (choice as DecisionOutcome)
            : null
        if (!id || !ch)
          return {
            success: false,
            error: 'nodeId and choice (cleared|blocked|done|dismissed|cancelled) required'
          }
        const n = typeof note === 'string' ? note : undefined
        const vd = typeof readSettings().localBrainNotesDir === 'string' ? (readSettings().localBrainNotesDir as string) : null
        return { success: true, data: recordDecision(id, ch, n, vd) }
      } catch (err) {
        return { success: false, error: friendly(err, 'record-decision failed') }
      }
    }
  )

  ipcMain.handle('settings:get', async () => {
    try {
      return { success: true, data: readSettings() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Whether settings.json was actually read, and where a torn one was moved aside. A
  // corrupt file used to boot the app on defaults with success:true, which looks exactly
  // like a fresh install (settings evaluation D6).
  ipcMain.handle('settings:fileState', async () => {
    try {
      const path = getSettingsPath()
      return {
        success: true,
        data: { state: readSettingsFile(path).state, path, sidecars: listCorruptSidecars(app.getPath('userData')) }
      }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Portability (settings evaluation D4): the four plain-JSON configuration files travel as
  // one document; keys are re-entered by design (safeStorage is bound to the OS user).
  ipcMain.handle('settings:exportBundle', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const stamp = new Date().toISOString().slice(0, 10)
      const opts = {
        title: 'Export DUIN settings',
        defaultPath: join(app.getPath('documents'), `DUIN-settings-${stamp}.json`),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const dlg = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (dlg.canceled || !dlg.filePath) return { success: true, data: { cancelled: true } }
      const bundle = buildSettingsBundle(app.getPath('userData'), app.getVersion())
      atomicWriteFileSync(dlg.filePath, JSON.stringify(bundle, null, 2))
      return { success: true, data: { cancelled: false, path: dlg.filePath, files: Object.keys(bundle.files) } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not export settings') }
    }
  })

  ipcMain.handle('settings:importBundle', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const opts = {
        title: 'Import DUIN settings',
        properties: ['openFile' as const],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const dlg = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (dlg.canceled || dlg.filePaths.length === 0) return { success: true, data: { cancelled: true } }
      const bundle = parseSettingsBundle(readFileSync(dlg.filePaths[0], 'utf-8'))
      const before = readSettings()
      const result = applySettingsBundle(app.getPath('userData'), bundle)
      emitSettingsUpdated(before, readSettings(), { importedFrom: dlg.filePaths[0] })
      return { success: true, data: { cancelled: false, ...result } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not import settings') }
    }
  })

  ipcMain.handle('settings:resetToDefaults', async () => {
    try {
      const before = readSettings()
      const result = resetSettingsFile(app.getPath('userData'))
      emitSettingsUpdated(before, readSettings(), { reset: true })
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not reset settings') }
    }
  })

  ipcMain.handle('settings:set', (_event, partial, options?: unknown) => {
    const ensureBrainReady =
      options !== null &&
      typeof options === 'object' &&
      (options as { ensureBrainReady?: unknown }).ensureBrainReady === true
    if (ensureBrainReady) {
      return enqueueBrainVaultMutation(async () => {
        try {
          const checked = guardSettingsPartial(sanitizeSettingsPartial(partial))
          if (checked.rejected.length > 0) return refusedSettingsWrite(checked.rejected)
          const safePartial = checked.accepted
          const current = readSettings()
          assertTrustedRootChanges(safePartial, current)
          // No first-run replacement exists any more: the demo vault (the one replaceable
          // beforeDir) was removed 2026-08-22, so an occupied brain folder always requires
          // the full Settings switch contract. allowReplace stays a parameter because the
          // Settings-side switch path is the one caller allowed to pass true.
          return await commitReadyBrainVault(safePartial, current, false)
        } catch (err) {
          return { success: false, error: messageOf(err) }
        }
      })
    }
    return enqueueBrainVaultMutation(async () => {
      try {
      const checked = guardSettingsPartial(sanitizeSettingsPartial(partial))
      if (checked.rejected.length > 0) return refusedSettingsWrite(checked.rejected)
      const safePartial = checked.accepted
      const current = readSettings()
      assertTrustedRootChanges(safePartial, current)
      const updated = { ...current, ...safePartial }
      const beforeDir = typeof current.localBrainNotesDir === 'string' ? current.localBrainNotesDir : ''
      const afterDir = typeof updated.localBrainNotesDir === 'string' ? updated.localBrainNotesDir : ''
      const vaultChanged = afterDir !== beforeDir
      if (vaultChanged) {
        // The ordinary Brain Settings picker is an explicit replacement, but it
        // still uses the same awaited readiness transaction as first-run setup.
        // No vault path is persisted until indexing and durability both succeed.
        return await commitReadyBrainVault(safePartial, current, true)
      }
      // Persist ONLY what was on disk plus the sanitised patch — never the
      // defaults-merged `updated`. readSettings() folds in every
      // DEFAULT_APP_SETTINGS key, so writing `updated` would materialise all ~40
      // defaults onto disk as if the user had set them. That freezes them: on a
      // later version that lowers a default (e.g. for safety), readSettings()'s
      // {...defaults, ...onDisk} merge lets the stale persisted value win and the
      // new default silently never reaches this user. Writing onDisk+patch keeps
      // untouched keys absent so they continue to resolve from the live defaults.
      // `updated` is still the correct defaults-merged view for the change event
      // and the notes-dir before/after diff below.
      const onDisk = readSettingsFile(getSettingsPath()).data
      writeSettings({ ...onDisk, ...safePartial })
      emitSettingsUpdated(current, updated, safePartial)
      return { success: true, data: null }
      } catch (err) {
        return { success: false, error: messageOf(err) }
      }
    })
  })

  // Multi-provider key API. Keys are keyed by provider id (deepseek/google/dashscope).
  ipcMain.handle('settings:saveProviderKey', async (_event, provider, key) => {
    try {
      if (!isProvider(provider)) return { success: false, error: `Unknown provider: ${provider}` }
      // Keyless→keyed transition, sampled BEFORE the write. The cold-start onboarding
      // tells a keyless operator "connect a model and the graph builds automatically" —
      // but every buildBrain() trigger was boot / reindex / note-edit / the explicit
      // button, so the key pasted right after onboarding built NOTHING until a restart.
      // When THIS key is what makes a model routable at all, run the same key-gated
      // extraction→construction tail reindexAndBuild runs, in the background.
      const { routeModel } = await import('../services/providers/registry')
      const hadModel = ((): boolean => {
        try {
          return routeModel('extraction') != null
        } catch {
          return false
        }
      })()
      keychain.setKey(provider, String(key))
      resetProviderClient(provider)
      // P0 model plane: a saved key is the moment to learn whether the ACCOUNT answers (health is
      // a completion, not a key check). One probe, off the handler's path; the result reaches the
      // renderer via model:health-changed. Lane A's granted cross-lane edit (SESSION-LANES p0-router).
      void import('../services/providers/provider-health').then((h) => h.refreshProviderHealth(provider)).catch(() => {})
      // Release M11 — CONSENT, recorded. Every surface that takes a key (ApiKeyModal, Settings →
      // API keys, onboarding's provider cards → the modal) shows the disclosure line first:
      // "DUIN sends that provider your current question plus relevant excerpts and
      // personalization context, and — to build your knowledge graph — your notes, in
      // batches." Saving the key after reading it is the operator's yes, and it is what lets
      // the boot-time and edit-driven extraction→construction passes run unattended from here
      // on (brain/cloud-consent.ts). Persisted, not just in-memory, so the next launch honours
      // it. Best-effort: a failed write must not fail the key save.
      try {
        const { patchSettings } = await import('../services/settings-helper')
        patchSettings({ cloudExtractionConsent: true })
      } catch (e) {
        console.warn('[settings] could not record cloud-extraction consent:', messageOf(e))
      }
      // Saving a key is the natural "I fixed the account" action — close the
      // extraction breaker even when a model was already routable (topping up an
      // existing provider re-saves the same key).
      resetExtractionBreaker('provider key saved')
      if (!hadModel) {
        void (async () => {
          try {
            if (routeModel('extraction') == null) return // key stored but still nothing routable
            const result = await runExtractionAndBuild()
            if (result.status === 'built') broadcastBrainUpdated(indexedCount())
            else console.warn('[brain] post-key auto build returned status:', result.status)
          } catch (e) {
            console.warn('[brain] post-key auto build failed:', (e as Error)?.message)
          }
        })()
      }
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:hasProviderKey', async (_event, provider) => {
    try {
      if (!isProvider(provider)) return { success: false, error: `Unknown provider: ${provider}` }
      return { success: true, data: keychain.hasKey(provider) }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:testProviderKey', async (_event, provider) => {
    try {
      if (!isProvider(provider)) return { success: false, error: `Unknown provider: ${provider}` }
      const result = await validateProviderKeyDetailed(provider)
      return { success: true, data: result }
    } catch (err) {
      // validateProviderKeyDetailed already swallows provider errors into
      // { ok: false, reason }, so reaching here is genuinely unexpected.
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:deleteProviderKey', async (_event, provider) => {
    try {
      if (!isProvider(provider)) return { success: false, error: `Unknown provider: ${provider}` }
      keychain.deleteKey(provider)
      resetProviderClient(provider)
      // P0 model plane: recompute health without a call (the row becomes `no-key`) and push it.
      void import('../services/providers/provider-health').then((h) => h.refreshProviderHealth(provider)).catch(() => {})
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:listProviderKeys', async () => {
    try {
      // `routable`: whether a key for this provider can reach ANY model today —
      // a pinned catalog entry, a hand-added custom model, or (ollama) keyless
      // local models. The zero-catalog providers (groq/mistral/github-models/
      // deepinfra/openrouter) validate a key fine and then route NOTHING until
      // models are imported — the key-entry UI needs to say so instead of
      // reporting a bare "connected" that leaves chat unset-up.
      const { MODEL_CATALOG } = await import('../services/providers/registry')
      const customs = (readSettings().customModels ?? []) as Array<{ provider?: string }>
      const data = Object.values(PROVIDERS)
        .filter((p) => !p.hidden)
        .map((p) => ({
          id: p.id,
          label: p.label,
          docsUrl: p.docsUrl,
          hasKey: keychain.hasKey(p.id),
          routable:
            p.id === 'ollama' ||
            MODEL_CATALOG.some((m) => m.provider === p.id) ||
            customs.some((c) => c?.provider === p.id)
        }))
      return { success: true, data }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // R4 — Search-provider key handlers. Distinct from AI-provider handlers
  // because they target the `web_search:<id>` keychain namespace and use a
  // different allowlist (Brave, Tavily, SerpAPI — anything in
  // ALL_WEB_SEARCH_PROVIDERS that requires a key). No validation endpoint:
  // search APIs charge per request, so we let the next research turn act as
  // the real test rather than burning a paid call on settings entry.
  const SEARCH_PROVIDER_DOCS_URLS: Partial<Record<WebSearchProviderId, string>> = {
    brave: 'https://api.search.brave.com/app/keys',
    tavily: 'https://app.tavily.com/home',
    serpapi: 'https://serpapi.com/manage-api-key'
  }
  function isSearchProviderWithKey(id: unknown): id is WebSearchProviderId {
    return (
      typeof id === 'string' &&
      ALL_WEB_SEARCH_PROVIDERS.some((p) => p.id === id && p.requiresKey)
    )
  }

  ipcMain.handle('settings:listSearchProviderKeys', async () => {
    try {
      const data = ALL_WEB_SEARCH_PROVIDERS.filter((p) => p.requiresKey).map((p) => ({
        id: p.id,
        label: p.label,
        docsUrl: SEARCH_PROVIDER_DOCS_URLS[p.id] ?? '',
        hasKey: keychain.hasKey(searchKeychainKey(p.id))
      }))
      return { success: true, data }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:saveSearchProviderKey', async (_event, provider, key) => {
    try {
      if (!isSearchProviderWithKey(provider)) {
        return { success: false, error: `Unknown search provider: ${provider}` }
      }
      keychain.setKey(searchKeychainKey(provider), String(key))
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:deleteSearchProviderKey', async (_event, provider) => {
    try {
      if (!isSearchProviderWithKey(provider)) {
        return { success: false, error: `Unknown search provider: ${provider}` }
      }
      keychain.deleteKey(searchKeychainKey(provider))
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Legacy single-key handlers, retained so existing UI surfaces keep working.
  ipcMain.handle('settings:saveApiKey', async (_event, key) => {
    try {
      keychain.setKey('deepseek', key)
      deepseekClient.resetClient()
      // Also drop the registry's cached OpenAI client for deepseek — chat turns route
      // through it, and resetting only the legacy deepseekClient left a stale key live.
      resetProviderClient('deepseek')
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:hasApiKey', async () => {
    try {
      return { success: true, data: keychain.hasKey('deepseek') }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:testApiKey', async () => {
    try {
      const valid = await deepseekClient.validateKey()
      return { success: true, data: valid }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:saveGoogleCredentials', async (_event, clientId, clientSecret) => {
    try {
      keychain.setKey('google-client-id', clientId)
      keychain.setKey('google-client-secret', clientSecret)
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:deleteApiKey', async () => {
    try {
      keychain.deleteKey('deepseek')
      deepseekClient.resetClient()
      resetProviderClient('deepseek') // same stale-client gap as settings:saveApiKey
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // macOS Full Disk Access. There is no API to REQUEST it — the most any app can do is
  // report whether it has it and open the pane, which is what these two do.
  ipcMain.handle('system:fullDiskAccess:status', async () => {
    try {
      const { getFullDiskAccessState } = await import('../services/mac-permissions')
      return { success: true, data: await getFullDiskAccessState() }
    } catch (err) {
      return { success: false, error: messageOf(err) ?? 'full disk access probe failed' }
    }
  })

  ipcMain.handle('system:fullDiskAccess:openSettings', async () => {
    try {
      const { openFullDiskAccessSettings } = await import('../services/mac-permissions')
      return { success: true, data: await openFullDiskAccessSettings() }
    } catch (err) {
      return { success: false, error: messageOf(err) ?? 'could not open System Settings' }
    }
  })

  ipcMain.handle('settings:isEncryptionAvailable', async () => {
    try {
      return { success: true, data: keychain.isEncryptionAvailable() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // SEC-10: record explicit user consent to plaintext storage for this
  // session. The renderer calls this after surfacing a `window.confirm`
  // dialog the user accepted; subsequent setKey calls (across every IPC
  // handler that persists a credential) succeed without re-prompting.
  ipcMain.handle('settings:grantPlaintextConsent', async () => {
    try {
      keychain.grantPlaintextConsent()
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('settings:hasPlaintextConsent', async () => {
    try {
      return { success: true, data: keychain.hasPlaintextConsent() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}

// Settings keys that can carry credentials. Even though `settings:set` is
// keys-only on the event row, names like `apiKey` are still suggestive — flag
// them explicitly so a future log reader knows the change is sensitive
// without having to read the value (we never log the value either way).
const SENSITIVE_SETTING_KEYS = new Set(['apiKey'])

// Keys that `__proto__`-style prototype-pollution attacks would target. We
// reject these unconditionally so a malicious or buggy renderer can't
// inject inherited properties into the settings object.
const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Sanitize a renderer-supplied settings partial. Drops non-object inputs,
 * dangerous keys (prototype pollution), and own-property `Object.prototype`
 * leak vectors. Returns an empty object for non-object input so the merge
 * is a no-op rather than a crash.
 *
 * **Recursive**: a nested object like `{modelConfig: {__proto__: {...}}}` is
 * also flattened — JSON.parse creates `__proto__` as an own property
 * (which is harmless on its own), but any downstream code that later does
 * `for (const k in obj) target[k] = obj[k]` would honor the special
 * `__proto__` semantics and pollute the prototype chain. Recursive
 * stripping closes that gap defensively, regardless of who reads the
 * value later.
 *
 * The settings shape is open by design (modelConfig can hold per-model
 * blocks the harness doesn't know about ahead of time), so we don't gate
 * unknown keys here — that's the responsibility of the schema layer in
 * `defaultSettings`. We only block dangerous keys.
 */
/** A refused write names every key and why, so the caller can show it and the log can
 *  find it; nothing is silently dropped or partially written. */
function refusedSettingsWrite(rejected: SettingsRejection[]): { success: false; error: string } {
  const error = `Settings write refused: ${rejected.map((r) => r.reason).join('; ')}`
  console.warn('[settings]', error)
  return { success: false, error }
}

function sanitizeSettingsPartial(raw: unknown): Record<string, unknown> {
  const cleaned = stripPollutionKeys(raw)
  if (
    !cleaned ||
    typeof cleaned !== 'object' ||
    Array.isArray(cleaned)
  ) {
    return {}
  }
  return cleaned as Record<string, unknown>
}

function assertTrustedRootChanges(
  partial: Record<string, unknown>,
  current: Record<string, unknown>
): void {
  if (Object.prototype.hasOwnProperty.call(partial, 'localBrainNotesDir')) {
    const next = partial.localBrainNotesDir
    const previous = current.localBrainNotesDir
    if (
      typeof next !== 'string' ||
      (next !== '' && next !== previous && !hasTrustedDirectoryGrant(next))
    ) {
      throw new Error('localBrainNotesDir must come from the native folder picker')
    }
  }

  if (Object.prototype.hasOwnProperty.call(partial, 'sandboxWritePaths')) {
    const next = partial.sandboxWritePaths
    const previous = Array.isArray(current.sandboxWritePaths)
      ? current.sandboxWritePaths.filter((value): value is string => typeof value === 'string')
      : []
    if (
      !Array.isArray(next) ||
      next.some(
        (value) =>
          typeof value !== 'string' ||
          (!previous.includes(value) && !hasTrustedDirectoryGrant(value))
      )
    ) {
      throw new Error('sandboxWritePaths additions must come from the native folder picker')
    }
    // The sandbox skips the home folder and machine roots when it READS the list
    // (operator-write-paths.ts); refusing them here keeps the list on screen honest,
    // instead of showing a folder the sandbox never honours.
    const added = next.filter((value) => !previous.includes(value))
    const unusable = added.filter((value) => resolveOperatorWritePaths([value]).length === 0)
    if (unusable.length > 0) {
      throw new Error(
        `Your home folder and system folders cannot be added (${unusable.join(', ')}); choose a folder inside them.`
      )
    }
  }
}

function stripPollutionKeys(value: unknown, depth = 0): unknown {
  // Defensive recursion cap so a hostile renderer can't ship a 10⁴-deep
  // object and OOM the sanitizer. Settings is shallow by design; 16 is
  // more than enough headroom for modelConfig + nested theme objects.
  if (depth > 16) return undefined
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((item) => stripPollutionKeys(item, depth + 1))
  }
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(value as Record<string, unknown>)) {
    if (POLLUTION_KEYS.has(k)) continue
    out[k] = stripPollutionKeys((value as Record<string, unknown>)[k], depth + 1)
  }
  return out
}

/**
 * Emit a `settings.updated` event recording ONLY the names of the keys that
 * changed. Values never leave this function — even non-sensitive keys are
 * stripped because settings.json can grow new credential-shaped fields that
 * the spine writer is unaware of.
 *
 * Comparison is shallow (top-level keys) because that's the granularity
 * `settings:set` operates at. A change inside `modelConfig['x'].temperature`
 * still produces one `modelConfig` entry — good enough for an audit trail of
 * "this is the moment something model-config-shaped moved" without
 * micro-diffing the JSON.
 */
function emitSettingsUpdated(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  partial: unknown
): void {
  try {
    const changedKeys: string[] = []
    const allKeys = new Set([...Object.keys(before), ...Object.keys(after)])
    for (const k of allKeys) {
      const a = (before as Record<string, unknown>)[k]
      const b = (after as Record<string, unknown>)[k]
      if (!shallowEqual(a, b)) changedKeys.push(k)
    }
    if (changedKeys.length === 0) return
    const sensitiveChanged = changedKeys.filter((k) => SENSITIVE_SETTING_KEYS.has(k))
    recordEvent({
      type: 'settings.updated',
      actorKind: 'user',
      payload: {
        changedKeys,
        sensitiveChanged,
        partialKeys:
          partial && typeof partial === 'object'
            ? Object.keys(partial as Record<string, unknown>)
            : undefined
      }
    })
  } catch (err) {
    console.error('[settings] settings.updated event failed:', err)
  }
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== 'object') return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}
