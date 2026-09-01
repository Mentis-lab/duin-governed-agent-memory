import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  startSeamAutoReconcile,
  stopSeamAutoReconcile,
  scheduleSeamReconcile,
  runSeamReconcileNow,
  seamReconcileStatus,
  __resetSeamReconcileForTests,
  type SeamReconcileDeps
} from './seam-reconcile'
import type { OperatorFact } from './operator-model'

function fact(over: Partial<OperatorFact> = {}): OperatorFact {
  return {
    id: 'f_auto1',
    fact: 'TQ prefers conclusion-first replies.',
    kind: 'preference',
    status: 'promoted',
    ts: 1_700_000_000_000,
    source: 'operator',
    ...over
  } as OperatorFact
}

describe('seam-reconcile (auto-fire hardening)', () => {
  let tmp: string
  let deps: SeamReconcileDeps
  let prevSeam: string | undefined

  beforeEach(() => {
    vi.useFakeTimers()
    tmp = mkdtempSync(join(tmpdir(), 'seam-auto-'))
    prevSeam = process.env.DUIN_SEAM_MATERIALIZE
    process.env.DUIN_SEAM_MATERIALIZE = '1'
    deps = {
      getNotesDir: () => tmp,
      getPromoted: () => [fact()],
      getAllFacts: () => [fact()],
      buildCatalog: () => undefined,
      reindex: vi.fn()
    }
    __resetSeamReconcileForTests()
  })
  afterEach(() => {
    stopSeamAutoReconcile()
    vi.useRealTimers()
    if (prevSeam === undefined) delete process.env.DUIN_SEAM_MATERIALIZE
    else process.env.DUIN_SEAM_MATERIALIZE = prevSeam
    rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
  })

  it('runSeamReconcileNow writes the concept lane and records status', () => {
    const r = runSeamReconcileNow('test', deps)
    expect(r.ok).toBe(true)
    expect(existsSync(join(tmp, '.brain', 'memory', 'concept-f_auto1.md'))).toBe(true)
    expect(existsSync(join(tmp, '.brain', 'memory', '_concept-index.md'))).toBe(true)
    const s = seamReconcileStatus()
    expect(s.lastTrigger).toBe('test')
    expect(s.lastResult?.written).toBe(1)
    expect(s.lastError).toBeNull()
    expect(deps.reindex).toHaveBeenCalledWith(tmp)
  })

  it('is gated on DUIN_SEAM_MATERIALIZE unless the caller overrides (manual backfill route)', () => {
    delete process.env.DUIN_SEAM_MATERIALIZE
    const r = runSeamReconcileNow('test', deps)
    expect(r.ok).toBe(false)
    expect(r.skipped).toBe('seam-disabled')
    expect(existsSync(join(tmp, '.brain', 'memory', 'concept-f_auto1.md'))).toBe(false)
    const forced = runSeamReconcileNow('backfill-route', deps, { ignoreFlag: true })
    expect(forced.ok).toBe(true)
    expect(existsSync(join(tmp, '.brain', 'memory', 'concept-f_auto1.md'))).toBe(true)
  })

  it('NEVER throws: a failing dep is captured into status, not propagated', () => {
    const bad: SeamReconcileDeps = { ...deps, getPromoted: () => { throw new Error('moat exploded') } }
    let r: ReturnType<typeof runSeamReconcileNow> | null = null
    expect(() => { r = runSeamReconcileNow('test', bad) }).not.toThrow()
    expect(r!.ok).toBe(false)
    expect(seamReconcileStatus().lastError).toContain('moat exploded')
  })

  it('a failing catalog degrades to a T1 reconcile instead of failing the run', () => {
    const bad: SeamReconcileDeps = { ...deps, buildCatalog: () => { throw new Error('db locked') } }
    const r = runSeamReconcileNow('test', bad)
    expect(r.ok).toBe(true) // concepts still projected, entities skipped
    expect(existsSync(join(tmp, '.brain', 'memory', 'concept-f_auto1.md'))).toBe(true)
  })

  it('schedule debounces: a burst of govern events coalesces into ONE reconcile', () => {
    startSeamAutoReconcile(deps, { bootDelayMs: 0, debounceMs: 10_000 })
    scheduleSeamReconcile('promote')
    vi.advanceTimersByTime(4_000)
    scheduleSeamReconcile('retire')
    scheduleSeamReconcile('promote')
    vi.advanceTimersByTime(9_999)
    expect(seamReconcileStatus().runs).toBe(0) // still pending — timer reset by the burst
    vi.advanceTimersByTime(1)
    expect(seamReconcileStatus().runs).toBe(1)
    expect(seamReconcileStatus().lastTrigger).toBe('promote')
    scheduleSeamReconcile('retire')
    vi.advanceTimersByTime(10_000)
    expect(seamReconcileStatus().runs).toBe(2)
  })

  it('boot self-heal fires once after the settle delay and heals un-hooked drift', () => {
    startSeamAutoReconcile(deps, { bootDelayMs: 90_000, debounceMs: 10_000 })
    expect(seamReconcileStatus().runs).toBe(0)
    vi.advanceTimersByTime(90_000)
    expect(seamReconcileStatus().runs).toBe(1)
    expect(seamReconcileStatus().lastTrigger).toBe('boot')
    vi.advanceTimersByTime(300_000)
    expect(seamReconcileStatus().runs).toBe(1) // one-shot, not an interval
  })

  it('stop cancels both the boot timer and a pending debounce', () => {
    startSeamAutoReconcile(deps, { bootDelayMs: 60_000, debounceMs: 10_000 })
    scheduleSeamReconcile('promote')
    stopSeamAutoReconcile()
    vi.advanceTimersByTime(600_000)
    expect(seamReconcileStatus().runs).toBe(0)
  })

  it('schedule before start is a safe no-op (hook can fire before wiring completes)', () => {
    expect(() => scheduleSeamReconcile('promote')).not.toThrow()
    vi.advanceTimersByTime(600_000)
    expect(seamReconcileStatus().runs).toBe(0)
  })

  it('kill-switch DUIN_SEAM_AUTO_RECONCILE=0 disables scheduling and boot fire', () => {
    const prev = process.env.DUIN_SEAM_AUTO_RECONCILE
    try {
      process.env.DUIN_SEAM_AUTO_RECONCILE = '0'
      startSeamAutoReconcile(deps, { bootDelayMs: 0, debounceMs: 1_000 })
      scheduleSeamReconcile('promote')
      vi.advanceTimersByTime(60_000)
      expect(seamReconcileStatus().runs).toBe(0)
    } finally {
      if (prev === undefined) delete process.env.DUIN_SEAM_AUTO_RECONCILE
      else process.env.DUIN_SEAM_AUTO_RECONCILE = prev
    }
  })

  it('a T2 catalog flows through: entity file materializes on auto-reconcile', () => {
    const withCat: SeamReconcileDeps = {
      ...deps,
      getPromoted: () => [
        fact({ id: 'w1', fact: 'Works on Beilan launch.' }),
        fact({ id: 'w2', fact: 'Focused on Beilan strategy.' })
      ],
      buildCatalog: () => [{ label: 'Beilan', kind: 'project', minRefs: 2 }]
    }
    const r = runSeamReconcileNow('test', withCat)
    expect(r.ok).toBe(true)
    expect(r.result?.entitiesWritten).toBe(1)
    expect(readFileSync(join(tmp, '.brain', 'memory', 'entity-beilan.md'), 'utf-8')).toContain('— believed')
  })
})
