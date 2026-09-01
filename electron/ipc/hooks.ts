import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as store from '../services/hooks-store'
import { testHook, type HookContext } from '../services/hooks-runner'
import { friendly, messageOf } from '../services/guarded'

/**
 * SECURITY BOUNDARY for the hooks system. Authoring a hook (create / update /
 * test) runs code inside DUIN, so it is gated by a NATIVE main-process
 * confirmation the renderer cannot fake or auto-dismiss: an injected script or
 * malicious artifact can call window.api.hooks.* but cannot click this OS dialog.
 * This is what lets hooks run by default (they're core to agent work) while the
 * RCE side-door stays closed — the trust is at authoring time, not execution.
 * Returns true only on explicit user approval.
 */
async function approveHookCode(opts: {
  action: 'create' | 'update' | 'test'
  event?: string
  label?: string
  command: string
}): Promise<boolean> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null
  const runBtn =
    opts.action === 'test' ? 'Run once' : opts.action === 'update' ? 'Update hook' : 'Create hook'
  const runsWhen =
    opts.action === 'test'
      ? 'run once, right now'
      : `run automatically on every "${opts.event ?? 'hook'}" event`
  const detail =
    (opts.event ? `Event: ${opts.event}\n` : '') +
    (opts.label ? `Label: ${opts.label}\n` : '') +
    `\nThis JavaScript will ${runsWhen} inside DUIN:\n\n` +
    opts.command.slice(0, 2000) +
    (opts.command.length > 2000 ? '\n… (truncated)' : '')
  const dialogOpts = {
    type: 'warning' as const,
    buttons: ['Cancel', runBtn],
    defaultId: 0, // Enter → Cancel: safe default for a code-execution prompt
    cancelId: 0,
    noLink: true,
    title: 'Approve hook code',
    message: 'Allow this hook to run code inside DUIN?',
    detail
  }
  const r = win
    ? await dialog.showMessageBox(win, dialogOpts)
    : await dialog.showMessageBox(dialogOpts)
  return r.response === 1
}

export function registerHooksHandlers(): void {
  ipcMain.handle('hooks:list', async () => {
    try {
      return { success: true, data: store.listHooks() }
    } catch (err) {
      return { success: false, error: friendly(err, 'list failed') }
    }
  })

  ipcMain.handle(
    'hooks:create',
    async (
      _e,
      input: {
        event: store.HookEvent
        label: string
        command: string
        language?: store.HookLanguage
        timeoutMs?: number
      }
    ) => {
      try {
        if (!input?.event || !input?.label || !input?.command) {
          return { success: false, error: 'event, label, command required' }
        }
        // SECURITY: authoring a hook runs code — require a native approval the
        // renderer can't fake before persisting it.
        const ok = await approveHookCode({
          action: 'create',
          event: input.event,
          label: input.label,
          command: input.command
        })
        if (!ok) return { success: false, error: 'Hook creation cancelled' }
        // The renderer may only create JS hooks. The shell path (arbitrary
        // `spawn(cmd, {shell:true})`) is legacy-migration-only — never honor a
        // renderer-supplied 'shell' language.
        return { success: true, data: store.createHook({ ...input, language: 'js' }) }
      } catch (err) {
        return { success: false, error: friendly(err, 'create failed') }
      }
    }
  )

  ipcMain.handle(
    'hooks:update',
    async (
      _e,
      id: string,
      patch: Partial<{
        event: store.HookEvent
        label: string
        command: string
        enabled: boolean
        language: store.HookLanguage
        timeoutMs: number
      }>
    ) => {
      try {
        // SECURITY: a command change re-arms code execution — require approval.
        if (typeof patch.command === 'string') {
          const ok = await approveHookCode({
            action: 'update',
            event: patch.event,
            label: patch.label,
            command: patch.command
          })
          if (!ok) return { success: false, error: 'Hook update cancelled' }
        }
        // Never let a renderer flip an existing hook to the shell path.
        const safePatch = { ...patch }
        delete safePatch.language
        store.updateHook(id, safePatch)
        return { success: true, data: true }
      } catch (err) {
        return { success: false, error: friendly(err, 'update failed') }
      }
    }
  )

  ipcMain.handle('hooks:delete', async (_e, id: string) => {
    try {
      store.deleteHook(id)
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'delete failed') }
    }
  })

  // Track 2 / C2 — test-run path for the HooksSettings UI. The renderer
  // sends the (possibly unsaved) code, the target event, a sample
  // context, and optional timeoutMs. We run the JS sandbox once and
  // return the captured logs + any throw message. Does not consult the
  // persisted hooks table.
  ipcMain.handle(
    'hooks:test',
    async (
      _e,
      payload: {
        code: string
        event: store.HookEvent
        context?: HookContext
        timeoutMs?: number
      }
    ) => {
      try {
        if (!payload || typeof payload.code !== 'string') {
          return { success: false, error: 'code required' }
        }
        if (!payload.event) return { success: false, error: 'event required' }
        // SECURITY: the test path runs the code immediately — require approval.
        const ok = await approveHookCode({
          action: 'test',
          event: payload.event,
          command: payload.code
        })
        if (!ok) return { success: false, error: 'Hook test cancelled' }
        const r = testHook({
          code: payload.code,
          event: payload.event,
          context: payload.context,
          timeoutMs: payload.timeoutMs
        })
        return { success: true, data: r }
      } catch (err) {
        return { success: false, error: friendly(err, 'test failed') }
      }
    }
  )
}
