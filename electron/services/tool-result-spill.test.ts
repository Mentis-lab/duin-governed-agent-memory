import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  formatSpillPreview,
  maybeSpillToolResult,
  readSpilledResult,
  gcSpillDir,
  capToolResultChars,
  maxToolResultChars,
  DEFAULT_SPILL_THRESHOLD,
  DEFAULT_MAX_TOOL_RESULT_CHARS
} from './tool-result-spill'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hy3-spill-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('formatSpillPreview (pure)', () => {
  it('keeps head + tail and names the ref; shorter than the original', () => {
    const full = 'A'.repeat(5000) + 'ZZZ' + 'B'.repeat(5000)
    const preview = formatSpillPreview(full, 'ref123')
    expect(preview).toContain('ref123')
    expect(preview).toContain('read_tool_result')
    expect(preview).toContain('elided')
    expect(preview.length).toBeLessThan(full.length)
    expect(preview.startsWith('A')).toBe(true) // head preserved
    expect(preview.endsWith('B'.repeat(10) /* tail tail */)).toBe(true)
  })
})

describe('maybeSpillToolResult', () => {
  it('passes small results through untouched', () => {
    const out = maybeSpillToolResult('small output', { dir })
    expect(out.spilled).toBe(false)
    expect(out.result).toBe('small output')
    expect(out.ref).toBeUndefined()
  })

  it('spills large results and returns a preview + ref', () => {
    const full = 'x'.repeat(DEFAULT_SPILL_THRESHOLD + 1000)
    const out = maybeSpillToolResult(full, { dir })
    expect(out.spilled).toBe(true)
    expect(out.ref).toBeTruthy()
    expect(out.chars).toBe(full.length)
    expect(out.result.length).toBeLessThan(full.length)
  })

  it('threshold <= 0 disables spilling', () => {
    const full = 'x'.repeat(50_000)
    expect(maybeSpillToolResult(full, { dir, threshold: 0 }).spilled).toBe(false)
  })

  it('round-trips: a spilled result is fully readable via readSpilledResult', () => {
    const full = Array.from({ length: 20_000 }, (_, i) => `line-${i}`).join('\n')
    // This payload (~208KB) exceeds the default MAX_TOOL_RESULT_CHARS; opt out
    // of the Phase-4 cap here so the round-trip fidelity assertion still holds.
    const out = maybeSpillToolResult(full, { dir, maxChars: 0 })
    expect(out.spilled).toBe(true)
    const back = JSON.parse(readSpilledResult(out.ref!, 0, full.length, dir))
    expect(back.content).toBe(full)
    expect(back.totalChars).toBe(full.length)
  })

  it('readSpilledResult pages a sub-range', () => {
    const full = 'abcdefghij'.repeat(2000)
    const out = maybeSpillToolResult(full, { dir })
    const back = JSON.parse(readSpilledResult(out.ref!, 5, 15, dir))
    expect(back.content).toBe(full.slice(5, 15))
    expect(back.start).toBe(5)
    expect(back.end).toBe(15)
  })
})

// R5 (Phase-4) — hard char cap applied BEFORE persistence so an oversized
// MCP/subagent result can't throw out of the store and orphan the turn.
describe('capToolResultChars (pure)', () => {
  afterEach(() => {
    delete process.env.DUIN_MAX_TOOL_RESULT_CHARS
    delete process.env.MAX_TOOL_RESULT_CHARS
  })

  it('returns short results unchanged', () => {
    expect(capToolResultChars('hello', 100)).toBe('hello')
  })

  it('truncates so the RESULT stays within the cap and appends a naming marker', () => {
    const full = 'x'.repeat(5000)
    const out = capToolResultChars(full, 1000)
    expect(out.length).toBeLessThanOrEqual(1000) // result is a true upper bound
    expect(out.startsWith('x'.repeat(500))).toBe(true) // head preserved
    expect(out).toContain('truncated')
    expect(out).toContain('MAX_TOOL_RESULT_CHARS=1000')
  })

  it('is idempotent on an already-capped string', () => {
    const full = 'y'.repeat(5000)
    const once = capToolResultChars(full, 1000)
    const twice = capToolResultChars(once, 1000)
    expect(twice).toBe(once)
  })

  it('max<=0 disables the cap', () => {
    const full = 'z'.repeat(10_000)
    expect(capToolResultChars(full, 0)).toBe(full)
    expect(capToolResultChars(full, -1)).toBe(full)
  })

  it('maxToolResultChars reads DUIN_ env first, then the plain name, then default', () => {
    expect(maxToolResultChars()).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS)
    process.env.MAX_TOOL_RESULT_CHARS = '1234'
    expect(maxToolResultChars()).toBe(1234)
    process.env.DUIN_MAX_TOOL_RESULT_CHARS = '5678'
    expect(maxToolResultChars()).toBe(5678) // DUIN_ prefix wins
  })
})

