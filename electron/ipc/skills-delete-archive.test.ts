// skills:delete must not destroy hand-authored skill files without preserving them.
//
// The defect: `skills:delete` was four lines — getSkill(id) then a bare
// `unlinkSync(existing.filePath)` — while `archiveSkillFile()`, defined in the SAME
// file and called by the sibling `skills:update` handler three lines up, copies the
// prior bytes to `userData/skills-archive/<id>-<ts>.md` plus a JSON sidecar and even
// REFUSES to save when archiving throws. Exactly one call site skipped the guard.
//
// The scenario: SkillPanel lists several near-identical names; the user picks the wrong
// one, accepts `confirm("Delete skill ...? The .md file will be removed.")`, and a
// curated body with `allowedTools` / `model` frontmatter is gone from disk with no
// archive entry, no .trash tombstone and no journal line. Bundled skills get reseeded
// from resourcesPath on next launch (skill-loader's ensureSkillsDir), but a skill made
// via skills:create or hand-dropped into userData/skills has no bundled counterpart.
// In directory mode only `<dir>/skill.md` was unlinked, leaving an orphan directory
// holding reference.md and blocking slug reuse in uniqueId().
//
// These tests drive the REAL registered ipcMain handler against a REAL temp directory,
// same harness as skills-update-preserve.test.ts: electron is mocked only for ipcMain
// (to capture handlers) and app.getPath (archive dir); skill-loader is mocked so
// getSkill returns a skill parsed from the temp file.
//
// Power control: restoring the bare `unlinkSync(existing.filePath)` makes
// "archives the exact prior bytes" and both directory-mode assertions FAIL.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  statSync,
  chmodSync
} from 'fs'
import { join, basename, dirname } from 'path'
import { tmpdir } from 'os'
import matter from 'gray-matter'

let skillsDir = ''
let userDataDir = ''

type Handler = (event: unknown, ...args: any[]) => Promise<any>
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn)
    }
  },
  app: { getPath: () => userDataDir },
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('../services/skill-loader', () => ({
  getSkillsDir: () => skillsDir,
  listSkills: () => [],
  getSkill: (id: string) => loadSkillFromDisk(id)
}))

import { registerSkillsHandlers } from './skills'

/** Mirrors skill-loader's parseSkillFile + discoverSupportingFiles for the fields under
 *  test, so the handler receives the LoadedSkill shape production hands it — including
 *  the directory-mode `<dir>/skill.md` layout and its siblings. */
function loadSkillFromDisk(id: string): any | undefined {
  const flat = join(skillsDir, `${id}.md`)
  const nested = join(skillsDir, id, 'skill.md')
  const filePath = existsSync(flat) ? flat : existsSync(nested) ? nested : ''
  if (!filePath) return undefined
  const parsed = matter(readFileSync(filePath, 'utf-8'))
  const d = parsed.data as Record<string, unknown>
  let supportingFiles: string[] | undefined
  if (basename(filePath).toLowerCase() === 'skill.md') {
    // Production filters to regular FILES — nested subdirectories are never
    // supportingFiles, which is why the handler must not assume the directory is empty
    // once the listed siblings are gone.
    const siblings = readdirSync(dirname(filePath)).filter(
      (f) => f.toLowerCase() !== 'skill.md' && statSync(join(dirname(filePath), f)).isFile()
    )
    if (siblings.length) supportingFiles = siblings.sort()
  }
  return {
    id,
    name: String(d.name ?? ''),
    description: String(d.description ?? ''),
    content: parsed.content.trim(),
    filePath,
    enabled: false,
    ...(Array.isArray(d.allowedTools) ? { allowedTools: d.allowedTools as string[] } : {}),
    ...(typeof d.model === 'string' ? { model: d.model } : {}),
    ...(supportingFiles ? { supportingFiles } : {})
  }
}

const HAND_WRITTEN = `---
name: Deploy
description: Ship the thing
allowedTools:
  - Read
  - Grep
model: claude-opus-4-8
---

Curated deploy runbook the user typed by hand.
`

const del = (id: string): Promise<any> => handlers.get('skills:delete')!(null, id)

const archiveDir = (): string => join(userDataDir, 'skills-archive')

beforeEach(() => {
  handlers.clear()
  skillsDir = mkdtempSync(join(tmpdir(), 'duin-skills-del-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-userdata-del-'))
  writeFileSync(join(skillsDir, 'deploy.md'), HAND_WRITTEN, 'utf-8')
  registerSkillsHandlers()
})

