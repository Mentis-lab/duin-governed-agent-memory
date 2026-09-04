// main-log.ts — the main process's ALWAYS-ON log sink.
//
// THE HOLE THIS CLOSES. The packaged app is launched with `start "" DUIN.exe`, so every
// `console.*` line the main process writes is discarded. The only file writer, debug-trace.ts,
// is opt-in (`settings.debugTrace === true`, absent on every real install) — so the live instance
// evaluated on 2026-09-02 had NO main-process log at all: 12,667 `[main-stall]` warnings, the
// breaker open/close lines and every "honest" console path of the 08-24 fixes had been written
// into the void (L7 F3). This module is the sink those lines were missing.
//
// SHAPE. A rolling text file at `<userData>/logs/main.log`, 2 MB × 5 rotations, one ISO-stamped
// line per record. Two producers feed it: the explicit `log.warn/error/info` API, and a console
// hook that mirrors `console.warn` / `console.error` (the level every existing warning already
// uses, `[main-stall]` included) into the file. `info` lines are written only when the verbose
// trace is on, so the always-on cost is bounded by how often the app warns.
//
// GUARANTEES.
//   • Never throws, never blocks the caller for long: lines are buffered and flushed on a short
//     timer; every fs call is wrapped; a full disk or a locked file drops the burst and counts it
//     (`dropped`), which the /debug/log-tail route publishes.
//   • Re-entrancy safe: a write failure is reported through console.error, which the hook would
//     mirror back into the sink — the `inHook` / `flushing` flags break that loop.
//   • Bounded: a line is capped at MAX_LINE_CHARS, the buffer flushes early past a size floor,
//     the file rotates at MAIN_LOG_MAX_BYTES and only MAIN_LOG_KEEP generations are retained.
//   • No secrets: key-shaped substrings (sk-…, Bearer …, x-duin-* tokens, `apiKey=…`) are masked
//     before a line is buffered. The masking is a floor, not a promise — the event spine's redaction
//     is the primary defence; this catches what a warning line happens to interpolate.
//
// Deliberately STANDALONE like debug-trace.ts: fs + path only, so any service can import it
// without an import cycle. debug-trace.ts wires it from the same bootstrap seam main.ts already
// calls (`setDebugTraceUserDataPath`), which is why main.ts needed no change.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { join } from 'path'

export const MAIN_LOG_MAX_BYTES = 2 * 1024 * 1024
export const MAIN_LOG_KEEP = 5
export const MAIN_LOG_FILE = 'main.log'
export const MAIN_LOG_DIR = 'logs'
/** Hard cap on lines a tail read returns, whatever the caller asks for. */
export const MAX_TAIL_LINES = 2000
const FLUSH_MS = 250
const EARLY_FLUSH_BYTES = 256 * 1024
const MAX_LINE_CHARS = 4096
const MAX_ARG_CHARS = 2048

export type MainLogLevel = 'info' | 'warn' | 'error'

interface SinkState {
  dirProvider: (() => string) | null
  /** Explicit directory (tests / overrides). Wins over dirProvider when set. */
  dir: string | null
  rotateAtBytes: number
  generations: number
  verbose: boolean
  buffer: string[]
  bufferedBytes: number
  timer: ReturnType<typeof setTimeout> | null
  written: number
  dropped: number
  lastError: string | null
  consoleHooked: boolean
  inHook: boolean
  flushing: boolean
  originals: {
    log: typeof console.log
    info: typeof console.info
    warn: typeof console.warn
    error: typeof console.error
  } | null
}

function freshState(): SinkState {
  return {
    dirProvider: null,
    dir: null,
    rotateAtBytes: MAIN_LOG_MAX_BYTES,
    generations: MAIN_LOG_KEEP,
    verbose: false,
    buffer: [],
    bufferedBytes: 0,
    timer: null,
    written: 0,
    dropped: 0,
    lastError: null,
    consoleHooked: false,
    inHook: false,
    flushing: false,
    originals: null
  }
}

let state: SinkState = freshState()

export interface MainLogOptions {
  /** Also write `info` lines. Default false (warn level always on). */
  verbose?: boolean
}

/**
 * Point the sink at `<provider()>/logs`. Idempotent — a second call only updates options — and
 * cheap: the directory is resolved lazily on the first flush, so calling this before app-ready
 * (when `app.getPath` may still throw) is fine.
 */
export function initMainLog(provider: (() => string) | null, opts: MainLogOptions = {}): void {
  state.dirProvider = provider
  if (typeof opts.verbose === 'boolean') state.verbose = opts.verbose
}

/** Test seam: shrink the rotation policy so a rotation test does not have to write 2 MB. The
 *  production policy is the two constants above and is not configurable on purpose. */
