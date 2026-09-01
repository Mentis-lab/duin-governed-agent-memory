import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { isoWeek, arenaDirs, taskFiles, computeThroughput } from './throughput'

describe('isoWeek — matches Python date.isocalendar()', () => {
  it('Thursday Jan 1 2026 → 2026-W01', () => {
    expect(isoWeek(new Date('2026-01-01T00:00:00Z'))).toEqual([2026, 1])
  })
  it('Mon Dec 29 2025 rolls into 2026-W01 (the canonical ISO edge)', () => {
    expect(isoWeek(new Date('2025-12-29T00:00:00Z'))).toEqual([2026, 1])
  })
  it('Mon Jun 15 2026 → 2026-W25', () => {
    expect(isoWeek(new Date('2026-06-15T00:00:00Z'))).toEqual([2026, 25])
  })
})

describe('computeThroughput', () => {
  it('no vault → empty + stale', () => {
    const t = computeThroughput(null, new Date('2026-07-01T00:00:00Z'))
    expect(t.total).toBe(0)
    expect(t.newest).toBe(null)
    expect(t.stale).toBe(true)
  })

  describe('over a fixture vault', () => {
    let vault: string
    const today = new Date('2026-07-01T00:00:00Z')
    beforeAll(() => {
      vault = mkdtempSync(join(tmpdir(), 'duin-tp-'))
      mkdirSync(join(vault, '06 Tasks'), { recursive: true })
      writeFileSync(
        join(vault, '06 Tasks', 'a.md'),
        '- done ✅ 2026-06-15\n- also ✅ 2026-06-16\n- old ✅ 2026-01-02\n'
      )
      // an arena with its own Tasks.md
      mkdirSync(join(vault, '北澜'), { recursive: true })
      writeFileSync(join(vault, '北澜', 'Tasks.md'), '- shipped ✅ 2026-06-30\n')
      // reserved + numbered-pillar dirs must NOT be treated as arenas
      mkdirSync(join(vault, '.duin'), { recursive: true })
      mkdirSync(join(vault, '03 Projects'), { recursive: true })
    })
    afterAll(() => rmSync(vault, { recursive: true, force: true }))

    it('arenaDirs excludes reserved/hidden/numbered-pillar dirs', () => {
      const arenas = arenaDirs(vault)
      expect(arenas).toContain('北澜')
      expect(arenas).not.toContain('.duin')
      expect(arenas).not.toContain('03 Projects')
    })

    it('taskFiles finds the pillar + arena Tasks.md', () => {
      const files = taskFiles(vault)
      expect(files.some((f) => f.endsWith('a.md'))).toBe(true)
      expect(files.some((f) => f.replace(/\\/g, '/').endsWith('北澜/Tasks.md'))).toBe(true)
    })

    it('counts ✅ stamps, buckets weekly, computes recency + stale', () => {
      const t = computeThroughput(vault, today)
      expect(t.total).toBe(4) // 3 in a.md + 1 in 北澜/Tasks.md
      expect(t.newest).toBe('2026-06-30')
      expect(t.cold_days).toBe(1) // 2026-07-01 - 2026-06-30
      expect(t.recent_28d).toBe(3) // 06-15, 06-16, 06-30 within 28d of 07-01; 01-02 is not
      expect(t.weekly.find((w) => w.week === '2026-W25')?.count).toBe(2) // 06-15 + 06-16
      expect(t.stale).toBe(true) // recent_28d (3) < 30
    })
  })
})
