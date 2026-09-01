import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  predictedRiskForecasts,
  anchorRiskForecasts,
  logPredictedKindsToLedger,
  type KindLedgerRow
} from './predicted-kinds-ledger'

// The PORT: the three Python-only calibration kinds (deadline-collision / decision-window /
// anchor-risk) must be GENERATED + LOGGED by the TS single writer once the :8765 Python write
// path is retired. Each generator must fire on the right condition, emit the Python schema/ids,
// and log idempotently so the resolver (calibration-resolve-native) scores them unchanged.

const state = (v: string): string => join(v, '.duin', '_state')
const ledgerOf = (v: string): string => join(state(v), 'risk-predictions.jsonl')
const readLedger = (v: string): KindLedgerRow[] =>
  readFileSync(ledgerOf(v), 'utf-8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l))

/** A ledger row is schema-complete = the exact resolver contract the Python loggers wrote. */
const assertSchema = (r: KindLedgerRow): void => {
  for (const k of ['id', 'created', 'source', 'kind', 'trigger_signature', 'predicted', 'subjects', 'sources', 'track', 'confidence', 'eval_after', 'verdict'])
    expect(r).toHaveProperty(k)
  expect(r.verdict).toBeNull()
  expect(r.eval_after).toHaveProperty('by')
  expect(Array.isArray(r.subjects)).toBe(true)
}

describe('predicted-kinds-ledger port', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pkl-'))
    mkdirSync(state(vault), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  const tasksFile = (proj: string, lines: string[]): void => {
    const p = join(vault, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    writeFileSync(join(p, 'Tasks.md'), lines.join('\n'), 'utf-8')
  }
  const futures = (rows: object[]): void =>
    writeFileSync(join(state(vault), 'future-nodes.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n'), 'utf-8')
  const anchorFile = (proj: string, file: string, fm: Record<string, string>): void => {
    const p = join(vault, '03 Projects', proj)
    mkdirSync(p, { recursive: true })
    const body = ['---', 'type: anchor', ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), '---', '# ' + (fm.name || file)]
    writeFileSync(join(p, file), body.join('\n'), 'utf-8')
  }

  // ── deadline-collision ────────────────────────────────────────────────────
  it('deadline-collision: ≥2 high-stakes tasks on one due-date within 5d → one row', () => {
    tasksFile('Coll', [
      '- [ ] 上线 | 提交审核 {{priority:: 1}} {{dateDue:: 2026-07-03}}',
      '- [ ] 上线 | 素材定稿 {{priority:: 1}} {{dateDue:: 2026-07-03}}'
    ])
    const rows = predictedRiskForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    const c = rows.find((r) => r.kind === 'deadline-collision')
    expect(c).toBeTruthy()
    expect(c!.id).toBe('collision::2026-07-03')
    expect(c!.source).toBe('duin-predicted')
    expect(c!.eval_after.by).toBe('2026-07-03')
    expect(c!.subjects.length).toBe(2) // both task ids → resolver adjudicates
    expect(c!.confidence).toBe(0.5) // deadline-collision carries no confidence → Python default
    assertSchema(c!)
  })

  it('deadline-collision: a lone high-stakes task does NOT fire (needs ≥2)', () => {
    tasksFile('Coll', ['- [ ] 上线 | 单点 {{priority:: 1}} {{dateDue:: 2026-07-03}}'])
    const rows = predictedRiskForecasts(vault, new Date('2026-07-01T00:00:00Z'))
    expect(rows.some((r) => r.kind === 'deadline-collision')).toBe(false)
  })

  // ── decision-window (signal-mode via KIND_MODE, inferred from kind) ─────────
  it('decision-window: open stream with decide_by ≤21d → one row with its confidence', () => {
    futures([{ id: 's-open', title: '北澜渠道决策', track: '北澜', status: 'open', decide_by: '2026-06-11', target: '2026-07-01' }])
    const rows = predictedRiskForecasts(vault, new Date('2026-06-01T00:00:00Z'))
    const dw = rows.find((r) => r.kind === 'decision-window')
    expect(dw).toBeTruthy()
    expect(dw!.id).toBe('decide::s-open')
    expect(dw!.source).toBe('duin-predicted')
    expect(dw!.eval_after.by).toBe('2026-06-11')
    expect(dw!.subjects).toEqual(['s-open'])
    expect(dw!.confidence).toBe(0.65) // 10d out (>7) → 0.65, matches server.py
    assertSchema(dw!)
  })

  it('decision-window: a stream beyond the 21d horizon does NOT fire', () => {
    futures([{ id: 's-far', title: 'later', status: 'open', decide_by: '2026-09-01' }])
    const rows = predictedRiskForecasts(vault, new Date('2026-06-01T00:00:00Z'))
    expect(rows.some((r) => r.kind === 'decision-window')).toBe(false)
  })

  // ── anchor-risk (negative-slack critical-path gates) ───────────────────────
  it('anchor-risk: a red anchor with a negative-slack gate → one row', () => {
    anchorFile('Launch', '(C) anchor-launch.md', {
      'anchor-id': 'launch',
      name: 'Launch',
      kind: 'event',
      date: '2026-07-10',
      track: '北澜',
      'binds-contexts': 'launch'
    })
    tasksFile('Launch', [
      '- [ ] Ship the build {{contexts:: launch}} {{priority:: 1}} {{dateDue:: 2020-01-01}}', // overdue P1 → red, slack<0
      '- [ ] Write notes {{contexts:: launch}} {{dateDue:: 2026-07-05}}' // positive slack → not a gate
    ])
    const rows = anchorRiskForecasts(vault, new Date('2026-07-01T09:00:00+08:00'))
    expect(rows).toHaveLength(1)
    const a = rows[0]
    expect(a.id).toBe('anchor::launch')
    expect(a.kind).toBe('anchor-risk')
    expect(a.source).toBe('duin-anchor')
    expect(a.confidence).toBe(0.8) // red → 0.8
    expect(a.eval_after.by).toBe('2026-07-10')
    expect(a.subjects.length).toBe(1) // only the negative-slack gate
    expect(a.track).toBe('北澜')
    expect(a.trigger_signature.value).toBe('branch negative-slack')
    assertSchema(a)
  })

  it('anchor-risk: a green anchor (no overdue work) does NOT fire', () => {
    anchorFile('Calm', '(C) anchor-calm.md', {
      'anchor-id': 'calm',
      name: 'Calm',
      date: '2026-07-10',
      'binds-contexts': 'calm'
    })
    tasksFile('Calm', ['- [ ] future work {{contexts:: calm}} {{dateDue:: 2026-07-08}}'])
    expect(anchorRiskForecasts(vault, new Date('2026-07-01T09:00:00+08:00'))).toEqual([])
  })

  // ── the single-writer logger: append + idempotent ─────────────────────────
  it('logPredictedKindsToLedger appends all three kinds and is idempotent', () => {
    writeFileSync(ledgerOf(vault), '') // empty ledger
    tasksFile('Coll', [
      '- [ ] 上线 | 提交审核 {{priority:: 1}} {{dateDue:: 2026-07-03}}',
      '- [ ] 上线 | 素材定稿 {{priority:: 1}} {{dateDue:: 2026-07-03}}'
    ])
    futures([{ id: 's-open', title: '决策', track: '北澜', status: 'open', decide_by: '2026-07-05', target: 'x' }])
    anchorFile('Launch', '(C) anchor-launch.md', { 'anchor-id': 'launch', name: 'Launch', date: '2026-07-10', 'binds-contexts': 'launch' })
    tasksFile('Launch', ['- [ ] Ship {{contexts:: launch}} {{priority:: 1}} {{dateDue:: 2020-01-01}}'])

    const now = new Date('2026-07-01T00:00:00Z')
    const n1 = logPredictedKindsToLedger(vault, now)
    expect(n1).toBeGreaterThanOrEqual(3)
    const kinds = new Set(readLedger(vault).map((r) => r.kind))
    expect(kinds.has('deadline-collision')).toBe(true)
    expect(kinds.has('decision-window')).toBe(true)
    expect(kinds.has('anchor-risk')).toBe(true)

    const n2 = logPredictedKindsToLedger(vault, now) // second pass → stable ids dedup
    expect(n2).toBe(0)
    expect(readLedger(vault).length).toBe(n1) // no dup rows
  })

  it('null vault → no rows, no write', () => {
    expect(predictedRiskForecasts(null)).toEqual([])
    expect(anchorRiskForecasts(null)).toEqual([])
    expect(logPredictedKindsToLedger(null)).toBe(0)
  })
})
