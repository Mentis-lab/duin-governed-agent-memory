import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  shouldFire,
  detectFrozenLoops,
  statePath,
  historyPath,
  readLedgerHeartbeat,
  readLastEntry,
  appendEntry,
  notesLivenessMonitorEnabled,
  accumulationThreshold,
  noteAccumulationTick,
  runNotesLivenessMonitor,
  resetAccumulator,
  pendingAccumulation,
  WATCHED_LOOPS,
  type LoopHeartbeat,
  type NotesLivenessEntry,
  type WatchedLoop
} from './notes-liveness-monitor'

const HOUR = 60 * 60 * 1000

// ──────────────────── pure core: shouldFire ────────────────────

describe('shouldFire', () => {
  it('fires at or above the threshold, not below', () => {
    expect(shouldFire(9, 10)).toBe(false)
    expect(shouldFire(10, 10)).toBe(true)
    expect(shouldFire(11, 10)).toBe(true)
  })
  it('a non-positive threshold never fires (guards a misconfigured env)', () => {
    expect(shouldFire(100, 0)).toBe(false)
    expect(shouldFire(100, -5)).toBe(false)
  })
})

// ──────────────────── pure core: detectFrozenLoops ────────────────────

describe('detectFrozenLoops', () => {
  const beats = (over: Partial<LoopHeartbeat>[]): LoopHeartbeat[] =>
    over.map((o, i) => ({ loop: o.loop ?? `l${i}`, ageMs: o.ageMs ?? 0, staleMs: o.staleMs ?? HOUR }))

  it('flags a loop whose heartbeat exceeds its threshold', () => {
    const f = detectFrozenLoops(
      beats([{ loop: 'construction', ageMs: 7 * HOUR, staleMs: 6 * HOUR }]),
      true
    )
    expect(f).toEqual(['construction'])
  })

  it('a fresh loop (age within threshold) is not frozen', () => {
    const f = detectFrozenLoops(
      beats([{ loop: 'construction', ageMs: 1 * HOUR, staleMs: 6 * HOUR }]),
      true
    )
    expect(f).toEqual([])
  })

  it('a never-run loop is frozen ONLY when there is note activity', () => {
    const never = beats([{ loop: 'coherence', ageMs: undefined, staleMs: 24 * HOUR }]).map((b) => ({
      ...b,
      ageMs: null
    }))
    expect(detectFrozenLoops(never, true)).toEqual(['coherence'])
    expect(detectFrozenLoops(never, false)).toEqual([]) // idle brand-new vault: not a defect
  })

  it('exact-threshold age is NOT frozen (strictly greater trips it)', () => {
    const f = detectFrozenLoops(beats([{ loop: 'x', ageMs: 6 * HOUR, staleMs: 6 * HOUR }]), true)
    expect(f).toEqual([])
  })

  it('reports each frozen loop, preserving input order', () => {
    const f = detectFrozenLoops(
      beats([
        { loop: 'construction', ageMs: 8 * HOUR, staleMs: 6 * HOUR },
        { loop: 'coherence', ageMs: 1 * HOUR, staleMs: 24 * HOUR },
        { loop: 'self-improve', ageMs: 30 * HOUR, staleMs: 24 * HOUR }
      ]),
      true
    )
    expect(f).toEqual(['construction', 'self-improve'])
  })
})

// ──────────────────── watched-loop seed sanity ────────────────────

describe('WATCHED_LOOPS', () => {
  it('watches construction + the three metabolism benchmarks, all with .jsonl heartbeats', () => {
    const loops = WATCHED_LOOPS.map((l) => l.loop)
    expect(loops).toEqual(['construction', 'coherence', 'compounding', 'self-improve'])
    for (const l of WATCHED_LOOPS) {
      expect(l.ledger.endsWith('.jsonl')).toBe(true)
      expect(l.staleMs).toBeGreaterThan(0)
    }
  })
})

// ──────────────────── path helpers ────────────────────

describe('statePath / historyPath', () => {
  it('land under .duin/_state; null without a vault', () => {
    expect(statePath('/v', 'x.jsonl')).toBe(join('/v', '.duin', '_state', 'x.jsonl'))
    expect(historyPath('/v')).toBe(join('/v', '.duin', '_state', 'notes-liveness-history.jsonl'))
    expect(statePath(null, 'x.jsonl')).toBeNull()
    expect(historyPath('')).toBeNull()
  })
})

