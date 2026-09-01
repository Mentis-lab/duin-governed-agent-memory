#!/usr/bin/env node
/**
 * merge-board-guard self-test — proves the guard actually BLOCKS A REAL `git push`.
 *
 * Same discipline as lane-guard.selftest.mjs: this does not unit-test the matcher in
 * isolation and call that proof. It builds throwaway git repos with real bare remotes,
 * installs the SHIPPED guard file (copied byte-for-byte from scripts/hooks/), runs real
 * `git push` invocations and asserts on the exit codes -- then runs the SHIPPED
 * scripts/lane-close.mjs and asserts the same push now succeeds. That round trip is the
 * whole claim: the merge is what triggers the close, and closing is what unblocks it.
 *
 * The scratch `pre-push` runs ONLY the guard. The shipped one also runs
 * `npm run verify:proof`, which needs a full node_modules the scratch repo does not have
 * -- so case 6 asserts, against the shipped file itself, that the guard is actually wired
 * into it. Without that case this self-test could pass while the hook never called it.
 *
 * Nothing outside the scratch directories is touched, and `core.hooksPath` is set only
 * inside them -- never in this checkout, where it would apply to every worktree sharing
 * the common .git dir.
 *
 * Run:  node scripts/hooks/merge-board-guard.selftest.mjs
 * Exit: 0 all cases pass, 1 otherwise.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOOKS_SRC = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(HOOKS_SRC, '..', '..')

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}`)
  if (!ok) failures++
}

const TRUNK = 'duin/unify-backend-ui'
const LANE = 'duin/lane-x'

/** A board shaped like the real one: the live table has a `Building now?` column, the
 *  standing-work table does not, and there is a `_(template)_` row to ignore. */
function board(buildingNow) {
  return [
    '# SESSION-LANES',
    '',
    '## Live lanes (edit me)',
    '',
    '| Session | Lane / files owned | Deploy owner? | Building now? | Last checkpoint |',
    '|---|---|---|---|---|',
    `| **x** (2026-08-04) | worktree \`../duin-lane-x\`, branch \`${LANE}\`. Owns \`src/x/\` | no | ${buildingNow} | \`abc1234\` |`,
    '| _(template)_ panels | `src/components/**` | no | no | `<commit>` |',
    '',
    '## Standing work lanes',
    '',
    '| Lane | Files | Done when | Finding |',
    '|---|---|---|---|',
    '| A — yes this row says yes | `src/a.ts` | yes it does | somewhere |',
    ''
  ].join('\n')
}

