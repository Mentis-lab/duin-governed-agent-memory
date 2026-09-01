import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

// getSkillsDir is read at call time, so a mutable module var lets each test point
// the import at a fresh temp dest dir.
let destDir = ''
vi.mock('./skill-loader', () => ({
  getSkillsDir: () => destDir
}))

import { importSkillsFromDir } from './skill-import'

const withName = (name: string, body = 'body'): string =>
  `---\nname: ${name}\ndescription: ${name} desc\n---\n${body}\n`
const noFrontmatter = (): string => 'Reference content, no frontmatter.\n'

let srcDir = ''

beforeEach(() => {
  srcDir = mkdtempSync(join(tmpdir(), 'duin-skill-src-'))
  destDir = mkdtempSync(join(tmpdir(), 'duin-skill-dest-'))
})
afterEach(() => {
  rmSync(srcDir, { recursive: true, force: true })
  rmSync(destDir, { recursive: true, force: true })
})

describe('importSkillsFromDir', () => {
  it('imports a directory-mode skill — whole dir, id = parent name', () => {
    const dir = join(srcDir, 'engineer')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), withName('engineer'))
    writeFileSync(join(dir, 'references', 'guide.md'), noFrontmatter())

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual(['engineer'])
    expect(existsSync(join(destDir, 'engineer', 'SKILL.md'))).toBe(true)
    // supporting files come along
    expect(existsSync(join(destDir, 'engineer', 'references', 'guide.md'))).toBe(true)
  })

  it('does NOT import a nested .md under a SKILL.md root as its own skill', () => {
    const dir = join(srcDir, 'biz')
    mkdirSync(join(dir, 'references'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), withName('biz'))
    // even though this reference file has a name, it is claimed by the biz unit
    writeFileSync(join(dir, 'references', 'lens.md'), withName('lens-should-not-import'))

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual(['biz'])
    expect(existsSync(join(destDir, 'lens-should-not-import.md'))).toBe(false)
  })

  it('imports a flat <id>.md skill', () => {
    writeFileSync(join(srcDir, 'compress.md'), withName('compress'))

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual(['compress'])
    expect(existsSync(join(destDir, 'compress.md'))).toBe(true)
  })

  it('skips a .md with no name frontmatter', () => {
    writeFileSync(join(srcDir, 'notes.md'), noFrontmatter())

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual([])
    expect(r.skipped.some((s) => s.reason === 'no name frontmatter')).toBe(true)
  })

  it('skips when the dest id already exists and never overwrites', () => {
    writeFileSync(join(destDir, 'engineer.md'), withName('engineer', 'EXISTING'))
    const dir = join(srcDir, 'engineer')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), withName('engineer', 'NEW'))

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual([])
    expect(r.skipped.some((s) => s.reason === 'already exists')).toBe(true)
    expect(readFileSync(join(destDir, 'engineer.md'), 'utf-8')).toContain('EXISTING')
    expect(existsSync(join(destDir, 'engineer'))).toBe(false)
  })

  it('handles a mixed folder (dir-mode + flat + skip)', () => {
    const d = join(srcDir, 'engineer')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), withName('engineer'))
    writeFileSync(join(srcDir, 'compress.md'), withName('compress'))
    writeFileSync(join(srcDir, 'readme.md'), noFrontmatter())

    const r = importSkillsFromDir(srcDir)

    expect(r.imported.sort()).toEqual(['compress', 'engineer'])
    expect(r.skipped.some((s) => s.reason === 'no name frontmatter')).toBe(true)
  })

  it('no-ops when the source IS the skills dir', () => {
    const r = importSkillsFromDir(destDir)
    expect(r.imported).toEqual([])
    expect(r.skipped[0]?.reason).toContain('DUIN skills dir')
  })
})

// ── backlog finding 12 ──────────────────────────────────────────────────────

describe('importSkillsFromDir — the exists check matches the filesystem, not the string', () => {
  it('does NOT overwrite a hand-authored skill whose id differs only by case', () => {
    // NTFS and APFS treat MySkill and myskill as the SAME directory, but the exists
    // check compared ids exactly — so a routine cross-platform export/re-zip walked
    // straight past "already exists, skip" and the copy clobbered the curated files.
    const curated = join(destDir, 'MySkill')
    mkdirSync(curated, { recursive: true })
    writeFileSync(join(curated, 'SKILL.md'), withName('MySkill', 'THE CURATED BODY'))

    const incoming = join(srcDir, 'myskill')
    mkdirSync(incoming, { recursive: true })
    writeFileSync(join(incoming, 'SKILL.md'), withName('myskill', 'THE IMPORTED BODY'))

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual([])
    expect(r.skipped.some((s) => s.reason === 'already exists')).toBe(true)
    // The assertion that matters: the authored work is still on disk, unchanged.
    expect(readFileSync(join(curated, 'SKILL.md'), 'utf-8')).toContain('THE CURATED BODY')
  })

  it('applies the same fold to flat .md skills', () => {
    writeFileSync(join(destDir, 'Helper.md'), withName('Helper', 'THE CURATED BODY'))
    writeFileSync(join(srcDir, 'helper.md'), withName('helper', 'THE IMPORTED BODY'))

    const r = importSkillsFromDir(srcDir)

    expect(r.imported).toEqual([])
    expect(readFileSync(join(destDir, 'Helper.md'), 'utf-8')).toContain('THE CURATED BODY')
  })

  // NOT tested here: two same-name-different-case units inside ONE import. The
  // in-run bookkeeping folds too (existingIds.add(foldId(id))), but the scenario
  // cannot be CONSTRUCTED on this platform — creating src/Dup and src/dup on NTFS
  // yields a single directory, which is the very filesystem behaviour this fix is
  // about. Asserting it would need a case-sensitive volume.

  it('still imports a genuinely new skill', () => {
    const d = join(srcDir, 'brandnew')
    mkdirSync(d, { recursive: true })
    writeFileSync(join(d, 'SKILL.md'), withName('brandnew'))
    expect(importSkillsFromDir(srcDir).imported).toEqual(['brandnew'])
  })
})
