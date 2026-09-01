import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync, rmdirSync, rmSync } from 'fs'
import { join, basename, dirname } from 'path'
import matter from 'gray-matter'
import { getSkillsDir, listSkills, getSkill, type LoadedSkill } from '../services/skill-loader'
import { importSkillsFromDir } from '../services/skill-import'
import { listSkillFiles, readSkillFile } from '../services/skill-files'
import { exportSkillZip, unpackSkillZip } from '../services/skill-package'

interface SkillInput {
  name: string
  description: string
  content: string
  allowedTools?: string[]
  model?: string
  autoInvoke?: boolean
  /** C4: when true, scaffold a directory-mode skill at
   *  `<skillsDir>/<slug>/skill.md`. When false (default), a flat
   *  `<skillsDir>/<slug>.md` file is written. */
  directoryMode?: boolean
  /** C4: when true and `directoryMode` is also true, scaffold an empty
   *  `reference.md` stub alongside `skill.md`. */
  scaffoldReference?: boolean
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return base || 'skill'
}

function uniqueId(baseSlug: string, directoryMode = false): string {
  const dir = getSkillsDir()
  const occupied = (slug: string) =>
    existsSync(join(dir, `${slug}.md`)) || existsSync(join(dir, slug))
  if (!occupied(baseSlug)) return baseSlug
  let i = 2
  while (occupied(`${baseSlug}-${i}`)) i++
  void directoryMode
  return `${baseSlug}-${i}`
}

function serializeSkill(input: SkillInput): string {
  const data: Record<string, unknown> = {
    name: input.name,
    description: input.description
  }
  if (input.allowedTools && input.allowedTools.length) data.allowedTools = input.allowedTools
  if (input.model) data.model = input.model
  if (typeof input.autoInvoke === 'boolean') data.autoInvoke = input.autoInvoke
  return matter.stringify(input.content.trim() + '\n', data)
}

/** Copy the current bytes of a skill file into `userData/skills-archive/` before an
 *  overwrite OR a delete, plus a JSON sidecar saying which id/path they came from and
 *  which frontmatter fields the update carried. Mirrors archiveConversation
 *  (ipc/conversation.ts): the write is destructive, user-invoked and unconfirmed, so
 *  the prior content has to survive it somewhere traceable. Throws if the archive
 *  cannot be written — the caller then abandons the save/delete rather than destroying
 *  content it failed to preserve.
 *
 *  `extraFiles` (absolute paths) carries a directory-mode skill's siblings — the
 *  `reference.md`-style files discovered by skill-loader's discoverSupportingFiles —
 *  into the SAME timestamped archive set as `<stamp>--<basename>`, so a deleted
 *  directory skill can be reconstructed whole rather than leaving an orphan directory
 *  whose skill.md is gone. */
function archiveSkillFile(
  id: string,
  filePath: string,
  meta: Record<string, unknown>,
  extraFiles: string[] = []
): string {
  // Nothing on disk to preserve (file removed out from under the loader) — the
  // write below is a create, not an overwrite.
  if (!existsSync(filePath)) return ''
  const dir = join(app.getPath('userData'), 'skills-archive')
  mkdirSync(dir, { recursive: true })
  const stamp = `${id.replace(/[^a-zA-Z0-9._-]+/g, '_')}-${Date.now()}`
  const path = join(dir, `${stamp}.md`)
  writeFileSync(path, readFileSync(filePath, 'utf-8'), 'utf-8')
  // Siblings first-class in the same set: a failure here throws like the main copy,
  // so the caller abandons rather than half-preserving the skill.
  const archivedSupportingFiles: string[] = []
  for (const extra of extraFiles) {
    if (!existsSync(extra)) continue
    const name = `${stamp}--${basename(extra)}`
    writeFileSync(join(dir, name), readFileSync(extra))
    archivedSupportingFiles.push(name)
  }
  writeFileSync(
    join(dir, `${stamp}.json`),
    JSON.stringify(
      {
        skillId: id,
        filePath,
        archivedAt: new Date().toISOString(),
        ...meta,
        ...(archivedSupportingFiles.length ? { archivedSupportingFiles } : {})
      },
      null,
      2
    ),
    'utf-8'
  )
  return path
}

/** The renderer's update payload has slots for exactly `{name, description, content}`
 *  (preload.ts `skills.update`, SkillsColumn's EditDrawer), so an ABSENT optional key
 *  means "the editor never saw this field", NOT "the user cleared it". Serializing the
 *  raw payload therefore erased `allowedTools` / `model` / `disable-model-invocation`
 *  from hand-written skill files on a completely normal save — silently widening a
 *  Read/Grep-only skill to every tool, unpinning its model, and flipping it back to
 *  auto-invocable. Carry the parsed on-disk values forward when the input omits them;
 *  clearing stays possible but now requires an explicit value (`[]`, `''`, a boolean),
 *  which only the create/wizard path supplies. */