afterEach(() => {
  try {
    chmodSync(userDataDir, 0o700)
  } catch {
    /* only set in the archive-failure test */
  }
  rmSync(skillsDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('skills:delete — preserves the deleted skill somewhere traceable', () => {
  it('archives the exact prior bytes plus a sidecar before unlinking', async () => {
    const before = readFileSync(join(skillsDir, 'deploy.md'), 'utf-8')

    const res = await del('deploy')
    expect(res.success).toBe(true)

    // The delete really happened...
    expect(existsSync(join(skillsDir, 'deploy.md'))).toBe(false)

    // ...but a byte-identical copy survives. Before the fix the archive dir did not
    // even exist: `archive dir exists? false`, `userData contents: []`.
    const files = readdirSync(archiveDir())
    const md = files.filter((f) => f.endsWith('.md'))
    const meta = files.filter((f) => f.endsWith('.json'))
    expect(md).toHaveLength(1)
    expect(meta).toHaveLength(1)
    expect(readFileSync(join(archiveDir(), md[0]), 'utf-8')).toBe(before)
    // The frontmatter the editor cannot express is recoverable from the archive.
    expect(readFileSync(join(archiveDir(), md[0]), 'utf-8')).toContain('model: claude-opus-4-8')

    // Traceable: what was removed, when, why, and from where.
    const sidecar = JSON.parse(readFileSync(join(archiveDir(), meta[0]), 'utf-8'))
    expect(sidecar.skillId).toBe('deploy')
    expect(sidecar.filePath).toBe(join(skillsDir, 'deploy.md'))
    expect(sidecar.reason).toBe('skills:delete')
    expect(sidecar.previousName).toBe('Deploy')
    expect(typeof sidecar.archivedAt).toBe('string')

    // Surfaced to the renderer so the toast can say where the copy went.
    expect(res.data.archivePath).toBe(join(archiveDir(), md[0]))
  })

  it('archives directory-mode siblings and clears the orphan directory', async () => {
    const dir = join(skillsDir, 'bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'skill.md'), HAND_WRITTEN, 'utf-8')
    writeFileSync(join(dir, 'reference.md'), '# Long-form reference notes\n', 'utf-8')

    const res = await del('bundle')
    expect(res.success).toBe(true)

    // Before the fix: `skill.md gone? true`, `dir still exists? true`,
    // `orphan dir contents: ['reference.md']` — the supported definition unreconstructable
    // and the leftover directory blocking slug reuse in uniqueId().
    expect(existsSync(dir)).toBe(false)

    const files = readdirSync(archiveDir())
    const meta = files.find((f) => f.endsWith('.json'))!
    const sidecar = JSON.parse(readFileSync(join(archiveDir(), meta), 'utf-8'))
    expect(sidecar.directoryMode).toBe(true)
    expect(sidecar.supportingFiles).toEqual(['reference.md'])
    // The sibling's bytes are in the same timestamped archive set, not just named in it.
    expect(sidecar.archivedSupportingFiles).toHaveLength(1)
    expect(
      readFileSync(join(archiveDir(), sidecar.archivedSupportingFiles[0]), 'utf-8')
    ).toBe('# Long-form reference notes\n')
  })

  it('leaves a nested subdirectory alone rather than destroying what it did not archive', async () => {
    const dir = join(skillsDir, 'nested')
    mkdirSync(join(dir, 'assets'), { recursive: true })
    writeFileSync(join(dir, 'skill.md'), HAND_WRITTEN, 'utf-8')
    writeFileSync(join(dir, 'assets', 'diagram.txt'), 'not captured by supportingFiles', 'utf-8')

    const res = await del('nested')
    expect(res.success).toBe(true)
    // skill.md is archived and removed, but the un-archived nested content survives —
    // rmdirSync is non-recursive on purpose.
    expect(existsSync(join(dir, 'skill.md'))).toBe(false)
    expect(readFileSync(join(dir, 'assets', 'diagram.txt'), 'utf-8')).toBe(
      'not captured by supportingFiles'
    )
  })

  it('abandons the delete when the skill cannot be archived', async () => {
    // Same posture as skills:update, which refuses to save when archiving throws.
    // Force the archive write to fail by planting a FILE where the archive DIR must go,
    // so mkdirSync(dir, {recursive:true}) throws ENOTDIR/EEXIST.
    writeFileSync(archiveDir(), 'not a directory', 'utf-8')

    const res = await del('deploy')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Could not archive')
    // The point: the file is STILL THERE. A failed preserve must not become a delete.
    expect(existsSync(join(skillsDir, 'deploy.md'))).toBe(true)
    expect(readFileSync(join(skillsDir, 'deploy.md'), 'utf-8')).toBe(HAND_WRITTEN)
  })

  it('reports skill-not-found unchanged', async () => {
    const res = await del('nope')
    expect(res.success).toBe(false)
    expect(res.error).toContain('Skill not found')
  })
})
