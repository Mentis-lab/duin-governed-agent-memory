import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join, normalize } from 'path'
import type { PluginManifest } from '../services/plugin-loader'
import {
  listPlugins,
  getPlugin,
  setPluginEnabled,
  removePlugin,
  installFromDirectory,
  installFromManifest,
  installBundled,
  installReviewedDirectory,
  installedPluginIds,
  bundledPluginsNotInstalled
} from '../services/plugin-loader'
import { stageFromUrl, stagedPath, discardStaged } from '../services/plugin-install-remote'
import { approveStdioConnector } from './mcp'
import type { McpServerConfig } from '../services/mcp-manager'

/**
 * SECURITY BOUNDARY — installing a plugin is a SECOND ingress to the stdio
 * spawn that `mcp:addServer` gates behind a native dialog (the threat model is
 * spelled out on approveStdioConnector in ./mcp). A plugin's connectors.json is
 * not passive data: installFromManifest writes it and calls broadcastChange
 * SYNCHRONOUSLY, mcp-manager.refreshPluginConnectors rebuilds the plugin server
 * set from that file with `enabled: true` hard-coded, and connectPluginServer
 * reaches connectStdio with the supplied command/args/env — before the install
 * IPC even replies. A fresh plugin resolves to enabled=true (plugin-loader
 * loadPlugin: no persisted state, no manifest.enabled => true), so no second
 * click gates it either, and the dir lives under userData so it re-spawns every
 * launch.
 *
 * Why this was invisible: plugin-loader's own header describes plugins as
 * "declarative-asset bundles (no executable code Lamprey runs in-process)", and
 * installFromManifest's only check on `files` is a path-traversal guard. Both
 * statements are true and both are beside the point — nothing runs IN Lamprey;
 * connectors.json makes something run NEXT TO it. The identical JSON pasted
 * into "Add connector" raised the approval dialog this door skipped.
 *
 * Returns null when there is nothing to approve or everything was approved,
 * otherwise the refusal message to hand back to the renderer.
 */
async function refuseUnapprovedStdioConnectors(text: string): Promise<string | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    // refreshPluginConnectors JSON.parses this file too and bails on junk, so
    // an unparseable connectors.json spawns nothing: no consent to collect.
    return null
  }
  if (!Array.isArray(parsed)) return null
  for (const raw of parsed) {
    if (!raw || typeof raw !== 'object') continue
    const obj = raw as Record<string, unknown>
    // Mirror refreshPluginConnectors' acceptance rules so we prompt for exactly
    // the entries that will spawn — an entry it drops must not raise a dialog
    // (noise trains click-through), and one it keeps must never skip one.
    const innerId = typeof obj.id === 'string' ? obj.id : ''
    if (!innerId) continue
    if (obj.transport !== 'stdio') continue
    // No command => connectStdio has nothing to exec; same reason mcp:addServer
    // rejects that shape before prompting rather than showing "Command: undefined".
    if (typeof obj.command !== 'string' || !obj.command.trim()) continue
    const cfg: McpServerConfig = {
      id: innerId,
      name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim() : innerId,
      transport: 'stdio',
      auth: 'none',
      enabled: true,
      command: obj.command
    }
    if (Array.isArray(obj.args)) {
      cfg.args = obj.args.filter((a: unknown): a is string => typeof a === 'string')
    }
    if (obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)) {
      const env: Record<string, string> = {}
      for (const [k, v] of Object.entries(obj.env as Record<string, unknown>)) {
        if (typeof v === 'string') env[k] = v
      }
      cfg.env = env
    }
    const approved = await approveStdioConnector(cfg)
    if (!approved) {
      return `Plugin install cancelled — connector "${innerId}" was not approved`
    }
  }
  return null
}

/**
 * Does this `files` key land on the plugin root's connectors.json — the one
 * path mcp-manager reads? Answered with the SAME normalizer the write uses:
 * installFromManifest strips backslashes and leading slashes, then writes to
 * `join(dest, normalized)` — and join() applies path.normalize().
 *
 * This gate previously open-coded that normalization as a "strip a leading ./"
 * loop, which is precisely how a gate drifts from the thing it guards. The loop
 * stops at the first segment that is not `./`, so `.//connectors.json` came out
 * as `/connectors.json` and compared unequal — while join() still collapsed it
 * onto the plugin root's connectors.json. One extra slash and the spawn was
 * ungated again, with the gate visibly present and passing its own tests.
 * Trailing separators are stripped for the same reason: Win32 accepts a write to
 * `connectors.json\` as a write to `connectors.json`, which mcp-manager's
 * existsSync then finds. Case is folded because the plugin root lives on a
 * case-insensitive filesystem on the primary platform.
 */
function isConnectorsJsonKey(rel: string): boolean {
  const slashed = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  // installFromManifest refuses the WHOLE install on a parent escape, so a key
  // like `x/../connectors.json` never lands: prompting would be noise for an
  // install that is already doomed, and noise is what trains click-through.
  if (slashed.includes('..')) return false
  const norm = normalize(slashed).replace(/[\\/]+$/, '')
  return norm.toLowerCase() === 'connectors.json'
}

