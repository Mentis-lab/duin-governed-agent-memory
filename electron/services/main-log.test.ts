import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  __resetMainLogForTest,
  initMainLog,
  __setMainLogLimitsForTest,
  setMainLogDir,
  setMainLogVerbose,
  log,
  flushMainLog,
  readLogTail,
  installConsoleMirror,
  mainLogStatus,
  formatLine,
  maskSecrets,
  MAIN_LOG_FILE,
  MAX_TAIL_LINES
} from './main-log'

// The always-on main-process log sink (cohesion P0, lane C). The live instance had none
// (2026-09-02 L7 F3); these pin the three properties that make one safe to leave on: it
// rotates and stays bounded, it never throws, and it never re-enters itself through the
// console hook.

let dir: string

beforeEach(() => {
  __resetMainLogForTest()
  dir = mkdtempSync(join(tmpdir(), 'duin-main-log-'))
  setMainLogDir(dir)
})

afterEach(() => {
  __resetMainLogForTest()
  rmSync(dir, { recursive: true, force: true })
})

function lines(name = MAIN_LOG_FILE): string[] {
  return readFileSync(join(dir, name), 'utf-8').split('\n').filter(Boolean)
}

describe('formatLine', () => {
  it('stamps ISO time + padded level and flattens newlines, objects and errors', () => {
    const at = Date.UTC(2026, 8, 2, 3, 4, 5)
    expect(formatLine('warn', ['[main-stall] 812ms', { scope: 'unattributed' }], at)).toBe(
      '2026-09-02T03:04:05.000Z WARN  [main-stall] 812ms {"scope":"unattributed"}'
    )
    expect(formatLine('error', ['a\nb'], at)).toContain('a\\nb')
    expect(formatLine('info', [new Error('bad thing')], at)).toContain('Error: bad thing')
  })

  it('bounds one line and survives a cyclic argument', () => {
    const cyc: Record<string, unknown> = {}
    cyc.self = cyc
    expect(formatLine('warn', [cyc])).toContain('[cycle]')
    expect(formatLine('warn', ['x'.repeat(10_000)]).length).toBeLessThan(4_200)
  })
})

describe('maskSecrets — the floor under the spine redaction', () => {
  it('masks key-shaped substrings and leaves ordinary text alone', () => {
    expect(maskSecrets('key sk-abcdefghijklmnop failed')).toBe('key sk-[…] failed')
    expect(maskSecrets('Authorization: Bearer abcdefghijklmnopqrstuvwxyz')).toBe('Authorization: Bearer [...]')
    expect(maskSecrets('apiKey=sk-live-123456789')).toBe('apiKey=[...]')
    expect(maskSecrets('x-duin-control: 3f2a9c1b-0000-4000-8000-000000000000')).toBe('x-duin-control: [...]')
    expect(maskSecrets('[main-stall] 812ms — unattributed')).toBe('[main-stall] 812ms — unattributed')
  })
})