describe('maybeSpillToolResult — cap + guarded write (Phase-4)', () => {
  it('caps an over-cap result before spilling to disk', () => {
    const full = 'q'.repeat(50_000)
    const out = maybeSpillToolResult(full, { dir, maxChars: 10_000 })
    expect(out.spilled).toBe(true)
    // The on-disk copy is capped, so read-back never exceeds the cap + marker.
    const back = JSON.parse(readSpilledResult(out.ref!, 0, 1_000_000, dir))
    expect(back.totalChars).toBeLessThanOrEqual(10_000 + 200) // cap + marker slack
    expect(back.content).toContain('truncated')
  })

  it('a failed spill write does not throw — falls back to the capped inline result', () => {
    const full = 'w'.repeat(DEFAULT_SPILL_THRESHOLD + 5000)
    // Point at a path that cannot be written (a file used as a directory).
    const notADir = join(dir, 'blocker')
    writeFileSync(notADir, 'i am a file', 'utf8')
    const out = maybeSpillToolResult(full, { dir: join(notADir, 'nested'), maxChars: 20_000 })
    expect(out.spilled).toBe(false)
    expect(out.result.length).toBeLessThanOrEqual(20_000 + 200)
  })
})

describe('readSpilledResult safety', () => {
  it('rejects traversal-shaped refs', () => {
    expect(JSON.parse(readSpilledResult('../etc/passwd', 0, 10, dir)).error).toBe('invalid ref')
    expect(JSON.parse(readSpilledResult('a/b', 0, 10, dir)).error).toBe('invalid ref')
  })

  it('reports a missing ref cleanly', () => {
    const r = JSON.parse(readSpilledResult('deadbeef-0000', 0, 10, dir))
    expect(r.error).toContain('not found')
  })
})

// SP-6 (Sweet Spot Phase, 2026-06-10) — spill GC (D3). HY3 had zero deletion
// call sites; gcSpillDir ages out 7-day-old files and trims the directory
// oldest-first to the size cap.
describe('SP-6 gcSpillDir', () => {
  const DAY = 24 * 60 * 60 * 1000

  function writeSpill(name: string, content: string, ageMs: number, now: number): string {
    const path = join(dir, `${name}.txt`)
    writeFileSync(path, content, 'utf8')
    const mtime = new Date(now - ageMs)
    utimesSync(path, mtime, mtime)
    return path
  }

  it('deletes files older than maxAgeMs, keeps younger ones', () => {
    const now = Date.now()
    const old = writeSpill('old', 'stale', 8 * DAY, now)
    const fresh = writeSpill('fresh', 'recent', 1 * DAY, now)
    const out = gcSpillDir({ dir, now })
    expect(out.scanned).toBe(2)
    expect(out.deletedByAge).toBe(1)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it('trims oldest-first to the size cap after the age sweep', () => {
    const now = Date.now()
    const oldest = writeSpill('a', 'x'.repeat(1000), 3 * DAY, now)
    const middle = writeSpill('b', 'x'.repeat(1000), 2 * DAY, now)
    const newest = writeSpill('c', 'x'.repeat(1000), 1 * DAY, now)
    // Cap fits two files: the oldest must go, in mtime order.
    const out = gcSpillDir({ dir, now, maxTotalBytes: 2200 })
    expect(out.deletedByAge).toBe(0)
    expect(out.deletedBySize).toBe(1)
    expect(existsSync(oldest)).toBe(false)
    expect(existsSync(middle)).toBe(true)
    expect(existsSync(newest)).toBe(true)
    expect(out.remainingBytes).toBeLessThanOrEqual(2200)
  })

  it('a GCd ref resolves to the standard expired-result reply', () => {
    const now = Date.now()
    const full = 'y'.repeat(DEFAULT_SPILL_THRESHOLD + 500)
    const spilled = maybeSpillToolResult(full, { dir })
    expect(spilled.spilled).toBe(true)
    gcSpillDir({ dir, now: now + 30 * DAY })
    const readBack = JSON.parse(readSpilledResult(spilled.ref!, 0, 100, dir))
    expect(readBack.error).toContain('not found')
  })

  it('missing directory is a clean no-op', () => {
    const out = gcSpillDir({ dir: join(dir, 'does-not-exist'), now: Date.now() })
    expect(out).toEqual({ scanned: 0, deletedByAge: 0, deletedBySize: 0, remainingBytes: 0 })
  })

  it('ignores non-.txt entries', () => {
    const now = Date.now()
    writeFileSync(join(dir, 'README.md'), 'not a spill file', 'utf8')
    const out = gcSpillDir({ dir, now })
    expect(out.scanned).toBe(0)
    expect(existsSync(join(dir, 'README.md'))).toBe(true)
  })
})
