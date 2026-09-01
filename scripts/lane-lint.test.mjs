// lane-lint.test.mjs — proves scripts/lane-lint.mjs actually fails on a lying board.
//
// Run: node --test scripts/   (npm run test:teeth)
//
// These are NOT vitest tests. vitest.config.ts's `include` is
// ['electron/**/*.test.ts', 'src/**/*.test.{ts,tsx}'], so a test under scripts/
// would silently never run — and a gate whose own test silently never runs is
// the exact failure this lane exists to remove. node:test needs no config.
//
// Every case drives the REAL script as a subprocess against a REAL throwaway git
// repo, because half of what lane-lint asserts (ancestry, commit dates, ref
// resolution) only exists in git. A mocked git would prove nothing.

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./lane-lint.mjs', import.meta.url))

let repo
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return String(r.stdout).trim()
}

/** Write SESSION-LANES.md with the given table rows and run the lint. */
function runLint(rows, extraArgs = []) {
  writeFileSync(
    join(repo, 'SESSION-LANES.md'),
    ['# SESSION-LANES', '', '## Live lanes (edit me)', '', '| Session | Lane / files owned | Deploy owner? | Building now? | Last checkpoint |', '|---|---|---|---|---|', ...rows, '', '## Notes', ''].join('\n')
  )
  const r = spawnSync(process.execPath, [SCRIPT, '--root', repo, '--trunk', 'trunkref', ...extraArgs], {
    encoding: 'utf8'
  })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

const stamp = (msAgo) => {
  const d = new Date(Date.now() - msAgo)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

describe('lane-lint', () => {
  let laneTip

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'lane-lint-'))
    git('init', '-q', '-b', 'trunkref')
    git('config', 'user.email', 'lane-lint@test')
    git('config', 'user.name', 'lane lint test')
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', '.')
    git('commit', '-q', '-m', 'seed')
    // lane/alpha: one commit AHEAD of trunk → genuinely unmerged.
    git('checkout', '-q', '-b', 'lane/alpha')
    writeFileSync(join(repo, 'alpha.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'alpha work')
    laneTip = git('rev-parse', '--short', 'HEAD')
    // lane/merged: fast-forwarded INTO trunk → an ancestor of it.
    git('checkout', '-q', 'trunkref')
    git('checkout', '-q', '-b', 'lane/merged')
    writeFileSync(join(repo, 'merged.txt'), 'm\n')
    git('add', '.')
    git('commit', '-q', '-m', 'merged work')
    git('checkout', '-q', 'trunkref')
    git('merge', '-q', '--no-ff', '-m', 'merge lane/merged', 'lane/merged')
    git('checkout', '-q', 'lane/alpha')
  })

  after(() => {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* windows file locks — the temp dir is disposable */
    }
  })

  test('PASSES on a swept board (fresh, unmerged, resolvable)', () => {
    const { status, out } = runLint([
      `| **alpha** (${stamp(0)}) | worktree \`../x\`, branch \`lane/alpha\`. Owns stuff | no | yes | \`${laneTip}\` |`
    ])
    assert.equal(status, 0, out)
    assert.match(out, /RESULT: PASS/)
  })

  test('FAILS (R1) when a row is hand-aged by 3 days — the acceptance case', () => {
    // The checkpoint commit is also backdated, otherwise a live checkpoint would
    // (correctly) keep the row fresh and this would be testing nothing.
    const threeDays = 3 * 24 * 3600 * 1000
    const iso = new Date(Date.now() - threeDays).toISOString()
    spawnSync('git', ['-C', repo, 'commit', '-q', '--amend', '--no-edit', '--date', iso], {
      encoding: 'utf8',
      env: { ...process.env, GIT_COMMITTER_DATE: iso }
    })
    const aged = git('rev-parse', '--short', 'HEAD')
    const { status, out } = runLint([
      `| **alpha** (${stamp(threeDays)}) | branch \`lane/alpha\`. Owns stuff | no | yes | \`${aged}\` |`
    ])
    assert.equal(status, 1, out)
    assert.match(out, /✗ R1 .*\[alpha\].*stale/)
    assert.match(out, /RESULT: FAIL/)
  })

  test('a live checkpoint keeps a stale-DATED row fresh (the refreshed-SHA escape)', () => {
    git('checkout', '-q', 'lane/alpha')
    writeFileSync(join(repo, 'alpha2.txt'), 'a2\n')
    git('add', '.')
    git('commit', '-q', '-m', 'alpha work 2')
    const fresh = git('rev-parse', '--short', 'HEAD')
    const { status, out } = runLint([
      `| **alpha** (${stamp(3 * 24 * 3600 * 1000)}) | branch \`lane/alpha\`. Owns stuff | no | yes | \`${fresh}\` |`
    ])
    assert.equal(status, 0, out)
  })

  test('FAILS (R4) when the branch already merged into trunk — a date cannot fake this', () => {
    const { status, out } = runLint([
      `| **shipped** (${stamp(0)}) | branch \`lane/merged\`. Owns stuff | no | yes | \`${git('rev-parse', '--short', 'lane/merged')}\` |`
    ])
    assert.equal(status, 1, out)
    assert.match(out, /✗ R4 .*\[shipped\].*already an ancestor of trunkref/)
    assert.match(out, /lane:close/)
  })

  test('FAILS (R3) on a checkpoint SHA git has never heard of', () => {
    const { status, out } = runLint([
      `| **ghost** (${stamp(0)}) | branch \`lane/alpha\`. Owns stuff | no | yes | \`deadbee\` |`
    ])
    assert.equal(status, 1, out)
    assert.match(out, /✗ R3 .*\[ghost\].*does not resolve/)
  })

  test('FAILS (R2) on an open row that names no branch and no reason', () => {
    const { status, out } = runLint([
      `| **deploy** (${stamp(0)}) | deploy lane | YES | no | \`${git('rev-parse', '--short', 'trunkref')}\` |`
    ])
    assert.equal(status, 1, out)
    assert.match(out, /✗ R2 .*\[deploy\].*names no branch/)
  })

  test('R2 accepts an explicit `no-branch:` reason (the deploy-owner row shape)', () => {
    const { status, out } = runLint([
      `| **deploy** (${stamp(0)}) | deploy lane. no-branch: owns the deploy lock, not a ref | YES | no | \`${git('rev-parse', '--short', 'trunkref')}\` |`
    ])
    assert.equal(status, 0, out)
  })

  test('a MERGED row is exempt from TTL but its merge SHA must be in trunk', () => {
    const good = runLint([
      `| **shipped** MERGED (${stamp(30 * 24 * 3600 * 1000)}) | branch \`lane/merged\` | no | no | \`${git('rev-parse', '--short', 'trunkref')}\` |`
    ])
    assert.equal(good.status, 0, good.out)

    const lying = runLint([
      `| **shipped** MERGED (${stamp(0)}) | branch \`lane/alpha\` | no | no | \`${git('rev-parse', '--short', 'lane/alpha')}\` |`
    ])
    assert.equal(lying.status, 1, lying.out)
    assert.match(lying.out, /✗ R5 .*NOT an ancestor/)
  })

  test('template rows are skipped, not failed', () => {
    const { status, out } = runLint(['| _(example)_ engine | `electron/**` | no | no | `<commit>` |'])
    assert.equal(status, 0, out)
    assert.match(out, /0 live, 1 template/)
  })

  test('no board at all PASSES — the public tree has no lanes to verify', () => {
    rmSync(join(repo, 'SESSION-LANES.md'), { force: true })
    const r = spawnSync(process.execPath, [SCRIPT, '--root', repo, '--trunk', 'trunkref'], { encoding: 'utf8' })
    assert.equal(r.status, 0, String(r.stdout) + String(r.stderr))
    assert.match(String(r.stdout), /PASS — no lane board/)
  })

  test('a board whose Live lanes table has been renamed away FAILS loudly', () => {
    mkdirSync(join(repo, '.keep'), { recursive: true })
    writeFileSync(join(repo, 'SESSION-LANES.md'), '# SESSION-LANES\n\n## Something else\n\nno table here\n')
    const r = spawnSync(process.execPath, [SCRIPT, '--root', repo, '--trunk', 'trunkref'], { encoding: 'utf8' })
    assert.equal(r.status, 1)
    assert.match(String(r.stderr), /parser has gone dark/)
  })
})
