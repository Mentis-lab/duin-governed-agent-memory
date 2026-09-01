import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setFmField, setDecisionMeta, resolveNode, makeDecision } from './decision-write-native'

describe('decision-write-native', () => {
  let vault: string
  let dd: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dw-'))
    dd = join(vault, '05 Decisions')
    mkdirSync(dd, { recursive: true })
    writeFileSync(join(dd, 'd1.md'), '---\ntype: decision\ntitle: First\n---\n\nThe call: do X.\n')
    writeFileSync(
      join(dd, '_Owed-Decisions.md'),
      [
        '# Owed Decisions',
        '',
        '- **D1 · First decision** `open` — needs a call',
        '  extra detail line',
        '- **D2 · Second decision** `to-make` — draft the spec',
        ''
      ].join('\n')
    )
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))
  const readDec = (f: string): string => readFileSync(join(dd, f), 'utf-8')

  describe('setFmField', () => {
    it('replaces an existing field, adds a new one, and creates a block when absent', () => {
      expect(setFmField('---\na: 1\n---\nbody', 'a', '2')).toBe('---\na: 2\n---\nbody')
      expect(setFmField('---\na: 1\n---\nbody', 'b', 'x')).toBe('---\na: 1\nb: x\n---\nbody')
      expect(setFmField('no fm here', 'layer', 'strategic')).toBe('---\nlayer: strategic\n---\n\nno fm here')
    })
  })

  describe('setDecisionMeta', () => {
    it('writes layer + domain into the note frontmatter', () => {
      expect(setDecisionMeta(vault, 'd1.md', 'strategic', 'product')).toBe(true)
      const fm = readDec('d1.md')
      expect(fm).toContain('layer: strategic')
      expect(fm).toContain('domain: product')
      expect(fm).toContain('title: First') // untouched
    })
    it('sets only the provided field (undefined leaves the other alone)', () => {
      setDecisionMeta(vault, 'd1', 'tactical') // no .md, no domain
      const fm = readDec('d1.md')
      expect(fm).toContain('layer: tactical')
      expect(fm).not.toContain('domain:')
    })
    it('returns false for a missing decision / vault', () => {
      expect(setDecisionMeta(vault, 'ghost', 'x')).toBe(false)
      expect(setDecisionMeta(null, 'd1', 'x')).toBe(false)
    })
  })

  describe('resolveNode', () => {
    it('resolve moves the node into the audit trail with a dated line', () => {
      const r = resolveNode(vault, 'D1', 'resolve', 'shipped it', new Date('2026-07-02T00:00:00Z'))
      expect(r.ok).toBe(true)
      const reg = readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')
      expect(reg).toContain('## ✅ Graduated / resolved (audit trail)')
      expect(reg).toContain('- 2026-07-02 · **D1** (First decision) → resolved: shipped it')
      expect(reg).not.toMatch(/^- \*\*D1 · First decision\*\* `open`/m) // original bullet gone
      expect(reg).not.toContain('extra detail line') // multi-line block fully removed (not just line 1)
    })
    it('advance bumps the pipeline state token', () => {
      const r = resolveNode(vault, 'D2', 'advance')
      expect(r.ok).toBe(true)
      expect(readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')).toContain('**D2 · Second decision** `made-not-executed`')
    })
    it('unknown action / missing node / missing register → ok:false', () => {
      expect(resolveNode(vault, 'D1', 'frob').ok).toBe(false)
      expect(resolveNode(vault, 'ghost', 'resolve').ok).toBe(false)
      expect(resolveNode(null, 'D1', 'resolve').ok).toBe(false)
    })
  })

  describe('makeDecision', () => {
    const T = new Date('2026-07-02T00:00:00Z')
    it('writes a decision note with the exact frontmatter + body format', () => {
      const r = makeDecision(vault, { title: 'Adopt X', call: 'do X now', rationale: 'because Y', layer: 'strategic' }, T)
      expect(r).toMatchObject({ ok: true, path: '05 Decisions/2026-07-02-adopt-x.md', id: '2026-07-02-adopt-x' })
      const note = readFileSync(join(dd, '2026-07-02-adopt-x.md'), 'utf-8')
      expect(note).toBe(
        [
          '---', 'type: decision', 'date: 2026-07-02', 'status: decided', 'reversibility: reversible',
          'owner: operator', 'review_on: 2026-08-01', 'supersedes:', 'superseded_by:', 'method:', 'tags: [decision]',
          'layer: strategic', '---', '',
          '# Adopt X', '', '## Decision', '', 'do X now', '', '## Rationale', '', 'because Y', '',
          '## Consequences / watch for', '', '_(to monitor at review)_', ''
        ].join('\n')
      )
    })
    it('collision-numbers a duplicate slug + closes the originating node', () => {
      makeDecision(vault, { title: 'Dup' }, T)
      const r2 = makeDecision(vault, { title: 'Dup', nodeId: 'D1' }, T)
      expect(r2.id).toBe('2026-07-02-dup-2')
      expect(r2.nodeClosed).toBe(true)
      // node D1 moved to the register audit trail with a wikilink to the decision
      expect(readFileSync(join(dd, '_Owed-Decisions.md'), 'utf-8')).toContain('→ resolved: decided → [[2026-07-02-dup-2]]')
    })
    it('requires a title / vault', () => {
      expect(makeDecision(vault, { title: '  ' }, T).ok).toBe(false)
      expect(makeDecision(null, { title: 'x' }, T).ok).toBe(false)
    })
  })
})
