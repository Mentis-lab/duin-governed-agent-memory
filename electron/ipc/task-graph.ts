import { ipcMain } from 'electron'
import { loadTaskGraph, type TaskGraphQuery } from '../services/task-graph'
import { readTaskSnapshot, waitForTasks, type WaitTaskTarget } from '../services/task-query'
import { taskLifecycle, type RecoverableTaskAction } from '../services/task-lifecycle'

// task-graph:* IPC — the renderer-facing surface for the canonical task graph
// (conversation + agent-run nodes), read/wait, and recoverable/destructive
// lifecycle. Distinct from tasks:* (which reads/mutates the agent_runs table
// directly); this namespace speaks the graph.

export function registerTaskGraphHandlers(): void {
  ipcMain.handle('task-graph:graph', async (_e, query?: TaskGraphQuery) => {
    try {
      return { success: true, data: loadTaskGraph(query ?? {}) }
    } catch (err: unknown) {
      return { success: false, error: messageFor(err, 'task graph failed') }
    }
  })

  ipcMain.handle('task-graph:readGraphTask', async (_e, taskId: string) => {
    try {
      return { success: true, data: readTaskSnapshot(taskId) }
    } catch (err: unknown) {
      return { success: false, error: messageFor(err, 'task read failed') }
    }
  })

  ipcMain.handle(
    'task-graph:waitGraph',
    async (_e, targets: WaitTaskTarget[], timeoutMs?: number) => {
      try {
        return { success: true, data: await waitForTasks(targets, { timeoutMs }) }
      } catch (err: unknown) {
        return { success: false, error: messageFor(err, 'task wait failed') }
      }
    }
  )

  ipcMain.handle(
    'task-graph:updateMetadata',
    async (_e, taskId: string, action: RecoverableTaskAction, value?: string | null) => {
      try {
        const allowed: RecoverableTaskAction[] = [
          'rename',
          'pin',
          'unpin',
          'archive',
          'restore',
          'close'
        ]
        if (!allowed.includes(action)) return { success: false, error: 'invalid lifecycle action' }
        return { success: true, data: taskLifecycle.update(taskId, action, value, 'user') }
      } catch (err: unknown) {
        return { success: false, error: messageFor(err, 'task update failed') }
      }
    }
  )

  ipcMain.handle('task-graph:previewDelete', async (_e, taskId: string) => {
    try {
      return { success: true, data: taskLifecycle.previewDelete(taskId) }
    } catch (err: unknown) {
      return { success: false, error: messageFor(err, 'task delete preview failed') }
    }
  })

  ipcMain.handle('task-graph:deleteGraphTask', async (_e, taskId: string, previewToken: string) => {
    try {
      return { success: true, data: taskLifecycle.delete(taskId, previewToken, 'user') }
    } catch (err: unknown) {
      return { success: false, error: messageFor(err, 'task delete failed') }
    }
  })
}

function messageFor(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback
  if (typeof err === 'string') return err || fallback
  return fallback
}
