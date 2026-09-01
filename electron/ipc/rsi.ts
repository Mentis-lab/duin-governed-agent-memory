import { ipcMain } from 'electron'
import { loadInflight } from '../services/brain/self-improve-registry'
import { ratifyProposed, dismissProposed } from '../services/brain/self-improve-loop'
import { describeRsiChange } from '../services/brain/self-improve-tick'
import { resolveByActionId } from '../services/proactive/notices-store'
import { broadcastNoticesChanged } from './notices'
import { readSettings } from '../services/settings-helper'
import { messageOf } from '../services/guarded'

// W2 considerate-RSI — the ratify surface's read/decide IPC. A staged self-tune is a
// QUESTION, not an event: `rsi:pending` lists the open questions with an honest one-line
// diff, `rsi:resolve` answers one — 'ratify' applies it (byte-reversible, into the normal
// held-out A/B), 'dismiss' parks it for good (the QD archive never re-asks that value).
// Answering also clears the Needs-you card (resolveByActionId), so the inbox never keeps
// asking a settled question. Read-only listing; the only writes go through the two
// audited service paths in self-improve-loop.ts.

function vaultDir(): string | null {
  try {
    const d = readSettings().localBrainNotesDir
    return typeof d === 'string' && d.trim() ? d : null
  } catch {
    return null
  }
}

export function registerRsiHandlers(): void {
  ipcMain.handle('rsi:pending', async () => {
    try {
      const dir = vaultDir()
      if (!dir) return { success: true, data: [] }
      const rows = loadInflight(dir)
        .filter((c) => c.status === 'proposed')
        .map((c) => ({
          id: c.id,
          changeClass: c.changeClass,
          engine: c.engine,
          proposedAt: c.proposedAt,
          diff: describeRsiChange(dir, c),
          // The file this change writes. Surfaced so the operator ratifies with the write
          // target in view, not just the key diff — a ledger row can carry any targetPath,
          // and applyChange refuses one outside <vault>/.duin/, but the human should see it.
          targetPath: c.targetPath
        }))
      return { success: true, data: rows }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('rsi:resolve', async (_event, id: unknown, verb: unknown) => {
    try {
      if (typeof id !== 'string' || id.length === 0) {
        return { success: false, error: 'resolve: id is required' }
      }
      if (verb !== 'ratify' && verb !== 'dismiss') {
        return { success: false, error: "resolve: verb must be 'ratify' | 'dismiss'" }
      }
      const dir = vaultDir()
      if (!dir) return { success: false, error: 'no vault configured' }
      const out = verb === 'ratify' ? ratifyProposed(dir, id, new Date().toISOString()) : dismissProposed(dir, id)
      if (out.ok) {
        resolveByActionId(id)
        broadcastNoticesChanged()
      }
      return out.ok ? { success: true, data: out } : { success: false, error: out.reason }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}
