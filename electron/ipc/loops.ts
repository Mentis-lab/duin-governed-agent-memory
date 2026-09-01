import { ipcMain } from 'electron'
import {
  cancelWakeup,
  listWakeups,
  scheduleWakeup,
  type LoopWakeupStatus
} from '../services/loop-runner'
import {
  createLoop,
  getLoop,
  getBacklogItem,
  updateBacklogItem,
  listLoops,
  updateLoop,
  deleteLoop,
  listBacklog,
  enqueueBacklog,
  reorderBacklog,
  removeBacklogItem,
  listLoopRuns,
  type LoopMode,
  type LoopStatus
} from '../services/loop-store'
import { readLoopConfig } from '../services/loop-config'
import { readLongRunConfig, resolveLoopCostBudget } from '../services/longrun-config'
import { createConversation, getConversation } from '../services/conversation-store'
import { ratifyStagedItem, isRatifyVerb } from '../services/loop-ratify'
import { applyStaged, discardStaged, defaultExecSeam } from '../services/longrun/artifact-checkpoint'
import { recordFeedback } from '../services/ans/capability-ledger'

export function registerLoopsHandlers(): void {
  ipcMain.handle(
    'loops:schedule',
    async (
      _event,
      input: {
        conversationId: string
        delaySeconds: number
        prompt: string
        reason?: string | null
      }
    ) => {
      try {
        return { success: true, data: scheduleWakeup(input) }
      } catch (err) {
        return { success: false, error: messageFor(err, 'schedule failed') }
      }
    }
  )

  ipcMain.handle('loops:cancel', async (_event, id: string) => {
    try {
      return { success: true, data: { cancelled: cancelWakeup(id) } }
    } catch (err) {
      return { success: false, error: messageFor(err, 'cancel failed') }
    }
  })

  ipcMain.handle(
    'loops:list',
    async (
      _event,
      filter?: {
        conversationId?: string
        status?: LoopWakeupStatus | LoopWakeupStatus[]
        limit?: number
      }
    ) => {
      try {
        return { success: true, data: listWakeups(filter) }
      } catch (err) {
        return { success: false, error: messageFor(err, 'list failed') }
      }
    }
  )

  // ---- LP-7: loop entities (distinct from the one-shot wake-ups above) ----

  ipcMain.handle(
    'loops:create',
    async (
      _event,
      input: {
        mode: LoopMode
        conversationId?: string
        instruction?: string
        model?: string
        intervalSeconds?: number
        tasks?: string[]
        // Long-run (L1/L2/L5/L6) user-settable knobs. All optional; omitting them
        // keeps a loop on today's behavior (no git artifact, no dollar cap, no
        // fallback chain).
        costBudgetUsd?: number
        artifactDir?: string
        providerChain?: string[]
      }
    ) => {
      try {
        const cfg = readLoopConfig()
        if (!cfg.enabled) {
          return { success: false, error: 'Loops are disabled. Enable them in Settings → Loops.' }
        }
        const mode = input?.mode
        if (mode !== 'interval' && mode !== 'self_paced' && mode !== 'autonomous') {
          return { success: false, error: 'invalid loop mode' }
        }
        // F3 (A5) — loops run through the BRAIN by default (grounded, tools,
        // governance, on the configured engine). An explicit input.model wins.
        const model = input.model || 'duin-brain'
        let conversationId = input.conversationId
        if (!conversationId || !getConversation(conversationId)) {
          conversationId = createConversation(model).id
        }
        const instruction = input.instruction?.trim() || null
        const tasks = (Array.isArray(input.tasks) ? input.tasks : [])
          .map((t) => String(t ?? '').trim())
          .filter(Boolean)
        const seedTasks = tasks.length > 0 ? tasks : instruction ? [instruction] : []
        if (seedTasks.length === 0) {
          return { success: false, error: 'a loop needs at least one task or an instruction' }
        }
        const loop = createLoop({
          conversationId,
          mode,
          instruction,
          model,
          intervalSeconds: typeof input.intervalSeconds === 'number' ? input.intervalSeconds : null,
          maxIterations: cfg.maxIterations,
          maxWallclockMs: cfg.maxWallclockMs,
          tokenBudget: cfg.tokenBudget,
          costBudgetUsd: resolveLoopCostBudget(input.costBudgetUsd, readLongRunConfig()),
          artifactDir: input.artifactDir?.trim() ? input.artifactDir.trim() : null,
          providerChain:
            Array.isArray(input.providerChain) && input.providerChain.length > 0
              ? JSON.stringify(input.providerChain.filter((p) => typeof p === 'string'))
              : null,
          nextFireAt: Date.now()
        })
        enqueueBacklog(loop.id, seedTasks)
        return { success: true, data: loop }
      } catch (err) {
        return { success: false, error: messageFor(err, 'create failed') }
      }
    }
  )

  ipcMain.handle(
    'loops:listLoops',
    async (_event, filter?: { conversationId?: string; status?: LoopStatus | LoopStatus[]; limit?: number }) => {
      try {
        return { success: true, data: listLoops(filter) }
      } catch (err) {
        return { success: false, error: messageFor(err, 'list loops failed') }
      }
    }
  )

  ipcMain.handle('loops:getLoop', async (_event, id: string) => {
    try {
      return { success: true, data: getLoop(id) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'get loop failed') }
    }
  })

  ipcMain.handle('loops:pause', async (_event, id: string) => {
    try {
      return { success: true, data: updateLoop(id, { status: 'paused', nextFireAt: null }) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'pause failed') }
    }
  })

  ipcMain.handle('loops:resume', async (_event, id: string) => {
    try {
      if (!readLoopConfig().enabled) {
        return { success: false, error: 'Loops are disabled. Enable them in Settings → Loops.' }
      }
      return { success: true, data: updateLoop(id, { status: 'running', nextFireAt: Date.now() }) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'resume failed') }
    }
  })

  ipcMain.handle('loops:stop', async (_event, id: string, reason?: string) => {
    try {
      return {
        success: true,
        data: updateLoop(id, { status: 'stopped', stopReason: reason || 'user-stop', nextFireAt: null })
      }
    } catch (err) {
      return { success: false, error: messageFor(err, 'stop failed') }
    }
  })

  // Governor 4a — ratify/revert/dismiss a HELD (staged) loop iteration. `backlogId`
  // must be a real awaiting-ratification item (ratifyStagedItem rejects otherwise), and
  // `verb` is validated here so a malformed call never reaches the store/git. Delegates
  // to the tied, idempotent ratify flow with the production git seam + recordFeedback.
  ipcMain.handle('loops:ratify', async (_event, backlogId: unknown, verb: unknown) => {
    try {
      if (typeof backlogId !== 'string' || backlogId.length === 0) {
        return { success: false, error: 'ratify: backlogId is required' }
      }
      if (!isRatifyVerb(verb)) {
        return { success: false, error: "ratify: verb must be 'ratify' | 'revert' | 'dismiss'" }
      }
      const result = await ratifyStagedItem(backlogId, verb, {
        getBacklogItem,
        getLoop,
        updateBacklogItem,
        recordFeedback,
        applyStaged,
        discardStaged,
        exec: defaultExecSeam
      })
      // W2: answering the staged question — from ANY surface — clears its Needs-you card, so
      // the inbox never keeps asking a settled question (the notices-store contract).
      if (result.ok) {
        try {
          const { resolveByActionId } = await import('../services/proactive/notices-store')
          if (resolveByActionId(backlogId)) {
            const { broadcastNoticesChanged } = await import('./notices')
            broadcastNoticesChanged()
          }
        } catch {
          /* card cleanup is best-effort — the decision itself already landed */
        }
      }
      return result.ok ? { success: true, data: result } : { success: false, error: result.error }
    } catch (err) {
      return { success: false, error: messageFor(err, 'ratify failed') }
    }
  })

  ipcMain.handle('loops:deleteLoop', async (_event, id: string) => {
    try {
      return { success: true, data: { deleted: deleteLoop(id) } }
    } catch (err) {
      return { success: false, error: messageFor(err, 'delete failed') }
    }
  })

  ipcMain.handle('loops:listBacklog', async (_event, loopId: string) => {
    try {
      return { success: true, data: listBacklog(loopId) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'list backlog failed') }
    }
  })

  ipcMain.handle('loops:enqueue', async (_event, loopId: string, tasks: string[]) => {
    try {
      const clean = (Array.isArray(tasks) ? tasks : []).map((t) => String(t ?? '')).filter((t) => t.trim())
      return { success: true, data: enqueueBacklog(loopId, clean) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'enqueue failed') }
    }
  })

  ipcMain.handle('loops:reorderBacklog', async (_event, loopId: string, orderedIds: string[]) => {
    try {
      reorderBacklog(loopId, Array.isArray(orderedIds) ? orderedIds : [])
      return { success: true, data: listBacklog(loopId) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'reorder failed') }
    }
  })

  ipcMain.handle('loops:removeBacklog', async (_event, id: string) => {
    try {
      return { success: true, data: { removed: removeBacklogItem(id) } }
    } catch (err) {
      return { success: false, error: messageFor(err, 'remove failed') }
    }
  })

  ipcMain.handle('loops:listRuns', async (_event, loopId: string, limit?: number) => {
    try {
      return { success: true, data: listLoopRuns(loopId, limit ?? 50) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'list runs failed') }
    }
  })

  // Run a loop through the headless AGENTIC executor (it actually produces its
  // artifact). Gated by the backgroundAutonomy kill switch in runLoopAgentic.
  ipcMain.handle('loops:runAgentic', async (_event, name: string) => {
    try {
      const { runLoopAgentic } = await import('../services/loop-agent')
      return { success: true, data: await runLoopAgentic(name) }
    } catch (err) {
      return { success: false, error: messageFor(err, 'agentic run failed') }
    }
  })
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string') return err || fallback
  return fallback
}
