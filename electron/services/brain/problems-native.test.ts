import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProblems } from './problems-native'

describe('listProblems', () => {
  let vault: string
  let dec: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-pb-'))
    dec = join(vault, '05 Decisions')
    mkdirSync(dec, { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('parses register sections → nodes (id/title/meta/state/source/links) + counts', () => {
    writeFileSync(
      join(dec, '_Owed-Decisions.md'),
      '## 🧩 Problems\n\n- **P1 · Backlog too big** — `open` `duin` see [[Tasks]]\n  - a detail line\n\n## ⚠️ Risks\n\n- **R1 · Deadline slip** — `amber` `北澜`\n'
    )
    const { nodes, counts, register } = listProblems(vault)
    expect(counts).toEqual({ problem: 1, risk: 1, owed: 0 })
    const p1 = nodes.find((n) => n.id === 'P1')!
    expect(p1).toMatchObject({ kind: 'problem', title: 'Backlog too big', state: 'open', source: 'duin', detail: 'a detail line' })
    expect(p1.links).toEqual(['Tasks'])
    expect(register).toBe('05 Decisions/_Owed-Decisions.md')
  })

  it('picks up graduated standalone type:risk|problem files (skips _ files)', () => {
    writeFileSync(join(dec, 'r-vendor.md'), '---\ntype: risk\nid: RG9\ntitle: Vendor slip\nstate: amber\n---\nbody')
    const { nodes } = listProblems(vault)
    const g = nodes.find((n) => n.id === 'RG9')!
    expect(g).toMatchObject({ kind: 'risk', title: 'Vendor slip', state: 'amber', graduated: true, path: '05 Decisions/r-vendor.md' })
  })

  it('null vault → empty', () => {
    expect(listProblems(null).nodes).toEqual([])
  })
})
