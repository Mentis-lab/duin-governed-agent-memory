// lane-close.test.mjs — proves `lane:close` writes exactly three files, records
// the REAL merge SHA, and refuses to close a lane that has not merged.
//
// Run: npm run test:teeth   (node --test "scripts/*.test.mjs")

import { test, describe, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { closeBoardRow, listGaps, positional, stampGaps } from './lane-close.mjs'

const SCRIPT = fileURLToPath(new URL('./lane-close.mjs', import.meta.url))

let repo
const git = (...args) => {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return String(r.stdout).trim()
}

const BOARD = (extra = '') =>
  [
    '# SESSION-LANES',
    '',
    '## Live lanes (edit me)',
    '',
    '| Session | Lane / files owned | Deploy owner? | Building now? | Last checkpoint |',
    '|---|---|---|---|---|',
    '| **alpha** (2026-08-01 09:00) | worktree `../a`, branch `lane/alpha`. Owns `src/a` | no | yes | `abc1234` |',
    '| **beta** (2026-08-02 10:00) | worktree `../b`, branch `lane/beta`. Owns `src/b` | no | yes | `def5678` |',
    '| _(example)_ engine | `electron/**` | no | no | `<commit>` |',
    extra,
    '',
    '## Notes',
    ''
  ].join('\n')

const LEDGER = [
  '# Gap ledger',
  '',
  '## 1. CLOSED — the migration system was frozen',
  '',
  '*Violates properties 3, 6, 7 · closed 2026-07-31, measured*',
  '',
  'body one',
  '',
  '## 2. Two durable-fact stores',
  '',
  '*Violates property 2 · 2026-07-30*',
  '',
  'body two',
  '',
  '## 4. The slow loops are instrumented and idle',
  '',
  '*Violates property 7 · 2026-07-30*',
  '',
  'body four',
  ''
].join('\n')

function seedRepo() {
  writeFileSync(join(repo, 'SESSION-LANES.md'), BOARD())
  mkdirSync(join(repo, 'ARCHITECTURE'), { recursive: true })
  mkdirSync(join(repo, 'PLANNING'), { recursive: true })
  writeFileSync(join(repo, 'ARCHITECTURE/GAP_LEDGER.md'), LEDGER)
  writeFileSync(join(repo, 'PLANNING/INDEX.md'), '# Planning index\n\n(stale)\n')
  // Stand-in for I4's generator: rewrites PLANNING/INDEX.md from the directory.
  writeFileSync(
    join(repo, 'scripts/gen-planning-index.mjs'),
    [
      "import { readdirSync, writeFileSync } from 'node:fs'",
      "const files = readdirSync('PLANNING').filter((f) => f !== 'INDEX.md').sort()",
      "writeFileSync('PLANNING/INDEX.md', '# Planning index\\n\\n' + files.map((f) => '- ' + f).join('\\n') + '\\n')"
    ].join('\n')
  )
  writeFileSync(join(repo, 'PLANNING/A_PLAN.md'), '# a\n')
  writeFileSync(join(repo, 'PLANNING/B_PLAN.md'), '# b\n')
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', scripts: {} }))
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, '--root', repo, '--trunk', 'trunkref', ...args], {
    encoding: 'utf8',
    cwd: repo
  })
  return { status: r.status, out: String(r.stdout || '') + String(r.stderr || '') }
}

