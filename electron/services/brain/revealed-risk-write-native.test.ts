import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { actRevealedRisk, autoTrackRisks, suppressedRisks, riskSummary } from './revealed-risk-write-native'

const NOW = new Date(2026, 6, 3)

describe('revealed-risk — actRevealedRisk', () => {
  let vault: string
  let dd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-rr-'))
    dd = join(vault, '05 Decisions')
    mkdirSync(dd, { recursive: true })
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('rejects a missing id', () => {
    expect(actRevealedRisk(vault, '', 'confirm')).toEqual({ ok: false, error: 'id required' })
  })

  it('dismiss suppresses the source', () => {
    expect(actRevealedRisk(vault, 'task-1', 'dismiss')).toEqual({ ok: true })
    expect(suppressedRisks(vault).has('task-1')).toBe(true)
  })

  it('confirm errors when the register is absent', () => {
    expect(actRevealedRisk(vault, 'task-1', 'confirm', 'A risk')).toEqual({ ok: false, error: 'register not found' })
  })

  it('confirm appends a numbered risk bullet under the Risks heading + suppresses the source', () => {
    writeFileSync(join(dd, '_Owed-Decisions.md'), '# Owed Decisions\n\n## ⚠️ Risks\n- **R1 · existing** — `open`\n')
    const res = actRevealedRisk(vault, 'task-9', 'confirm', 'Deadline slip on 北澜', NOW)
    expect(res).toEqual({ ok: true, id: 'R2' }) // max existing R1 → R2
    const reg = readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')
    expect(reg).toContain('- **R2 · Deadline slip on 北澜** — `open` · `revealed`')
    expect(reg).toContain('confirmed 2026-07-03')
    // new bullet inserted directly under the heading, above R1
    expect(reg.indexOf('R2')).toBeLessThan(reg.indexOf('R1 · existing'))
    expect(suppressedRisks(vault).has('task-9')).toBe(true)
  })

  it('creates the Risks section when absent + tags predicted provenance for decide:: ids', () => {
    writeFileSync(join(dd, '_Owed-Decisions.md'), '# Owed Decisions\n')
    writeFileSync(join(vault, '.duin', '_state', 'future-nodes.jsonl'), JSON.stringify({ id: 'abc', objective: '锁定 TapTap 联运', target: '2026-08', decide_by: '2026-07-20' }) + '\n')
    const res = actRevealedRisk(vault, 'decide::abc', 'confirm', 'TapTap window', NOW)
    expect(res.id).toBe('R1')
    const reg = readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')
    expect(reg).toContain('## ⚠️ Risks')
    expect(reg).toContain('`predicted`')
    expect(reg).toContain('锁定 TapTap 联运') // risk summary from the stream
  })
})

describe('revealed-risk — riskSummary', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-rs-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    writeFileSync(join(vault, '.duin', '_state', 'future-nodes.jsonl'), JSON.stringify({ id: 's1', objective: 'ship the beta', target: '2026-09', decide_by: '2026-08' }) + '\n')
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('composes stakes for a decision-window risk (EN)', () => {
    expect(riskSummary(vault, 'decide::s1')).toBe('ship the beta Decide by 2026-08, or the 2026-09 target slips.')
  })
  it('empty for a non-decision id', () => {
    expect(riskSummary(vault, 'task-1')).toBe('')
  })
})

describe('revealed-risk — autoTrackRisks', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-at-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('disabled → {enabled:false}, no model/graduation', () => {
    expect(autoTrackRisks(vault, { autoTrack: false })).toEqual({ ok: true, enabled: false, graduated: [] })
  })

  it('enabled with no risks → empty graduated', () => {
    expect(autoTrackRisks(vault, { autoTrack: true, today: () => NOW })).toEqual({ ok: true, enabled: true, graduated: [] })
  })
})
