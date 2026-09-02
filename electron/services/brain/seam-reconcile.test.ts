import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { makeMaterializeHook } from './concept-materialize'
import { notifyVaultFileEvent } from '../local-brain/notes-watcher'
import {
  confirmFact,
  getAllOperatorFacts as allFacts,
  setMaterializeHook
} from './operator-model'
import { setOperatorModelPath, recordFacts, promoteFact, supersedeFact, getAllOperatorFacts, __resetOperatorModel } from './operator-model'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  startSeamAutoReconcile,
  stopSeamAutoReconcile,
  scheduleSeamReconcile,
  runSeamReconcileNow,
  seamReconcileStatus,
  __resetSeamReconcileForTests,
  type SeamReconcileDeps,
  makeProductionSeamDeps
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

  it('is gated off by DUIN_SEAM_MATERIALIZE=0 unless the caller overrides (manual backfill route)', () => {
    process.env.DUIN_SEAM_MATERIALIZE = '0'
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

// W3 — the production deps project PROVISIONAL facts too (a keyless install never reaches `promoted`,
// so without this its learned facts would never become files) and never a retired one.
describe('seam-reconcile — production deps (W3)', () => {
  it('include live provisional facts, exclude candidates and superseded rows', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'seam-deps-'))
    try {
      setOperatorModelPath(join(tmp, 'operator-model.json'))
      __resetOperatorModel()
      recordFacts([
        { fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' },
        { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'operator' }
      ])
      const tea = getAllOperatorFacts().find((f) => f.fact.includes('tea'))!
      expect(promoteFact(tea.id)).toBe(true) // → provisional (human)
      const prod = makeProductionSeamDeps(() => tmp)
      expect(prod.getPromoted().map((f) => f.fact)).toEqual(['Operator prefers tea in the afternoon'])
      expect(supersedeFact(tea.id, 'Operator prefers coffee in the afternoon', 'context', 'operator').superseded).toBe(true)
      expect(prod.getPromoted()).toEqual([]) // the retired row is out; its replacement is only a candidate
    } finally {
      __resetOperatorModel()
      rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  })
})

// W4 — production hooks: a hand edit becomes the operator's statement, a hand delete becomes a veto.
describe('seam-reconcile — human edits flow back (W4)', () => {
  it('edit → supersede + promote (+ confirm when the old fact was promoted); delete → veto', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'seam-w4p-'))
    const prev = process.env.DUIN_SEAM_MATERIALIZE
    try {
      process.env.DUIN_SEAM_MATERIALIZE = '1'
      setOperatorModelPath(join(tmp, 'operator-model.json'))
      __resetOperatorModel()
      setMaterializeHook(makeMaterializeHook(() => tmp)) // as main.ts wires it: promote/retire project at once
      recordFacts([
        { fact: 'Operator prefers tea in the afternoon', kind: 'context', source: 'operator' },
        { fact: 'Operator ships releases on Fridays', kind: 'context', source: 'operator' }
      ])
      const tea = allFacts().find((f) => f.fact.includes('tea'))!
      const ships = allFacts().find((f) => f.fact.includes('Fridays'))!
      promoteFact(tea.id)
      confirmFact(tea.id) // → promoted
      promoteFact(ships.id) // → provisional
      const prod = makeProductionSeamDeps(() => tmp)
      expect(runSeamReconcileNow('t', prod).ok).toBe(true)
      const memoryDir = join(tmp, '.brain', 'memory')
      const teaFile = join(memoryDir, `concept-${tea.id}.md`)
      const shipsFile = join(memoryDir, `concept-${ships.id}.md`)
      expect(existsSync(teaFile)).toBe(true)
      expect(existsSync(shipsFile)).toBe(true)

      // The human rewrites the claim line of the PROMOTED fact and deletes the provisional one.
      writeFileSync(teaFile, readFileSync(teaFile, 'utf-8').split('Operator prefers tea in the afternoon').join('Operator prefers coffee in the afternoon'), 'utf-8')
      rmSync(shipsFile)
      expect(runSeamReconcileNow('t2', prod).ok).toBe(true)

      const oldTea = allFacts().find((f) => f.id === tea.id)!
      expect(oldTea.invalidatedAt).toEqual(expect.any(Number))
      const newTea = allFacts().find((f) => f.id === oldTea.supersededBy)!
      expect(newTea.fact).toBe('Operator prefers coffee in the afternoon')
      expect(newTea.status).toBe('promoted') // a confirmed rule stays confirmed with the new text
      expect(newTea.adjudicatedBy).toBe('human')
      expect(newTea.source).toBe('operator')
      expect(existsSync(join(memoryDir, `concept-${newTea.id}.md`))).toBe(true)
      expect(existsSync(teaFile)).toBe(false)
      expect(existsSync(join(tmp, '.brain', '_retired', `concept-${tea.id}.md`))).toBe(true) // the edited bytes are kept

      expect(allFacts().find((f) => f.id === ships.id)!.status).toBe('vetoed')
      expect(existsSync(shipsFile)).toBe(false) // not re-created
    } finally {
      setMaterializeHook(null)
      __resetOperatorModel()
      if (prev === undefined) delete process.env.DUIN_SEAM_MATERIALIZE
      else process.env.DUIN_SEAM_MATERIALIZE = prev
      rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  })

  it('a concept-file change in the vault schedules a reconcile; a note change does not', () => {
    vi.useFakeTimers()
    const tmp = mkdtempSync(join(tmpdir(), 'seam-w4w-'))
    const prev = process.env.DUIN_SEAM_MATERIALIZE
    try {
      process.env.DUIN_SEAM_MATERIALIZE = '1'
      __resetSeamReconcileForTests()
      const deps: SeamReconcileDeps = { getNotesDir: () => tmp, getPromoted: () => [], getAllFacts: () => [], buildCatalog: () => undefined }
      startSeamAutoReconcile(deps, { bootDelayMs: 0, debounceMs: 50 })
      notifyVaultFileEvent({ type: 'change', path: join(tmp, 'notes', 'todo.md'), dir: tmp })
      vi.advanceTimersByTime(100)
      expect(seamReconcileStatus().runs).toBe(0)
      notifyVaultFileEvent({ type: 'unlink', path: join(tmp, '.brain', 'memory', 'concept-x.md'), dir: tmp })
      vi.advanceTimersByTime(100)
      expect(seamReconcileStatus().runs).toBe(1)
      expect(seamReconcileStatus().lastTrigger).toBe('file-unlink')
      stopSeamAutoReconcile()
      notifyVaultFileEvent({ type: 'change', path: join(tmp, '.brain', 'memory', 'concept-x.md'), dir: tmp })
      vi.advanceTimersByTime(100)
      expect(seamReconcileStatus().runs).toBe(1) // unsubscribed on stop
    } finally {
      stopSeamAutoReconcile()
      vi.useRealTimers()
      if (prev === undefined) delete process.env.DUIN_SEAM_MATERIALIZE
      else process.env.DUIN_SEAM_MATERIALIZE = prev
      rmSync(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
    }
  })
})
