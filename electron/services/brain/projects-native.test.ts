import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { listProjects, projectDesc } from './projects-native'

// Deep correctness proven by live parity (parity.ts /state/projects → EXACT). These lock
// the arena-first branch + the contracts.
describe('projects-native', () => {
  it('projectDesc: first H1 wins; else first non-"---" line (frontmatter NOT parsed, matches Python)', () => {
    expect(projectDesc('---\na: b\n---\n# The Hub\nbody')).toBe('The Hub')
    expect(projectDesc('plain first line\nsecond')).toBe('plain first line')
    expect(projectDesc('---\na: b\n---\nx')).toBe('a: b') // Python only skips '---' lines, so the first fm line is returned
    expect(projectDesc('')).toBe('')
  })

  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-proj-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('arena-first: top-level dirs as projects (skips DUIN/_/.); desc + recursive .md count', () => {
    mkdirSync(join(vault, '北澜', 'sub'), { recursive: true })
    writeFileSync(join(vault, '北澜', 'BRAIN.md'), '# 北澜 Hub\n')
    writeFileSync(join(vault, '北澜', 'a.md'), 'x')
    writeFileSync(join(vault, '北澜', 'sub', 'b.md'), 'y')
    mkdirSync(join(vault, 'DUIN'), { recursive: true }) // skipped
    const rows = listProjects(vault)
    const wy = rows.find((r) => r.name === '北澜')!
    expect(wy.desc).toBe('北澜 Hub')
    expect(wy.tracks).toBe(3) // BRAIN.md + a.md + sub/b.md, recursive
    expect(rows.some((r) => r.name === 'DUIN')).toBe(false)
  })

  it('arena-first: rejects doc/container folders + numbered pillars, skips empty candidates (P0-1)', () => {
    // A real arena that holds a note → surfaces.
    mkdirSync(join(vault, '北澜'), { recursive: true })
    writeFileSync(join(vault, '北澜', 'a.md'), 'x')
    // Doc/system containers that hold notes must NOT surface as projects.
    for (const container of ['Documents', 'Outputs', 'DUIN-Docs', '04 Notes']) {
      mkdirSync(join(vault, container), { recursive: true })
      writeFileSync(join(vault, container, 'note.md'), 'y')
    }
    // A candidate-named folder with NO notes is skipped (tracks === 0).
    mkdirSync(join(vault, 'EmptyArena'), { recursive: true })

    expect(listProjects(vault).map((r) => r.name)).toEqual(['北澜'])
  })

  it('null vault → empty', () => {
    expect(listProjects(null)).toEqual([])
  })
})
