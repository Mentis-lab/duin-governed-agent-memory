import { ipcMain, BrowserWindow } from 'electron'
import chokidar, { type FSWatcher } from 'chokidar'
import * as path from 'path'
import { runGit } from '../services/git-runner'
import { getActiveWorkspace } from '../services/workspace-state'
import { friendly, messageOf } from '../services/guarded'

// U5 — resolve the directory every review:* git action runs in.
//
// Every renderer caller (ReviewPanel, BranchPickerPopover, EnvironmentPanel,
// FloatingEnvironmentCard, StatusLine/useEnvironment) invokes these channels
// with no `cwd`, so the fallback IS the production path. It used to be
// process.cwd(): on a packaged install that is the install directory — not a
// git repo — so Review and Environment were permanently inert (branch
// 'detached HEAD', +0 -0, Commit disabled) with no UI signal; on a dev launch
// it is DUIN's OWN repo, so Stage / Unstage / Discard silently operated on the
// wrong tree. Resolving through getActiveWorkspace matches every other
// workspace-touching IPC module (chat, conversation, files, monitor,
// proposed-edit, tasks) and makes the folder the user picked the one git sees.
// An explicit args.cwd still wins so a caller can target another checkout.
function resolveCwd(args?: { cwd?: string }): string {
  return args?.cwd || getActiveWorkspace()
}

/** git's own wording when the cwd has no repository; matched so the UI can show
 *  an explicit "not a git repository" state instead of an empty, silent diff. */
function isNotARepository(stderr: string): boolean {
  return /not a git repository/i.test(stderr)
}

// Single active watcher across the app: cwd-change closes the prior watcher
// before installing the new one, so changing workdirs mid-session can't pile
// up FSWatchers. Broadcasts `review:changed` (debounced 200 ms) to all
// windows on .git/HEAD or .git/index mutation.
let activeWatcher: { cwd: string; watcher: FSWatcher } | null = null
let broadcastDebounce: ReturnType<typeof setTimeout> | null = null

function broadcast(cwd: string): void {
  if (broadcastDebounce) clearTimeout(broadcastDebounce)
  broadcastDebounce = setTimeout(() => {
    broadcastDebounce = null
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send('review:changed', { cwd })
      } catch {
        // window closed mid-broadcast
      }
    }
  }, 200)
}

function ensureWatcher(cwd: string): void {
  if (activeWatcher && activeWatcher.cwd === cwd) return
  if (activeWatcher) {
    void activeWatcher.watcher.close().catch(() => {
      // ignore — best effort teardown
    })
    activeWatcher = null
  }
  const gitDir = path.join(cwd, '.git')
  const watcher = chokidar.watch(
    [path.join(gitDir, 'HEAD'), path.join(gitDir, 'index')],
    { ignoreInitial: true, depth: 0 }
  )
  watcher.on('all', () => broadcast(cwd))
  watcher.on('error', () => {
    // Swallow — non-git directories or permission issues just stop watching.
  })
  activeWatcher = { cwd, watcher }
}

export async function shutdownReviewWatcher(): Promise<void> {
  if (broadcastDebounce) clearTimeout(broadcastDebounce)
  broadcastDebounce = null
  if (activeWatcher) {
    try {
      await activeWatcher.watcher.close()
    } catch {
      // best effort
    }
    activeWatcher = null
  }
}

interface FileStatus {
  path: string
  indexStatus: string // ' ', M, A, D, R, C, U, ?
  workStatus: string
  staged: boolean
  unstaged: boolean
}

/** Undo git's C-quoting of a porcelain path.
 *
 *  Belt to git-runner's `core.quotePath=false` braces: that stops git quoting in the
 *  first place, but a path can still arrive quoted from an older git, a repo-local
 *  config, or any caller that bypasses the runner. An unquoted path is returned
 *  untouched, so this is safe to apply unconditionally.
 *
 *  The escapes are decoded to BYTES and then UTF-8 decoded together — one CJK
 *  character is three separate `NNN` octal escapes, so decoding them one at a time
 *  would produce three mojibake characters instead of the one real one. PURE. */
