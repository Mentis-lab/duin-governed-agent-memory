import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Lets a test force writeSync to behave the way the POSIX contract allows but a regular file
// rarely does — consuming only part of the buffer — without waiting for a filesystem that
// actually does it. `null` means "pass through". Mirrors ../atomic-write.test.ts's harness,
// which guards the identical short-write hazard for keys.json.
let shortWriteTo: number | null = null

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    writeSync: (fd: number, data: Buffer | string, offset?: number, length?: number): number => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8')
      const off = typeof offset === 'number' ? offset : 0
      const len = typeof length === 'number' ? length : buf.length - off
      if (shortWriteTo !== null) {
        const capped = Math.min(len, shortWriteTo)
        shortWriteTo = null
        return actual.writeSync(fd, buf, off, capped)
      }
      return actual.writeSync(fd, buf, off, len)
    }
  }
})

const { atomicWriteDurable, durableAppend } = await import('./durable-write')

describe('durable-write', () => {
  let dir: string
  beforeEach(() => {
    shortWriteTo = null
    dir = mkdtempSync(join(tmpdir(), 'duin-dw-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('atomicWriteDurable writes content and leaves no tmp file behind', () => {
    const p = join(dir, 'x.jsonl')
    atomicWriteDurable(p, 'line1\nline2\n')
    expect(readFileSync(p, 'utf-8')).toBe('line1\nline2\n')
    expect(readdirSync(dir)).toEqual(['x.jsonl']) // tmp fsync'd + renamed away, nothing torn/left
  })

  it('atomicWriteDurable overwrites an existing file atomically', () => {
    const p = join(dir, 'x.jsonl')
    writeFileSync(p, 'old content here')
    atomicWriteDurable(p, 'new')
    expect(readFileSync(p, 'utf-8')).toBe('new')
    expect(readdirSync(dir)).toEqual(['x.jsonl'])
  })

  it('durableAppend concatenates without truncating', () => {
    const p = join(dir, 'ledger.jsonl')
    durableAppend(p, '{"id":"a"}\n')
    durableAppend(p, '{"id":"b"}\n')
    expect(readFileSync(p, 'utf-8')).toBe('{"id":"a"}\n{"id":"b"}\n')
  })

  it('atomicWriteDurable drains a short writeSync instead of fsync-ing a truncated tmp file', () => {
    const p = join(dir, 'config.json')
    const payload = JSON.stringify({ tuned: 'z'.repeat(500) })

    // Only 1 byte lands on the first writeSync call; the rest must be driven by a loop.
    // Before the fix, the single unchecked writeSync(fd, text) call would fsync + rename
    // whatever it actually wrote — here a 1-byte tmp file — over the real target, silently
    // discarding the rest of the payload with no error anywhere in the call chain.
    shortWriteTo = 1
    atomicWriteDurable(p, payload)

    expect(readFileSync(p, 'utf-8')).toBe(payload)
  })

  it('durableAppend drains a short writeSync instead of committing a torn line', () => {
    const p = join(dir, 'ledger.jsonl')
    durableAppend(p, '{"id":"a"}\n')

    const line = `{"id":"b","note":"${'x'.repeat(200)}"}\n`
    shortWriteTo = 3
    durableAppend(p, line)

    expect(readFileSync(p, 'utf-8')).toBe(`{"id":"a"}\n${line}`)
  })
})
