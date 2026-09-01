// Behavior lock for the self-improvement backbone: the earned-autonomy ratchet (registry),
// byte-exact apply/rollback, and the symmetric-window deferred verdict (loop).
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  loadInflight,
  upsertInflight,
  inflightForEngine,
  recordVerdict,
  tierFor,
  loadAutonomy,
  GRADUATE_N,
  type InflightChange,
} from './self-improve-registry'
import { applyChange, rollbackChange, adjudicateInflight } from './self-improve-loop'
import { readRsiTunables, rsiTunablesPath } from './rsi-tunables'

let dir: string
const stateDir = (): string => join(dir, '.duin', '_state')
const seedLedger = (rows: unknown[]): void =>
  writeFileSync(join(stateDir(), 'risk-predictions.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
// risk-domain rows with explicit resolution dates so we can place them in pre/post windows.
const hit = (id: string, d: string) => ({ id, kind: 'deadline', verdict: 'materialized', outcome: 'hit', resolved: d })
const miss = (id: string, d: string) => ({ id, kind: 'deadline', verdict: 'refuted', outcome: 'miss', resolved: d })
// n rows all resolved on one in-window date (n counts rows, not distinct days).
const many = (prefix: string, date: string, n: number, mk: (id: string, d: string) => unknown) =>
  Array.from({ length: n }, (_, i) => mk(`${prefix}${i}`, date))

const mkChange = (over: Partial<InflightChange> = {}): InflightChange => ({
  id: 'c1',
  changeClass: 'kind-weight',
  engine: 'risk',
  targetPath: join(stateDir(), 'target.json'),
  beforeBytes: 'OLD',
  afterBytes: 'NEW',
  proposedAt: '2026-06-15T00:00:00.000Z',
  status: 'proposed',
  ...over,
})

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-rsiloop-'))
  mkdirSync(stateDir(), { recursive: true })
})
afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe('registry — earned-autonomy ratchet', () => {
  it('graduates propose -> auto after GRADUATE_N kept verdicts, demotes on a rollback', () => {
    for (let i = 0; i < GRADUATE_N; i++) recordVerdict(dir, 'kind-weight', true, '2026-06-20T00:00:00Z')
    expect(tierFor(dir, 'kind-weight')).toBe('auto')
    const st = recordVerdict(dir, 'kind-weight', false, '2026-06-21T00:00:00Z') // one rollback demotes
    expect(st.tier).toBe('propose')
    expect(st.keptStreak).toBe(0)
    expect(st.rollbacks).toBe(1)
    expect(tierFor(dir, 'kind-weight')).toBe('propose')
  })

  it('dedups in-flight by id (status mutations are re-appends) and finds one-per-engine', () => {
    upsertInflight(dir, mkChange({ status: 'proposed' }))
    upsertInflight(dir, mkChange({ status: 'applied', appliedAt: '2026-06-15T00:00:00Z' }))
    expect(loadInflight(dir)).toHaveLength(1)
    expect(loadInflight(dir)[0].status).toBe('applied')
    expect(inflightForEngine(dir, 'risk')).toHaveLength(1)
    expect(inflightForEngine(dir, 'stream')).toHaveLength(0)
  })
})

describe('loop — apply / rollback are byte-exact reversible', () => {
  it('applies afterBytes, snapshots the real current bytes, restores on rollback', () => {
    const target = join(stateDir(), 'target.json')
    writeFileSync(target, 'LIVE-CONTENT', 'utf-8')
    const applied = applyChange(dir, mkChange({ targetPath: target }), '2026-06-15T00:00:00Z')
    expect(readFileSync(target, 'utf-8')).toBe('NEW')
    expect(applied.beforeBytes).toBe('LIVE-CONTENT') // snapshot of the ACTUAL pre-change file, not the stub
    expect(applied.status).toBe('applied')
    rollbackChange(dir, applied)
    expect(readFileSync(target, 'utf-8')).toBe('LIVE-CONTENT') // byte-exact restore
    expect(loadInflight(dir)[0].status).toBe('rolled-back')
  })
})

