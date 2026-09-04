import { ipcMain, dialog, BrowserWindow, shell } from 'electron'
import { spawn } from 'child_process'
import * as path from 'path'
import * as fs from 'fs/promises'
import { realpathSync } from 'fs'
import { processFiles, processPastedImage } from '../services/file-handler'
import { readSettings } from '../services/settings-helper'
import {
  clearActiveWorkspace,
  getActiveWorkspace,
  getExplicitActiveWorkspace,
  setActiveWorkspace
} from '../services/workspace-state'
import { friendly, messageOf } from '../services/guarded'
import { operatorWritePaths, fullComputerAccess } from '../services/sandbox/operator-write-paths'
import { grantTrustedDirectory, hasTrustedDirectoryGrant } from '../services/trusted-path-grants'

// ----------------------------------------------------------------------------
// Pure helpers (exported for unit tests). SEC-6: every spawn that follows a
// model-reachable codepath uses `shell: false` + argv form; nothing the
// renderer sends gets concatenated into a shell command line.
// ----------------------------------------------------------------------------

export function parseProbeOutput(stdout: string): string | null {
  const first = stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  return first ?? null
}

export interface VSCodeLaunchPlan {
  command: string
  args: string[]
  options: {
    detached: true
    stdio: 'ignore'
    windowsHide: true
    shell: false
  }
}

export function buildVSCodeLaunchPlan(codePath: string, target: string): VSCodeLaunchPlan {
  return {
    command: codePath,
    args: [target],
    options: {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      shell: false
    }
  }
}

// argv-form probe. `where` (Windows) and `which` (POSIX) are real binaries —
// no shell needed. The string `code` is a constant, not user input, so even
// the probe surface has no model-reachable argument injection.
async function probeCodeBinary(): Promise<string | null> {
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which'
    let out = ''
    let p: ReturnType<typeof spawn>
    try {
      p = spawn(cmd, ['code'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true
      })
    } catch {
      return resolve(null)
    }
    p.stdout?.on('data', (b: Buffer) => {
      out += b.toString('utf8')
    })
    p.on('error', () => resolve(null))
    p.on('exit', (code) => {
      if (code !== 0) return resolve(null)
      resolve(parseProbeOutput(out))
    })
  })
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  '.vscode', '.idea', '__pycache__', '.pytest_cache', '.venv', 'venv',
  'target', '.gradle', '.turbo', 'coverage', '.nyc_output'
])

const TEXT_READ_CAP = 2_000_000 // 2 MB cap for in-app viewer
const WALK_FILE_CAP = 5000      // safety stop for huge repos

type FsEntry = {
  name: string
  type: 'file' | 'dir'
  path: string
  size?: number
}

async function listDir(absPath: string): Promise<FsEntry[]> {
  const entries = await fs.readdir(absPath, { withFileTypes: true })
  const out: FsEntry[] = []
  for (const e of entries) {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) continue
    const full = path.join(absPath, e.name)
    if (e.isDirectory()) {
      out.push({ name: e.name, type: 'dir', path: full })
    } else if (e.isFile()) {
      try {
        const st = await fs.stat(full)
        out.push({ name: e.name, type: 'file', path: full, size: st.size })
      } catch {
        out.push({ name: e.name, type: 'file', path: full })
      }
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return out
}

async function walkProject(rootPath: string): Promise<string[]> {
  const results: string[] = []
  const stack: string[] = [rootPath]
  while (stack.length && results.length < WALK_FILE_CAP) {
    const dir = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue
        stack.push(path.join(dir, e.name))
      } else if (e.isFile()) {
        if (results.length >= WALK_FILE_CAP) break
        const full = path.join(dir, e.name)
        results.push(path.relative(rootPath, full))
      }
    }
  }
  return results
}

