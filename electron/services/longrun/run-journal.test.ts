import { describe, it, expect } from 'vitest'
import {
  appendEntry,
  readEntries,
  lastEntry,
  type JournalEntry,
  type JournalFs
} from './run-journal'

// In-memory JournalFs fake. Mirrors the O_APPEND semantics of the real seam:
// appendLine concatenates line + "\n"; readLines splits on "\n" dropping a
// trailing empty; exists tracks whether any write has happened.
function makeFakeFs(): JournalFs & { raw(path: string): string; corrupt(path: string, line: string): void } {
  const store = new Map<string, string>()
  return {
    appendLine(path, line) {
      store.set(path, (store.get(path) ?? '') + line + '\n')
    },
    readLines(path) {
      const c = store.get(path)
      if (c == null) return []
      const parts = c.split('\n')
      if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop()
      return parts
    },
    exists(path) {
      return store.has(path)
    },
    raw(path) {
      return store.get(path) ?? ''
    },
    // Append a raw (possibly malformed) line — simulates a torn/partial write.
    corrupt(path, line) {
      store.set(path, (store.get(path) ?? '') + line + '\n')
    }
  }
}

const P = '/loop/.duin/run-journal.jsonl'

function base(
  over: Partial<Omit<JournalEntry, 'seq' | 'ts'>> = {}
): Omit<JournalEntry, 'seq' | 'ts'> {
  return {
    loopId: 'loop-1',
    itemId: 'item-1',
    kind: 'commit',
    gitSha: null,
    usage: null,
    cost: null,
    note: null,
    ...over
  }
}

describe('appendEntry — the durable-write primitive (L1)', () => {
  it('assigns seq 0 and the clock ts on the first append to a fresh file', () => {
    const fs = makeFakeFs()
    const e = appendEntry(P, base({ kind: 'load' }), fs, () => 1000)
    expect(e.seq).toBe(0)
    expect(e.ts).toBe(1000)
    expect(e.kind).toBe('load')
  })

  it('assigns monotonically increasing seq continued from the last entry', () => {
    const fs = makeFakeFs()
    const a = appendEntry(P, base(), fs, () => 1)
    const b = appendEntry(P, base(), fs, () => 2)
    const c = appendEntry(P, base(), fs, () => 3)
    expect([a.seq, b.seq, c.seq]).toEqual([0, 1, 2])
  })

  it('continues seq from the last WELL-FORMED entry even if a torn line follows', () => {
    const fs = makeFakeFs()
    appendEntry(P, base(), fs, () => 1) // seq 0
    appendEntry(P, base(), fs, () => 2) // seq 1
    fs.corrupt(P, '{"seq":2,"ts":3,"loopId":"loop-1"') // torn trailing write
    const next = appendEntry(P, base(), fs, () => 4)
    // last well-formed seq was 1 → next is 2, and it lands AFTER the torn line.
    expect(next.seq).toBe(2)
    expect(readEntries(P, fs).map((e) => e.seq)).toEqual([0, 1, 2])
  })

  it('writes exactly one line per entry (one JSON object + newline)', () => {
    const fs = makeFakeFs()
    appendEntry(P, base(), fs, () => 1)
    appendEntry(P, base(), fs, () => 2)
    const lines = fs.raw(P).split('\n').filter((l) => l.length > 0)
    expect(lines).toHaveLength(2)
    expect(() => JSON.parse(lines[0])).not.toThrow()
  })

  it('round-trips a full entry with usage + cost + gitSha', () => {
    const fs = makeFakeFs()
    const written = appendEntry(
      P,
      base({
        kind: 'commit',
        gitSha: 'abc123',
        cost: 0.42,
        usage: { model: 'm', inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 },
        note: 'did the thing'
      }),
      fs,
      () => 99
    )
    const [read] = readEntries(P, fs)
    expect(read).toEqual(written)
    expect(read.usage).toEqual({ model: 'm', inputTokens: 10, outputTokens: 20, cachedInputTokens: 5 })
  })
})

describe('readEntries', () => {
  it('returns [] for a missing file', () => {
    const fs = makeFakeFs()
    expect(readEntries(P, fs)).toEqual([])
  })

  it('parses all entries in file order', () => {
    const fs = makeFakeFs()
    appendEntry(P, base({ kind: 'load' }), fs, () => 1)
    appendEntry(P, base({ kind: 'do' }), fs, () => 2)
    appendEntry(P, base({ kind: 'commit' }), fs, () => 3)
    expect(readEntries(P, fs).map((e) => e.kind)).toEqual(['load', 'do', 'commit'])
  })

  it('skips malformed / partial lines rather than throwing (crash-torn tail)', () => {
    const fs = makeFakeFs()
    appendEntry(P, base(), fs, () => 1)
    fs.corrupt(P, '{ this is not json')
    fs.corrupt(P, '') // blank line
    appendEntry(P, base(), fs, () => 2)
    const entries = readEntries(P, fs)
    expect(entries).toHaveLength(2)
    expect(entries.map((e) => e.seq)).toEqual([0, 1])
  })

  it('skips a JSON object missing required fields', () => {
    const fs = makeFakeFs()
    fs.corrupt(P, JSON.stringify({ seq: 5 })) // no ts/loopId/kind
    expect(readEntries(P, fs)).toEqual([])
  })
})

describe('lastEntry', () => {
  it('returns null for a missing file', () => {
    const fs = makeFakeFs()
    expect(lastEntry(P, fs)).toBeNull()
  })

  it('returns the final well-formed entry', () => {
    const fs = makeFakeFs()
    appendEntry(P, base({ kind: 'load' }), fs, () => 1)
    appendEntry(P, base({ kind: 'commit', gitSha: 'zzz' }), fs, () => 2)
    const last = lastEntry(P, fs)
    expect(last?.kind).toBe('commit')
    expect(last?.gitSha).toBe('zzz')
    expect(last?.seq).toBe(1)
  })

  it('skips a torn trailing line and returns the previous good entry', () => {
    const fs = makeFakeFs()
    appendEntry(P, base(), fs, () => 1)
    appendEntry(P, base({ gitSha: 'good' }), fs, () => 2)
    fs.corrupt(P, '{"seq":2,"ts":') // half-flushed record
    const last = lastEntry(P, fs)
    expect(last?.gitSha).toBe('good')
    expect(last?.seq).toBe(1)
  })
})