describe('lane-close', () => {
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'lane-close-'))
    mkdirSync(join(repo, 'scripts'), { recursive: true })
    git('init', '-q', '-b', 'trunkref')
    git('config', 'user.email', 'lane-close@test')
    git('config', 'user.name', 'lane close test')
    // Windows checkouts otherwise CRLF-ify the fixtures, and a byte-for-byte
    // "nothing was written" assertion would compare LF source against CRLF disk.
    git('config', 'core.autocrlf', 'false')
    seedRepo()
    git('add', '.')
    git('commit', '-q', '-m', 'seed')
    // lane/alpha MERGES into trunk; lane/beta stays unmerged.
    git('checkout', '-q', '-b', 'lane/alpha')
    writeFileSync(join(repo, 'src-a.txt'), 'a\n')
    git('add', '.')
    git('commit', '-q', '-m', 'alpha work')
    git('checkout', '-q', 'trunkref')
    git('merge', '-q', '--no-ff', '-m', "Merge branch 'lane/alpha' into trunkref", 'lane/alpha')
    git('checkout', '-q', 'trunkref')
    git('branch', 'lane/beta')
    git('checkout', '-q', 'lane/beta')
    writeFileSync(join(repo, 'src-b.txt'), 'b\n')
    git('add', '.')
    git('commit', '-q', '-m', 'beta work')
    git('checkout', '-q', 'trunkref')
    git('add', '.')
    git('commit', '-q', '-m', 'checkpoint', '--allow-empty')
  })

  beforeEach(() => {
    // Restore the three tracked docs AND the stand-in generator to their
    // committed state between cases, by explicit path — never `git checkout .`,
    // which would also revert anything a concurrent process was writing. Listing
    // the generator here keeps the cases order-independent: one of them deletes
    // it on purpose.
    git(
      'checkout',
      '--',
      'SESSION-LANES.md',
      'ARCHITECTURE/GAP_LEDGER.md',
      'PLANNING/INDEX.md',
      'scripts/gen-planning-index.mjs'
    )
  })

  after(() => {
    try {
      rmSync(repo, { recursive: true, force: true })
    } catch {
      /* disposable */
    }
  })

  test('writes EXACTLY the three files, with the real merge SHA — the acceptance case', () => {
    const expectedMerge = git('rev-list', '--ancestry-path', '--merges', 'lane/alpha..trunkref').split('\n').filter(Boolean).pop()
    const expectedShort = git('rev-parse', '--short', expectedMerge)

    const { status, out } = run(['alpha', '--gaps=2,4'])
    assert.equal(status, 0, out)

    const touched = git('diff', '--name-only').split('\n').filter(Boolean).sort()
    assert.deepEqual(touched, ['ARCHITECTURE/GAP_LEDGER.md', 'PLANNING/INDEX.md', 'SESSION-LANES.md'])

    const board = readFileSync(join(repo, 'SESSION-LANES.md'), 'utf8')
    assert.match(board, new RegExp(`\\*\\*alpha\\*\\* MERGED .*\`${expectedShort}\` \\(merged\\)`))
    assert.match(board, /\*\*beta\*\* \(2026-08-02/) // untouched
    assert.match(board, /_\(example\)_/) // untouched

    const ledger = readFileSync(join(repo, 'ARCHITECTURE/GAP_LEDGER.md'), 'utf8')
    assert.match(ledger, /^## 2\. CLOSED — Two durable-fact stores$/m)
    assert.match(ledger, new RegExp(`\\*Violates property 2 · 2026-07-30 · closed \\d{4}-\\d{2}-\\d{2}, ${expectedShort}\\*`))
    assert.match(ledger, /^## 4\. CLOSED — The slow loops are instrumented and idle$/m)
    // Gap 1 was already CLOSED and was NOT re-stamped.
    assert.equal((ledger.match(/closed 2026-07-31, measured/g) || []).length, 1)
    assert.doesNotMatch(ledger, /^## 1\. CLOSED — CLOSED/m)

    const index = readFileSync(join(repo, 'PLANNING/INDEX.md'), 'utf8')
    assert.match(index, /- A_PLAN\.md/)
    assert.match(index, /- B_PLAN\.md/)
    assert.doesNotMatch(index, /\(stale\)/)
  })

  test('REFUSES to close a lane whose branch has not merged into trunk', () => {
    const { status, out } = run(['beta', '--gaps=none'])
    assert.equal(status, 1, out)
    assert.match(out, /NOT an ancestor of trunkref/)
    assert.equal(git('diff', '--name-only'), '', 'nothing may be written on a refusal')
  })

  test('REFUSES a merge SHA trunk does not contain', () => {
    const betaTip = git('rev-parse', 'lane/beta')
    const { status, out } = run(['beta', '--gaps=none', `--merge-sha=${betaTip}`])
    assert.equal(status, 1, out)
    assert.match(out, /not an ancestor of trunkref/)
  })

  test('REFUSES a gap number the ledger does not have, writing nothing to the ledger', () => {
    const { status, out } = run(['alpha', '--gaps=2,99'])
    assert.equal(status, 1, out)
    assert.match(out, /no section\(s\) numbered 99/)
    assert.equal(readFileSync(join(repo, 'ARCHITECTURE/GAP_LEDGER.md'), 'utf8'), LEDGER)
  })

  test('is idempotent: a second close of the same lane refuses instead of double-stamping', () => {
    assert.equal(run(['alpha', '--gaps=none']).status, 0)
    const { status, out } = run(['alpha', '--gaps=none'])
    assert.equal(status, 1, out)
    assert.match(out, /already MERGED/)
  })

  test('names the missing index generator, and leaves NO half-closed repo behind', () => {
    rmSync(join(repo, 'scripts/gen-planning-index.mjs'))
    const { status, out } = run(['alpha', '--gaps=2'])
    assert.equal(status, 1, out)
    assert.match(out, /no PLANNING\/INDEX\.md generator found/)
    assert.match(out, /item I4 and has not landed/)
    // The regression this case exists for: the first version wrote the board and
    // the ledger BEFORE looking for the generator, so a failure here left the row
    // marked MERGED, the index stale, and a re-run refusing as 'already MERGED'.
    assert.equal(
      git('diff', '--name-only', '--', 'SESSION-LANES.md', 'ARCHITECTURE/GAP_LEDGER.md', 'PLANNING/INDEX.md'),
      '',
      'a close that cannot complete must write nothing at all'
    )
    // --no-index is the documented way through, and it still closes the board.
    const ok = run(['alpha', '--gaps=none', '--no-index'])
    assert.equal(ok.status, 0, ok.out)
    assert.deepEqual(
      git('diff', '--name-only', '--', 'SESSION-LANES.md', 'ARCHITECTURE/GAP_LEDGER.md', 'PLANNING/INDEX.md')
        .split('\n')
        .filter(Boolean),
      ['SESSION-LANES.md']
    )
  })

  test('--dry-run prints the plan and writes nothing', () => {
    const { status, out } = run(['alpha', '--gaps=2', '--dry-run'])
    assert.equal(status, 0, out)
    assert.match(out, /DRY RUN, nothing written/)
    assert.equal(git('diff', '--name-only'), '')
  })

  test('matches a lane by branch name as well as by row name', () => {
    const { status, out } = run(['lane/alpha', '--gaps=none', '--no-index'])
    assert.equal(status, 0, out)
    assert.match(readFileSync(join(repo, 'SESSION-LANES.md'), 'utf8'), /\*\*alpha\*\* MERGED/)
  })

  test('positional() does not mistake a flag value for the lane name', () => {
    assert.equal(positional(['--root', '/tmp/x', 'teeth', '--gaps=1']), 'teeth')
    assert.equal(positional(['--gaps', '1,2', 'teeth']), 'teeth')
    assert.equal(positional(['--dry-run', 'teeth']), 'teeth')
    assert.equal(positional(['--root', '/tmp/x']), null)
  })

  test('closeBoardRow reports the open rows when the lane is not on the board', () => {
    const r = closeBoardRow(BOARD(), 'gamma', 'aaa', '2026-08-03')
    assert.equal(r.ok, false)
    assert.match(r.reason, /no open row matches 'gamma'/)
    assert.deepEqual(r.candidates, ['alpha (lane/alpha)', 'beta (lane/beta)'])
  })

  test('listGaps / stampGaps are pure and skip already-closed sections', () => {
    const gaps = listGaps(LEDGER)
    assert.deepEqual(gaps.map((g) => g.n), [1, 2, 4])
    assert.equal(gaps[0].closed, true)
    const r = stampGaps(LEDGER, [1, 2, 3], 'cafe123', '2026-08-03')
    assert.deepEqual(r.stamped, [2])
    assert.deepEqual(r.skipped, [1])
    assert.deepEqual(r.missing, [3])
  })
})
