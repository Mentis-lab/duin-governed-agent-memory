import { ipcMain, BrowserWindow } from 'electron'
import {
  listNotices,
  markAllRead,
  markRead,
  noticeCounts,
  resolveNotices,
  type Notice
} from '../services/proactive/notices-store'
import { messageOf } from '../services/guarded'

// Read/ack surface for the notice inbox. Producers live in main-process services —
// the renderer can mark things seen, but it cannot invent a notice, for the same
// reason the event spine has no `events:record`.

/** Tell every window the inbox changed so the panel and the pill badge stay honest
 *  without polling. Exported so producers can call it after recording. */
export function broadcastNoticesChanged(): void {
  const counts = noticeCounts()
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('notices:changed', counts)
  }
}

export function registerNoticesHandlers(): void {
  ipcMain.handle('notices:list', async (_event, opts: unknown) => {
    try {
      const o = (opts ?? {}) as { limit?: unknown; includeRead?: unknown }
      const limit = typeof o.limit === 'number' && o.limit > 0 ? Math.floor(o.limit) : 200
      const includeRead = o.includeRead !== false
      const data: Notice[] = listNotices({ limit, includeRead })
      return { success: true, data: { notices: data, counts: noticeCounts() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('notices:markRead', async (_event, ids: unknown) => {
    try {
      const list = Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []
      if (list.length === 0) return { success: false, error: 'No notice ids given' }
      const changed = markRead(list)
      if (changed) broadcastNoticesChanged()
      return { success: true, data: { changed, counts: noticeCounts() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('notices:markAllRead', async () => {
    try {
      const changed = markAllRead()
      if (changed) broadcastNoticesChanged()
      return { success: true, data: { changed, counts: noticeCounts() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // The operator's way out of an owed row. Deliberately NOT a general "answer" verb: the
  // renderer can close the inbox row, never decide the thing behind it.
  ipcMain.handle('notices:resolve', async (_event, ids: unknown) => {
    try {
      const list = Array.isArray(ids) ? ids.filter((i): i is string => typeof i === 'string') : []
      if (list.length === 0) return { success: false, error: 'No notice ids given' }
      const changed = resolveNotices(list)
      if (changed) broadcastNoticesChanged()
      return { success: true, data: { changed, counts: noticeCounts() } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('notices:counts', async () => {
    try {
      return { success: true, data: noticeCounts() }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}
