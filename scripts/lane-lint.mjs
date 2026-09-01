#!/usr/bin/env node
// lane-lint — expire SESSION-LANES.md rows MECHANICALLY instead of by memory.
//
// WHY THIS EXISTS
// ---------------
// SESSION-LANES.md is the lock board that keeps two sessions out of the same
// file. It only works if it is TRUE. Three rows on it were stale — one for nine
// days — and a stale board is worse than no board: it trains the next session to
// scroll past the table, which is precisely how `6545f48` swept seven of another
// session's uncommitted files into an unrelated commit.
//
// A pure date check is not enough, and the third stale row proves it. That row
// was left behind by a MERGE: the work landed, the branch became an ancestor of
// trunk, nobody went back to the board. The row's date can be refreshed by
// anyone typing today's date; what cannot be faked is git. So this lint resolves
// every row's named branch to its tip and its merged/unmerged state against
// trunk. A merge can no longer leave a lying row behind.
//
// WHAT IT CHECKS (all hard failures — exit 1)
//   R1 date/TTL   an OPEN row whose date AND whose checkpoint commit are both
//                 older than the TTL (48h) is stale.
//   R2 branch     an OPEN row must name a branch (or say why it has none), and
//                 that branch must resolve.
//   R3 checkpoint the checkpoint SHA must resolve to a commit, and must be
//                 reachable from the row's named branch.
//   R4 merged     an OPEN row whose branch is already an ancestor of trunk is a
//                 LYING row. Close it (`npm run lane:close -- <lane>`).
//   R5 closed     a CLOSED row's merge SHA must resolve and be an ancestor of
//                 trunk — a close that names a commit trunk never got is a lie
//                 in the other direction.
//
// ROW GRAMMAR (what the parser expects, so a rewrite does not silently go dark)
//   | **<lane name>** (YYYY-MM-DD [HH:MM]) | …, branch `<ref>`. … | … | … | `<sha>` |
//   - Template rows are SKIPPED: session cell contains `_(example)_`, or the
//     checkpoint cell is the literal `<commit>` placeholder.
//   - A row is CLOSED when its session cell contains the token `MERGED` — that
//     is what `lane:close` writes. Closed rows are exempt from R1/R2/R4.
//   - A row with no branch must carry `no-branch: <reason>` in its lane cell.
//     (The deploy-owner row is the real case: it owns a lock, not a ref.)
//   - `x` in a time (`09:1x`) is read as `0`; that biases the row OLDER by at
//     most 9 minutes, which is the safe direction for a staleness check.
//
// Usage:  node scripts/lane-lint.mjs [--root <dir>] [--trunk <ref>] [--ttl-hours <n>]
//                                    [--board <path>]
//         npm run lint:lanes
// Env:    DUIN_LANE_TTL_HOURS, DUIN_TRUNK
//
// `--board` points the parser at a different board file while git stays on
// `--root`. It exists so a proposed sweep can be checked against the REAL refs
// before anyone edits the real board — dry-running a fix should not require
// making the edit first.

import { readFileSync, existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO_DEFAULT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function flag(name, fallback) {
  const i = process.argv.indexOf(name)
  if (i !== -1 && process.argv[i + 1] !== undefined) return process.argv[i + 1]
  return fallback
}

// NOTE: written as an explicit undefined/'' check rather than `Number(env) || N`
// on purpose — that idiom cannot express 0 and is exactly what scripts/signal-lint.mjs
// RULE 1 fails the build for.
function envNumber(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || String(raw).trim() === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

const ROOT = flag('--root', REPO_DEFAULT)
const TRUNK = flag('--trunk', process.env.DUIN_TRUNK || 'duin/unify-backend-ui')
const TTL_HOURS = Number(flag('--ttl-hours', String(envNumber('DUIN_LANE_TTL_HOURS', 48))))
const BOARD = flag('--board', join(ROOT, 'SESSION-LANES.md'))

// ── git helpers (all scoped to --root; never touch another worktree) ──────────
function git(...args) {
  const r = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' })
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() }
}
const resolves = (ref) => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`).ok
const isAncestor = (a, b) => git('merge-base', '--is-ancestor', a, b).ok
function commitDate(ref) {
  const r = git('show', '-s', '--format=%cI', `${ref}^{commit}`)
  if (!r.ok || !r.out) return null
  const d = new Date(r.out)
  return Number.isNaN(d.getTime()) ? null : d
}

// ── board parsing ────────────────────────────────────────────────────────────
/** Extract the rows of the markdown table that follows the `## Live lanes` heading. */
export function parseBoard(text) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s+Live lanes\b/i.test(l))
  if (start === -1) return { found: false, rows: [] }
  const rows = []
  let sawHeader = false
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (/^##\s/.test(line)) break
    if (!line.trim().startsWith('|')) {
      if (sawHeader && line.trim() === '') break
      continue
    }
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue // separator
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())
    if (!sawHeader) {
      sawHeader = true
      continue // header row
    }
    rows.push({ lineNo: i + 1, cells, raw: line })
  }
  return { found: true, rows }
}