// ──────────────────── ledger heartbeat read ────────────────────

describe('readLedgerHeartbeat', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'nlm-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  const writeLedger = (file: string, lines: string[]): string => {
    const p = statePath(vault, file)!
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(p, lines.join('\n') + '\n', 'utf-8')
    return p
  }

  it('returns the newest parseable ts as epoch ms', () => {
    const p = writeLedger('h.jsonl', [
      JSON.stringify({ ts: '2026-07-01T00:00:00.000Z' }),
      JSON.stringify({ ts: '2026-07-10T12:00:00.000Z' })
    ])
    expect(readLedgerHeartbeat(p)).toBe(Date.parse('2026-07-10T12:00:00.000Z'))
  })

  it('skips a trailing corrupt line and uses the last GOOD ts', () => {
    const p = writeLedger('h.jsonl', [JSON.stringify({ ts: '2026-07-05T00:00:00.000Z' }), '{ broken'])
    expect(readLedgerHeartbeat(p)).toBe(Date.parse('2026-07-05T00:00:00.000Z'))
  })

  it('falls back to file mtime when no line carries a ts', () => {
    const p = writeLedger('h.jsonl', [JSON.stringify({ note: 'no ts here' })])
    const hb = readLedgerHeartbeat(p)
    expect(hb).not.toBeNull()
    expect(Math.abs((hb as number) - Date.now())).toBeLessThan(60_000)
  })

  it('null for an absent ledger', () => {
    expect(readLedgerHeartbeat(statePath(vault, 'nope.jsonl'))).toBeNull()
    expect(readLedgerHeartbeat(null)).toBeNull()
  })
})

// ──────────────────── history I/O ────────────────────

describe('notes-liveness history I/O', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'nlm-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('appendEntry writes a JSONL line readLastEntry round-trips (newest wins)', () => {
    const a: NotesLivenessEntry = { ts: 't1', accumulated: 10, loopAgeMin: { construction: 5 }, frozen: [] }
    const b: NotesLivenessEntry = {
      ts: 't2',
      accumulated: 12,
      loopAgeMin: { construction: 999 },
      frozen: ['construction']
    }
    appendEntry(vault, a)
    appendEntry(vault, b)
    expect(existsSync(historyPath(vault)!)).toBe(true)
    expect(readLastEntry(vault)).toEqual(b)
  })

  it('readLastEntry is null with no ledger', () => {
    expect(readLastEntry(vault)).toBeNull()
  })
})

// ──────────────────── flag gate + threshold ────────────────────

describe('flag gate + threshold', () => {
  const OLD_FLAG = process.env.DUIN_NOTES_LIVENESS_MONITOR
  const OLD_THRESH = process.env.DUIN_NOTES_LIVENESS_THRESHOLD
  afterEach(() => {
    if (OLD_FLAG === undefined) delete process.env.DUIN_NOTES_LIVENESS_MONITOR
    else process.env.DUIN_NOTES_LIVENESS_MONITOR = OLD_FLAG
    if (OLD_THRESH === undefined) delete process.env.DUIN_NOTES_LIVENESS_THRESHOLD
    else process.env.DUIN_NOTES_LIVENESS_THRESHOLD = OLD_THRESH
  })

  it('default-ON; opt-out with =0', () => {
    delete process.env.DUIN_NOTES_LIVENESS_MONITOR
    expect(notesLivenessMonitorEnabled()).toBe(true)
    process.env.DUIN_NOTES_LIVENESS_MONITOR = '0'
    expect(notesLivenessMonitorEnabled()).toBe(false)
  })

  it('threshold defaults to 10; a valid positive env overrides; garbage falls back', () => {
    delete process.env.DUIN_NOTES_LIVENESS_THRESHOLD
    expect(accumulationThreshold()).toBe(10)
    process.env.DUIN_NOTES_LIVENESS_THRESHOLD = '25'
    expect(accumulationThreshold()).toBe(25)
    process.env.DUIN_NOTES_LIVENESS_THRESHOLD = 'nope'
    expect(accumulationThreshold()).toBe(10)
    process.env.DUIN_NOTES_LIVENESS_THRESHOLD = '-3'
    expect(accumulationThreshold()).toBe(10)
  })
})

// ──────────────────── accumulator + wrapper ────────────────────