const BACKSLASH = String.fromCharCode(92)

export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || raw[0] !== '"' || raw[raw.length - 1] !== '"') return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c !== BACKSLASH) {
      for (const b of Buffer.from(c, 'utf8')) bytes.push(b)
      continue
    }
    const n = body[++i]
    if (n === undefined) break
    if (n >= '0' && n <= '7') {
      const oct = body.slice(i, i + 3)
      bytes.push(parseInt(oct, 8) & 0xff)
      i += 2
      continue
    }
    const simple: Record<string, number> = { n: 10, t: 9, r: 13, f: 12, b: 8, v: 11, a: 7 }
    bytes.push(simple[n] ?? n.charCodeAt(0))
  }
  return Buffer.from(bytes).toString('utf8')
}

function parsePorcelain(stdout: string): FileStatus[] {
  const lines = stdout.split('\n')
  const out: FileStatus[] = []
  for (const raw of lines) {
    if (!raw) continue
    // Format: XY <space> path  (rename: XY <space> path -> path)
    if (raw.length < 3) continue
    const x = raw[0]
    const y = raw[1]
    const rest = raw.slice(3)
    let path = rest
    if (x === 'R' || y === 'R') {
      const arrow = rest.indexOf(' -> ')
      if (arrow >= 0) path = rest.slice(arrow + 4)
    }
    path = unquoteGitPath(path)
    if (x === '?' && y === '?') {
      out.push({ path, indexStatus: '?', workStatus: '?', staged: false, unstaged: true })
      continue
    }
    out.push({
      path,
      indexStatus: x === ' ' ? ' ' : x,
      workStatus: y === ' ' ? ' ' : y,
      staged: x !== ' ' && x !== '?',
      unstaged: y !== ' '
    })
  }
  return out
}

