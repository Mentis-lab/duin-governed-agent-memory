import { ipcMain } from 'electron'
import {
  pushNotification,
  getDigestSchedule,
  setDigestSchedule,
  initDigestScheduler,
  type DigestSchedule
} from '../services/notifications-service'

export function registerNotificationsHandlers(): void {
  ipcMain.handle(
    'notifications:push',
    async (_event, input: { title: string; body: string; deepLink?: string | null }) => {
      try {
        return { success: true, data: pushNotification(input) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Daily brain-digest opt-in — jargon-free "send me a daily digest" toggle.
  ipcMain.handle('notifications:getDigestSchedule', async () => {
    try {
      return { success: true, data: getDigestSchedule() }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'notifications:setDigestSchedule',
    async (_event, input: Partial<DigestSchedule>) => {
      try {
        return { success: true, data: setDigestSchedule(input) }
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Restore a persisted opt-in so the digest survives restarts.
  initDigestScheduler()
}
