import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setDecisionMeta, resolveNode } from './decision-write-native'
import { readAnchorDecls } from './causal-substrate'

// A1 (Evidence Threshold Phase) — DUIN-LAYOUT BRANCH COVERAGE.
//
// The write-natives resolve their pillar as `PILLARS.find(isDir) ?? PILLARS[0]`, with the
// DUIN layout at index 0 (`DUIN/Decisions`, `DUIN/Planning`, `DUIN/Tasks`, `DUIN/Instincts`)
// and the legacy legacy-numbered layout at index 1 (`05 Decisions`, `04 Notes`, …). Every existing
// suite fixtures the LEGACY branch — so the DUIN branch, the one the production Sample-brain vault
// actually runs on, had ZERO coverage (surfaced by the 2026-07-08 eval verification pass).
// The resolver spelling is replicated identically across all pillar families; these lock the
// branch for the two representative spellings — the write-critical Decisions family
// (`pillarPath`, shared by 6 natives) and the Planning read family (`map().find(dirOK)`) —
// plus the index-0 precedence invariant both rely on.

const DECISION = '---\ntype: decision\ntitle: First\n---\n\nThe call: do X.\n'
const OWED = ['# Owed Decisions', '', '- **D1 · First decision** `open` — needs a call', ''].join('\n')
const ANCHOR = '---\ntype: anchor\nanchor-id: a-x\nname: X launch\nkind: milestone\ndate: 2026-08-01\n---\n'

describe('layout resolver — DUIN-layout branch (production path)', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-layout-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  describe('Decisions pillar (DUIN/Decisions)', () => {
    it('setDecisionMeta writes into DUIN/Decisions when that is the layout', () => {
      const dd = join(vault, 'DUIN', 'Decisions')
      mkdirSync(dd, { recursive: true })
      writeFileSync(join(dd, 'd1.md'), DECISION)
      expect(setDecisionMeta(vault, 'd1.md', 'strategic', 'product')).toBe(true)
      const fm = readFileSync(join(dd, 'd1.md'), 'utf-8')
      expect(fm).toContain('layer: strategic')
      expect(fm).toContain('domain: product')
    })

    it('resolveNode edits the register under DUIN/Decisions', () => {
      const dd = join(vault, 'DUIN', 'Decisions')
      mkdirSync(dd, { recursive: true })
      writeFileSync(join(dd, '_Owed-Decisions.md'), OWED)
      const r = resolveNode(vault, 'D1', 'resolve', 'shipped', new Date('2026-07-02T00:00:00Z'))
      expect(r.ok).toBe(true)
      expect(readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')).toContain(
        '- 2026-07-02 · **D1** (First decision) → resolved: shipped'
      )
    })

    it('DUIN layout WINS when both DUIN and legacy pillars exist (index-0 precedence)', () => {
      const duin = join(vault, 'DUIN', 'Decisions')
      const legacy = join(vault, '05 Decisions')
      mkdirSync(duin, { recursive: true })
      mkdirSync(legacy, { recursive: true })
      writeFileSync(join(duin, 'd1.md'), DECISION)
      writeFileSync(join(legacy, 'd1.md'), DECISION)
      expect(setDecisionMeta(vault, 'd1.md', 'tactical')).toBe(true)
      expect(readFileSync(join(duin, 'd1.md'), 'utf-8')).toContain('layer: tactical') // DUIN edited
      expect(readFileSync(join(legacy, 'd1.md'), 'utf-8')).not.toContain('layer: tactical') // legacy untouched
    })
  })

  describe('Planning pillar (DUIN/Planning)', () => {
    it('readAnchorDecls reads anchors from DUIN/Planning/_system', () => {
      const sys = join(vault, 'DUIN', 'Planning', '_system')
      mkdirSync(sys, { recursive: true })
      writeFileSync(join(sys, '(C) anchor-x.md'), ANCHOR)
      expect(readAnchorDecls(vault).map((d) => d.id)).toContain('a-x')
    })

    it('DUIN/Planning WINS over legacy 04 Notes (index-0 precedence)', () => {
      const duinSys = join(vault, 'DUIN', 'Planning', '_system')
      const legacySys = join(vault, '04 Notes', '_system')
      mkdirSync(duinSys, { recursive: true })
      mkdirSync(legacySys, { recursive: true })
      writeFileSync(join(duinSys, '(C) anchor-duin.md'), ANCHOR.replace('a-x', 'a-duin'))
      writeFileSync(join(legacySys, '(C) anchor-legacy.md'), ANCHOR.replace('a-x', 'a-legacy'))
      const ids = readAnchorDecls(vault).map((d) => d.id)
      expect(ids).toContain('a-duin')
      expect(ids).not.toContain('a-legacy') // planning resolver picked DUIN; legacy _system not globbed
    })
  })
})
