import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parseDecision, listDecisions } from './decisions-native'

// Deep correctness proven by live parity (parity.ts /state/decisions → EXACT, 18 rows).
describe('decisions-native', () => {
  it('parseDecision: frontmatter + H1 title + oneWay from reversibility', () => {
    const r = parseDecision('---\ndate: 2026-06-01\nstatus: decided\nreversibility: one-way\nowner: TQ\n---\n# Ship it\nbody [[x]] [[y]]', 'd1.md')
    expect(r).toMatchObject({ id: 'd1.md', title: 'Ship it', date: '2026-06-01', oneWay: true, owner: 'TQ', links: 2 })
  })

  it('title falls back to filename stem when no H1', () => {
    expect(parseDecision('---\ndate: x\n---\nno heading', 'my-call.md').title).toBe('my-call')
  })

  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dec-'))
    mkdirSync(join(vault, '05 Decisions'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('lists legacy-pillar decisions, newest first, skipping templates + _ files', () => {
    writeFileSync(join(vault, '05 Decisions', 'a.md'), '---\ndate: 2026-05-01\n---\n# Old')
    writeFileSync(join(vault, '05 Decisions', 'b.md'), '---\ndate: 2026-06-01\n---\n# New')
    writeFileSync(join(vault, '05 Decisions', 'tmpl.md'), '---\ndate: 2026-07-01\n---\n# {{title}}') // template → skipped
    writeFileSync(join(vault, '05 Decisions', '_owed.md'), '---\ndate: 2026-08-01\n---\n# skip') // _ → skipped
    const { decisions } = listDecisions(vault)
    expect(decisions.map((d) => d.title)).toEqual(['New', 'Old']) // date desc, template + _ excluded
  })

  it('null vault → empty', () => {
    expect(listDecisions(null)).toEqual({ decisions: [] })
  })
})
