import { appendFileSync, existsSync, statSync, renameSync, readFileSync } from 'fs'
import { join } from 'path'
import { flushMainLog, initMainLog, installConsoleMirror, setMainLogVerbose } from './main-log'

// Diagnostic trace writer for the Stall & Timeout phase follow-up. Writes
// timestamped JSONL records to userData/lamprey-debug.log so we can see the
// exact call sequence when chatStream hangs without the inactivity watchdog
// firing. This module is intentionally STANDALONE — no imports from chat-events,
// providers, mcp-manager, etc. — so it can be safely called from any service
// without risking import cycles.
//
// The writer is opt-in via `debugTrace: true` in settings.json. The Stall &
// Timeout debug build ships with the flag forced on; production builds leave
// it off so users aren't writing trace logs by default.
//
// The ALWAYS-ON sink is a different file: main-log.ts keeps `<userData>/logs/main.log` at warn
// level on every install (console.warn/error mirrored, 2 MB × 5). It is wired from the same
// bootstrap call main.ts already makes here (setDebugTraceUserDataPath), so the opt-in verbose
// trace above and the always-on warn log share one seam and main.ts needed no change. When the
// verbose trace is on, main.log also takes `info` lines.

const MAX_LOG_BYTES = 20 * 1024 * 1024 // 20 MB then rotate to .prev
const BUFFER_FLUSH_MS = 250

let userDataPathProvider: (() => string) | null = null
let forceEnabled = false
let enabledCache: boolean | null = null
let enabledCheckedAt = 0
const ENABLED_TTL_MS = 1500

const buffer: string[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null

export function setDebugTraceUserDataPath(fn: (() => string) | null): void {
  userDataPathProvider = fn
  // The provider just changed, so a cached answer is stale: a trace() before this call cached
  // "no provider → off" for ENABLED_TTL_MS, and initMainLog read that cache — which is how an
  // instance seeded with `debugTrace: true` booted with main.log non-verbose (P0 audit E2,
  // 2026-09-03). Re-read from disk here; isEnabled() keeps main-log in step on every later read.
  enabledCache = null
  // Always-on warn-level sink (main-log.ts). Idempotent, and cheap before app-ready: the
  // directory is resolved lazily on the first flush.
  initMainLog(fn, { verbose: isEnabled() })
  if (fn) installConsoleMirror()
}

/** Force the trace on regardless of settings — used by the debug build's
 *  bootstrap so users don't have to flip a setting. */
export function forceDebugTraceOn(): void {
  forceEnabled = true
  enabledCache = true
  setMainLogVerbose(true)
}

function isEnabled(): boolean {
  if (forceEnabled) return true
  const now = Date.now()
  if (enabledCache !== null && now - enabledCheckedAt < ENABLED_TTL_MS) return enabledCache
  enabledCheckedAt = now
  if (!userDataPathProvider) {
    enabledCache = false
    return false
  }
  try {
    // `fs` is statically imported at the top of this module — see the
    // standalone-no-cycle note above. Lazy require was a holdover and the
    // ESLint rule @typescript-eslint/no-require-imports forbids it.
    const settingsPath = join(userDataPathProvider(), 'settings.json')
    if (!existsSync(settingsPath)) {
      enabledCache = false
      setMainLogVerbose(false)
      return false
    }
    const raw = JSON.parse(readFileSync(settingsPath, 'utf-8')) as { debugTrace?: unknown }
    enabledCache = raw.debugTrace === true
    // main.log's info gate follows the flag on every fresh read (≤ ENABLED_TTL_MS behind a
    // settings change), so verbose neither needs a restart to apply nor to stop applying.
    setMainLogVerbose(enabledCache)
    return enabledCache
  } catch {
    enabledCache = false
    setMainLogVerbose(false)
    return false
  }
}

function logPath(): string | null {
  if (!userDataPathProvider) return null
  try {
    return join(userDataPathProvider(), 'lamprey-debug.log')
  } catch {
    return null
  }
}

function rotateIfHuge(path: string): void {
  try {
    if (!existsSync(path)) return
    const st = statSync(path)
    if (st.size < MAX_LOG_BYTES) return
    renameSync(path, path + '.prev')
  } catch {
    // best-effort
  }
}

function scheduleFlush(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushNow()
  }, BUFFER_FLUSH_MS)
}

function flushNow(): void {
  if (buffer.length === 0) return
  const path = logPath()
  if (!path) {
    buffer.length = 0
    return
  }
  const out = buffer.join('')
  buffer.length = 0
  try {
    rotateIfHuge(path)
    appendFileSync(path, out, 'utf-8')
  } catch {
    // If the disk is full or the file is locked we drop the burst rather
    // than crashing the chat path.
  }
}

/** Emit one trace record. Cheap when disabled. */
export function trace(tag: string, payload?: Record<string, unknown>): void {
  if (!isEnabled()) return
  const line = JSON.stringify({
    ts: Date.now(),
    tag,
    ...(payload ?? {})
  })
  buffer.push(line + '\n')
  // Mirror to stdout so a dev-mode run from a terminal also sees the
  // timeline live. main.ts already gates the renderer push so the user
  // doesn't see noise in the right panel.
  // eslint-disable-next-line no-console
  console.log('[trace]', tag, payload ?? '')
  scheduleFlush()
}

/** Force a synchronous flush — call before crashes / quits. */
export function flushTrace(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  flushNow()
  flushMainLog()
}
