import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { decisionConnections } from './decision-connections-native'

// Deep correctness proven by live parity (parity.ts decision-connections → EXACT).
describe('decisionConnections', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-dc-'))
    mkdirSync(join(vault, '05 Decisions'), { recursive: true })
    mkdirSync(join(vault, 'People'), { recursive: true })
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('resolves + categorizes a decision doc wikilinks (person vs reference)', () => {
    writeFileSync(join(vault, 'People', 'Ann.md'), '---\ntype: person\n---\n')
    writeFileSync(join(vault, 'Notes.md'), 'plain ref')
    writeFileSync(join(vault, '05 Decisions', 'd.md'), '# Call\nsee [[Ann]] and [[Notes]] and [[Ghost]]')
    const g = decisionConnections(vault, 'd.md')
    expect(g.people.map((p) => p.name)).toEqual(['Ann'])
    expect(g.references.map((r) => r.name)).toEqual(['Notes'])
    // [[Ghost]] unresolved → dropped from all groups
    expect([...g.projects, ...g.organizations, ...g.decisions].length).toBe(0)
  })

  it('null vault / unknown id → empty groups', () => {
    expect(decisionConnections(null, 'x.md')).toEqual({ projects: [], people: [], organizations: [], decisions: [], references: [] })
  })
})
