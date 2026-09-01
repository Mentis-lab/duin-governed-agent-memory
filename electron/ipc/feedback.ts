import { ipcMain } from 'electron'
import {
  getEngagementByClass,
  recordFeedback,
  type FeedbackAction,
  type FeedbackObservationInput,
  type FeedbackSourceKind
} from '../services/feedback-observations'
import { friendly, messageOf } from '../services/guarded'

const SOURCE_KINDS: readonly FeedbackSourceKind[] = [
  'notice',
  'notification',
  'activity-card'
]

const ACTIONS: readonly FeedbackAction[] = ['act', 'snooze', 'dismiss', 'not-relevant']

export function registerFeedbackHandlers(): void {
  // feedback:record — the renderer calls this when the user clicks a verdict
  // button on a proactive surface. Returns the derived seed metadata so the UI
  // can confirm what the click produced.
  ipcMain.handle(
    'feedback:record',
    async (_e, input: FeedbackObservationInput) => {
      try {
        if (!input?.sourceCardId || typeof input.sourceCardId !== 'string') {
          return { success: false, error: 'sourceCardId required' }
        }
        if (!ACTIONS.includes(input.action)) {
          return { success: false, error: `invalid action: ${String(input.action)}` }
        }
        const sourceKind: FeedbackSourceKind = SOURCE_KINDS.includes(
          input.sourceKind
        )
          ? input.sourceKind
          : 'notice'
        return {
          success: true,
          data: recordFeedback({ ...input, sourceKind })
        }
      } catch (err) {
        return { success: false, error: friendly(err, 'record failed') }
      }
    }
  )

  // feedback:engagement — the loudness gate / governor sensor read. Returns the
  // per-detectorClass tally, loudest-first.
  ipcMain.handle(
    'feedback:engagement',
    async (_e, opts?: { sinceMs?: number; limit?: number }) => {
      try {
        return { success: true, data: getEngagementByClass(opts ?? {}) }
      } catch (err) {
        return { success: false, error: friendly(err, 'engagement query failed') }
      }
    }
  )
}
