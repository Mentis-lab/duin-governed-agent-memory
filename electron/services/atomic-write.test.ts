import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// Lets a test force writeSync to behave the way the POSIX contract allows but a regular file
// rarely does — consuming only part of the buffer — without waiting for the filesystem that
// actually does it. `null` means "pass through".
let shortWriteTo: number | null = null

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    // Normalises both writeSync overloads so the cap below applies however the payload is
    // passed — otherwise a caller that reverts to the string form silently escapes this test.
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

const { atomicWriteFileSync } = await import('./atomic-write')

const DIR = join(tmpdir(), `lamprey-atomic-test-${process.pid}-${Date.now()}`)

beforeEach(() => {
  shortWriteTo = null
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true })
  mkdirSync(DIR, { recursive: true })
})

afterAll(() => {
  if (existsSync(DIR)) rmSync(DIR, { recursive: true, force: true })
})

describe('atomicWriteFileSync', () => {
  it('writes the whole payload and leaves no temp file behind', () => {
    const target = join(DIR, 'keys.json')
    const payload = JSON.stringify({ passphrase: 'x'.repeat(200) })

    atomicWriteFileSync(target, payload)

    expect(readFileSync(target, 'utf8')).toBe(payload)
    expect(readdirSync(DIR).filter((f) => f.startsWith('.atomic-'))).toEqual([])
  })

  it('completes a short write instead of committing a truncated file', () => {
    const target = join(DIR, 'keys.json')
    const payload = JSON.stringify({ passphrase: 'y'.repeat(500) })

    // One byte lands on the first call; the rest must be driven by the loop, not dropped.
    shortWriteTo = 1
    atomicWriteFileSync(target, payload)

    expect(readFileSync(target, 'utf8')).toBe(payload)
  })

  it('does not truncate a short write over a previous good file', () => {
    const target = join(DIR, 'settings.json')
    atomicWriteFileSync(target, 'first-good-contents')

    const next = 'second-contents-'.repeat(40)
    shortWriteTo = 3
    atomicWriteFileSync(target, next)

    expect(readFileSync(target, 'utf8')).toBe(next)
  })

  it('counts bytes, not characters, for a multi-byte payload', () => {
    const target = join(DIR, 'notes.json')
    // 北澜 is 3 bytes per character in UTF-8: a character-indexed loop would stop early.
    const payload = JSON.stringify({ title: '北澜'.repeat(100) })

    shortWriteTo = 5
    atomicWriteFileSync(target, payload)

    expect(readFileSync(target, 'utf8')).toBe(payload)
  })

  it('accepts a Buffer payload unchanged', () => {
    const target = join(DIR, 'blob.bin')
    const payload = Buffer.from([0, 1, 2, 250, 251, 252])

    shortWriteTo = 2
    atomicWriteFileSync(target, payload)

    expect(readFileSync(target)).toEqual(payload)
  })
})
