// skills:update must not silently delete frontmatter the editor cannot show.
//
// The defect: the renderer's update payload has slots for exactly
// {name, description, content} (preload.ts `skills.update`, SkillsColumn's EditDrawer),
// but the handler serialized that payload over the whole file. A hand-written
// skills/deploy.md carrying `allowedTools: [Read, Grep]`, `model: claude-opus-4-8` and
// `disable-model-invocation: true` lost all three the moment the user fixed one typo in
// the body and hit Save — the skill silently widened from Read/Grep-only to every tool,
// unpinned its model and became auto-invocable again, with `{success:true}` and a green
// toast. `getSkill(id)` on the line above already held every dropped value.
//
// These tests drive the REAL registered ipcMain handler against a REAL temp directory:
// electron is mocked only for ipcMain (to capture handlers) and app.getPath (archive
// dir); skill-loader is mocked so getSkill returns a skill parsed from the temp file by
// the real parser. Power control: reverting the merge in mergeSkillUpdate makes
// "preserves ..." fail; reverting the archive makes "archives ..." fail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
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

/** Mirrors skill-loader's parseSkillFile for the fields under test, so the handler
 *  receives the same LoadedSkill shape production hands it. */
function loadSkillFromDisk(id: string): any | undefined {
  const filePath = join(skillsDir, `${id}.md`)
  if (!existsSync(filePath)) return undefined
  const parsed = matter(readFileSync(filePath, 'utf-8'))
  const d = parsed.data as Record<string, unknown>
  const allowedTools = Array.isArray(d.allowedTools ?? d['allowed-tools'])
    ? ((d.allowedTools ?? d['allowed-tools']) as string[])
    : undefined
  let autoInvoke: boolean | undefined
  if (typeof d.autoInvoke === 'boolean') autoInvoke = d.autoInvoke
  else if (typeof d['disable-model-invocation'] === 'boolean')
    autoInvoke = !(d['disable-model-invocation'] as boolean)
  return {
    id,
    name: String(d.name ?? ''),
    description: String(d.description ?? ''),
    content: parsed.content.trim(),
    filePath,
    enabled: false,
    ...(allowedTools ? { allowedTools } : {}),
    ...(typeof d.model === 'string' ? { model: d.model } : {}),
    ...(autoInvoke !== undefined ? { autoInvoke } : {})
  }
}

const HAND_WRITTEN = `---
name: Deploy
description: Ship the thing
allowedTools:
  - Read
  - Grep
model: claude-opus-4-8
disable-model-invocation: true
---

Run the deploy steps carfully.
`

const update = (id: string, payload: unknown): Promise<any> =>
  handlers.get('skills:update')!(null, id, payload)

beforeEach(() => {
  handlers.clear()
  skillsDir = mkdtempSync(join(tmpdir(), 'duin-skills-'))
  userDataDir = mkdtempSync(join(tmpdir(), 'duin-userdata-'))
  writeFileSync(join(skillsDir, 'deploy.md'), HAND_WRITTEN, 'utf-8')
  registerSkillsHandlers()
})

afterEach(() => {
  rmSync(skillsDir, { recursive: true, force: true })
  rmSync(userDataDir, { recursive: true, force: true })
})

describe('skills:update — preserves frontmatter the editor cannot express', () => {
  it('keeps allowedTools / model / autoInvoke when the 3-field payload omits them', async () => {
    const res = await update('deploy', {
      name: 'Deploy',
      description: 'Ship the thing',
      content: 'Run the deploy steps carefully.'
    })
    expect(res.success).toBe(true)

    const after = loadSkillFromDisk('deploy')!
    // The typo fix landed...
    expect(after.content).toBe('Run the deploy steps carefully.')
    // ...and the capability restriction, the model pin and the manual-only flag survived.
    expect(after.allowedTools).toEqual(['Read', 'Grep'])
    expect(after.model).toBe('claude-opus-4-8')
    expect(after.autoInvoke).toBe(false)
    expect(res.data.preservedFields).toEqual(['allowedTools', 'model', 'autoInvoke'])
  })

  it('archives the prior file bytes with a traceable sidecar before overwriting', async () => {
    const before = readFileSync(join(skillsDir, 'deploy.md'), 'utf-8')
    const res = await update('deploy', {
      name: 'Deploy',
      description: 'Ship the thing',
      content: 'Run the deploy steps carefully.'
    })
    expect(res.success).toBe(true)

    const archiveDir = join(userDataDir, 'skills-archive')
    const files = readdirSync(archiveDir)
    const md = files.filter((f) => f.endsWith('.md'))
    const meta = files.filter((f) => f.endsWith('.json'))
    expect(md).toHaveLength(1)
    expect(meta).toHaveLength(1)
    // Exact prior bytes, recoverable.
    expect(readFileSync(join(archiveDir, md[0]), 'utf-8')).toBe(before)
    const sidecar = JSON.parse(readFileSync(join(archiveDir, meta[0]), 'utf-8'))
    expect(sidecar.skillId).toBe('deploy')
    expect(sidecar.filePath).toBe(join(skillsDir, 'deploy.md'))
    expect(sidecar.reason).toBe('skills:update')
    expect(typeof sidecar.archivedAt).toBe('string')
    expect(res.data.archivePath).toBe(join(archiveDir, md[0]))
  })

  it('still lets an explicit value clear a field (create/wizard path keeps working)', async () => {
    const res = await update('deploy', {
      name: 'Deploy',
      description: 'Ship the thing',
      content: 'body',
      allowedTools: [],
      model: '',
      autoInvoke: true
    })
    expect(res.success).toBe(true)
    const after = loadSkillFromDisk('deploy')!
    expect(after.allowedTools).toBeUndefined()
    expect(after.model).toBeUndefined()
    expect(after.autoInvoke).toBe(true)
  })

  it('rejects a nameless payload instead of stripping the name off disk', async () => {
    const res = await update('deploy', { description: 'x', content: 'y' })
    expect(res.success).toBe(false)
    expect(loadSkillFromDisk('deploy')!.name).toBe('Deploy')
  })

  it('reports skill-not-found unchanged', async () => {
    const res = await update('nope', { name: 'n', description: 'd', content: 'c' })
    expect(res.success).toBe(false)
    expect(res.error).toContain('Skill not found')
  })
})