function makeScratchRepo(boardText) {
  const dir = mkdtempSync(join(tmpdir(), 'merge-board-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', TRUNK)
  g('config', 'user.email', 'selftest@example.invalid')
  g('config', 'user.name', 'merge-board selftest')
  g('config', 'commit.gpgsign', 'false')
  g('config', 'core.autocrlf', 'false') // keeps the transcript readable; irrelevant to the check

  // Ship the real guard, not a paraphrase of it. lane-close comes along because case 4
  // asserts the CLOSE is what unblocks the push.
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  cpSync(join(HOOKS_SRC, 'merge-board-guard.mjs'), join(dir, 'scripts', 'hooks', 'merge-board-guard.mjs'))
  cpSync(join(REPO_ROOT, 'scripts', 'lane-close.mjs'), join(dir, 'scripts', 'lane-close.mjs'))
  writeFileSync(
    join(dir, 'scripts', 'hooks', 'pre-push'),
    '#!/bin/sh\nset -eu\nnode scripts/hooks/merge-board-guard.mjs\n',
    { mode: 0o755 }
  )
  writeFileSync(join(dir, 'SESSION-LANES.md'), boardText)
  writeFileSync(join(dir, 'README.md'), '# scratch\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'scaffold')
  return { dir, g }
}

/** A bare remote, fresh each time: a second push to an already-up-to-date remote is a
 *  no-op and git would not run pre-push at all, which would look like a pass. */
function addRemote(dir, g, name) {
  const bare = mkdtempSync(join(tmpdir(), 'merge-board-remote-'))
  execFileSync('git', ['init', '-q', '--bare', bare])
  g('remote', 'add', name, bare.replace(/\\/g, '/'))
  return bare
}

function push(dir, remote, env = {}) {
  const r = spawnSync('git', ['push', remote, TRUNK], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

/** trunk -> lane branch -> one commit -> `git merge --no-ff` back into trunk. */
function mergeLaneIntoTrunk(dir, g) {
  g('checkout', '-q', '-b', LANE)
  mkdirSync(join(dir, 'src', 'x'), { recursive: true })
  writeFileSync(join(dir, 'src', 'x', 'work.ts'), 'export const done = true\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'x: land the lane work')
  g('checkout', '-q', TRUNK)
  g('merge', '--no-ff', '-q', LANE, '-m', `Merge branch '${LANE}' into ${TRUNK}`)
}

console.log('merge-board-guard self-test')

// ------------------------------------------------- case 1: the merge is BLOCKED
{
  const { dir, g } = makeScratchRepo(board('yes'))
  mergeLaneIntoTrunk(dir, g)
  g('config', 'core.hooksPath', 'scripts/hooks')
  addRemote(dir, g, 'origin')

  const blocked = push(dir, 'origin')
  check('a merge closing a live-row lane is BLOCKED', blocked.code !== 0, `exit=${blocked.code}`)
  check('abort names the guard', /merge-board-guard: PUSH BLOCKED/.test(blocked.out))
  check(
    'abort prints the offending row',
    new RegExp(`\\*\\*x\\*\\*.*${LANE.replace('/', '\\/')}`).test(blocked.out),
    blocked.out.split('\n').find((l) => /\*\*x\*\*/.test(l))?.trim().slice(0, 90) || '(no row line)'
  )
  check('abort cites the board file and line', /SESSION-LANES\.md:7\b/.test(blocked.out))
  check('abort points at lane:close', /npm run lane:close -- x\b/.test(blocked.out))
  check('abort advertises the escape', /LANE_OVERRIDE=1/.test(blocked.out))

  // Fresh remote: the blocked push above left `origin` empty, but be explicit about it.
  addRemote(dir, g, 'escape')
  const forced = push(dir, 'escape', { LANE_OVERRIDE: '1' })
  check('LANE_OVERRIDE=1 lets the same push through', forced.code === 0, `exit=${forced.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------- case 2: lane:close UNBLOCKS the push
{
  const { dir, g } = makeScratchRepo(board('yes'))
  mergeLaneIntoTrunk(dir, g)
  g('config', 'core.hooksPath', 'scripts/hooks')
  addRemote(dir, g, 'origin')
  check('(precondition) push is blocked before closing', push(dir, 'origin').code !== 0)

  const close = spawnSync(
    process.execPath,
    [join(dir, 'scripts', 'lane-close.mjs'), 'x', '--gaps=none', '--no-index', `--root=${dir}`],
    { cwd: dir, encoding: 'utf8' }
  )
  check('lane:close succeeds against the merged lane', close.status === 0, `exit=${close.status} ${String(close.stderr || '').trim().slice(0, 120)}`)
  check(
    'lane:close marked the row MERGED',
    /\*\*x\*\* MERGED/.test(readFileSync(join(dir, 'SESSION-LANES.md'), 'utf8'))
  )

  g('add', 'SESSION-LANES.md')
  g('-c', 'core.hooksPath=', 'commit', '-q', '-m', 'chore: close lane x on the board')
  const after = push(dir, 'origin')
  check('after lane:close the push SUCCEEDS', after.code === 0, `exit=${after.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------- case 3: no false positives
{
  const { dir, g } = makeScratchRepo(board('no'))
  mergeLaneIntoTrunk(dir, g)
  g('config', 'core.hooksPath', 'scripts/hooks')
  addRemote(dir, g, 'origin')
  const ok = push(dir, 'origin')
  check('a merge whose row says "no" is ALLOWED', ok.code === 0, `exit=${ok.code}`)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { dir, g } = makeScratchRepo(board('yes'))
  writeFileSync(join(dir, 'README.md'), '# scratch, edited\n')
  g('add', '-A')
  g('commit', '-q', '-m', 'docs: not a merge')
  g('config', 'core.hooksPath', 'scripts/hooks')
  addRemote(dir, g, 'origin')
  const ok = push(dir, 'origin')
  check('an ordinary (non-merge) commit is ALLOWED even with a live row', ok.code === 0, `exit=${ok.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------- case 4: fail-safe, never wedge
{
  const { dir, g } = makeScratchRepo(board('yes'))
  mergeLaneIntoTrunk(dir, g)
  rmSync(join(dir, 'SESSION-LANES.md'))
  g('add', '-A')
  g('commit', '-q', '-m', 'chore: no board here')
  g('config', 'core.hooksPath', 'scripts/hooks')
  addRemote(dir, g, 'origin')
  const ok = push(dir, 'origin')
  check('a repo with no board does NOT wedge the push', ok.code === 0, `exit=${ok.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------- case 5: the pure decision function
{
  const mod = await import('./merge-board-guard.mjs')
  const live = mod.liveRows(board('yes'))
  check('only the table with a "Building now?" column yields rows', live.length === 1, `rows=${live.length}`)
  check('the standing-work row saying "yes it does" is NOT read as live', !live.some((r) => /Standing|yes it does/.test(r.text)))
  check('a live row for the merged branch is an offence', mod.offendingRows(board('yes'), [LANE]).length === 1)
  check('the same row with "no" is not', mod.offendingRows(board('no'), [LANE]).length === 0)
  check('an unrelated branch does not match the row', mod.offendingRows(board('yes'), ['duin/lane-other']).length === 0)
  check(
    'the merge target after " into " is NOT read as a merged branch',
    JSON.stringify(mod.branchesFromSubject(`Merge branch '${LANE}' into ${TRUNK}`)) === JSON.stringify([LANE])
  )
  check(
    'octopus subjects yield every merged branch',
    JSON.stringify(mod.branchesFromSubject("Merge branches 'a' and 'b' into trunk")) === JSON.stringify(['a', 'b'])
  )
  check(
    'a branch DELETION (all-zero local sha) is not treated as a push of that sha',
    mod.parsePrePushStdin(`refs/heads/x ${'0'.repeat(40)} refs/heads/x deadbeef\n`).length === 0
  )
}

// ------------------------------------------------- case 6: the guard is WIRED into pre-push
{
  const shipped = readFileSync(join(HOOKS_SRC, 'pre-push'), 'utf8')
  check(
    'the shipped pre-push invokes merge-board-guard.mjs',
    /node\s+scripts\/hooks\/merge-board-guard\.mjs/.test(shipped),
    shipped.split('\n').filter((l) => l.trim() && !l.startsWith('#')).join(' ; ').slice(0, 120)
  )
  // Both indices must be FOUND, not merely ordered. Written as `a < b` alone this passed
  // against a pre-push that did not mention the guard at all (-1 < 25) -- a source-lock
  // assertion that is green with the defect present, which is the exact failure mode
  // backlog item U34 was opened for. It is worth catching in one's own test first.
  const iGuard = shipped.indexOf('merge-board-guard.mjs')
  const iProof = shipped.indexOf('verify:proof')
  check(
    'and invokes it BEFORE the minutes-long verify:proof',
    iGuard !== -1 && iProof !== -1 && iGuard < iProof,
    `guard@${iGuard} proof@${iProof}`
  )
}

console.log(failures === 0 ? '\nmerge-board-guard self-test: ALL PASS' : `\nmerge-board-guard self-test: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
