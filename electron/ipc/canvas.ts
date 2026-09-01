import { ipcMain } from 'electron'
import { readSettings } from '../services/settings-helper'
import {
  listCanvasesIn,
  readCanvasIn,
  saveCanvasAtIn,
  saveCanvasToVaultIn
} from '../services/canvas/canvas-vault'
import { scheduleReindex } from '../services/local-brain/notes-watcher'
import { openCanvasWindow, openDetachedWindow } from '../services/canvas/canvas-window'

// Canvas blueprints as first-class vault files. The renderer owns the editor;
// this is the only path by which it touches disk, and every handler is jailed
// to the configured vault (see canvas-vault.ts) — no arbitrary path reaches fs.

const vaultDir = (): string => (readSettings().localBrainNotesDir as string) || ''

export function registerCanvasHandlers(): void {
  ipcMain.handle('canvas:save', async (_event, name: unknown, json: unknown) => {
    try {
      const res = saveCanvasToVaultIn(vaultDir(), String(name ?? ''), String(json ?? ''))
      if (!res.ok) return { success: false, error: res.error }
      // A saved blueprint should be findable immediately — without this the
      // canvas is on disk but absent from retrieval until the next full pass.
      try {
        scheduleReindex(vaultDir())
      } catch {
        /* indexing is best-effort; the file is already written */
      }
      return { success: true, data: { path: res.path, rel: res.rel } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('canvas:saveAt', async (_event, rel: unknown, json: unknown) => {
    try {
      const res = saveCanvasAtIn(vaultDir(), String(rel ?? ''), String(json ?? ''))
      if (!res.ok) return { success: false, error: res.error }
      try {
        scheduleReindex(vaultDir())
      } catch {
        /* best-effort */
      }
      return { success: true, data: { path: res.path, rel: res.rel } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('canvas:list', async () => {
    try {
      return { success: true, data: listCanvasesIn(vaultDir()) }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('canvas:openWindow', async (_event, rel: unknown) => {
    try {
      const res = openCanvasWindow(String(rel ?? ''))
      return res.ok ? { success: true, data: null } : { success: false, error: res.error }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Generic detached surface — a note, an entity, a canvas — in its own window.
  ipcMain.handle('window:openDetached', async (_event, view: unknown, key: unknown) => {
    try {
      const v = String(view ?? '')
      if (v !== 'canvas' && v !== 'node') {
        return { success: false, error: `Unknown detached view: ${v}` }
      }
      const res = openDetachedWindow(v, String(key ?? ''))
      return res.ok ? { success: true, data: null } : { success: false, error: res.error }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('canvas:read', async (_event, rel: unknown) => {
    try {
      const text = readCanvasIn(vaultDir(), String(rel ?? ''))
      if (text === null) return { success: false, error: 'Canvas not found' }
      return { success: true, data: text }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
