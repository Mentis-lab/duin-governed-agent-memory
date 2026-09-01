import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareMethodRun } from './method-run'

const METHOD = `---
type: method
name: Deal debrief
task-kind: debrief/deal
deliverable: an internal debrief preserving insider judgment verbatim
calls-skills: [meeting-note, preserve, to-internal-briefing]
grounds-in: [f-rigor-verification]
---

# Deal debrief

## Method
Prose that also wires [[preserve]] and a judgment node [[f-rigor-verification]].

## Steps (DAG)

### capture
**after:** —
**calls:** meeting-note, preserve
Capture verbatim.

### assemble
**after:** capture
**calls:** to-internal-briefing
Assemble the debrief.

## Memory
- a learning
`

describe('prepareMethodRun', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-mr-'))
    mkdirSync(join(vault, '.duin', 'skills', 'meeting-note'), { recursive: true })
    mkdirSync(join(vault, '.duin', 'skills', 'preserve'), { recursive: true })
    mkdirSync(join(vault, 'DUIN', 'Rules'), { recursive: true })
    writeFileSync(join(vault, 'DUIN', 'Rules', 'm-deal-debrief.md'), METHOD)
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('resolves skills from calls-skills frontmatter + body skill wikilinks', () => {
    const run = prepareMethodRun(vault, 'DUIN/Rules/m-deal-debrief.md')!
    expect(run).not.toBeNull()
    expect(run.name).toBe('Deal debrief')
    // calls-skills entries all present; preserve also appears as a wikilink (deduped)
    expect(run.skillWires).toEqual(
      expect.arrayContaining(['meeting-note', 'preserve', 'to-internal-briefing'])
    )
    // the judgment node [[f-rigor-verification]] is NOT a skill wire
    expect(run.skillWires).not.toContain('f-rigor-verification')
  })

  it('classifies wikilinks against the APP\'s installed skills, not just the vault dir', () => {
    // The realistic install: no hand-built `<vault>/.duin/skills` anywhere,
    // because nothing in DUIN writes one. Skills live in userData/skills, and
    // until they were passed in, every wikilink wire here resolved to nothing.
    const bare = mkdtempSync(join(tmpdir(), 'duin-mr-bare-'))
    try {
      mkdirSync(join(bare, 'DUIN', 'Rules'), { recursive: true })
      writeFileSync(join(bare, 'DUIN', 'Rules', 'm-deal-debrief.md'), METHOD)

      const without = prepareMethodRun(bare, 'DUIN/Rules/m-deal-debrief.md')!
      // frontmatter still works — it is added unconditionally — but the
      // wikilink-only wire is missing, which is the defect this closes.
      expect(without.skillWires).toContain('preserve')

      const withInstalled = prepareMethodRun(bare, 'DUIN/Rules/m-deal-debrief.md', [
        'meeting-note',
        'preserve',
        'ground-answers'
      ])!
      expect(withInstalled.skillWires).toEqual(
        expect.arrayContaining(['meeting-note', 'preserve', 'to-internal-briefing'])
      )
      // Still not a skill: passing an installed set must not turn judgment
      // nodes into wires.
      expect(withInstalled.skillWires).not.toContain('f-rigor-verification')
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('builds a prompt with the deliverable and the Steps section', () => {
    const run = prepareMethodRun(vault, 'DUIN/Rules/m-deal-debrief.md')!
    expect(run.prompt).toContain('preserving insider judgment verbatim') // deliverable
    expect(run.prompt).toContain('## Steps (DAG)') // steps section included
    expect(run.prompt).toContain('### capture')
    expect(run.prompt).toContain('meeting-note, preserve, to-internal-briefing') // composed skills
    expect(run.prompt).not.toContain('## Memory') // stops at next ## heading
  })

  it('returns null for a non-method note', () => {
    writeFileSync(join(vault, 'note.md'), '---\ntype: note\nname: x\n---\nhi')
    expect(prepareMethodRun(vault, 'note.md')).toBeNull()
  })

  it('returns null on path escape', () => {
    expect(prepareMethodRun(vault, '../evil.md')).toBeNull()
    expect(prepareMethodRun(vault, '..\\..\\evil.md')).toBeNull()
  })

  it('returns null for null vault / empty path', () => {
    expect(prepareMethodRun(null, 'x.md')).toBeNull()
    expect(prepareMethodRun(vault, '')).toBeNull()
  })
})
