#!/usr/bin/env node
/**
 * merge-board-guard — pre-push guard against closing a lane the board still calls live.
 *
 * WHY THIS EXISTS
 * ---------------
 * `SESSION-LANES.md` is declared the single coordination authority, and it is wrong in
 * BOTH directions at the time of writing: it still carries the 2026-08-03 roster with
 * every row marked MERGED, it calls `frontend` UNCLAIMED while `duin/lane-frontend`
 * merged at 9c98416, and `duin/lane-ipc` has never had a row at all. Rows expire in 48h
 * per protocol 5, and `scripts/ship-gate.mjs --group=INSTRUCTION` check I6 fails on stale
 * dated rows — but only if someone runs it. Nothing connects the ACT of landing a lane to
 * the ACT of closing its row, so the board drifts by default and the next session learns
 * to ignore it. A lock nobody trusts is worse than no lock.
 *
 * `npm run lane:close` already does the closing correctly (it resolves the merge SHA from
 * git and refuses to close a branch trunk does not contain). The missing piece is not the
 * mechanism, it is the INVOCATION: closing has to be triggered by the merge instead of by
 * memory. So: when the commit you are pushing is a merge, and the branch it merged still
 * has a `Building now? yes` row on the board, this refuses the push and prints the row.
 *
 * FAIL-SAFE BY CONSTRUCTION
 * -------------------------
 * Only a POSITIVE, confident detection aborts. No board file, no merge commit, an
 * unparseable table, a branch this cannot resolve, or any internal error at all -> print a
 * notice and exit 0. A guard that wedges a push for a reason nobody can act on gets
 * uninstalled rather than consulted, and `core.hooksPath` lives in the COMMON `.git/config`
 * so a wedge here wedges every worktree sharing this git dir at once.
 *
 * ESCAPE HATCH (documented, deliberate, and the SAME one lane-guard uses -- one escape for
 * the hook layer, not one per script):
 *
 *      LANE_OVERRIDE=1 git push ...
 *
 * Read-only: this script never stages, commits, writes or rewrites anything.
 *
 * Usage: invoked by scripts/hooks/pre-push. Can be run by hand:
 *      node scripts/hooks/merge-board-guard.mjs [--sha <rev>] [--root <dir>]
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ZERO_SHA = /^0{40,64}$/

function argValue(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + '='))
  if (eq !== undefined) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  if (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return fallback
}

const ROOT = argValue(process.argv.slice(2), '--root', process.cwd())

function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}
function gitQuiet(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

/**
 * The refs git is about to push, read from the pre-push stdin protocol
 * (`<local ref> <local sha> <remote ref> <remote sha>` per line).
 *
 * Skipped entirely when stdin is a TTY, which is the hand-run case: reading fd 0 there
 * would block forever on a human who has nothing to type.
 */
export function parsePrePushStdin(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split(/\s+/)[1])
    .filter((sha) => sha && !ZERO_SHA.test(sha)) // all-zero local sha == a branch DELETION
}

function pushedShas() {
  const explicit = argValue(process.argv.slice(2), '--sha', null)
  if (explicit) return [explicit]
  if (process.stdin.isTTY) return ['HEAD']
  try {
    const refs = parsePrePushStdin(readFileSync(0, 'utf8'))
    return refs.length > 0 ? refs : ['HEAD']
  } catch {
    return ['HEAD']
  }
}

/**
 * The branch names a merge commit brought in.
 *
 * The subject is the primary source because it is what git actually writes
 * ("Merge branch 'duin/lane-ipc' into duin/unify-backend-ui") and it survives the branch
 * ref being deleted after the merge. Everything after ` into ` is the TARGET -- trunk --
 * and must not be read as a merged branch, or every merge would look like it closed trunk.
 */
