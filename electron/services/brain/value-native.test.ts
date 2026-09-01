import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listValue } from './value-native'

// Deep correctness proven by live parity (parity.ts /state/value → EXACT).
describe('listValue', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-val-'))
    mkdirSync(join(vault, '.duin', '_state'), { recursive: true })
    mkdirSync(join(vault, '05 Decisions'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('parses digest track/verdicts + save/miss bullets; hasDigest', () => {
    writeFileSync(
      join(vault, '.duin', '_state', 'value-digest.md'),
      'decided **5** reviewed **3** DUIN-surfaced **2** pending verdict (due) **1**\nverdicts: right 4 wrong 1 partial 0\n\n### ✅ Saves\n- caught the slip\n- averted X\n\n### ⚠️ Misses\n- missed Y\n'
    )
    const v = listValue(vault, new Date('2026-07-01T00:00:00Z'))
    expect(v.hasDigest).toBe(true)
    expect(v.track).toMatchObject({ decided: 5, reviewed: 3, surfaced: 2, pendingDue: 1, right: 4, wrong: 1, partial: 0 })
    expect(v.saves).toEqual(['caught the slip', 'averted X'])
    expect(v.misses).toEqual(['missed Y'])
  })

  it('surfaces decisions due for verdict (reviewOn <= today)', () => {
    writeFileSync(join(vault, '05 Decisions', 'd.md'), '---\ndate: 2026-05-01\nreview_on: 2026-06-01\n---\n# Call')
    const v = listValue(vault, new Date('2026-07-01T00:00:00Z'))
    expect(v.dueForVerdict).toEqual([{ id: 'd.md', title: 'Call', reviewOn: '2026-06-01' }])
  })

  it('no digest → empty track + hasDigest false', () => {
    const v = listValue(vault, new Date('2026-07-01T00:00:00Z'))
    expect(v.hasDigest).toBe(false)
    expect(v.track).toEqual({})
  })
})
