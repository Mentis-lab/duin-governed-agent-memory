import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync } from 'fs'
import { join, resolve } from 'path'
import { app } from 'electron'
import { recordEvent } from './event-log'
import { readSettings } from './settings-helper'

// Persistent "active workspace" path — the folder the user picked via the
// ChatInput chip. Tool execution (workspace_context, shell_command,
// apply_patch) resolves cwd against this so the model operates on the
// user's chosen directory, not the folder Lamprey itself was launched from.
//
// Stored as a single-line text file under userData so it cannot collide
// with concurrent settings.json read-modify-writes from settings.ts. Read
// is lazy + cached for 1s so a chat round doesn't stat the file per tool
// call. When nothing is explicitly picked, we default to the active brain
// vault (settings.localBrainNotesDir) so the agent's file-write (apply_patch)
// and terminal (shell_command) operate INSIDE the user's vault — i.e. it can
// actually create notes/files where their knowledge lives, instead of DUIN's
// launch dir. Falls back to process.cwd() only when no vault is configured,
// the file is unreadable, or the persisted path no longer exists.

const FILE_NAME = 'active-workspace.txt'
const CACHE_MS = 1000

let cachedPath: string | null = null
let cachedAt = 0

function statePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

function isDirectorySafe(absolute: string): boolean {
  try {
    return existsSync(absolute) && statSync(absolute).isDirectory()
  } catch {
    return false
  }
}

export function getActiveWorkspace(): string {
  const now = Date.now()
  if (cachedPath && now - cachedAt < CACHE_MS) return cachedPath
  const p = statePath()
  let persisted: string | null = null
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8').trim()
      if (raw.length > 0 && isDirectorySafe(raw)) persisted = resolve(raw)
    }
  } catch {
    // Corrupted file or perms — silently fall back; the file is rewritable.
  }
  cachedPath = persisted ?? vaultWorkspaceFallback()
  cachedAt = now
  return cachedPath
}

/** The operator-picked workspace only, without the vault/process.cwd fallback. */
export function getExplicitActiveWorkspace(): string | null {
  try {
    const p = statePath()
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8').trim()
    return raw.length > 0 && isDirectorySafe(raw) ? resolve(raw) : null
  } catch {
    return null
  }
}

// Default workspace when the user hasn't explicitly picked one: the active
// brain vault, so agent file-write + terminal land where the user's notes are.
// Only falls back to process.cwd() when no valid vault directory is configured.
function vaultWorkspaceFallback(): string {
  try {
    const vault = readSettings().localBrainNotesDir
    if (typeof vault === 'string' && vault.trim().length > 0 && isDirectorySafe(vault)) {
      return resolve(vault)
    }
  } catch {
    // Settings unreadable — fall through to the launch dir.
  }
  return process.cwd()
}

export function setActiveWorkspace(candidate: string): { path: string } {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new Error('setActiveWorkspace: path must be a non-empty string')
  }
  const absolute = resolve(candidate)
  if (!existsSync(absolute)) {
    throw new Error(`setActiveWorkspace: "${absolute}" does not exist`)
  }
  if (!isDirectorySafe(absolute)) {
    // A file path here would become the cwd for shell_command,
    // apply_patch, and workspace_context — every workspace-relative tool
    // would fail in confusing ways.
    throw new Error(`setActiveWorkspace: "${absolute}" is not a directory`)
  }
  // Capture the resolved previous workspace BEFORE the write so the change
  // event records the real transition (not the same path twice). We resolve
  // through getActiveWorkspace so an unset → set move shows from=process.cwd().
  const previous = getActiveWorkspace()
  writeFileSync(statePath(), absolute, 'utf8')
  cachedPath = absolute
  cachedAt = Date.now()
  if (previous !== absolute) {
    emitWorkspaceChanged({ from: previous, to: absolute, action: 'set' })
  }
  return { path: absolute }
}

export function clearActiveWorkspace(): void {
  const previous = (() => {
    try {
      return getActiveWorkspace()
    } catch {
      return undefined
    }
  })()
  let removed = false
  try {
    const p = statePath()
    if (existsSync(p)) {
      unlinkSync(p)
      removed = true
    }
  } catch {
    // ignore — caller falls back to process.cwd() via getActiveWorkspace.
  }
  cachedPath = null
  cachedAt = 0
  // Only emit when the persisted file actually changed — calling clear on a
  // brand-new install with no active-workspace.txt isn't a real transition.
  if (removed) {
    emitWorkspaceChanged({ from: previous, to: undefined, action: 'clear' })
  }
}

function emitWorkspaceChanged(detail: {
  from: string | undefined
  to: string | undefined
  action: 'set' | 'clear'
}): void {
  try {
    recordEvent({
      type: 'workspace.changed',
      actorKind: 'user',
      workspacePath: detail.to ?? detail.from,
      entityKind: 'workspace',
      entityId: detail.to ?? detail.from,
      payload: {
        action: detail.action,
        from: detail.from,
        to: detail.to
      }
    })
  } catch (err) {
    console.error('[workspace-state] workspace.changed event failed:', err)
  }
}

/** Test-only: drop the cache so tests can stub the file. */
export function __resetWorkspaceStateCache(): void {
  cachedPath = null
  cachedAt = 0
}
