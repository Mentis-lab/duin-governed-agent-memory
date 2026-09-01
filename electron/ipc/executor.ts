// executor IPC — the operator's window into delegated runs.
//
// Two surfaces: `executor:status` (is the runtime ready, is there a key, has the capability earned
// autonomy, what's pending review) drives the Settings → Executors card; and the review actions
// (list / diff / keep / discard) are how the operator decides what a run produced. The renderer
// can READ everything and ACT on a review, but it cannot start a run (that is delegate_task, gated
// like every other tool) — the same "no events:record from the renderer" discipline the notice
// inbox keeps.

import { ipcMain } from 'electron'
import { messageOf } from '../services/guarded'
import { getKey } from '../services/keychain'
import { probeDshRuntime, dshRuntimeDir } from '../services/executor/executor-runtime'
import { describeMissing } from '../services/capability-requires'
import { executorRung, EXECUTOR_DSH_CAP_ID } from '../services/executor/executor-capability'
import { getCapability } from '../services/ans/capability-ledger'
import {
  listExecutorReviews,
  executorReviewDiff,
  keepExecutorReview,
  discardExecutorReview
} from '../services/executor/executor-review'

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data }
}
function err(e: unknown): { success: false; error: string } {
  return { success: false, error: messageOf(e) }
}

export function registerExecutorHandlers(): void {
  ipcMain.handle('executor:status', async () => {
    try {
      const runtime = probeDshRuntime()
      const cap = getCapability(EXECUTOR_DSH_CAP_ID)
      return ok({
        kind: 'dsh' as const,
        runtimeDir: dshRuntimeDir(),
        runtimeStaged: runtime.satisfied,
        runtimeMissing: runtime.satisfied ? '' : describeMissing(runtime),
        hasKey: !!getKey('deepseek'),
        rung: executorRung(),
        // The earned-autonomy record, so the card can say "kept 3, discarded 1".
        ratifyN: cap?.ratifyN ?? 0,
        ratifyK: cap?.ratifyK ?? 0,
        reverts: cap?.reverts ?? 0,
        pendingReviews: listExecutorReviews().length
      })
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('executor:reviews', async () => {
    try {
      return ok({ reviews: listExecutorReviews() })
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('executor:reviewDiff', async (_e, runId: unknown) => {
    try {
      if (typeof runId !== 'string' || !runId) throw new Error('runId required')
      return ok(await executorReviewDiff(runId))
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('executor:keep', async (_e, runId: unknown) => {
    try {
      if (typeof runId !== 'string' || !runId) throw new Error('runId required')
      return ok(await keepExecutorReview(runId))
    } catch (e) {
      return err(e)
    }
  })

  ipcMain.handle('executor:discard', async (_e, runId: unknown) => {
    try {
      if (typeof runId !== 'string' || !runId) throw new Error('runId required')
      return ok(await discardExecutorReview(runId))
    } catch (e) {
      return err(e)
    }
  })
}
