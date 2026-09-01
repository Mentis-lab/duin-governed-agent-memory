// Connections store — per-source ingest state (enabled, last sync, count) +
// the periodic sync orchestrator. The reach side (agent calling Slack/Gmail
// tools) is the MCP connectors; THIS is the ingest side (sources → brain).

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { BrowserWindow } from 'electron'
import { listAdapters, getAdapter, syncSource } from './source-adapters'
import { messageOf } from '../guarded'
import { readSettings } from '../settings-helper'
import { refreshComprehension } from '../local-brain/notes-watcher'

/** The vault root, or null when none is configured. */
function vaultDir(): string | null {
  const v = (readSettings() as { localBrainNotesDir?: unknown }).localBrainNotesDir
  return typeof v === 'string' && v.trim().length > 0 ? v : null
}

interface SourceState {
  enabled: boolean
  lastSyncMs: number | null
  lastCount: number | null
  lastError: string | null
}
type StateMap = Record<string, SourceState>

let state: StateMap = {}
let storePath: string | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let syncing = false

const SYNC_INTERVAL_MS = 30 * 60 * 1000 // 30 min
const FIRST_SYNC_DELAY_MS = 20 * 1000

export function setConnectionsPath(userDataDir: string): void {
  storePath = join(userDataDir, 'connections.json')
  try {
    if (existsSync(storePath)) {
      const raw = JSON.parse(readFileSync(storePath, 'utf-8')) as { state?: StateMap }
      state = raw.state && typeof raw.state === 'object' ? raw.state : {}
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
  } catch (e) { console.debug('[connections-store] best-effort:', messageOf(e)) }
}

function get(id: string): SourceState {
  return state[id] ?? (state[id] = { enabled: false, lastSyncMs: null, lastCount: null, lastError: null })
}

function broadcast(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('connections:updated')
  }
}

/** Adapters merged with their persisted state + live configured-ness, for the UI. */
export function listConnections(): {
  id: string
  label: string
  configured: boolean
  enabled: boolean
  lastSyncMs: number | null
  lastCount: number | null
  lastError: string | null
}[] {
  return listAdapters().map((a) => {
    const s = get(a.id)
    return {
      id: a.id,
      label: a.label,
      configured: a.isConfigured(),
      enabled: s.enabled,
      lastSyncMs: s.lastSyncMs,
      lastCount: s.lastCount,
      lastError: s.lastError
    }
  })
}

export function setConnectionEnabled(id: string, enabled: boolean): boolean {
  if (!getAdapter(id)) return false
  get(id).enabled = enabled
  persist()
  if (enabled) void syncOne(id) // kick an initial sync on enable
  return true
}

/** Sync one source now (manual or on-enable). Records state + broadcasts.
 *  `opts.sinceMs` threads a backfill floor through to the adapter. */
export async function syncOne(id: string, opts?: { sinceMs?: number }): Promise<{ ok: boolean; count: number; error?: string }> {
  const s = get(id)
  try {
    const count = await syncSource(id, opts)
    s.lastSyncMs = Date.now()
    s.lastCount = count
    s.lastError = null
    persist()
    broadcast()
    // tell the brain views to refetch (new src/ nodes in the graph)
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('brain:updated', { count })
    }
    // Run comprehension on what just landed. `syncSource` writes chunks, which
    // gets the structural half (retrieval, causal graph) for free — but the LLM
    // half (entity/edge extraction, construction, the channel→foresight bridge)
    // used to fire ONLY from the chokidar vault-file watcher. So a week of Slack
    // and Gmail syncs into a quiet vault produced no new comprehension at all,
    // and a first-run user with one connected channel and zero notes had no file
    // to edit and therefore never triggered any. Connection worked; comprehension
    // waited for an event that never came.
    //
    // Only on a non-zero count: an empty poll has nothing new to comprehend, and
    // the connector scheduler runs every 30 minutes.
    if (count > 0) {
      void refreshComprehension(vaultDir()).catch((e) =>
        console.warn('[connections] comprehension refresh failed:', (e as Error).message)
      )
    }
    return { ok: true, count }
  } catch (err) {
    s.lastError = (err as Error)?.message ?? 'sync failed'
    s.lastSyncMs = Date.now()
    persist()
    broadcast()
    return { ok: false, count: 0, error: s.lastError }
  }
}

/** Backfill one source `days` back: re-pulls with an extended `sinceMs` floor so
 *  the adapter reaches past its rolling window (Gmail after:, Calendar timeMin,
 *  Slack oldest, Feishu/RSS/Notion client-filter). Records state like syncOne. */
export async function backfillSource(id: string, days: number): Promise<{ ok: boolean; count: number; error?: string }> {
  const d = Number.isFinite(days) && days > 0 ? Math.min(days, 3650) : 30
  const sinceMs = Date.now() - d * 86_400_000
  return syncOne(id, { sinceMs })
}

/** Sync every enabled + configured source. Guarded against overlap. */
export async function syncAllEnabled(): Promise<void> {
  if (syncing) return
  syncing = true
  try {
    for (const a of listAdapters()) {
      const s = get(a.id)
      if (s.enabled && a.isConfigured()) await syncOne(a.id)
    }
  } finally {
    syncing = false
  }
}

/** Start the periodic ingest sync (first run after a short delay, then every
 *  30 min). No-op-safe: only enabled+configured sources actually fetch. */
export function startConnectorSync(): void {
  if (syncTimer) return
  setTimeout(() => void syncAllEnabled(), FIRST_SYNC_DELAY_MS)
  syncTimer = setInterval(() => void syncAllEnabled(), SYNC_INTERVAL_MS)
}
export function stopConnectorSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
}
