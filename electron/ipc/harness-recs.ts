import { ipcMain } from 'electron'
import { generateRecommendations } from '../services/harness-recommendations'
import { friendly, messageOf } from '../services/guarded'

export function registerHarnessRecsHandlers(): void {
  ipcMain.handle('harness:recommendations', async (_event, conversationId: unknown) => {
    try {
      const opts: { conversationId?: string } = {}
      if (typeof conversationId === 'string' && conversationId.trim()) {
        opts.conversationId = conversationId
      }
      return { success: true, data: generateRecommendations(opts) }
    } catch (err) {
      return {
        success: false,
        error: friendly(err, 'harness:recommendations failed')
      }
    }
  })
}
