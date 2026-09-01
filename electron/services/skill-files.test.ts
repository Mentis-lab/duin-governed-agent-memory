import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { listSkillFiles, readSkillFile, skillRoot } from './skill-files'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-skill-files-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** The Agent Skills layout: a definition plus scripts/, references/ and assets/. */
function makeDirectorySkill(): string {
  const root = join(dir, 'researcher')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'references'), { recursive: true })
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'skill.md'), '---\nname: researcher\n---\nBody\n', 'utf-8')
  writeFileSync(join(root, 'scripts', 'fetch.py'), 'print("hi")\n', 'utf-8')
  writeFileSync(join(root, 'references', 'sources.md'), '# Sources\n', 'utf-8')
  writeFileSync(join(root, 'assets', 'template.txt'), 'TEMPLATE\n', 'utf-8')
  return join(root, 'skill.md')
}

describe('listSkillFiles — sees the whole skill, not just its siblings', () => {
  it('walks nested convention directories', () => {
    const files = listSkillFiles(makeDirectorySkill())
    const paths = files.map((f) => f.path)

    // The shallow `supportingFiles` scan the delete path uses would have returned
    // nothing here — every asset lives one level down.
    expect(paths).toEqual([
      'SKILL.md',
      'assets/template.txt',
      'references/sources.md',
      'scripts/fetch.py'
    ])
    expect(files[0].kind).toBe('text')
    expect(files.find((f) => f.path === 'scripts/fetch.py')?.size).toBeGreaterThan(0)
  })

  it('reports the definition as SKILL.md whatever the on-disk case is', () => {
    const root = join(dir, 'cased')
    mkdirSync(root, { recursive: true })
    // skill-loader treats a lowercase `skill.md` as directory mode; the browser
    // still labels it canonically so the picker never shows two spellings.
    writeFileSync(join(root, 'skill.md'), 'x', 'utf-8')
    expect(listSkillFiles(join(root, 'skill.md')).map((f) => f.path)).toEqual(['SKILL.md'])
  })

  it('treats a flat skill as a single file with no assets', () => {
    const flat = join(dir, 'deploy.md')
    writeFileSync(flat, '---\nname: deploy\n---\nBody\n', 'utf-8')
    expect(skillRoot(flat)).toBeNull()
    expect(listSkillFiles(flat).map((f) => f.path)).toEqual(['SKILL.md'])
  })

  it('skips dependency and VCS directories', () => {
    const skill = makeDirectorySkill()
    const root = join(dir, 'researcher')
    mkdirSync(join(root, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'left-pad', 'index.js'), '//\n', 'utf-8')

    expect(listSkillFiles(skill).some((f) => f.path.includes('node_modules'))).toBe(false)
  })
})

describe('readSkillFile — reads inside the skill and nowhere else', () => {
  it('returns text content for a bundled file', () => {
    const skill = makeDirectorySkill()
    expect(readSkillFile(skill, 'references/sources.md')?.text).toBe('# Sources\n')
  })

  it('refuses to escape the skill directory', () => {
    const skill = makeDirectorySkill()
    writeFileSync(join(dir, 'secret.txt'), 'not yours', 'utf-8')

    // A skill could name any path it likes in its own body; the viewer must not
    // become an arbitrary-file reader because of it.
    expect(readSkillFile(skill, '../secret.txt')).toBeNull()
    expect(readSkillFile(skill, '../../etc/passwd')).toBeNull()
  })

  it('reports oversized and binary files instead of loading them', () => {
    const root = join(dir, 'researcher')
    makeDirectorySkill()
    writeFileSync(join(root, 'assets', 'big.txt'), 'x'.repeat(600 * 1024), 'utf-8')
    writeFileSync(join(root, 'assets', 'blob.bin'), Buffer.from([0, 1, 2, 3]))

    const big = readSkillFile(join(root, 'skill.md'), 'assets/big.txt')
    expect(big?.tooLarge).toBe(true)
    expect(big?.text).toBeUndefined()

    expect(readSkillFile(join(root, 'skill.md'), 'assets/blob.bin')?.tooLarge).toBe(true)
  })

  it('returns null for a file that is not there', () => {
    expect(readSkillFile(makeDirectorySkill(), 'scripts/absent.py')).toBeNull()
  })
})