describe('sink', () => {
  it('writes warn and error; info only when verbose', () => {
    log.info('quiet')
    log.warn('loud')
    log.error('louder')
    flushMainLog()
    expect(lines().map((l) => l.slice(25))).toEqual(['WARN  loud', 'ERROR louder'])
    setMainLogVerbose(true)
    log.info('now heard')
    flushMainLog()
    expect(lines().at(-1)).toContain('INFO  now heard')
    expect(mainLogStatus()).toMatchObject({ written: 3, dropped: 0, path: join(dir, MAIN_LOG_FILE) })
  })

  it('rotates at maxBytes and keeps at most `keep` generations, each bounded', () => {
    __setMainLogLimitsForTest(600, 3)
    for (let i = 0; i < 120; i++) {
      log.warn(`line ${String(i).padStart(3, '0')} ${'x'.repeat(60)}`)
      flushMainLog()
    }
    const files = readdirSync(dir).filter((f) => f.startsWith('main')).sort()
    expect(files).toEqual(['main.1.log', 'main.2.log', 'main.3.log', 'main.log'])
    for (const f of files) expect(statSync(join(dir, f)).size).toBeLessThanOrEqual(600 + 120)
    // The newest line is in the current file; the oldest surviving generation is main.3.log.
    expect(lines().at(-1)).toContain('line 119')
    expect(Number(lines('main.3.log')[0].match(/line (\d+)/)?.[1])).toBeLessThan(
      Number(lines('main.1.log')[0].match(/line (\d+)/)?.[1])
    )
  })

  it('readLogTail returns the last n lines oldest-first and spans into the previous generation', () => {
    __setMainLogLimitsForTest(300, 2)
    for (let i = 0; i < 12; i++) {
      log.warn(`row ${i} ${'y'.repeat(40)}`)
      flushMainLog()
    }
    const tail = readLogTail(3)
    expect(tail).toHaveLength(3)
    expect(tail[2]).toContain('row 11')
    expect(tail[0]).toContain('row 9')
    // More than the current file holds → the previous generation fills in, still ordered.
    const wide = readLogTail(10)
    const nums = wide.map((l) => Number(l.match(/row (\d+)/)?.[1]))
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
    expect(nums.at(-1)).toBe(11)
    expect(readLogTail(1_000_000).length).toBeLessThanOrEqual(MAX_TAIL_LINES)
  })

  it('never throws when the directory is unwritable — the burst is dropped and counted', () => {
    const notADir = join(dir, 'file-not-dir')
    writeFileSync(notADir, 'x')
    setMainLogDir(notADir)
    log.warn('boom')
    expect(() => flushMainLog()).not.toThrow()
    expect(mainLogStatus().dropped).toBe(1)
    expect(mainLogStatus().lastError).toBeTruthy()
    expect(() => readLogTail(5)).not.toThrow()
  })

  it('never throws when the userData provider throws (before app-ready)', () => {
    setMainLogDir(null)
    initMainLog(() => {
      throw new Error('app not ready')
    })
    log.error('early')
    expect(() => flushMainLog()).not.toThrow()
    expect(mainLogStatus()).toMatchObject({ dropped: 1, path: null })
    expect(readLogTail(5)).toEqual([])
  })

  it('a buffered line is flushed on the timer without an explicit flush', async () => {
    log.warn('timer')
    await new Promise((r) => setTimeout(r, 400))
    expect(lines()[0]).toContain('WARN  timer')
  })
})

describe('console mirror', () => {
  it('mirrors console.warn / console.error into the file, masks, and restores cleanly', () => {
    const restore = installConsoleMirror()
    console.warn('[main-stall] 812ms — unattributed')
    console.error('provider rejected sk-abcdefghijklmnop', new Error('401'))
    flushMainLog()
    const out = lines()
    expect(out[0]).toContain('WARN  [main-stall] 812ms — unattributed')
    expect(out[1]).toContain('ERROR provider rejected sk-[…] Error: 401')
    expect(mainLogStatus().consoleMirrored).toBe(true)
    restore()
    console.warn('after restore')
    flushMainLog()
    expect(lines()).toHaveLength(2)
    expect(mainLogStatus().consoleMirrored).toBe(false)
  })

  it('is idempotent and does not re-enter itself when the sink itself errors', () => {
    installConsoleMirror()
    installConsoleMirror()
    const notADir = join(dir, 'file-not-dir')
    writeFileSync(notADir, 'x')
    setMainLogDir(notADir)
    console.warn('one')
    expect(() => flushMainLog()).not.toThrow()
    expect(mainLogStatus().dropped).toBe(1)
    setMainLogDir(dir)
    console.warn('two')
    flushMainLog()
    expect(lines()).toHaveLength(1)
    expect(lines()[0]).toContain('two')
  })
})

// ── console.log / console.info at info level (P0 audit C2, 2026-09-03) ──
// debug-trace.ts promised "when verbose, main.log also takes info lines"; nothing produced one.
// The mirror now takes console.log/info as `info`, which the sink drops unless verbose — a default
// install's main.log stays warn-level, a verbose one carries the boot milestones.
describe('console mirror — info lines', () => {
  it('console.log / console.info reach main.log only when verbose; restore puts them back', () => {
    const origLog = console.log
    const origInfo = console.info
    const restore = installConsoleMirror()
    console.log('boot milestone quiet')
    console.warn('a warning to make the file exist')
    flushMainLog()
    const tail = () => readFileSync(join(dir, MAIN_LOG_FILE), 'utf-8').split('\n').filter(Boolean)
    expect(tail().some((l) => l.includes('boot milestone quiet'))).toBe(false)
    setMainLogVerbose(true)
    console.log('[main] boot milestone heard')
    console.info('info heard')
    flushMainLog()
    expect(tail().at(-2)).toContain('INFO  [main] boot milestone heard')
    expect(tail().at(-1)).toContain('INFO  info heard')
    restore()
    expect(console.log).toBe(origLog)
    expect(console.info).toBe(origInfo)
  })
})
