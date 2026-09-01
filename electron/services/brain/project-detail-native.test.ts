import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { projectDetail, projectDesc, categorizeLinks } from './project-detail-native'

describe('project-detail-native (unification: /state/project)', () => {
  let dir: string
  const write = (rel: string, body: string): void => {
    const full = join(dir, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf-8')
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'duin-proj-'))
  })
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('projectDesc: first H1, else first non--- line (naive, matches Python), truncated to 90', () => {
    expect(projectDesc('---\ntype: x\n---\n# The Title\nbody')).toBe('The Title')
    expect(projectDesc('\n\nfirst real line\nsecond')).toBe('first real line') // blanks skipped
    expect(projectDesc('---\na: b\n---\nreal')).toBe('a: b') // naive: only '---' lines skipped, not FM content
    expect(projectDesc('# ' + 'x'.repeat(200)).length).toBe(90)
    expect(projectDesc('')).toBe('')
  })

  it('unknown project → empty shell (connections {})', () => {
    const r = projectDetail(dir, 'nope')
    expect(r).toEqual({ name: 'nope', desc: '', overview: '', tracks: [], connections: {} })
  })

  it('null vault / empty name never throws', () => {
    expect(() => projectDetail(null, 'x')).not.toThrow()
    expect(projectDetail(dir, '').connections).toEqual({})
  })

  it('reads BRAIN.md desc + tracks + categorizes wikilinks by target kind', () => {
    write('03 Projects/Alpha/BRAIN.md', '# Alpha Project\nlinks: [[Bob]] [[D1]] [[Ref1]] [[Beta]]')
    write('03 Projects/Alpha/Notes.md', 'a track note')
    write('人物/Bob.md', '---\ntype: person\n---\nBob') // person via FM
    write('05 Decisions/D1.md', '---\ntype: decision\n---\nthe call') // decision via path
    write('04 Notes/Ref1.md', 'just a reference note') // reference (fallthrough)
    write('03 Projects/Beta/Beta.md', '# Beta') // project via path (basename must match the wikilink)

    const r = projectDetail(dir, 'Alpha')
    expect(r.desc).toBe('Alpha Project')
    expect(r.overview).toBe('03 Projects/Alpha/BRAIN.md')
    expect(r.tracks).toEqual([{ name: 'Notes', path: '03 Projects/Alpha/Notes.md' }]) // BRAIN excluded
    const c = r.connections as ReturnType<typeof categorizeLinks>
    expect(c.people.map((x) => x.name)).toEqual(['Bob'])
    expect(c.decisions.map((x) => x.name)).toEqual(['D1'])
    expect(c.references.map((x) => x.name)).toEqual(['Ref1'])
    expect(c.projects.map((x) => x.name)).toEqual(['Beta'])
  })

  it('dedups a wikilink seen twice (case-insensitive)', () => {
    write('03 Projects/A/BRAIN.md', '# A\n[[Ref1]] and again [[ref1]] and [[REF1]]')
    write('04 Notes/Ref1.md', 'ref')
    const c = projectDetail(dir, 'A').connections as ReturnType<typeof categorizeLinks>
    expect(c.references).toHaveLength(1)
  })
})