export function registerFilesHandlers(): void {
  // SECURITY: confine file-browser reads to the active workspace + connected vault.
  // Blocks a compromised renderer from reading arbitrary local files (e.g. SSH keys)
  // via files:readText / files:listDir / files:walkProject.
  function confinedRoots(): string[] {
    const roots: string[] = []
    const ws = getExplicitActiveWorkspace()
    if (ws) roots.push(path.resolve(ws))
    const vault = readSettings().localBrainNotesDir
    if (typeof vault === 'string' && vault) roots.push(path.resolve(vault))
    // ...and the directories the operator explicitly allowed. Without these the file
    // BROWSER stayed blind to a folder the agent had just been permitted to act in —
    // "organize my Desktop" could move files it could not then list. One allowlist,
    // one answer, across the shell sandbox, the agent's file tools, and this reader.
    for (const extra of operatorWritePaths()) roots.push(path.resolve(extra))
    return roots
  }
  function assertConfined(p: string): string {
    if (process.platform === 'win32' && p.startsWith('\\\\')) {
      throw new Error('UNC and device paths are not allowed (access denied).')
    }
    const resolved = path.resolve(p)
    // Full computer access (operator opt-in, OFF by default): the file browser is unconfined —
    // list/read any path on the machine. Otherwise enforce the workspace/vault jail below.
    if (fullComputerAccess()) return resolved
    const roots = confinedRoots()
    if (roots.length === 0) {
      throw new Error('File access is confined to the workspace/vault; none is set.')
    }
    if (!roots.some((r) => resolved === r || resolved.startsWith(r + path.sep))) {
      throw new Error('Path is outside the workspace/vault (access denied).')
    }
    return resolved
  }

  ipcMain.handle('files:listDir', async (_event, dirPath: string) => {
    try {
      if (typeof dirPath !== 'string' || !dirPath) {
        return { success: false, error: 'dirPath required' }
      }
      const entries = await listDir(assertConfined(dirPath))
      return { success: true, data: entries }
    } catch (err) {
      return { success: false, error: friendly(err, 'listDir failed') }
    }
  })

  ipcMain.handle('files:readText', async (_event, filePath: string) => {
    try {
      if (typeof filePath !== 'string' || !filePath) {
        return { success: false, error: 'filePath required' }
      }
      const safePath = assertConfined(filePath)
      const st = await fs.stat(safePath)
      if (st.size > TEXT_READ_CAP) {
        return {
          success: false,
          error: `File too large (${(st.size / 1_000_000).toFixed(1)} MB). Cap is ${(TEXT_READ_CAP / 1_000_000).toFixed(1)} MB.`
        }
      }
      const buf = await fs.readFile(safePath)
      // Crude binary sniff: presence of NUL byte in first 4 KB.
      const sample = buf.subarray(0, Math.min(buf.length, 4096))
      const isBinary = sample.includes(0)
      if (isBinary) {
        return { success: false, error: 'Binary file — not previewable as text.' }
      }
      return { success: true, data: { content: buf.toString('utf8'), size: st.size } }
    } catch (err) {
      return { success: false, error: friendly(err, 'readText failed') }
    }
  })

  ipcMain.handle('files:walkProject', async (_event, rootPath: string) => {
    try {
      if (typeof rootPath !== 'string' || !rootPath) {
        return { success: false, error: 'rootPath required' }
      }
      const files = await walkProject(assertConfined(rootPath))
      return { success: true, data: { files, truncated: files.length >= WALK_FILE_CAP } }
    } catch (err) {
      return { success: false, error: friendly(err, 'walkProject failed') }
    }
  })

  ipcMain.handle('files:process', async (_event, paths: string[]) => {
    try {
      if (!Array.isArray(paths)) return { success: false, error: 'paths must be an array' }
      // CONFINED again (2026-08-25). The 2026-08-22 unconfinement existed for ONE caller — the
      // drag-drop attach UI, whose OS-drag consent argument was real — but that caller now sends
      // its genuine File objects through files:processDropped, where the preload resolves paths
      // inside the isolated world (a renderer string can't impersonate a drop). With no
      // out-of-jail caller left, an unconfined path-string route is pure attack surface, so this
      // route rejoins the same jail as the file-browser handlers. Under full computer access
      // (the default) assertConfined stays permissive, exactly like every other jailed handler.
      const safePaths = paths.map((filePath) => {
        if (typeof filePath !== 'string' || !filePath) {
          throw new Error('Each file path must be a non-empty string.')
        }
        // realpath FIRST, then confine: a symlink/junction planted inside the jail must not
        // smuggle a read outside it (the prefix check would pass on the link's own path).
        return assertConfined(realpathSync(path.resolve(filePath)))
      })
      const result = await processFiles(safePaths)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'File processing failed') }
    }
  })

  // Native File objects are capabilities created by an OS picker/drop. The preload
  // resolves their paths inside the isolated world and sends them only to this
  // one-shot read handler. This restores ordinary external attachments without
  // turning the containing directory into a persistent workspace grant.
  ipcMain.handle('files:processDropped', async (_event, paths: string[]) => {
    try {
      if (!Array.isArray(paths)) return { success: false, error: 'paths must be an array' }
      if (paths.length === 0) {
        return { success: false, error: 'No readable dropped file paths were provided.' }
      }
      const safePaths: string[] = []
      for (const filePath of paths) {
        if (typeof filePath !== 'string' || !filePath) {
          throw new Error('Each dropped file path must be a non-empty string.')
        }
        if (process.platform === 'win32' && filePath.startsWith('\\\\')) {
          throw new Error('UNC and device paths are not allowed (access denied).')
        }
        const resolved = realpathSync(path.resolve(filePath))
        const stat = await fs.stat(resolved)
        if (!stat.isFile()) throw new Error('Dropped attachments must be files.')
        safePaths.push(resolved)
      }
      const result = await processFiles(safePaths)
      return { success: true, data: result }
    } catch (err) {
      return { success: false, error: friendly(err, 'Dropped file processing failed') }
    }
  })

  // A pasted screenshot has no path, so it cannot go through files:process. This
  // gives it the same main-process treatment an on-disk image gets — type check
  // and OCR — instead of the renderer hand-rolling the attachment.
  ipcMain.handle(
    'files:processPastedImage',
    async (_event, input: { dataUrl: string; name: string; mimeType: string }) => {
      try {
        if (!input || typeof input.dataUrl !== 'string' || typeof input.name !== 'string') {
          return { success: false, error: 'dataUrl and name are required' }
        }
        const result = await processPastedImage({
          dataUrl: input.dataUrl,
          name: input.name,
          mimeType: typeof input.mimeType === 'string' ? input.mimeType : ''
        })
        return { success: true, data: result }
      } catch (err) {
        return { success: false, error: friendly(err, 'Pasted image processing failed') }
      }
    }
  )

  ipcMain.handle('files:getWorkdir', async () => {
    try {
      // Resolve the active workspace from the persisted state, falling back
      // to process.cwd() when nothing is set. This is the source of truth
      // tool execution (workspace_context / shell_command / apply_patch)
      // reads through ToolExecutionContext.workspacePath.
      const cwd = getActiveWorkspace()
      return { success: true, data: { path: cwd, name: path.basename(cwd) } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not read working directory') }
    }
  })

  ipcMain.handle('files:pickWorkdir', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const dlg = win
        ? await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      if (dlg.canceled || dlg.filePaths.length === 0) return { success: true, data: null }
      const chosen = dlg.filePaths[0]
      // U5 — PERSIST the pick. This handler used to return the path without
      // setting anything, while Titlebar.tsx and WorkModePopover.tsx both toast
      // "Working folder set: <name>" purely off this return value — so on two of
      // the three picker surfaces the message was false and every consumer that
      // resolves through getActiveWorkspace (review, chat tools, monitor, tasks)
      // kept using the previous folder. ChatInput's follow-up files:setWorkdir
      // still runs and is simply idempotent now.
      // The dialog pick is ALSO a trust grant: ChatInput's follow-up files:setWorkdir (and any
      // later re-select of this folder) must keep working after the active workspace moves on.
      const result = setActiveWorkspace(grantTrustedDirectory(chosen))
      return { success: true, data: { path: result.path, name: path.basename(result.path) } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Folder picker failed') }
    }
  })

  ipcMain.handle('files:setWorkdir', async (_event, candidate: string) => {
    try {
      // A renderer/model-supplied workdir is a SELECTOR among roots the main process already
      // trusts (the current workspace/vault jail, or a directory a native picker granted) — it
      // must not mint a new trust root from a string. Under full computer access (the default)
      // assertConfined is deliberately permissive; on locked-down installs this is the jail.
      const target = hasTrustedDirectoryGrant(candidate) ? candidate : assertConfined(candidate)
      const result = setActiveWorkspace(target)
      return { success: true, data: { path: result.path, name: path.basename(result.path) } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not set working directory') }
    }
  })

  ipcMain.handle('files:clearWorkdir', async () => {
    try {
      clearActiveWorkspace()
      const cwd = getActiveWorkspace()
      return { success: true, data: { path: cwd, name: path.basename(cwd) } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not clear working directory') }
    }
  })

  ipcMain.handle('files:openPicker', async () => {
    try {
      const win = BrowserWindow.getAllWindows()[0]
      const dlg = win
        ? await dialog.showOpenDialog(win, {
            properties: ['openFile', 'multiSelections'],
            filters: [
              {
                name: 'Supported',
                extensions: [
                  'txt',
                  'md',
                  'mdx',
                  'py',
                  'js',
                  'ts',
                  'tsx',
                  'jsx',
                  'html',
                  'css',
                  'json',
                  'csv',
                  'tsv',
                  'yaml',
                  'yml',
                  'pdf',
                  // Office + ODF, readable since the chat path gained the Office
                  // loaders. Drag-and-drop never consulted this filter, so these
                  // were selectable by drop but invisible in the picker.
                  'docx',
                  'xlsx',
                  'pptx',
                  'odt',
                  'ods',
                  'odp',
                  'rtf',
                  'png',
                  'jpg',
                  'jpeg',
                  'gif',
                  'webp'
                ]
              },
              { name: 'All files', extensions: ['*'] }
            ]
          })
        : await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
      if (dlg.canceled) return { success: true, data: [] }
      const processed = await processFiles(dlg.filePaths)
      return { success: true, data: processed }
    } catch (err) {
      return { success: false, error: friendly(err, 'File picker failed') }
    }
  })

  ipcMain.handle('files:openInVSCode', async (_event, args?: { targetPath?: string }) => {
    try {
      const target = assertConfined(args?.targetPath || getActiveWorkspace())
      const codePath = await probeCodeBinary()
      if (!codePath) {
        return {
          success: false,
          error:
            "VS Code's `code` CLI was not found on PATH. Install VS Code or add it to PATH (Command Palette → Shell Command: Install 'code' command in PATH)."
        }
      }
      // SEC-6: no `shell: true`. The target is an argv element so the OS
      // shell never sees it. On Windows the resolved `code` is typically
      // `code.cmd`; Node ≥21.7 applies safe per-arg quoting for .cmd
      // targets automatically (CVE-2024-27980 fix), so this argv form is
      // safe across the modern Node runtimes Electron 35 carries.
      const plan = buildVSCodeLaunchPlan(codePath, target)
      const child = spawn(plan.command, plan.args, plan.options)
      child.on('error', () => {
        // Spawn errors after a successful probe are rare; the IPC has
        // already returned. The probe is the real gate.
      })
      child.unref()
      return { success: true, data: { path: target } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not launch VS Code') }
    }
  })

  ipcMain.handle('files:openInExplorer', async (_event, args?: { targetPath?: string }) => {
    try {
      const target = assertConfined(args?.targetPath || getActiveWorkspace())
      // A directory opens in the file manager; a file is revealed (selected) inside its
      // folder. Refusing files left Settings → Foundations' "Reveal in files" a button that
      // never worked and never said why.
      if ((await fs.stat(target)).isDirectory()) {
        await shell.openPath(target)
      } else {
        shell.showItemInFolder(target)
      }
      return { success: true, data: { path: target } }
    } catch (err) {
      return { success: false, error: friendly(err, 'Could not open file explorer') }
    }
  })
}