export function registerPluginsHandlers(): void {
  ipcMain.handle('plugins:list', async () => {
    try {
      return { success: true, data: listPlugins() }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:get', async (_event, id: string) => {
    try {
      const plugin = getPlugin(id)
      if (!plugin) return { success: false, error: `Plugin not found: ${id}` }
      return { success: true, data: plugin }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:enable', async (_event, id: string) => {
    try {
      const ok = setPluginEnabled(id, true)
      if (!ok) return { success: false, error: `Plugin not found: ${id}` }
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:disable', async (_event, id: string) => {
    try {
      const ok = setPluginEnabled(id, false)
      if (!ok) return { success: false, error: `Plugin not found: ${id}` }
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:remove', async (_event, id: string) => {
    try {
      const ok = removePlugin(id)
      if (!ok) return { success: false, error: `Plugin not found or could not be removed: ${id}` }
      return { success: true, data: null }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:installFromDirectory', async (_event, srcPath: string) => {
    try {
      if (typeof srcPath !== 'string' || !srcPath.trim()) {
        return { success: false, error: 'srcPath is required' }
      }
      // Same ingress, same gate: the copied tree carries connectors.json too,
      // and srcPath is renderer-supplied — it need not have come from the
      // native picker. A read failure here fails the install closed (the outer
      // catch): un-inspectable is not the same as approved.
      const connectorsPath = join(srcPath.trim(), 'connectors.json')
      if (existsSync(connectorsPath)) {
        const refusal = await refuseUnapprovedStdioConnectors(
          readFileSync(connectorsPath, 'utf-8')
        )
        if (refusal) return { success: false, error: refusal }
      }
      const result = installFromDirectory(srcPath.trim())
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: { id: result.id } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // URL install, as a REVIEWED two-step. The old stub here refused outright,
  // reasoning that .zip/.tar.gz extraction needed a parser dependency the app does
  // not carry. That is still true of archives — and unnecessary, because the way
  // open source is actually distributed is a git repository, and `git` is a
  // dependency the machine either has or can be told to install (which is now a
  // thing the app can say: see capability-requires).
  //
  // Step 1 of 2. Clones into scratch and returns what it contains. Installs nothing,
  // loads nothing, spawns nothing.
  ipcMain.handle('plugins:stageFromUrl', async (_event, url: unknown) => {
    try {
      if (typeof url !== 'string' || !url.trim()) {
        return { success: false, error: 'A repository URL is required' }
      }
      const result = await stageFromUrl(url.trim(), installedPluginIds())
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: result.staged }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Step 2 of 2. The operator has read the review screen; now apply the SAME stdio
  // approval gate the directory path uses, then install DISABLED.
  //
  // Deliberately reusing refuseUnapprovedStdioConnectors rather than treating the
  // review screen as consent: the screen is one renderer surface showing text, and
  // the thing being authorized is a process spawn. The native dialog is the gate
  // this codebase already decided is the right one for that, and a second, weaker
  // path to the same spawn is exactly the shape of the bug its docblock describes.
  ipcMain.handle('plugins:commitStaged', async (_event, stageId: unknown) => {
    try {
      if (typeof stageId !== 'string' || !stageId.trim()) {
        return { success: false, error: 'stageId is required' }
      }
      const dir = stagedPath(stageId.trim())
      if (!dir) return { success: false, error: 'That staged plugin is no longer available.' }

      const connectorsPath = join(dir, 'connectors.json')
      if (existsSync(connectorsPath)) {
        const refusal = await refuseUnapprovedStdioConnectors(
          readFileSync(connectorsPath, 'utf-8')
        )
        if (refusal) return { success: false, error: refusal }
      }
      const result = installReviewedDirectory(dir)
      // Staging is scratch either way: a committed plugin has been copied to the
      // plugins root, and a failed commit has nothing worth keeping.
      discardStaged(stageId.trim())
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: { id: result.id } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:discardStaged', async (_event, stageId: unknown) => {
    try {
      if (typeof stageId !== 'string') return { success: false, error: 'stageId is required' }
      return { success: true, data: { discarded: discardStaged(stageId.trim()) } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Kept so an older renderer gets a useful sentence rather than a missing-handler
  // rejection. Points at the flow that replaced it.
  ipcMain.handle('plugins:installFromUrl', async () => {
    return {
      success: false,
      error: 'Use the two-step URL install: stage the repository, review it, then install.'
    }
  })

  ipcMain.handle(
    'plugins:installFromManifest',
    async (_event, manifest: PluginManifest, files?: Record<string, string>) => {
      try {
        if (!manifest || typeof manifest !== 'object') {
          return { success: false, error: 'Manifest object is required' }
        }
        // Gate BEFORE installFromManifest — it writes the files and fires
        // broadcastChange in the same synchronous call, so approving afterwards
        // would be too late: the connector is already spawned.
        if (files && typeof files === 'object') {
          for (const [rel, body] of Object.entries(files)) {
            if (!isConnectorsJsonKey(rel) || typeof body !== 'string') continue
            const refusal = await refuseUnapprovedStdioConnectors(body)
            if (refusal) return { success: false, error: refusal }
          }
        }
        const result = installFromManifest(manifest, files)
        if (!result.ok) return { success: false, error: result.error }
        return { success: true, data: { id: result.id } }
      } catch (err) {
        return { success: false, error: (err as Error).message }
      }
    }
  )

  ipcMain.handle('plugins:listBundledAvailable', async () => {
    try {
      return { success: true, data: bundledPluginsNotInstalled() }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:installBundled', async (_event, id: string) => {
    try {
      const result = installBundled(id)
      if (!result.ok) return { success: false, error: result.error }
      return { success: true, data: { id: result.id } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('plugins:pickDirectory', async (event) => {
    try {
      const win = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: 'Select plugin directory',
        properties: ['openDirectory'] as Array<'openDirectory'>
      }
      const res = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts)
      if (res.canceled || res.filePaths.length === 0) {
        return { success: true, data: null }
      }
      return { success: true, data: res.filePaths[0] }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