export function branchesFromSubject(subject) {
  const beforeInto = subject.split(/\s+into\s+/)[0]
  if (!/^\s*Merge\b/i.test(subject)) return []
  return [...beforeInto.matchAll(/'([^']+)'/g)]
    .map((m) => m[1].trim())
    .filter(Boolean)
    .map((b) => b.replace(/^remotes\//, ''))
}

/** Fallback when the subject names nothing: branches still pointing at a non-first parent. */
function branchesFromParents(parents) {
  const out = []
  for (const p of parents.slice(1)) {
    const refs = gitQuiet(['branch', '--points-at', p, '--format=%(refname:short)'])
    if (!refs) continue
    for (const r of refs.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) out.push(r)
  }
  return out
}

/**
 * Rows of the ONE board table that has a `Building now?` column, with that cell extracted.
 *
 * The file holds two tables. "Standing work lanes" is `| Lane | Files | Done when |
 * Finding |` -- areas of open work, explicitly "not ownership claims" -- and reading a
 * row from it as a live claim would fire the guard on prose. So the column index is
 * re-derived from each header row encountered, and rows under a header without that
 * column are not candidates at all.
 */
export function liveRows(boardText) {
  const rows = []
  let buildingIdx = -1
  let inTable = false
  for (const [i, line] of boardText.split(/\r?\n/).entries()) {
    const t = line.trim()
    if (!t.startsWith('|')) {
      // The table block ended. Reset, or the live table's column index leaks into the
      // NEXT table -- which is how the first draft of this read "Standing work lanes"
      // (`| Lane | Files | Done when | Finding |`, no liveness column at all) as three
      // more live rows. Caught by case 5 of the self-test.
      inTable = false
      buildingIdx = -1
      continue
    }
    if (/^\|[\s|:-]+\|$/.test(t)) continue // separator
    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|')
    if (!inTable) {
      // First non-separator row of a block is its header. A block whose header has no
      // `Building now?` column is not a liveness table and contributes no rows.
      inTable = true
      buildingIdx = cells.findIndex((c) => /building\s*now/i.test(c))
      continue
    }
    if (buildingIdx === -1 || buildingIdx >= cells.length) continue
    if (/_\((?:template|example)\)_/.test(t)) continue
    rows.push({
      lineNo: i + 1,
      text: t,
      cells,
      building: /\byes\b/i.test(cells[buildingIdx]),
      branch: (cells[1] || '').match(/branch\s+`([^`]+)`/i)?.[1] ?? null,
      name: ((cells[0].match(/\*\*([^*]+)\*\*/)?.[1] ?? cells[0]).replace(/\s*\(.*$/, '').trim())
    })
  }
  return rows
}

/** Does this board row belong to `branch`? Same resolution order lane-close uses. */
export function rowMatchesBranch(row, branch) {
  const b = branch.toLowerCase()
  const short = b.replace(/^.*\//, '') // duin/lane-ipc -> lane-ipc
  const bare = short.replace(/^lane-/, '') // lane-ipc -> ipc
  if (row.branch) {
    const rb = row.branch.toLowerCase()
    if (rb === b || rb.endsWith('/' + short)) return true
  }
  const name = row.name.toLowerCase()
  if (name === b || name === short || name === bare) return true
  // Last resort: the branch spelled out anywhere in the row (a lane cell that names the
  // branch without the `branch \`x\`` phrasing the parser above expects).
  return row.text.toLowerCase().includes(b)
}

/** The whole decision, pure, so the self-test can drive it without a repo. */
export function offendingRows(boardText, branches) {
  const rows = liveRows(boardText)
  const hits = []
  for (const branch of branches) {
    for (const row of rows) {
      if (row.building && rowMatchesBranch(row, branch) && !hits.some((h) => h.row === row)) {
        hits.push({ branch, row })
      }
    }
  }
  return hits
}

// ------------------------------------------------------------------ main
function notice(msg) {
  console.log('[merge-board-guard] ' + msg)
}

function abort(hits) {
  // ASCII only: printed by a hook that runs under cmd.exe, Git Bash and CI alike.
  const e = console.error
  e('')
  e('  +-- merge-board-guard: PUSH BLOCKED ' + '-'.repeat(32))
  e('  | A merge you are pushing closes a lane the board still calls LIVE.')
  e('  |')
  for (const { branch, row } of hits) {
    e(`  | merged branch : ${branch}`)
    e(`  | board row     : SESSION-LANES.md:${row.lineNo}`)
    e(`  |   ${row.text.slice(0, 160)}`)
    e('  |')
  }
  e('  | The row says "Building now? yes". Merging closed the lane; the board did not')
  e('  | notice, and the next session reads the board, not your merge.')
  e('  |')
  e('  | Close it (this resolves the merge SHA from git, it does not take your word):')
  for (const { branch } of hits) {
    e(`  |     npm run lane:close -- ${branch.replace(/^.*\//, '').replace(/^lane-/, '')}`)
  }
  e('  |')
  e('  | If this push really must go without closing the row:')
  e('  |     LANE_OVERRIDE=1 git push ...')
  e('  +' + '-'.repeat(67))
  e('')
  process.exit(1)
}

function main() {
  if (process.env.LANE_OVERRIDE === '1') {
    notice('LANE_OVERRIDE=1 -- board check skipped by request.')
    return
  }

  const boardPath = join(ROOT, 'SESSION-LANES.md')
  if (!existsSync(boardPath)) {
    notice('no SESSION-LANES.md here -- nothing to check.')
    return
  }
  const board = readFileSync(boardPath, 'utf8')

  const allHits = []
  for (const rev of pushedShas()) {
    const parents = (gitQuiet(['show', '-s', '--format=%P', rev]) || '').trim().split(/\s+/).filter(Boolean)
    if (parents.length < 2) continue // not a merge
    const subject = (gitQuiet(['show', '-s', '--format=%s', rev]) || '').trim()
    let branches = branchesFromSubject(subject)
    if (branches.length === 0) branches = branchesFromParents(parents)
    if (branches.length === 0) {
      notice(`${rev.slice(0, 9)} is a merge but names no branch -- cannot check the board, allowing.`)
      continue
    }
    for (const hit of offendingRows(board, branches)) {
      if (!allHits.some((h) => h.row.lineNo === hit.row.lineNo)) allHits.push(hit)
    }
  }

  if (allHits.length > 0) abort(allHits)
  notice('no merge closes a lane the board still calls live. OK.')
}

// Fail-safe: an unexpected throw must never wedge a push. Only `abort` exits non-zero.
try {
  main()
} catch (err) {
  notice(`skipped (${err?.message ?? err}) -- a guard must not wedge a push it cannot reason about.`)
  process.exit(0)
}