export function __setMainLogLimitsForTest(rotateAtBytes: number, generations: number): void {
  state.rotateAtBytes = Math.max(1, Math.floor(rotateAtBytes))
  state.generations = Math.max(1, Math.floor(generations))
}

/** Use an explicit directory (tests). Passing null returns to the provider. */
export function setMainLogDir(dir: string | null): void {
  state.dir = dir
}

export function setMainLogVerbose(on: boolean): void {
  state.verbose = on
}

function resolveDir(): string | null {
  if (state.dir) return state.dir
  if (!state.dirProvider) return null
  try {
    const base = state.dirProvider()
    return base ? join(base, MAIN_LOG_DIR) : null
  } catch {
    return null
  }
}

export function mainLogPath(): string | null {
  const dir = resolveDir()
  return dir ? join(dir, MAIN_LOG_FILE) : null
}

function generationPath(dir: string, n: number): string {
  return join(dir, MAIN_LOG_FILE.replace(/\.log$/, `.${n}.log`))
}

// ──────────────────── formatting + masking ────────────────────

const MASKS: [RegExp, string][] = [
  [/sk-[A-Za-z0-9_-]{6,}/g, 'sk-[…]'],
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [...]'],
  [/(x-duin-(?:control|exec)["']?\s*[:=]\s*["']?)[A-Za-z0-9-]{8,}/gi, '$1[...]'],
  [
    /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
    '$1[...]'
  ]
]

/** PURE. Mask key-shaped substrings. A floor under the spine's structured redaction. */
export function maskSecrets(text: string): string {
  let out = text
  for (const [re, rep] of MASKS) out = out.replace(re, rep)
  return out
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>()
  try {
    const s = JSON.stringify(value, (_k, v) => {
      if (typeof v === 'bigint') return String(v)
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return '[cycle]'
        seen.add(v as object)
      }
      return v
    })
    return typeof s === 'string' ? s : String(value)
  } catch {
    return '[unserializable]'
  }
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) {
    const head = `${arg.name}: ${arg.message}`
    const frame = (arg.stack ?? '').split('\n')[1]?.trim()
    return frame ? `${head} (${frame})` : head
  }
  if (arg === undefined) return 'undefined'
  if (arg === null || typeof arg !== 'object') return String(arg)
  const s = safeStringify(arg)
  return s.length > MAX_ARG_CHARS ? s.slice(0, MAX_ARG_CHARS) + '…' : s
}

/** PURE. One log line: ISO time, level, message. Bounded and masked. */
export function formatLine(level: MainLogLevel, args: unknown[], at: number = Date.now()): string {
  let text: string
  try {
    text = args.map(formatArg).join(' ')
  } catch {
    text = '[unformattable log arguments]'
  }
  text = maskSecrets(text.replace(/\r?\n/g, '\\n'))
  if (text.length > MAX_LINE_CHARS) text = text.slice(0, MAX_LINE_CHARS) + '…'
  return `${new Date(at).toISOString()} ${level.toUpperCase().padEnd(5)} ${text}`
}

// ──────────────────── buffer + flush + rotation ────────────────────

function scheduleFlush(): void {
  if (state.timer || state.flushing) return
  const t = setTimeout(() => {
    state.timer = null
    flushMainLog()
  }, FLUSH_MS)
  ;(t as { unref?: () => void }).unref?.()
  state.timer = t
}

function rotateIfNeeded(dir: string, pendingBytes: number): void {
  const current = join(dir, MAIN_LOG_FILE)
  let size: number
  try {
    size = existsSync(current) ? statSync(current).size : 0
  } catch {
    return
  }
  if (size === 0 || size + pendingBytes < state.rotateAtBytes) return
  try {
    const oldest = generationPath(dir, state.generations)
    if (existsSync(oldest)) unlinkSync(oldest)
    for (let n = state.generations - 1; n >= 1; n--) {
      const from = generationPath(dir, n)
      if (existsSync(from)) renameSync(from, generationPath(dir, n + 1))
    }
    renameSync(current, generationPath(dir, 1))
  } catch (e) {
    // A rotation that fails leaves the current file growing; the next flush retries. Recorded,
    // not thrown — the sink must never be the reason a warning breaks its caller.
    state.lastError = e instanceof Error ? e.message : String(e)
  }
}

/** Write everything buffered to disk now. Synchronous; safe to call from a quit handler. */
export function flushMainLog(): void {
  if (state.flushing) return
  if (state.timer) {
    clearTimeout(state.timer)
    state.timer = null
  }
  if (state.buffer.length === 0) return
  state.flushing = true
  const lines = state.buffer
  const bytes = state.bufferedBytes
  state.buffer = []
  state.bufferedBytes = 0
  try {
    const dir = resolveDir()
    if (!dir) {
      state.dropped += lines.length
      return
    }
    mkdirSync(dir, { recursive: true })
    rotateIfNeeded(dir, bytes)
    appendFileSync(join(dir, MAIN_LOG_FILE), lines.join(''), 'utf-8')
    state.written += lines.length
  } catch (e) {
    state.dropped += lines.length
    state.lastError = e instanceof Error ? e.message : String(e)
  } finally {
    state.flushing = false
  }
}

function enqueue(level: MainLogLevel, args: unknown[]): void {
  try {
    if (level === 'info' && !state.verbose) return
    const line = formatLine(level, args) + '\n'
    state.buffer.push(line)
    state.bufferedBytes += line.length
    if (state.bufferedBytes >= EARLY_FLUSH_BYTES) flushMainLog()
    else scheduleFlush()
  } catch {
    // The sink is advisory. A formatting or scheduling failure loses one line, never the caller.
  }
}

/** The explicit API. `info` is written only when verbose (the trace flag); warn/error always. */
export const log = {
  info: (...args: unknown[]): void => enqueue('info', args),
  warn: (...args: unknown[]): void => enqueue('warn', args),
  error: (...args: unknown[]): void => enqueue('error', args)
}

// ──────────────────── console mirror ────────────────────

/**
 * Mirror `console.warn` / `console.error` into the sink, always; `console.log` / `console.info`
 * at `info`, which the sink drops unless verbose (the debugTrace flag) — so a default install's
 * main.log stays warn-level, and a verbose one also carries the boot milestones (`[main] …`,
 * `[local-brain] …`, `[settings] migrated …`) that were otherwise only on stdout. Wired
 * 2026-09-03 (P0 audit C2): debug-trace.ts had promised "when verbose, main.log also takes info
 * lines" while nothing in the process produced one. The originals still run, so a terminal dev
 * session sees nothing different. Idempotent; returns the restore function.
 */
export function installConsoleMirror(): () => void {
  if (state.consoleHooked) return restoreConsole
  const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error }
  state.originals = originals
  const wrap =
    (level: MainLogLevel, orig: (...a: unknown[]) => void) =>
    (...args: unknown[]): void => {
      try {
        orig.apply(console, args)
      } catch {
        /* the original console must not be able to break the hook either */
      }
      if (state.inHook) return
      state.inHook = true
      try {
        enqueue(level, args)
      } finally {
        state.inHook = false
      }
    }
  console.log = wrap('info', originals.log as (...a: unknown[]) => void)
  console.info = wrap('info', originals.info as (...a: unknown[]) => void)
  console.warn = wrap('warn', originals.warn as (...a: unknown[]) => void)
  console.error = wrap('error', originals.error as (...a: unknown[]) => void)
  state.consoleHooked = true
  return restoreConsole
}

