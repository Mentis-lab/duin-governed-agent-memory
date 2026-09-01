import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from 'path'
import matter from 'gray-matter'
import { readSettings } from '../services/settings-helper'
import { listWorkflows } from '../services/brain/workflows-native'
import { installedSkillNames } from '../services/skill-loader'
import { messageOf } from '../services/guarded'

// Methods are `type: method` notes in the user's vault: a deliverable, the skills it
// composes, and the steps. They were readable and runnable but not authorable — no
// create, edit, delete or import anywhere in the app, so the only way to get one was
// to hand-write a note in the right shape. These handlers mirror the skills family so
// the Customize column can offer the same flow.
//
// Everything writes into the VAULT, not userData: both readers (listWorkflows and
// prepareMethodRun) walk the vault, so a method stored anywhere else would be invisible
// the moment it was saved.

/** Methods live together in one folder so they are findable by hand too. Must not
 *  contain "template" — the method walk skips any path that does. */
const METHODS_DIR = 'Methods'

interface MethodInput {
  name: string
  description?: string
  deliverable?: string
  callsSkills?: string[]
  content?: string
}

function vaultDir(): string | null {
  try {
    return (readSettings().localBrainNotesDir as string) || null
  } catch {
    return null
  }
}

const NO_VAULT =
  'No vault is set up yet. Choose your notes folder in Settings → Brain, then methods can be saved there.'

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    // The method walk skips any path containing "template", so a method the user
    // happens to call "Template for debriefs" would save fine and then never appear.
    // The display name lives in frontmatter, so the filename can drop the word.
    .replace(/template/g, 'tmpl')
    .replace(/^-+|-+$/g, '')
  return base || 'method'
}

/** Resolve a vault-relative path, refusing anything that climbs out. Mirrors the guard
 *  in method-run.ts — a path from the renderer must never reach a file outside the vault. */
function resolveInVault(vault: string, rel: string): string | null {
  if (!rel || typeof rel !== 'string') return null
  if (isAbsolute(rel) || normalize(rel).startsWith('..')) return null
  const target = resolve(vault, rel)
  const base = resolve(vault)
  if (target !== base && !target.startsWith(base + sep)) return null
  return target
}