describe('noteAccumulationTick', () => {
  const OLD_FLAG = process.env.DUIN_NOTES_LIVENESS_MONITOR
  const OLD_THRESH = process.env.DUIN_NOTES_LIVENESS_THRESHOLD
  let vault: string

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'nlm-'))
    resetAccumulator()
    delete process.env.DUIN_NOTES_LIVENESS_MONITOR
    process.env.DUIN_NOTES_LIVENESS_THRESHOLD = '10'
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    resetAccumulator()
    if (OLD_FLAG === undefined) delete process.env.DUIN_NOTES_LIVENESS_MONITOR
    else process.env.DUIN_NOTES_LIVENESS_MONITOR = OLD_FLAG
    if (OLD_THRESH === undefined) delete process.env.DUIN_NOTES_LIVENESS_THRESHOLD
    else process.env.DUIN_NOTES_LIVENESS_THRESHOLD = OLD_THRESH
    vi.restoreAllMocks()
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('accumulates below threshold without firing (no ledger written)', () => {
    noteAccumulationTick(vault, 3)
    noteAccumulationTick(vault, 4)
    expect(pendingAccumulation()).toBe(7)
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('crossing the threshold fires a check, resets the accumulator, and writes a heartbeat', async () => {
    noteAccumulationTick(vault, 6)
    noteAccumulationTick(vault, 6) // 12 ≥ 10 → fires
    // fire is fire-and-forget; give the microtask queue a beat to flush the write
    await new Promise((r) => setTimeout(r, 20))
    expect(pendingAccumulation()).toBe(0)
    const last = readLastEntry(vault)
    expect(last?.accumulated).toBe(12)
    // brand-new temp vault: no loop ledgers exist → every watched loop reads "never ran",
    // and with real note activity that is exactly the frozen-loop signal we want surfaced.
    expect(last?.frozen).toEqual(WATCHED_LOOPS.map((l) => l.loop))
  })

  it('flag-OFF: does not even accumulate', () => {
    process.env.DUIN_NOTES_LIVENESS_MONITOR = '0'
    noteAccumulationTick(vault, 100)
    expect(pendingAccumulation()).toBe(0)
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('ignores non-positive / non-finite counts', () => {
    noteAccumulationTick(vault, 0)
    noteAccumulationTick(vault, -5)
    noteAccumulationTick(vault, NaN)
    expect(pendingAccumulation()).toBe(0)
  })
})

// ──────────────────── the check wrapper (injected heartbeats, pinned now) ────────────────────

describe('runNotesLivenessMonitor', () => {
  let vault: string
  const NOW = Date.parse('2026-07-16T00:00:00.000Z')

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'nlm-'))
    delete process.env.DUIN_NOTES_LIVENESS_MONITOR
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('all-fresh heartbeats ⇒ no frozen loops, records the ages it saw', async () => {
    const fresh: (v: string | null, loop: WatchedLoop) => number = () => NOW - 30 * 60 * 1000 // 30m old
    await runNotesLivenessMonitor(vault, 10, fresh, NOW)
    const last = readLastEntry(vault)
    expect(last?.frozen).toEqual([])
    expect(last?.loopAgeMin.construction).toBe(30)
  })

  it('a stale construction heartbeat is flagged frozen with a real age', async () => {
    const read = (_v: string | null, loop: WatchedLoop): number =>
      loop.loop === 'construction' ? NOW - 8 * HOUR : NOW - 30 * 60 * 1000
    await runNotesLivenessMonitor(vault, 10, read, NOW)
    const last = readLastEntry(vault)
    expect(last?.frozen).toEqual(['construction'])
    expect(last?.loopAgeMin.construction).toBe(480)
  })

  it('flag-OFF ⇒ no-op (no ledger written)', async () => {
    process.env.DUIN_NOTES_LIVENESS_MONITOR = '0'
    await runNotesLivenessMonitor(vault, 10, () => NOW, NOW)
    expect(existsSync(historyPath(vault)!)).toBe(false)
    delete process.env.DUIN_NOTES_LIVENESS_MONITOR
  })

  it('SWALLOWS a heartbeat-read throw (ingest-safe): resolves, writes nothing', async () => {
    await expect(
      runNotesLivenessMonitor(
        vault,
        10,
        () => {
          throw new Error('boom')
        },
        NOW
      )
    ).resolves.toBeUndefined()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })
})
