import { ipcMain } from 'electron'
import {
  listSlashCommands,
  resolveSlashCommand,
  listMethodSlashCommands,
  resolveMethodSlash
} from '../services/slash-commands'
import { readSettings } from '../services/settings-helper'
import { friendly, messageOf } from '../services/guarded'

/** The configured vault dir, or null — methods are enumerated relative to it. */
function vaultDir(): string | null {
  try {
    return (readSettings().localBrainNotesDir as string) || null
  } catch {
    return null
  }
}

// Track 2 / C4 — slash-command IPC. `slash:list` ships the discovered
// command set (built-ins + user overrides) for the palette/autocomplete;
// `slash:resolve` interpolates and returns the assembled prompt. The
// renderer dispatches the prompt as a normal user turn — slash commands
// are syntactic sugar over `chat:send`, not a separate transport.
//
// Hidden commands stay out of the listing but `slash:resolve` still
// resolves them when called by name, so a user can type the name
// verbatim and still get the template.

export function registerSlashHandlers(): void {
  ipcMain.handle('slash:list', async () => {
    try {
      const all = [...listSlashCommands(), ...listMethodSlashCommands(vaultDir())]
      return { success: true, data: all.filter((c) => !c.hidden) }
    } catch (err) {
      return { success: false, error: friendly(err, 'slash:list failed') }
    }
  })

  ipcMain.handle('slash:listAll', async () => {
    try {
      return { success: true, data: [...listSlashCommands(), ...listMethodSlashCommands(vaultDir())] }
    } catch (err) {
      return { success: false, error: friendly(err, 'slash:listAll failed') }
    }
  })

  ipcMain.handle(
    'slash:resolve',
    async (_event, payload: { name: string; rest?: string }) => {
      try {
        if (!payload || typeof payload.name !== 'string') {
          return { success: false, error: 'name required' }
        }
        // File/plugin commands first; a method note only resolves if no file
        // command shadows the same name.
        const r = resolveSlashCommand(payload.name, payload.rest ?? '')
        if (r) return { success: true, data: r }
        const method = resolveMethodSlash(vaultDir(), payload.name)
        if (method) return { success: true, data: method }
        return { success: false, error: `Unknown slash command: ${payload.name}` }
      } catch (err) {
        return { success: false, error: friendly(err, 'slash:resolve failed') }
      }
    }
  )
}