function methodsRoot(vault: string): string {
  const dir = join(vault, METHODS_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function uniquePath(dir: string, slug: string): string {
  if (!existsSync(join(dir, `m-${slug}.md`))) return join(dir, `m-${slug}.md`)
  let i = 2
  while (existsSync(join(dir, `m-${slug}-${i}.md`))) i++
  return join(dir, `m-${slug}-${i}.md`)
}

/** `prepareMethodRun` lifts the `## Steps` section verbatim into the run prompt, so the
 *  heading has to be exactly this or running the method silently loses its steps. */
function serializeMethod(input: MethodInput, existingBody?: string): string {
  const data: Record<string, unknown> = { type: 'method', name: input.name.trim() }
  if (input.description?.trim()) data.description = input.description.trim()
  if (input.deliverable?.trim()) data.deliverable = input.deliverable.trim()
  const skills = (input.callsSkills ?? []).map((s) => s.trim()).filter(Boolean)
  if (skills.length) data['calls-skills'] = skills

  const body =
    input.content?.trim() ||
    existingBody?.trim() ||
    `## Method\n\nWhat this method is for and when to reach for it.\n\n## Steps\n\n1. First move.\n2. Then this.\n`
  return matter.stringify(body + '\n', data)
}

/** Copy the prior bytes somewhere recoverable before an overwrite or delete. These are
 *  the user's own vault notes, so losing one to a mis-click is worse than for a skill —
 *  a failure here aborts the operation rather than proceeding unprotected. */
function archiveMethod(relPath: string, absPath: string, reason: string): string {
  if (!existsSync(absPath)) return ''
  const dir = join(app.getPath('userData'), 'methods-archive')
  mkdirSync(dir, { recursive: true })
  const stamp = `${basename(absPath, '.md').replace(/[^a-zA-Z0-9._-]+/g, '_')}-${Date.now()}`
  const path = join(dir, `${stamp}.md`)
  writeFileSync(path, readFileSync(absPath, 'utf-8'), 'utf-8')
  writeFileSync(
    join(dir, `${stamp}.json`),
    JSON.stringify({ relPath, absPath, reason, archivedAt: new Date().toISOString() }, null, 2),
    'utf-8'
  )
  return path
}

function broadcastChange(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('methods:changed')
  }
}

/** A method file for import purposes: a `.md` whose frontmatter declares type: method. */
function isMethodFile(absPath: string): boolean {
  try {
    if (!absPath.toLowerCase().endsWith('.md')) return false
    if (absPath.toLowerCase().includes('template')) return false
    return /^type:\s*method\b/m.test(readFileSync(absPath, 'utf-8').slice(0, 1400))
  } catch {
    return false
  }
}

export function registerMethodsHandlers(): void {
  ipcMain.handle('methods:list', async () => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      return { success: true, data: listWorkflows(vault, installedSkillNames()).methods }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('methods:read', async (_event, relPath: string) => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      const abs = resolveInVault(vault, relPath)
      if (!abs || !existsSync(abs)) return { success: false, error: `No such method: ${relPath}` }
      const parsed = matter(readFileSync(abs, 'utf-8'))
      const fm = parsed.data as Record<string, unknown>
      const calls = fm['calls-skills']
      return {
        success: true,
        data: {
          path: relPath,
          name: String(fm.name ?? fm.title ?? basename(abs, '.md')),
          description: typeof fm.description === 'string' ? fm.description : '',
          deliverable: typeof fm.deliverable === 'string' ? fm.deliverable : '',
          callsSkills: Array.isArray(calls) ? calls.map(String) : [],
          content: parsed.content.trim()
        }
      }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('methods:create', async (_event, input: MethodInput) => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      if (!input?.name?.trim()) return { success: false, error: 'A method needs a name' }

      const dir = methodsRoot(vault)
      const abs = uniquePath(dir, slugify(input.name))
      writeFileSync(abs, serializeMethod(input), 'utf-8')
      broadcastChange()
      return {
        success: true,
        data: { path: `${METHODS_DIR}/${basename(abs)}`, name: input.name.trim() }
      }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('methods:update', async (_event, relPath: string, input: MethodInput) => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      if (!input?.name?.trim()) return { success: false, error: 'A method needs a name' }
      const abs = resolveInVault(vault, relPath)
      if (!abs || !existsSync(abs)) return { success: false, error: `No such method: ${relPath}` }

      // Abandon rather than overwrite content we failed to preserve.
      let archivePath: string
      try {
        archivePath = archiveMethod(relPath, abs, 'methods:update')
      } catch (err) {
        return { success: false, error: `Couldn't back up this method, so it wasn't changed: ${messageOf(err)}` }
      }

      const existingBody = matter(readFileSync(abs, 'utf-8')).content
      writeFileSync(abs, serializeMethod(input, existingBody), 'utf-8')
      broadcastChange()
      return { success: true, data: { path: relPath, archivePath } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('methods:delete', async (_event, relPath: string) => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      const abs = resolveInVault(vault, relPath)
      if (!abs || !existsSync(abs)) return { success: false, error: `No such method: ${relPath}` }

      let archivePath: string
      try {
        archivePath = archiveMethod(relPath, abs, 'methods:delete')
      } catch (err) {
        return { success: false, error: `Couldn't back up this method, so it wasn't deleted: ${messageOf(err)}` }
      }

      unlinkSync(abs)
      broadcastChange()
      return { success: true, data: { path: relPath, archivePath } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  // Import methods from another vault or a shared folder. Copies only files that
  // actually declare `type: method`, and never overwrites an existing note.
  ipcMain.handle('methods:pickAndImport', async (event) => {
    try {
      const vault = vaultDir()
      if (!vault) return { success: false, error: NO_VAULT }
      const parent = BrowserWindow.fromWebContents(event.sender)
      const opts = {
        properties: ['openDirectory' as const],
        title: 'Choose a folder of methods to import'
      }
      const picked = parent
        ? await dialog.showOpenDialog(parent, opts)
        : await dialog.showOpenDialog(opts)
      if (picked.canceled || picked.filePaths.length === 0) {
        return { success: true, data: { imported: [], skipped: [], canceled: true } }
      }

      const src = picked.filePaths[0]
      if (resolve(src) === resolve(join(vault, METHODS_DIR))) {
        return { success: false, error: 'That folder is already where methods are kept.' }
      }

      const dest = methodsRoot(vault)
      const imported: string[] = []
      const skipped: { path: string; reason: string }[] = []
      for (const entry of readdirSync(src)) {
        const abs = join(src, entry)
        try {
          if (!statSync(abs).isFile()) continue
        } catch {
          continue
        }
        if (!isMethodFile(abs)) {
          if (entry.toLowerCase().endsWith('.md')) skipped.push({ path: entry, reason: 'not a method note' })
          continue
        }
        const target = join(dest, entry)
        if (existsSync(target)) {
          skipped.push({ path: entry, reason: 'already exists' })
          continue
        }
        try {
          mkdirSync(dirname(target), { recursive: true })
          copyFileSync(abs, target)
          imported.push(entry)
        } catch (err) {
          skipped.push({ path: entry, reason: `copy failed: ${messageOf(err)}` })
        }
      }
      if (imported.length) broadcastChange()
      return { success: true, data: { imported, skipped, canceled: false } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })
}
