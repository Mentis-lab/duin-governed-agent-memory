import { ipcMain } from 'electron'
import * as store from '../services/automations-store'
import { describeCron, nextFireAfter, parseCron, runAutomation } from '../services/automations-runner'
import { friendly, messageOf } from '../services/guarded'

export function registerAutomationsHandlers(): void {
  ipcMain.handle('automations:list', async () => {
    try {
      return { success: true, data: store.listAutomations() }
    } catch (err) {
      return { success: false, error: friendly(err, 'list failed') }
    }
  })

  ipcMain.handle(
    'automations:create',
    async (
      _e,
      input: { label: string; cron: string; prompt: string; model?: string | null }
    ) => {
      try {
        if (!input?.label || !input?.cron || !input?.prompt) {
          return { success: false, error: 'label, cron, prompt required' }
        }
        try {
          parseCron(input.cron)
        } catch (err) {
          return { success: false, error: `invalid cron: ${friendly(err, 'parse error')}` }
        }
        return { success: true, data: store.createAutomation(input) }
      } catch (err) {
        return { success: false, error: friendly(err, 'create failed') }
      }
    }
  )

  ipcMain.handle(
    'automations:update',
    async (
      _e,
      id: string,
      patch: Partial<{
        label: string
        cron: string
        prompt: string
        model: string | null
        enabled: boolean
      }>
    ) => {
      try {
        if (patch.cron) {
          try {
            parseCron(patch.cron)
          } catch (err) {
            return { success: false, error: `invalid cron: ${messageOf(err)}` }
          }
        }
        store.updateAutomation(id, patch)
        return { success: true, data: true }
      } catch (err) {
        return { success: false, error: friendly(err, 'update failed') }
      }
    }
  )

  ipcMain.handle('automations:delete', async (_e, id: string) => {
    try {
      store.deleteAutomation(id)
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'delete failed') }
    }
  })

  ipcMain.handle('automations:runNow', async (_e, id: string) => {
    try {
      // Return the OUTCOME. runAutomation resolves rather than throws for a failed run —
      // that is the whole point of AutomationRunOutcome — so awaiting it and reporting
      // `success: true` told the panel every run worked. The CLI path already reads this
      // same value and exits non-zero on it; only the GUI was throwing it away.
      const outcome = await runAutomation(id)
      if (outcome.status === 'ok') return { success: true, data: outcome }
      return { success: false, error: `${outcome.status}: ${outcome.error}`, data: outcome }
    } catch (err) {
      return { success: false, error: friendly(err, 'run failed') }
    }
  })

  // UA-AUTO — durable run history from the automation_runs ledger (attempt-level
  // observability: started/finished, status, result/error, trigger key).
  ipcMain.handle('automations:runs', async (_e, id: string, limit?: number) => {
    try {
      if (typeof id !== 'string' || !id) {
        return { success: false, error: 'automation id is required' }
      }
      return { success: true, data: store.listAutomationRuns(id, typeof limit === 'number' ? limit : 20) }
    } catch (err) {
      return { success: false, error: friendly(err, 'runs failed') }
    }
  })

  // G1 — cron expression validation + human-readable preview + next-fire
  // hint. Used by the AutomationsPanel CronEditor; returns
  // { valid: true, description, nextFireAt } on success or
  // { valid: false, error } when the expression doesn't parse.
  ipcMain.handle('automations:validateCron', async (_e, expr: string) => {
    try {
      if (typeof expr !== 'string' || expr.trim() === '') {
        return { success: true, data: { valid: false, error: 'cron expression is required' } }
      }
      try {
        parseCron(expr)
      } catch (err) {
        return {
          success: true,
          data: { valid: false, error: friendly(err, 'cron parse error') }
        }
      }
      const description = describeCron(expr)
      const next = nextFireAfter(expr)
      return {
        success: true,
        data: {
          valid: true,
          description: description ?? null,
          nextFireAt: next ? next.getTime() : null
        }
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'validate failed') }
    }
  })
}
