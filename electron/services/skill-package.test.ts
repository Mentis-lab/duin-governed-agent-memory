import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import JSZip from 'jszip'

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import { exportSkillZip, unpackSkillZip } from './skill-package'

let dir: string
let userDataDir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'duin-skill-pkg-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-pkg-userdata-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

function makeSkill(): { filePath: string; root: string } {
  const root = join(dir, 'researcher')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'references'), { recursive: true })
  writeFileSync(join(root, 'skill.md'), '---\nname: researcher\n---\nBody\n', 'utf-8')
  writeFileSync(join(root, 'scripts', 'fetch.py'), 'print("hi")\n', 'utf-8')
  writeFileSync(join(root, 'references', 'sources.md'), '# Sources\n', 'utf-8')
  return { filePath: join(root, 'skill.md'), root }
}

const skill = (filePath: string, id = 'researcher') =>
  ({ id, name: 'researcher', description: '', content: '', filePath, enabled: false }) as never

describe('exportSkillZip — the package IS the skill, assets included', () => {
  it('writes every bundled file under one top-level directory named for the skill', async () => {
    const { filePath } = makeSkill()
    const dest = join(dir, 'out.zip')

    const written = await exportSkillZip(skill(filePath), dest)
    expect(written).toBe(3)

    const zip = await JSZip.loadAsync(readFileSync(dest))
    const names = Object.keys(zip.files)
      .filter((n) => !zip.files[n].dir)
      .sort()

    // The Skills API and claude.ai both want the skill folder as the archive root,
    // so a package exported here uploads to either without repacking.
    expect(names).toEqual([
      'researcher/SKILL.md',
      'researcher/references/sources.md',
      'researcher/scripts/fetch.py'
    ])
    expect(await zip.file('researcher/scripts/fetch.py')!.async('string')).toBe('print("hi")\n')
  })

  it('strips a plugin namespace from the package directory name', async () => {
    const { filePath } = makeSkill()
    const dest = join(dir, 'ns.zip')
    await exportSkillZip(skill(filePath, 'acme-pack:researcher'), dest)

    const zip = await JSZip.loadAsync(readFileSync(dest))
    // `:` is not a legal path character and the spec's name rule is [a-z0-9-].
    expect(Object.keys(zip.files).every((n) => !n.includes(':'))).toBe(true)
    expect(Object.keys(zip.files).some((n) => n.startsWith('researcher/'))).toBe(true)
  })
})

describe('unpackSkillZip — staging a package for the normal importer', () => {
  it('round-trips an exported package back to the same file set', async () => {
    const { filePath } = makeSkill()
    const dest = join(dir, 'rt.zip')
    await exportSkillZip(skill(filePath), dest)

    const staged = await unpackSkillZip(dest)
    try {
      expect(existsSync(join(staged, 'researcher', 'SKILL.md'))).toBe(true)
      expect(readFileSync(join(staged, 'researcher', 'scripts', 'fetch.py'), 'utf-8')).toBe(
        'print("hi")\n'
      )
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  })

  it('nests a root-level SKILL.md so the importer sees a directory skill', async () => {
    const zip = new JSZip()
    zip.file('SKILL.md', '---\nname: bare\n---\nBody\n')
    const dest = join(dir, 'bare.zip')
    writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer' }))

    const staged = await unpackSkillZip(dest)
    try {
      expect(existsSync(join(staged, 'bare', 'SKILL.md'))).toBe(true)
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  })

  it('refuses entries that would escape the staging directory', async () => {
    const zip = new JSZip()
    zip.file('evil/SKILL.md', '---\nname: evil\n---\n')
    // Zip-slip: without containment this lands outside the staging dir entirely.
    zip.file('../../pwned.txt', 'owned')
    const dest = join(dir, 'evil.zip')
    writeFileSync(dest, await zip.generateAsync({ type: 'nodebuffer' }))

    const staged = await unpackSkillZip(dest)
    try {
      expect(existsSync(join(staged, 'evil', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(dir, 'pwned.txt'))).toBe(false)
      expect(existsSync(join(staged, '..', '..', 'pwned.txt'))).toBe(false)
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  })

  it('rejects an empty package rather than staging nothing', async () => {
    const dest = join(dir, 'empty.zip')
    writeFileSync(dest, await new JSZip().generateAsync({ type: 'nodebuffer' }))
    await expect(unpackSkillZip(dest)).rejects.toThrow(/empty/i)
  })
})