function restoreConsole(): void {
  if (!state.consoleHooked || !state.originals) return
  console.log = state.originals.log
  console.info = state.originals.info
  console.warn = state.originals.warn
  console.error = state.originals.error
  state.consoleHooked = false
  state.originals = null
}

// ──────────────────── readers ────────────────────

function readLines(path: string): string[] {
  try {
    if (!existsSync(path)) return []
    return readFileSync(path, 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/**
 * The last `n` lines (capped at MAX_TAIL_LINES), oldest first. Flushes the buffer first so a
 * warning written a moment ago is visible. Spans into the previous generation when the current
 * file is shorter than asked, so a tail read right after a rotation is not mysteriously empty.
 */
export function readLogTail(n: number): string[] {
  const want = Math.max(1, Math.min(MAX_TAIL_LINES, Math.floor(Number.isFinite(n) ? n : 200)))
  flushMainLog()
  const dir = resolveDir()
  if (!dir) return []
  let lines = readLines(join(dir, MAIN_LOG_FILE))
  if (lines.length < want) {
    const prev = readLines(generationPath(dir, 1))
    lines = [...prev.slice(Math.max(0, prev.length - (want - lines.length))), ...lines]
  }
  return lines.slice(Math.max(0, lines.length - want))
}

export interface MainLogStatus {
  path: string | null
  rotateAtBytes: number
  generations: number
  verbose: boolean
  consoleMirrored: boolean
  /** Lines written to disk since launch. */
  written: number
  /** Lines lost because the sink could not write (no directory yet, disk error). */
  dropped: number
  lastError: string | null
}

/** The sink's own limits, published with every tail read. */
export function mainLogStatus(): MainLogStatus {
  return {
    path: mainLogPath(),
    rotateAtBytes: state.rotateAtBytes,
    generations: state.generations,
    verbose: state.verbose,
    consoleMirrored: state.consoleHooked,
    written: state.written,
    dropped: state.dropped,
    lastError: state.lastError
  }
}

/** Test seam: restore the console and forget everything. */
export function __resetMainLogForTest(): void {
  restoreConsole()
  if (state.timer) clearTimeout(state.timer)
  state = freshState()
}