const backticked = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1])

export function classifyRow(row) {
  const [session = '', lane = '', , , checkpoint = ''] = row.cells
  const template = /_\(example\)_/.test(session) || /<commit>/.test(checkpoint)
  const closed = /\bMERGED\b/.test(session)

  // Date: first YYYY-MM-DD in the session cell, optional HH:MM where `x` reads as `0`.
  const dm = session.match(/(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2}|\d[x]|[x]{2}))?/i)
  let date = null
  if (dm) {
    const hh = dm[2] === undefined ? '00' : dm[2]
    const mm = dm[3] === undefined ? '00' : dm[3].replace(/x/gi, '0')
    const d = new Date(`${dm[1]}T${hh}:${mm}:00`)
    if (!Number.isNaN(d.getTime())) date = d
  }

  // Branch: `branch \`<ref>\`` ANYWHERE IN THE ROW, then a guess from the lane cell.
  //
  // Two corrections, both from rows this lint called liars while they were telling the truth:
  //
  // 1. The explicit form was only searched in the LANE cell, but the board's own convention
  //    writes it in the SESSION cell — `**skill-shelf** OPEN … · worktree `../x`, branch `y``.
  //    So the rows that name their branch most clearly were the ones whose name was missed.
  // 2. The fallback then guessed, and its shape test (`a/b`) matches every file path in a
  //    lane cell. Three separate rows were reported as "names branch
  //    `src/components/settings/AgentsSettings.tsx` which does not resolve".
  //
  // A guess that does not resolve is a FAILED GUESS, not a lie: discard it and let the
  // `no-branch:` rule decide. An explicit `branch \`x\`` that does not resolve is still
  // reported, because there the row made a claim.
  const bm = (session + ' ' + lane).match(/branch\s+`([^`]+)`/i)
  const guess = bm
    ? null
    : backticked(lane).find((t) => /^[\w.-]+\/[\w./-]+$/.test(t) && !t.includes(' ')) || null
  const branch = bm ? bm[1] : guess && resolves(guess) ? guess : null

  const noBranchReason = lane.match(/no-branch:\s*(\S[^|]*)/i)
  const sha = backticked(checkpoint)[0] || null
  const nameMatch = session.match(/\*\*([^*]+)\*\*/)
  const name = (nameMatch ? nameMatch[1] : session).replace(/\s*\(.*$/, '').replace(/\bMERGED\b/, '').trim()

  return { ...row, name, template, closed, date, branch, sha, noBranch: noBranchReason ? noBranchReason[1].trim() : null }
}

// ── run ──────────────────────────────────────────────────────────────────────
const findings = []
const notes = []
const fail = (row, rule, msg) => findings.push({ rule, lineNo: row.lineNo, name: row.name, msg })

if (!existsSync(BOARD)) {
  // No board means no claims to verify. The public tree ships without SESSION-LANES.md (it is
  // owner coordination, not product), and a gate that fails on the absence of its own input
  // would turn every contributor's push red for a reason they cannot act on.
  console.log(`[lint:lanes] PASS — no lane board at ${BOARD} (public tree; nothing to verify)`)
  process.exit(0)
}
if (!git('rev-parse', '--git-dir').ok) {
  console.error(`[lint:lanes] ${ROOT} is not a git worktree — the board cannot be verified against refs.`)
  process.exit(1)
}

const { found, rows } = parseBoard(readFileSync(BOARD, 'utf8'))
if (!found) {
  console.error('[lint:lanes] no "## Live lanes" section in SESSION-LANES.md — the parser has gone dark.')
  process.exit(1)
}

const trunkResolves = resolves(TRUNK)
if (!trunkResolves) notes.push(`trunk ref '${TRUNK}' does not resolve — R4/R5 (merged-state) checks are SKIPPED.`)

const now = Date.now()
const ttlMs = TTL_HOURS * 3600 * 1000
const ageHours = (d) => (now - d.getTime()) / 3600000
let live = 0
let skipped = 0

for (const raw of rows) {
  const row = classifyRow(raw)
  if (row.template) {
    skipped++
    continue
  }

  if (row.closed) {
    // R5 — a closed row must name a merge commit that trunk actually contains.
    if (!row.sha) fail(row, 'R5', 'row is MERGED but records no merge SHA')
    else if (!resolves(row.sha)) fail(row, 'R5', `merge SHA \`${row.sha}\` does not resolve`)
    else if (trunkResolves && !isAncestor(row.sha, TRUNK))
      fail(row, 'R5', `merge SHA \`${row.sha}\` is NOT an ancestor of ${TRUNK} — the close claims a merge that did not happen`)
    continue
  }

  live++

  // R2 — an open row must be verifiable against a ref.
  if (!row.branch && !row.noBranch)
    fail(row, 'R2', 'open row names no branch and carries no `no-branch: <reason>` — nothing to verify it against')
  if (row.branch && !resolves(row.branch))
    fail(row, 'R2', `names branch \`${row.branch}\` which does not resolve`)

  // R3 — the checkpoint must be a real commit on that branch.
  if (!row.sha) {
    fail(row, 'R3', 'open row records no checkpoint SHA')
  } else if (!resolves(row.sha)) {
    fail(row, 'R3', `checkpoint \`${row.sha}\` does not resolve to a commit`)
  } else if (row.branch && resolves(row.branch) && !isAncestor(row.sha, row.branch)) {
    fail(row, 'R3', `checkpoint \`${row.sha}\` is not reachable from \`${row.branch}\` — the row points at work that branch does not contain`)
  }

  // R1 — staleness. The row is fresh if EITHER its typed date OR its checkpoint
  // commit is inside the TTL: a session that keeps committing is live even if it
  // did not retype the date.
  const dateAge = row.date ? ageHours(row.date) : null
  const cd = row.sha && resolves(row.sha) ? commitDate(row.sha) : null
  const shaAge = cd ? ageHours(cd) : null
  if (dateAge === null && shaAge === null) {
    fail(row, 'R1', 'row carries no parseable date and no resolvable checkpoint — its age is unknowable')
  } else {
    const freshest = Math.min(dateAge === null ? Infinity : dateAge, shaAge === null ? Infinity : shaAge)
    if (freshest * 3600000 > ttlMs)
      fail(
        row,
        'R1',
        `stale — ${freshest.toFixed(1)}h old (TTL ${TTL_HOURS}h)` +
          (dateAge === null ? '' : `, board date ${dateAge.toFixed(1)}h`) +
          (shaAge === null ? '' : `, checkpoint commit ${shaAge.toFixed(1)}h`)
      )
  }

  // R4 — the merge check. This is the one a date cannot fake.
  if (trunkResolves && row.branch && resolves(row.branch) && isAncestor(row.branch, TRUNK))
    fail(
      row,
      'R4',
      `branch \`${row.branch}\` is already an ancestor of ${TRUNK} — the work merged and the row was never closed. Run \`npm run lane:close -- ${row.name}\`.`
    )
}

// ── report ───────────────────────────────────────────────────────────────────
const out = (s) => process.stdout.write(s + '\n')
const rule = '  ' + '─'.repeat(60)
out('\n  SESSION-LANES board lint')
out(rule)
out(`  board  : ${BOARD}`)
out(`  trunk  : ${TRUNK}${trunkResolves ? '' : ' (UNRESOLVED)'}`)
out(`  ttl    : ${TTL_HOURS}h`)
out(`  rows   : ${live} live, ${skipped} template(s) skipped, ${rows.length} total`)
for (const n of notes) out(`  note   : ${n}`)
out(rule)
if (findings.length === 0) {
  out('  RESULT: PASS — every live row is fresh, resolvable and unmerged.\n')
  process.exit(0)
}
for (const f of findings) out(`  ✗ ${f.rule} ${basename(BOARD)}:${f.lineNo} [${f.name}] — ${f.msg}`)
out(rule)
out(`  RESULT: FAIL — ${findings.length} lying/stale board row finding(s).`)
out('  Fix by editing the row, or close it: npm run lane:close -- <lane>\n')
process.exit(1)