describe('loop — concurrent changes sharing one config file are independently reversible', () => {
  it('rolling back one knob leaves a sibling knob (same file, distinct engine) intact', () => {
    // The RSI population deliberately runs two knobs on DISTINCT engines but the SAME
    // rsi-tunables.json (one-in-flight guard is per-engine, not per-path), so both are live at once.
    // A whole-file snapshot/restore made each rollback clobber the sibling's applied key.
    const target = rsiTunablesPath(dir)
    const j = (o: object): string => JSON.stringify(o, null, 2) + '\n'
    writeFileSync(target, j({ namedSkillTopK: 3, recallFailureLimit: 20 }), 'utf-8')

    // Tick 1 — A edits topK 3→4. applyChange snapshots the CURRENT whole file ({3,20}).
    const a = applyChange(
      dir,
      mkChange({ id: 'A', engine: 'recall-efficacy:named-skill', targetPath: target, afterBytes: j({ namedSkillTopK: 4, recallFailureLimit: 20 }) }),
      '2026-06-15T00:00:00.000Z'
    )
    // Tick 2 — B edits fail 20→25. Its afterBytes is built from the CURRENT file, which already has A's topK=4.
    const b = applyChange(
      dir,
      mkChange({ id: 'B', engine: 'recall-efficacy:failure', targetPath: target, afterBytes: j({ namedSkillTopK: 4, recallFailureLimit: 25 }) }),
      '2026-06-15T00:00:00.000Z'
    )
    expect(readRsiTunables(dir)).toEqual({ namedSkillTopK: 4, recallFailureLimit: 25 })

    // A matures first and regresses → rollback. Must revert ONLY topK, keeping B's fail=25.
    rollbackChange(dir, a)
    expect(readRsiTunables(dir)).toEqual({ namedSkillTopK: 3, recallFailureLimit: 25 })

    // B later rolls back → revert ONLY fail; must NOT resurrect topK=4 that A already reverted.
    rollbackChange(dir, b)
    expect(readRsiTunables(dir)).toEqual({ namedSkillTopK: 3, recallFailureLimit: 20 })
  })
})

describe('loop — rollback is path-confined at the write sink (defence-in-depth)', () => {
  it('refuses the durable write when a (planted) rolled-back row escapes <vault>/.duin/', () => {
    // Simulates a row appended to the unauthenticated inflight ledger by something other than the
    // confinement-checked proposer: escaping targetPath + attacker-chosen beforeBytes. The sink must
    // NOT perform the write, and must still quarantine the row so it is not re-adjudicated forever.
    const outside = join(dir, 'evil.json') // vault root, NOT under .duin/
    writeFileSync(outside, 'ORIGINAL', 'utf-8')
    const out = rollbackChange(dir, mkChange({ id: 'planted', targetPath: outside, beforeBytes: 'MALICIOUS', status: 'applied' }))
    expect(readFileSync(outside, 'utf-8')).toBe('ORIGINAL') // arbitrary-path write refused
    expect(out.status).toBe('rolled-back')
    expect(loadInflight(dir)[0].status).toBe('rolled-back')
  })

  it('adjudicateInflight (the production path) quarantines an escaping planted row on a regressing verdict', () => {
    const sentinel = join(dir, 'outside-secret.json') // outside .duin/
    writeFileSync(sentinel, 'PROTECTED', 'utf-8')
    // regressing post window → verdict fails → the rollback sink is exercised via adjudicateInflight
    seedLedger([
      ...many('preH', '2026-06-10', 22, hit),
      ...many('postH', '2026-06-20', 6, hit), ...many('postM', '2026-06-20', 16, miss),
    ])
    upsertInflight(dir, mkChange({ id: 'planted', targetPath: sentinel, beforeBytes: 'MALICIOUS', status: 'applied', appliedAt: '2026-06-15T00:00:00.000Z' }))
    const r = adjudicateInflight(dir, new Date('2026-06-29T00:00:00Z'))
    expect(r.adjudicated[0].outcome).toBe('rolled-back')
    expect(readFileSync(sentinel, 'utf-8')).toBe('PROTECTED') // arbitrary write refused on the reachable tick path
  })
})

