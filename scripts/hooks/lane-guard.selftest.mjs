#!/usr/bin/env node
/**
 * lane-guard self-test — proves the guard actually BLOCKS, in a real git repo.
 *
 * A guard is only worth its line count if it fires, so this does not unit-test the
 * matcher in isolation: it builds a throwaway git repo, installs the SHIPPED hook files
 * (copied byte-for-byte from scripts/hooks/), runs real `git commit` invocations against
 * it and asserts on the exit codes. Nothing outside the scratch directory is touched and
 * `core.hooksPath` is set only inside the scratch repo — never in this checkout, where it
 * would apply to every worktree sharing the common .git dir.
 *
 * Run:  node scripts/hooks/lane-guard.selftest.mjs
 * Exit: 0 all cases pass, 1 otherwise.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function makeScratchRepo(laneBoard) {
  const dir = mkdtempSync(join(tmpdir(), 'lane-guard-'))
  const g = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' })
  g('init', '-q', '-b', 'duin/lane-ci')
  g('config', 'user.email', 'selftest@example.invalid')
  g('config', 'user.name', 'lane-guard selftest')
  g('config', 'commit.gpgsign', 'false')

  // Ship the real hook files, not a paraphrase of them.
  mkdirSync(join(dir, 'scripts', 'hooks'), { recursive: true })
  cpSync(join(HOOKS_SRC, 'lane-guard.mjs'), join(dir, 'scripts', 'hooks', 'lane-guard.mjs'))

  // A pre-commit that runs ONLY the guard: this test is about the guard, and the shipped
  // pre-commit's lint/tsc steps need a full node_modules the scratch repo does not have.
  writeFileSync(
    join(dir, 'scripts', 'hooks', 'pre-commit'),
    '#!/bin/sh\nset -eu\nnode scripts/hooks/lane-guard.mjs\n',
    { mode: 0o755 }
  )
  if (laneBoard) writeFileSync(join(dir, 'SESSION-LANES.md'), laneBoard)

  g('add', '-A')
  g('-c', 'core.hooksPath=', 'commit', '-q', '-m', 'scaffold')
  g('config', 'core.hooksPath', 'scripts/hooks')
  return { dir, g }
}

function commit(dir, msg, env = {}) {
  const r = spawnSync('git', ['commit', '-m', msg], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` }
}

function writeN(dir, n, prefix) {
  mkdirSync(join(dir, prefix), { recursive: true })
  for (let i = 0; i < n; i++) writeFileSync(join(dir, prefix, `f${i}.ts`), `export const x${i} = ${i}\n`)
}

console.log('lane-guard self-test')

// ---------------------------------------------------------------- case 1: staged count
{
  const { dir, g } = makeScratchRepo(null)
  writeN(dir, 20, 'src')
  g('add', '-A')
  const blocked = commit(dir, 'sweep 20 files')
  check('20 staged files are BLOCKED', blocked.code !== 0, `exit=${blocked.code}`)
  check(
    'abort names the guard and the count',
    /lane-guard: COMMIT BLOCKED/.test(blocked.out) && /20 paths staged/.test(blocked.out),
    blocked.out.split('\n').find((l) => /paths staged/.test(l))?.trim() || '(no count line)'
  )
  check('abort advertises the escape', /LANE_OVERRIDE=1/.test(blocked.out))

  const forced = commit(dir, 'sweep 20 files', { LANE_OVERRIDE: '1' })
  check('LANE_OVERRIDE=1 lets the same commit through', forced.code === 0, `exit=${forced.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- case 2: lane scope
{
  const board = [
    '# SESSION-LANES',
    '',
    '| Session | Lane / files owned | Deploy owner? |',
    '|---|---|---|',
    '| **ci** (2026-08-03) | branch `duin/lane-ci`. Owns `.github/`, `scripts/hooks/`, `deploy.cmd` | no |',
    '| _(example)_ panels | `src/components/**` | no |',
    ''
  ].join('\n')
  const { dir, g } = makeScratchRepo(board)

  mkdirSync(join(dir, 'electron', 'services'), { recursive: true })
  writeFileSync(join(dir, 'electron', 'services', 'someone-elses.ts'), 'export const a = 1\n')
  g('add', '-A')
  const blocked = commit(dir, 'touch another lane')
  check('out-of-lane path is BLOCKED', blocked.code !== 0, `exit=${blocked.code}`)
  check(
    'abort prints the violated row',
    /violated row: .*duin\/lane-ci/.test(blocked.out),
    blocked.out.split('\n').find((l) => /violated row/.test(l))?.trim() || '(no row line)'
  )
  check(
    'abort lists the offending path',
    /electron\/services\/someone-elses\.ts/.test(blocked.out)
  )
  const forced = commit(dir, 'touch another lane', { LANE_OVERRIDE: '1' })
  check('LANE_OVERRIDE=1 bypasses the scope check too', forced.code === 0, `exit=${forced.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- case 3: in-lane passes
{
  const board = [
    '| Session | Lane / files owned |',
    '|---|---|',
    '| **ci** | branch `duin/lane-ci`. Owns `.github/`, `scripts/hooks/`, `deploy.cmd` |',
    ''
  ].join('\n')
  const { dir, g } = makeScratchRepo(board)
  writeFileSync(join(dir, 'deploy.cmd'), '@echo off\r\nrem in lane\r\n')
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true })
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'name: ci\n')
  g('add', '-A')
  const ok = commit(dir, 'in-lane change')
  check('in-lane commit is ALLOWED', ok.code === 0, `exit=${ok.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- case 4: no lane row
{
  const { dir, g } = makeScratchRepo('# SESSION-LANES\n\nno table here\n')
  writeFileSync(join(dir, 'anything.ts'), 'export const y = 1\n')
  g('add', '-A')
  const ok = commit(dir, 'unresolvable lane')
  check('unresolvable lane does NOT wedge the commit', ok.code === 0, `exit=${ok.code}`)
  check('and says the scope check was skipped', /scope check skipped/.test(ok.out))
  rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------- case 5: LANE_FILES
{
  const { dir, g } = makeScratchRepo(null)
  mkdirSync(join(dir, 'electron'), { recursive: true })
  writeFileSync(join(dir, 'electron', 'a.ts'), 'export const a = 1\n')
  g('add', '-A')
  const blocked = commit(dir, 'outside LANE_FILES', { LANE_FILES: 'src/**,deploy.cmd' })
  check('LANE_FILES scopes the check without a board row', blocked.code !== 0, `exit=${blocked.code}`)
  const allowed = commit(dir, 'inside LANE_FILES', { LANE_FILES: 'electron/**' })
  check('LANE_FILES allows an in-scope path', allowed.code === 0, `exit=${allowed.code}`)
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------------- case 6: OPT-IN unarmed assertion
//
// "core.hooksPath is unset" is NOT a property this repo wants forever -- the goal is the
// opposite, that `npm ci` arms it. It is a property one WAVE wants, while parallel lanes
// are mid-flight: `git config` writes to the COMMON .git/config, so arming it in one
// worktree arms all of them at once and a guard nobody expected wedges every lane.
//
// So it is opt-in. Run with LANE_GUARD_ASSERT_UNARMED=1 to check it; leaving it on by
// default would turn this self-test into a landmine that fails CI the day the hooks are
// correctly installed.
if (process.env.LANE_GUARD_ASSERT_UNARMED === '1') {
  const r = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  })
  const armed = r.status === 0 && r.stdout.trim() !== ''
  check(
    'this checkout is NOT armed (LANE_GUARD_ASSERT_UNARMED=1)',
    !armed,
    armed ? `core.hooksPath=${r.stdout.trim()}` : 'core.hooksPath unset'
  )
}

console.log(failures === 0 ? '\nlane-guard self-test: ALL PASS' : `\nlane-guard self-test: ${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