export function registerReviewHandlers(): void {
  ipcMain.handle('review:status', async (_e, args: { cwd?: string }) => {
    try {
      const cwd = resolveCwd(args)
      ensureWatcher(cwd)
      const res = await runGit(['status', '--porcelain=v1'], cwd)
      if (res.code !== 0) {
        const stderr = res.stderr.trim()
        // Explicit state: the workspace exists but holds no repository. Without
        // this the panel showed an empty diff / a silent '+0 -0' and looked like
        // a clean tree, which is indistinguishable from "nothing to review".
        if (isNotARepository(stderr)) {
          return {
            success: false,
            notARepository: true,
            cwd,
            error: `Not a git repository: ${cwd}`
          }
        }
        return { success: false, cwd, error: stderr || 'git status failed' }
      }
      // Also fetch branch info — best effort.
      const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
      const ahead = await runGit(['rev-list', '--count', '@{u}..HEAD'], cwd).catch(() => ({
        stdout: '0',
        code: 0,
        stderr: ''
      } as any))
      const behind = await runGit(['rev-list', '--count', 'HEAD..@{u}'], cwd).catch(() => ({
        stdout: '0',
        code: 0,
        stderr: ''
      } as any))
      return {
        success: true,
        data: {
          files: parsePorcelain(res.stdout),
          branch: branch.stdout.trim() || null,
          ahead: parseInt(ahead.stdout.trim() || '0', 10) || 0,
          behind: parseInt(behind.stdout.trim() || '0', 10) || 0,
          // The RESOLVED directory git actually ran in, so the panel can render
          // which folder it is reviewing rather than leaving the user to guess.
          cwd,
          isRepository: true
        }
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'status failed') }
    }
  })

  ipcMain.handle(
    'review:diff',
    async (_e, args: { cwd?: string; path?: string; staged?: boolean }) => {
      try {
        const cwd = resolveCwd(args)
        const gitArgs = ['diff', '--no-color']
        if (args?.staged) gitArgs.push('--cached')
        if (args?.path) gitArgs.push('--', args.path)
        const res = await runGit(gitArgs, cwd)
        if (res.code !== 0 && res.stderr) {
          return { success: false, error: res.stderr.trim() }
        }
        // For untracked files, fall back to showing the file content as additions.
        if (!res.stdout && args?.path && !args?.staged) {
          const trackedCheck = await runGit(['ls-files', '--error-unmatch', args.path], cwd)
          if (trackedCheck.code !== 0) {
            const content = await runGit(['ls-files', '-o', '--exclude-standard'], cwd) // noop, just to keep types
            void content
            // Read file directly
            const fs = await import('fs/promises')
            const path = await import('path')
            try {
              const text = await fs.readFile(path.join(cwd, args.path), 'utf8')
              const synthetic =
                `diff --git a/${args.path} b/${args.path}\n` +
                `new file\n--- /dev/null\n+++ b/${args.path}\n` +
                text
                  .split('\n')
                  .map((l) => `+${l}`)
                  .join('\n')
              return { success: true, data: { diff: synthetic, untracked: true } }
            } catch {
              return { success: true, data: { diff: '', untracked: true } }
            }
          }
        }
        return { success: true, data: { diff: res.stdout, untracked: false } }
      } catch (err) {
        return { success: false, error: friendly(err, 'diff failed') }
      }
    }
  )

  ipcMain.handle('review:stage', async (_e, args: { cwd?: string; path: string }) => {
    try {
      const cwd = resolveCwd(args)
      const res = await runGit(['add', '--', args.path], cwd)
      if (res.code !== 0) return { success: false, error: res.stderr.trim() }
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'stage failed') }
    }
  })

  ipcMain.handle('review:unstage', async (_e, args: { cwd?: string; path: string }) => {
    try {
      const cwd = resolveCwd(args)
      const res = await runGit(['restore', '--staged', '--', args.path], cwd)
      if (res.code !== 0) return { success: false, error: res.stderr.trim() }
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'unstage failed') }
    }
  })

  ipcMain.handle('review:discard', async (_e, args: { cwd?: string; path: string }) => {
    try {
      const cwd = resolveCwd(args)
      const res = await runGit(['checkout', '--', args.path], cwd)
      if (res.code !== 0) return { success: false, error: res.stderr.trim() }
      return { success: true, data: true }
    } catch (err) {
      return { success: false, error: friendly(err, 'discard failed') }
    }
  })

  ipcMain.handle('review:branches', async (_e, args?: { cwd?: string }) => {
    try {
      const cwd = resolveCwd(args)
      // %(HEAD) = '*' for current branch, ' ' otherwise. %(upstream:short) is
      // blank for branches with no upstream, which is fine.
      const fmt = '%(HEAD) %(refname:short)\t%(upstream:short)'
      const res = await runGit(
        ['for-each-ref', '--sort=-committerdate', `--format=${fmt}`, 'refs/heads'],
        cwd
      )
      if (res.code !== 0) return { success: false, error: res.stderr.trim() || 'branch list failed' }
      const lines = res.stdout.split('\n').filter((l) => l.trim().length > 0)
      const branches = lines.map((line) => {
        const headMarker = line[0] === '*'
        const rest = line.slice(2) // skip head marker + space
        const tabIdx = rest.indexOf('\t')
        const name = tabIdx >= 0 ? rest.slice(0, tabIdx) : rest
        const upstream = tabIdx >= 0 ? rest.slice(tabIdx + 1).trim() : ''
        return {
          name: name.trim(),
          current: headMarker,
          upstream: upstream || undefined
        }
      })
      return { success: true, data: { branches } }
    } catch (err) {
      return { success: false, error: friendly(err, 'branches failed') }
    }
  })

  ipcMain.handle('review:checkout', async (_e, args: { cwd?: string; name: string }) => {
    try {
      const cwd = resolveCwd(args)
      if (!args?.name) return { success: false, error: 'name required' }
      const res = await runGit(['checkout', args.name], cwd)
      if (res.code !== 0) return { success: false, error: res.stderr.trim() || 'checkout failed' }
      return { success: true, data: { name: args.name } }
    } catch (err) {
      return { success: false, error: friendly(err, 'checkout failed') }
    }
  })

  ipcMain.handle('review:createBranch', async (_e, args: { cwd?: string; name: string }) => {
    try {
      const cwd = resolveCwd(args)
      if (!args?.name) return { success: false, error: 'name required' }
      const res = await runGit(['checkout', '-b', args.name], cwd)
      if (res.code !== 0)
        return { success: false, error: res.stderr.trim() || 'create branch failed' }
      return { success: true, data: { name: args.name } }
    } catch (err) {
      return { success: false, error: friendly(err, 'create branch failed') }
    }
  })

  ipcMain.handle('review:summary', async (_e, args?: { cwd?: string }) => {
    try {
      const cwd = resolveCwd(args)
      // --shortstat for tracked changes (working tree); --cached for staged.
      // Untracked files don't count toward +/- numbers in git's view; treat
      // their existence as "has changes" via the porcelain status used by
      // the Review tool, not here.
      const [unstaged, staged] = await Promise.all([
        runGit(['diff', '--shortstat', '--no-color'], cwd),
        runGit(['diff', '--cached', '--shortstat', '--no-color'], cwd)
      ])
      // shortstat format: " 3 files changed, 12 insertions(+), 5 deletions(-)"
      const parse = (txt: string) => {
        const addM = txt.match(/(\d+) insertions?\(\+\)/)
        const delM = txt.match(/(\d+) deletions?\(-\)/)
        return {
          additions: addM ? parseInt(addM[1], 10) : 0,
          deletions: delM ? parseInt(delM[1], 10) : 0
        }
      }
      const u = parse(unstaged.stdout)
      const s = parse(staged.stdout)
      return {
        success: true,
        data: { additions: u.additions + s.additions, deletions: u.deletions + s.deletions }
      }
    } catch (err) {
      return { success: false, error: friendly(err, 'summary failed') }
    }
  })

  ipcMain.handle(
    'review:commit',
    async (_e, args: { cwd?: string; message: string; stageAll?: boolean }) => {
      try {
        const cwd = resolveCwd(args)
        if (!args?.message) return { success: false, error: 'message required' }
        if (args.stageAll) {
          const st = await runGit(['add', '-A'], cwd)
          if (st.code !== 0) return { success: false, error: st.stderr.trim() || 'stage failed' }
        }
        const res = await runGit(['commit', '-m', args.message], cwd)
        if (res.code !== 0) return { success: false, error: res.stderr.trim() || 'commit failed' }
        return { success: true, data: { stdout: res.stdout.trim() } }
      } catch (err) {
        return { success: false, error: friendly(err, 'commit failed') }
      }
    }
  )

  ipcMain.handle('review:push', async (_e, args?: { cwd?: string }) => {
    try {
      const cwd = resolveCwd(args)
      // Try plain push first; fall back to setting upstream if the branch has none.
      const first = await runGit(['push'], cwd)
      if (first.code === 0) return { success: true, data: { stdout: first.stdout.trim() } }
      const noUpstream =
        first.stderr.includes('has no upstream branch') ||
        first.stderr.includes('set-upstream')
      if (!noUpstream) return { success: false, error: first.stderr.trim() || 'push failed' }
      const branch = await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
      const name = branch.stdout.trim()
      if (!name) return { success: false, error: first.stderr.trim() || 'push failed' }
      const second = await runGit(['push', '--set-upstream', 'origin', name], cwd)
      if (second.code !== 0)
        return { success: false, error: second.stderr.trim() || 'push failed' }
      return { success: true, data: { stdout: second.stdout.trim() } }
    } catch (err) {
      return { success: false, error: friendly(err, 'push failed') }
    }
  })
}
