// skill-loader-seed.test.ts — the three states a bundled skill can be in.
//
// Before 2026-08-17 seeding was "copy if the destination does not exist", which
// got two of the three wrong: deleting a bundled skill did not stick (the next
// launch copied it back, while the delete toast claimed the file was archived
// and gone), and a bundled skill could never be improved (once seeded, a shipped
// fix could not reach an existing install, silently, forever).
//
// These tests pin all three. They are the reason the manifest exists.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => join(process.cwd(), '.tmp-test-user-data') },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

import { __skillLoaderTest } from './skill-loader'

const { ensureSkillsDir, BUNDLED_MANIFEST } = __skillLoaderTest

let bundled = ''
let userDir = ''

const SKILL_V1 = '---\nname: Recall\ndescription: v1\n---\nFirst version.\n'
const SKILL_V2 = '---\nname: Recall\ndescription: v2\n---\nSecond version, shipped later.\n'

beforeEach(() => {
  bundled = mkdtempSync(join(tmpdir(), 'duin-bundled-'))
  userDir = mkdtempSync(join(tmpdir(), 'duin-userskills-'))
  writeFileSync(join(bundled, 'recall.md'), SKILL_V1, 'utf-8')
  mkdirSync(join(bundled, 'produce'), { recursive: true })
  writeFileSync(join(bundled, 'produce', 'SKILL.md'), '---\nname: Produce\ndescription: d\n---\nBody.\n', 'utf-8')
  writeFileSync(join(bundled, 'produce', 'reference.md'), 'Supporting notes.\n', 'utf-8')
})

afterEach(() => {
  rmSync(bundled, { recursive: true, force: true })
  rmSync(userDir, { recursive: true, force: true })
})

const manifest = (): Record<string, string> =>
  JSON.parse(readFileSync(join(userDir, BUNDLED_MANIFEST), 'utf-8')).seeded

describe('bundled skill seeding', () => {
  it('seeds every bundled file on first run, including directory-mode siblings', () => {
    ensureSkillsDir(userDir, bundled)

    expect(readFileSync(join(userDir, 'recall.md'), 'utf-8')).toBe(SKILL_V1)
    expect(readFileSync(join(userDir, 'produce', 'SKILL.md'), 'utf-8')).toContain('Body.')
    // Supporting files are NOT inlined into the prompt, so a seeder that skipped
    // them would leave a directory skill referencing a file that isn't there.
    expect(readFileSync(join(userDir, 'produce', 'reference.md'), 'utf-8')).toContain('Supporting')
    expect(Object.keys(manifest()).sort()).toEqual([
      'produce/SKILL.md',
      'produce/reference.md',
      'recall.md'
    ])
  })

  it('does not resurrect a bundled skill the operator deleted', () => {
    ensureSkillsDir(userDir, bundled)
    rmSync(join(userDir, 'recall.md'))

    ensureSkillsDir(userDir, bundled)
    expect(existsSync(join(userDir, 'recall.md'))).toBe(false)

    // And it stays deleted on every later launch, not just the next one.
    ensureSkillsDir(userDir, bundled)
    ensureSkillsDir(userDir, bundled)
    expect(existsSync(join(userDir, 'recall.md'))).toBe(false)
  })

  it('delivers a bundled update to a skill the operator never touched', () => {
    ensureSkillsDir(userDir, bundled)
    writeFileSync(join(bundled, 'recall.md'), SKILL_V2, 'utf-8')

    ensureSkillsDir(userDir, bundled)
    expect(readFileSync(join(userDir, 'recall.md'), 'utf-8')).toBe(SKILL_V2)
  })

  it('never clobbers a bundled skill the operator edited, even when the bundle moves on', () => {
    ensureSkillsDir(userDir, bundled)
    const mine = '---\nname: Recall\ndescription: mine\n---\nMy own wording.\n'
    writeFileSync(join(userDir, 'recall.md'), mine, 'utf-8')

    writeFileSync(join(bundled, 'recall.md'), SKILL_V2, 'utf-8')
    ensureSkillsDir(userDir, bundled)
    expect(readFileSync(join(userDir, 'recall.md'), 'utf-8')).toBe(mine)

    // Still theirs after a further bundled revision — the divergence is
    // remembered, not re-evaluated against whatever shipped most recently.
    writeFileSync(join(bundled, 'recall.md'), SKILL_V1 + '\nthird revision\n', 'utf-8')
    ensureSkillsDir(userDir, bundled)
    expect(readFileSync(join(userDir, 'recall.md'), 'utf-8')).toBe(mine)
  })

  it('re-seeds rather than crashing when the manifest is unreadable', () => {
    ensureSkillsDir(userDir, bundled)
    writeFileSync(join(userDir, BUNDLED_MANIFEST), '{ not json', 'utf-8')
    rmSync(join(userDir, 'recall.md'))

    expect(() => ensureSkillsDir(userDir, bundled)).not.toThrow()
    // A corrupt manifest loses the deletion record, so the file comes back.
    // That is the deliberate trade: one unwanted re-seed beats losing the dir.
    expect(existsSync(join(userDir, 'recall.md'))).toBe(true)
  })

  it('is a no-op when the skills dir IS the bundle (dev)', () => {
    ensureSkillsDir(bundled, bundled)
    expect(existsSync(join(bundled, BUNDLED_MANIFEST))).toBe(false)
  })
})

describe('directory-mode skills own their siblings', () => {
  it('does not register a supporting file as a skill of its own', () => {
    // A supporting file that happens to carry `name:` frontmatter used to
    // register as a top-level skill with its BASENAME as the id — so two
    // directory skills each shipping a `reference.md` collided, and whichever
    // was scanned last silently replaced the other.
    writeFileSync(
      join(bundled, 'produce', 'reference.md'),
      '---\nname: Reference\ndescription: not a skill\n---\nNotes.\n',
      'utf-8'
    )
    const found = __skillLoaderTest.discoverSkillFiles(bundled).map((f) => f.replace(/\\/g, '/'))

    expect(found.some((f) => f.endsWith('produce/SKILL.md'))).toBe(true)
    expect(found.some((f) => f.endsWith('produce/reference.md'))).toBe(false)
    // Flat skills at the top level are unaffected.
    expect(found.some((f) => f.endsWith('recall.md'))).toBe(true)
  })
})