describe('loop — deferred verdict on symmetric windows', () => {
  const applied = (over: Partial<InflightChange> = {}) =>
    mkChange({ status: 'applied', appliedAt: '2026-06-15T00:00:00.000Z', ...over })

  it('holds as "maturing" until the target engine has n>=20 in both windows', () => {
    // only a handful of post-apply resolutions (pre window has plenty)
    seedLedger([...many('a', '2026-06-20', 5, hit), ...many('b', '2026-06-10', 22, hit)])
    upsertInflight(dir, applied())
    const r = adjudicateInflight(dir, new Date('2026-06-29T00:00:00Z'))
    expect(r.adjudicated[0].outcome).toBe('maturing')
    expect(loadInflight(dir)[0].status).toBe('applied') // untouched
  })

  it('rolls back a change whose engine never produced an observation, past the horizon', () => {
    // The live deadlock: the change targeted an engine whose kind is never staged, so the
    // engine name never appears in either window and the verdict was `maturing` forever.
    // With one-inflight-per-engine, that froze the knob permanently AND left an unvalidated
    // value applied with no path back. Silence past the horizon is a rollback, not a wait.
    seedLedger([]) // the target engine simply does not exist
    upsertInflight(dir, applied({ id: 'silent-engine' }))
    const r = adjudicateInflight(dir, new Date('2026-07-30T00:00:00Z')) // 45d after apply
    expect(r.adjudicated[0].outcome).toBe('rolled-back')
    expect(loadInflight(dir)[0].status).toBe('rolled-back') // engine freed for the next proposal
  })

  it('still waits inside the horizon — a slow engine is not a silent one', () => {
    seedLedger([])
    upsertInflight(dir, applied({ id: 'slow-engine' }))
    const r = adjudicateInflight(dir, new Date('2026-06-20T00:00:00Z')) // 5d after apply
    expect(r.adjudicated[0].outcome).toBe('maturing')
    expect(loadInflight(dir)[0].status).toBe('applied')
  })

  it('KEEPS when the post window does not regress vs the equal-duration pre window', () => {
    // pre [06-01,06-15): 18 hit + 4 miss (~0.82). post [06-15,..]: 22 hit (1.0) → improved.
    seedLedger([
      ...many('preH', '2026-06-10', 18, hit), ...many('preM', '2026-06-10', 4, miss),
      ...many('postH', '2026-06-20', 22, hit),
    ])
    upsertInflight(dir, applied())
    const r = adjudicateInflight(dir, new Date('2026-06-29T00:00:00Z'))
    expect(r.adjudicated[0].outcome).toBe('kept')
    expect(loadInflight(dir)[0].status).toBe('kept')
    expect(tierFor(dir, 'kind-weight')).toBe('propose') // one keep < GRADUATE_N
    expect(loadAutonomy(dir).get('kind-weight')!.keptStreak).toBe(1)
  })

  it('ROLLS BACK + demotes when the post window regresses', () => {
    const target = join(stateDir(), 'target.json')
    writeFileSync(target, 'GOOD', 'utf-8')
    // pre: 22 hit (1.0). post: 6 hit + 16 miss (~0.27) → big regression.
    seedLedger([
      ...many('preH', '2026-06-10', 22, hit),
      ...many('postH', '2026-06-20', 6, hit), ...many('postM', '2026-06-20', 16, miss),
    ])
    const rec = applyChange(dir, applied({ targetPath: target }), '2026-06-15T00:00:00.000Z')
    writeFileSync(target, 'BAD-NEW', 'utf-8') // simulate the applied change on disk
    const r = adjudicateInflight(dir, new Date('2026-06-29T00:00:00Z'))
    expect(r.adjudicated[0].outcome).toBe('rolled-back')
    expect(readFileSync(target, 'utf-8')).toBe(rec.beforeBytes) // restored
    expect(tierFor(dir, 'kind-weight')).toBe('propose')
    expect(loadAutonomy(dir).get('kind-weight')!.rollbacks).toBe(1)
  })
})