function mergeSkillUpdate(
  existing: LoadedSkill,
  input: SkillInput
): { merged: SkillInput; preserved: string[] } {
  const preserved: string[] = []
  const merged: SkillInput = {
    ...input,
    // A payload with no usable content must not truncate the file body either.
    content: typeof input.content === 'string' ? input.content : existing.content
  }
  if (input.allowedTools === undefined && existing.allowedTools?.length) {
    merged.allowedTools = existing.allowedTools
    preserved.push('allowedTools')
  }
  if (input.model === undefined && existing.model) {
    merged.model = existing.model
    preserved.push('model')
  }
  if (typeof input.autoInvoke !== 'boolean' && typeof existing.autoInvoke === 'boolean') {
    merged.autoInvoke = existing.autoInvoke
    preserved.push('autoInvoke')
  }
  return { merged, preserved }
}

export function registerSkillsHandlers(): void {
  ipcMain.handle('skills:list', async () => {
    try {
      return { success: true, data: listSkills() }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('skills:create', async (_event, skill: SkillInput) => {
    try {
      if (!skill?.name || typeof skill.name !== 'string') {
        return { success: false, error: 'Skill name is required' }
      }
      const id = uniqueId(slugify(skill.name), skill.directoryMode)
      const skillsDir = getSkillsDir()
      let filePath: string
      const supportingFiles: string[] = []
      if (skill.directoryMode) {
        const dir = join(skillsDir, id)
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        filePath = join(dir, 'skill.md')
        writeFileSync(filePath, serializeSkill(skill), 'utf-8')
        if (skill.scaffoldReference) {
          const refPath = join(dir, 'reference.md')
          if (!existsSync(refPath)) {
            writeFileSync(
              refPath,
              `# Reference notes for ${skill.name}\n\nLong-form notes the agent reads only when this skill needs them.\n`,
              'utf-8'
            )
            supportingFiles.push('reference.md')
          }
        }
      } else {
        filePath = join(skillsDir, `${id}.md`)
        writeFileSync(filePath, serializeSkill(skill), 'utf-8')
      }
      return {
        success: true,
        data: {
          id,
          name: skill.name,
          description: skill.description,
          content: skill.content,
          filePath,
          enabled: false,
          ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
          ...(skill.model ? { model: skill.model } : {}),
          ...(typeof skill.autoInvoke === 'boolean' ? { autoInvoke: skill.autoInvoke } : {}),
          ...(supportingFiles.length ? { supportingFiles } : {})
        }
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('skills:update', async (_event, id: string, skill: SkillInput) => {
    try {
      const existing = getSkill(id)
      if (!existing) return { success: false, error: `Skill not found: ${id}` }
      // Same input guard the sibling create handler already applies — an update
      // rewrites the whole file, so a nameless payload would strip the one field
      // skill-loader requires and make the skill disappear from the list.
      if (!skill?.name || typeof skill.name !== 'string') {
        return { success: false, error: 'Skill name is required' }
      }
      const { merged, preserved } = mergeSkillUpdate(existing, skill)
      let archivePath: string
      try {
        archivePath = archiveSkillFile(id, existing.filePath, {
          reason: 'skills:update',
          preservedFields: preserved,
          previousName: existing.name
        })
      } catch (e) {
        return {
          success: false,
          error: `Could not archive the previous skill file before saving: ${(e as Error).message}`
        }
      }
      writeFileSync(existing.filePath, serializeSkill(merged), 'utf-8')
      return { success: true, data: { archivePath, preservedFields: preserved } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // A delete is strictly MORE destructive than the update above, so it cannot be the
  // one call site that skips archiveSkillFile. It used to be: `unlinkSync` ran bare and
  // a hand-written skill (curated body + allowedTools/model frontmatter) left no copy
  // anywhere — no archive, no tombstone, no journal line — while skills:update three
  // lines up archived the same bytes and even refused to save when archiving failed.
  // The realistic trigger is mis-targeting: SkillPanel lists several near-identical
  // names, the confirm only promises "the .md file will be removed", and the toast says
  // `Skill "X" deleted` without hinting that recovery is impossible. Bundled skills are
  // reseeded from resourcesPath on next launch by skill-loader's ensureSkillsDir, but a
  // skill made via skills:create or hand-dropped into userData/skills has no bundled
  // counterpart and was gone for good. Same preserve+record+stamp posture as
  // memory-store's clearAllMemories ("behind a UI confirm, but still hand-authored
  // content — tombstone it"): archive first, and abandon the delete if archiving fails.
  ipcMain.handle('skills:delete', async (_event, id: string) => {
    try {
      const existing = getSkill(id)
      if (!existing) return { success: false, error: `Skill not found: ${id}` }
      // Directory-mode skills live at `<dir>/skill.md`; unlinking only that leaves an
      // orphan directory holding reference.md with no definition to support — and the
      // leftover directory keeps `uniqueId()` from reusing the slug.
      const directoryMode = basename(existing.filePath).toLowerCase() === 'skill.md'
      const skillDir = dirname(existing.filePath)
      const supporting =
        directoryMode && existing.supportingFiles?.length
          ? existing.supportingFiles.map((f) => join(skillDir, f))
          : []
      let archivePath: string
      try {
        archivePath = archiveSkillFile(
          id,
          existing.filePath,
          {
            reason: 'skills:delete',
            previousName: existing.name,
            ...(directoryMode ? { directoryMode: true, skillDir } : {}),
            ...(existing.supportingFiles?.length
              ? { supportingFiles: existing.supportingFiles }
              : {})
          },
          supporting
        )
      } catch (e) {
        return {
          success: false,
          error: `Could not archive the skill before deleting it: ${(e as Error).message}`
        }
      }
      unlinkSync(existing.filePath)
      if (directoryMode) {
        // Every sibling is inside the archive set above, so removing them is
        // recoverable. rmdirSync (non-recursive) is deliberate: if anything the
        // archive did NOT capture is still in there — a nested subdirectory —
        // it throws and we leave the directory alone rather than destroying it.
        try {
          for (const file of supporting) {
            if (existsSync(file)) unlinkSync(file)
          }
          rmdirSync(skillDir)
        } catch {
          // Orphan directory survives; the skill definition is already archived.
        }
      }
      return { success: true, data: { archivePath } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Import skills from ANY folder (Claude Code, a vault `.claude/skills`, another
  // agent's skill collection). Copies flat `<id>.md` + directory-mode `<id>/SKILL.md`
  // units into the DUIN skills dir; the loader's watcher live-reloads them. Never
  // overwrites an existing skill.
  ipcMain.handle('skills:pickAndImport', async (event) => {
    try {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        properties: ['openDirectory' as const],
        title: 'Choose a folder of skills to import'
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, data: { imported: [], skipped: [], dir: null, canceled: true } }
      }
      const dir = picked.filePaths[0]
      const result = importSkillsFromDir(dir)
      return { success: true, data: { ...result, dir, canceled: false } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('skills:importFromDir', async (_event, dir: string) => {
    try {
      if (!dir || typeof dir !== 'string') return { success: false, error: 'A source folder is required' }
      const result = importSkillsFromDir(dir)
      return { success: true, data: { ...result, dir, canceled: false } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Browse a skill's bundled assets. Walks the whole skill directory, so the
  // `scripts/` + `references/` + `assets/` layout the Agent Skills convention
  // produces is visible — unlike `supportingFiles`, which stays shallow because the
  // delete path only archives what it lists.
  ipcMain.handle('skills:listFiles', async (_event, id: string) => {
    try {
      const skill = getSkill(id)
      if (!skill) return { success: false, error: `Skill not found: ${id}` }
      return { success: true, data: listSkillFiles(skill.filePath) }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  ipcMain.handle('skills:readFile', async (_event, id: string, relPath: string) => {
    try {
      const skill = getSkill(id)
      if (!skill) return { success: false, error: `Skill not found: ${id}` }
      if (!relPath || typeof relPath !== 'string') {
        return { success: false, error: 'A file path is required' }
      }
      const file = readSkillFile(skill.filePath, relPath)
      if (!file) return { success: false, error: `No such file in this skill: ${relPath}` }
      return { success: true, data: file }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // Package a skill as a .zip the user can hand to someone else — the whole
  // directory, assets included, so the bundle is the skill rather than just its
  // definition. Flat skills export as a one-file zip.
  ipcMain.handle('skills:export', async (event, id: string) => {
    try {
      const skill = getSkill(id)
      if (!skill) return { success: false, error: `Skill not found: ${id}` }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        title: 'Export skill',
        defaultPath: `${id}.zip`,
        filters: [{ name: 'Skill package', extensions: ['zip'] }]
      }
      const picked = parent
        ? await dialog.showSaveDialog(parent, opts)
        : await dialog.showSaveDialog(opts)
      if (picked.canceled || !picked.filePath) {
        return { success: true, data: { canceled: true, path: null, files: 0 } }
      }
      const written = await exportSkillZip(skill, picked.filePath)
      return { success: true, data: { canceled: false, path: picked.filePath, files: written } }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })

  // The inverse: unpack a .zip into the skills dir. Reuses importSkillsFromDir so a
  // package gets the exact same validation and never-overwrite rule as a folder import.
  ipcMain.handle('skills:importPackage', async (event) => {
    try {
      const parent = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        properties: ['openFile' as const],
        title: 'Choose a skill package (.zip)',
        filters: [{ name: 'Skill package', extensions: ['zip'] }]
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, data: { imported: [], skipped: [], dir: null, canceled: true } }
      }
      const staged = await unpackSkillZip(picked.filePaths[0])
      try {
        const result = importSkillsFromDir(staged)
        return { success: true, data: { ...result, dir: picked.filePaths[0], canceled: false } }
      } finally {
        rmSync(staged, { recursive: true, force: true })
      }
    } catch (err) {
      return { success: false, error: (err as Error).message }
    }
  })
}
