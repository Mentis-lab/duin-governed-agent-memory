import { ipcMain } from 'electron'
import { drainFeedbackBridge, feedbackBridgeStatus } from '../services/feedback-bridge'
import { friendly, messageOf } from '../services/guarded'

// IPC surface for the consumption bridge (DUIN nervous system, organ #2). The
// bridge runs on a periodic tick in main; these handlers let the renderer (or a
// QA harness) force a drain and read the delivery ledger summary on demand.

export function registerFeedbackBridgeHandlers(): void {
  // feedback-bridge:drain — force a drain now. Returns the DrainSummary.
  ipcMain.handle('feedback-bridge:drain', async () => {
    try {
      return { success: true, data: await drainFeedbackBridge() }
    } catch (err) {
      return { success: false, error: friendly(err, 'drain failed') }
    }
  })

  // feedback-bridge:status — read-only counts by delivery state.
  ipcMain.handle('feedback-bridge:status', async () => {
    try {
      return { success: true, data: feedbackBridgeStatus() }
    } catch (err) {
      return { success: false, error: friendly(err, 'status failed') }
    }
  })
}
