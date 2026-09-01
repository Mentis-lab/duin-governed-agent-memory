// Channels store — per-channel runtime state (enabled, lastError, startedAt),
// persisted to channels.json. Mirrors connections-store.ts (the ingest side):
// same JSON persistence, same broadcast-on-change, so the two connectivity
// halves stay symmetric. The registry (index.ts) owns the adapter list; THIS
// owns the mutable per-channel state the UI toggles.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { BrowserWindow } from 'electron'
import { listChannels, getChannel } from './index'
import { messageOf } from '../guarded'
import { getKey, setKey, deleteKey, hasKey } from '../keychain'

interface ChannelState {
  enabled: boolean
  lastError: string | null
  startedAt: number | null
}
type StateMap = Record<string, ChannelState>

let state: StateMap = {}
let storePath: string | null = null

export function setChannelsPath(userDataDir: string): void {
  storePath = join(userDataDir, 'channels.json')
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { state?: StateMap }
      state = raw.state && typeof raw.state === 'object' ? raw.state : {}
    } else {
      state = {}
    }
  } catch {
    state = {}
  }
}

function persist(): void {
  if (!storePath) return
  try {
    mkdirSync(dirname(storePath), { recursive: true })
    writeFileSync(storePath, JSON.stringify({ state }, null, 2), 'utf-8')
  } catch (e) {
    console.debug('[channels-store] best-effort persist:', messageOf(e))
  }
}

function get(id: string): ChannelState {
  return state[id] ?? (state[id] = { enabled: false, lastError: null, startedAt: null })
}

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('channels:updated')
  }
}

/** Registry adapters merged with persisted state + live configured-ness, for the UI. */
export function listChannelSummaries(): {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  lastError: string | null
  startedAt: number | null
}[] {
  return listChannels().map((c) => {
    const s = get(c.id)
    return {
      id: c.id,
      label: c.label,
      configured: c.isConfigured(),
      enabled: s.enabled,
      lastError: s.lastError,
      startedAt: s.startedAt
    }
  })
}

/** The credential fields a channel declares, each with whether a value is already stored
 *  — and, for non-secret fields, the value itself so the operator can edit it rather than
 *  retype it blind. A secret's value NEVER crosses back to the renderer. */
export function listChannelCredentials(id: string): {
  keychainKey: string
  label: string
  kind: 'secret' | 'text'
  placeholder?: string
  help?: string
  hasValue: boolean
  value?: string
}[] {
  const adapter = getChannel(id)
  if (!adapter?.credentials) return []
  return adapter.credentials.map((field) => ({
    ...field,
    hasValue: hasKey(field.keychainKey),
    ...(field.kind === 'text' ? { value: getKey(field.keychainKey) ?? '' } : {})
  }))
}

/** Write (or, with an empty value, clear) one declared credential.
 *
 *  Pure store surgery — restarting the adapter so the new value takes effect is the IPC
 *  caller's job, exactly as it is for setChannelEnabled. This module owns persisted state
 *  and must not depend on the gateway (the gateway already depends on IT). */
export function setChannelCredential(
  id: string,
  keychainKey: string,
  value: string
): { ok: true; configured: boolean; enabled: boolean } | { ok: false; error: string } {
  const adapter = getChannel(id)
  if (!adapter) return { ok: false, error: `unknown channel: ${id}` }
  // Only a key this adapter DECLARED may be written here: without that check the IPC is a
  // general keychain-write primitive reachable from the renderer, which is a different
  // (and much larger) authority than "configure this channel".
  if (!adapter.credentials?.some((f) => f.keychainKey === keychainKey)) {
    return { ok: false, error: `channel ${id} does not declare ${keychainKey}` }
  }
  try {
    if (value) setKey(keychainKey, value)
    else deleteKey(keychainKey)
  } catch (e) {
    return { ok: false, error: messageOf(e) ?? 'could not write the credential' }
  }
  broadcast()
  return { ok: true, configured: adapter.isConfigured(), enabled: get(id).enabled }
}

export function setChannelEnabled(id: string, enabled: boolean): boolean {
  if (!getChannel(id)) return false
  const s = get(id)
  s.enabled = enabled
  if (!enabled) s.startedAt = null
  persist()
  broadcast()
  return true
}

export function isChannelEnabled(id: string): boolean {
  return !!state[id]?.enabled
}

export function recordChannelError(id: string, error: string | null): void {
  get(id).lastError = error
  persist()
  broadcast()
}

export function recordChannelStarted(id: string): void {
  const s = get(id)
  s.startedAt = Date.now()
  s.lastError = null
  persist()
  broadcast()
}
