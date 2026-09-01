import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  operatorProfile,
  projectionLanes,
  goalsContext,
  strategyContext,
  projectionContext
} from './projection-context-native'

describe('projection-context — operatorProfile', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-op-'))
    mkdirSync(join(vault, '.duin'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns "" when absent', () => {
    expect(operatorProfile(vault)).toBe('')
  })
  it('strips frontmatter + caps', () => {
    writeFileSync(join(vault, '.duin', 'operator-profile.md'), '---\ntype: profile\n---\n\nPriorities: 北澜 first.')
    expect(operatorProfile(vault)).toBe('Priorities: 北澜 first.')
  })
})

describe('projection-context — projectionLanes', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pl-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('derives lanes from the registry + always includes the core lanes', () => {
    writeFileSync(join(vault, '.duin', '_state', 'tracks.json'), JSON.stringify([{ id: 'x', label: 'X', lane: 'ait' }]))
    const lanes = projectionLanes(vault)
    expect(lanes).toContain('ait')
    expect(lanes).toContain('ProjectA') // cold-start A4 de-personalized the core lane names
    expect(lanes).toContain('PartnerCo')
    expect(lanes).toContain('personal')
  })
})

describe('projection-context — goalsContext', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-gc-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('assembles me.md (frontmatter-stripped) + GOALS.md', () => {
    writeFileSync(join(vault, 'me.md'), '---\ntype: identity\n---\n\nI build leverage.')
    writeFileSync(join(vault, 'GOALS.md'), 'Ship 北澜 globally.')
    const g = goalsContext(vault)
    expect(g).toContain('### Identity & mission (me.md)\nI build leverage.')
    expect(g).toContain('### GOALS.md\nShip 北澜 globally.')
  })
  it('returns "" for a bare vault', () => {
    expect(goalsContext(vault)).toBe('')
  })
})

describe('projection-context — strategyContext', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-sc-'))
    mkdirSync(join(vault, '03 Projects', '北澜'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('scores + keeps strategy-dense prose, skips checklists and low-signal docs', () => {
    // strategy-dense doc (many platform terms + a strategy-y name)
    writeFileSync(
      join(vault, '03 Projects', '北澜', '发行计划.md'),
      '# 发行策略\nTapTap 与 B站 联运；Steam/Xbox 国际发行；渠道资源位与首发定档。\n营收与用户增长。'
    )
    // a checklist doc → excluded
    writeFileSync(
      join(vault, '03 Projects', '北澜', 'Tasks.md'),
      '- [ ] a\n- [ ] b\n- [x] c\n'
    )
    // a low-signal doc → excluded (score <= 4)
    writeFileSync(join(vault, '03 Projects', '北澜', 'random.md'), '# Notes\njust some idle thoughts')

    const s = strategyContext(vault)
    expect(s).toContain('### 03 Projects/北澜/发行计划.md')
    expect(s).toContain('发行策略')
    expect(s).not.toContain('random.md')
    expect(s).not.toContain('Tasks.md')
  })
})

describe('projection-context — projectionContext', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pc-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('returns "" for an empty world (no tracks with open/risks)', () => {
    // bare vault → worldState has default tracks all at open:0/risks:0 → all skipped
    expect(projectionContext(vault, new Date(2026, 6, 3))).toBe('')
  })
})
