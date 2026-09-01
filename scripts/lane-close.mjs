#!/usr/bin/env node
// lane-close — make CLOSING work cheaper than writing another handoff.
//
// WHY THIS EXISTS
// ---------------
// A session that finishes work has no authoritative place to close it. So each
// new session re-audits the same ground and writes a NEW handoff document
// instead of retiring the old one — which is why the last 50 commits run roughly
// 24 docs / 14 fix / 4 feat. The board keeps rows for merged branches, the gap
// ledger keeps gaps that were closed weeks ago, and the planning index (when it
// exists) drifts from the directory it indexes. None of that is laziness: the
// closing ritual is three careful edits in three files, and writing a fresh
// handoff is one. This makes closing the cheap option.
//
// WHAT IT DOES — exactly three files, nothing else
//   (a) SESSION-LANES.md          rewrites the lane's row to MERGED and records
//                                 the real merge SHA (resolved from git, not typed)
//   (b) ARCHITECTURE/GAP_LEDGER.md stamps the gap rows the lane closed with that
//                                 SHA and today's date
//   (c) PLANNING/INDEX.md         regenerates it with the repo's index generator
//
// It REFUSES to close a lane whose branch is not actually an ancestor of trunk.
// A close is a claim about git, and this is the one tool that must not let a
// claim outrun the thing it claims.
//
// Usage:
//   npm run lane:close -- <lane>                      (interactive gap picker)
//   npm run lane:close -- <lane> --gaps=2,4           (non-interactive)
//   npm run lane:close -- <lane> --gaps=none          (closed no ledger rows)
//   npm run lane:close -- <lane> --merge-sha=<sha>    (when detection cannot)
//   npm run lane:close -- <lane> --no-index           (skip (c))
//   npm run lane:close -- <lane> --dry-run            (print the plan, write nothing)
// Flags: --root <dir>, --trunk <ref>, --index-cmd "<cmd>"

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_DEFAULT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

// Candidate generators for PLANNING/INDEX.md, tried in order. This lane does not
// own the generator (it is item I4 in another lane), so lane-close DISCOVERS it
// rather than assuming a name — and says so plainly when it finds nothing,
// instead of quietly skipping and reporting success.
const INDEX_GENERATORS = [
  { kind: 'npm', name: 'docs:index' },
  { kind: 'npm', name: 'gen:index' },
  { kind: 'npm', name: 'planning:index' },
  { kind: 'node', name: 'scripts/gen-planning-index.mjs' },
  { kind: 'node', name: 'scripts/gen-planning-index.cjs' },
  { kind: 'node', name: 'scripts/planning-index.mjs' }
]

// Flags that consume the NEXT argv entry when written space-separated. Without
// this list, `--root <dir>` donated `<dir>` to the lane name.
const VALUE_FLAGS = new Set(['--root', '--trunk', '--index-cmd', '--gaps', '--merge-sha'])

/** The first bare argument that is not a flag or a flag's value. */
export function positional(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const bare = a.split('=')[0]
      if (VALUE_FLAGS.has(bare) && !a.includes('=')) i++ // skip its value
      continue
    }
    return a
  }
  return null
}

const argFlag = (argv, name) => argv.includes(name)
function argValue(argv, name, fallback) {
  const eq = argv.find((a) => a.startsWith(name + '='))
  if (eq !== undefined) return eq.slice(name.length + 1)
  const i = argv.indexOf(name)
  if (i !== -1 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1]
  return fallback
}

const today = () => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ── board row rewriting (pure, so it is testable without a repo) ─────────────
/**
 * Rewrite the lane's row to MERGED. Matching is on the bolded session name OR
 * the branch named in the lane cell, so `lane:close -- duin/lane-teeth` and
 * `lane:close -- teeth` both work.
 * @returns {{ok:true, text:string, lineNo:number, branch:string|null}|{ok:false, reason:string, candidates:string[]}}
 */
export function closeBoardRow(boardText, lane, mergeSha, date) {
  const lines = boardText.split(/\r?\n/)
  const candidates = []
  let hit = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim().startsWith('|')) continue
    if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) continue
    if (/\|\s*Session\s*\|/i.test(line)) continue
    if (/_\(example\)_/.test(line)) continue
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
    const nameMatch = cells[0].match(/\*\*([^*]+)\*\*/)
    const name = (nameMatch ? nameMatch[1] : cells[0]).replace(/\s*\(.*$/, '').trim()
    const branchMatch = (cells[1] || '').match(/branch\s+`([^`]+)`/i)
    const branch = branchMatch ? branchMatch[1] : null
    if (name) candidates.push(name + (branch ? ` (${branch})` : ''))
    const matches =
      name.toLowerCase() === lane.toLowerCase() ||
      (branch && branch.toLowerCase() === lane.toLowerCase()) ||
      (branch && branch.toLowerCase().endsWith('/' + lane.toLowerCase()))
    if (matches) {
      if (/\bMERGED\b/.test(cells[0])) return { ok: false, reason: `row for '${lane}' is already MERGED`, candidates }
      hit = i
      break
    }
  }
  if (hit === -1) return { ok: false, reason: `no open row matches '${lane}'`, candidates }

  const cells = lines[hit].trim().replace(/^\|/, '').replace(/\|$/, '').split('|')
  const nameMatch = cells[0].match(/\*\*([^*]+)\*\*/)
  const name = (nameMatch ? nameMatch[1] : cells[0]).replace(/\s*\(.*$/, '').trim()
  const branchMatch = (cells[1] || '').match(/branch\s+`([^`]+)`/i)
  cells[0] = ` **${name}** MERGED (${date}) `
  if (cells.length > 2) cells[2] = ' no ' // deploy owner
  if (cells.length > 3) cells[3] = ' no ' // building now
  cells[cells.length - 1] = ` \`${mergeSha}\` (merged) `
  lines[hit] = '|' + cells.join('|') + '|'
  return { ok: true, text: lines.join('\n'), lineNo: hit + 1, branch: branchMatch ? branchMatch[1] : null }
}

// ── gap ledger stamping (pure) ───────────────────────────────────────────────
/** List the ledger's numbered gap sections: `## 4. The slow loops are …` */
export function listGaps(ledgerText) {
  const out = []
  ledgerText.split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^##\s+(\d+)\.\s+(.*)$/)
    if (m) out.push({ n: Number(m[1]), title: m[2].trim(), lineNo: i + 1, closed: /^CLOSED\b/i.test(m[2].trim()) })
  })
  return out
}

/**
 * Stamp the named gap sections closed with `<date>, <sha>`. Idempotent: a
 * section already marked CLOSED is left alone and reported as skipped.
 */
export function stampGaps(ledgerText, numbers, sha, date) {
  const lines = ledgerText.split(/\r?\n/)
  const gaps = listGaps(ledgerText)
  const stamped = []
  const skipped = []
  const missing = []

  for (const n of numbers) {
    const gap = gaps.find((g) => g.n === n)
    if (!gap) {
      missing.push(n)
      continue
    }
    if (gap.closed) {
      skipped.push(n)
      continue
    }
    const idx = gap.lineNo - 1
    lines[idx] = `## ${n}. CLOSED — ${gap.title}`
    // The italic meta line directly under the heading carries the provenance.
    // Find it within the next 3 lines; insert one if the section has none.
    let metaIdx = -1
    for (let j = idx + 1; j <= Math.min(idx + 3, lines.length - 1); j++) {
      if (/^\*.*\*\s*$/.test(lines[j].trim())) {
        metaIdx = j
        break
      }
      if (/^##\s/.test(lines[j])) break
    }
    const stamp = `closed ${date}, ${sha}`
    if (metaIdx === -1) {
      lines.splice(idx + 1, 0, '', `*${stamp}*`)
    } else {
      const body = lines[metaIdx].trim().replace(/^\*/, '').replace(/\*$/, '').trim()
      lines[metaIdx] = `*${body} · ${stamp}*`
    }
    stamped.push(n)
  }
  return { text: lines.join('\n'), stamped, skipped, missing }
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main(argv) {
  const ROOT = argValue(argv, '--root', REPO_DEFAULT)
  const TRUNK = argValue(argv, '--trunk', process.env.DUIN_TRUNK || 'duin/unify-backend-ui')
  const dryRun = argFlag(argv, '--dry-run')
  const noIndex = argFlag(argv, '--no-index')
  const lane = positional(argv)

  const die = (msg) => {
    console.error(`[lane:close] ${msg}`)
    process.exit(1)
  }
  if (!lane) die('usage: npm run lane:close -- <lane> [--gaps=2,4|none] [--merge-sha=<sha>] [--no-index] [--dry-run]')

  const git = (...a) => {
    const r = spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' })
    return { ok: r.status === 0, out: String(r.stdout || '').trim() }
  }
  if (!git('rev-parse', '--git-dir').ok) die(`${ROOT} is not a git worktree`)

  const boardPath = join(ROOT, 'SESSION-LANES.md')
  const ledgerPath = join(ROOT, 'ARCHITECTURE', 'GAP_LEDGER.md')
  const indexPath = join(ROOT, 'PLANNING', 'INDEX.md')
  if (!existsSync(boardPath)) die(`${boardPath} not found`)

  // ── resolve the merge SHA from git. A close is a claim about git; it must not
  //    be typed. ───────────────────────────────────────────────────────────────
  const board = readFileSync(boardPath, 'utf8')
  const probe = closeBoardRow(board, lane, 'PROBE', today())
  if (!probe.ok) die(`${probe.reason}. Open rows: ${probe.candidates.join(', ') || '(none)'}`)
  const branch = probe.branch

  let mergeSha = argValue(argv, '--merge-sha', null)
  if (!mergeSha) {
    if (!branch) die(`the row for '${lane}' names no branch, so the merge SHA cannot be resolved — pass --merge-sha=<sha>`)
    if (!git('rev-parse', '--verify', '--quiet', `${branch}^{commit}`).ok)
      die(`branch \`${branch}\` does not resolve — pass --merge-sha=<sha> if the branch was deleted after merging`)
    if (!git('merge-base', '--is-ancestor', branch, TRUNK).ok)
      die(
        `branch \`${branch}\` is NOT an ancestor of ${TRUNK} — it has not merged, so there is nothing to close. ` +
          'Closing it here would put a lie on the board, which is the failure this tool exists to prevent.'
      )
    const merges = git('rev-list', '--ancestry-path', '--merges', `${branch}..${TRUNK}`)
    const list = merges.out ? merges.out.split('\n').filter(Boolean) : []
    // The LAST entry walking back from trunk is the merge that first brought the
    // branch in. A fast-forward leaves no merge commit at all — then the branch
    // tip IS the landing point.
    mergeSha = list.length > 0 ? list[list.length - 1] : git('rev-parse', branch).out
  }
  if (!git('rev-parse', '--verify', '--quiet', `${mergeSha}^{commit}`).ok) die(`merge SHA ${mergeSha} does not resolve`)
  if (!git('merge-base', '--is-ancestor', mergeSha, TRUNK).ok)
    die(`merge SHA ${mergeSha} is not an ancestor of ${TRUNK} — refusing to record a merge trunk does not contain`)
  const shortSha = git('rev-parse', '--short', mergeSha).out || mergeSha

  // ── which gap rows did this lane close? ────────────────────────────────────
  let gapNumbers = []
  const gapsArg = argValue(argv, '--gaps', null)
  const ledgerExists = existsSync(ledgerPath)
  if (gapsArg === null) {
    if (!ledgerExists) {
      console.warn(`[lane:close] no ${ledgerPath} — skipping the ledger stamp`)
    } else if (!process.stdin.isTTY) {
      die('--gaps=<n,n|none> is required when not attached to a terminal (there is nobody to prompt)')
    } else {
      const gaps = listGaps(readFileSync(ledgerPath, 'utf8'))
      console.log(`\n  Gap ledger — which rows did lane '${lane}' close?\n`)
      for (const g of gaps) console.log(`   ${String(g.n).padStart(3)}  ${g.closed ? '[closed] ' : '         '}${g.title}`)
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await new Promise((res) => rl.question('\n  numbers (comma-separated), or "none": ', res))
      rl.close()
      gapNumbers = answer.trim().toLowerCase() === 'none' ? [] : answer.split(/[,\s]+/).map(Number).filter(Number.isFinite)
    }
  } else if (gapsArg.toLowerCase() !== 'none') {
    gapNumbers = gapsArg.split(/[,\s]+/).map(Number).filter(Number.isFinite)
  }

  // ── PLAN EVERYTHING BEFORE WRITING ANYTHING ────────────────────────────────
  // The first version wrote the board, then the ledger, then looked for the
  // index generator — and died there, leaving a HALF-CLOSED repo: the row said
  // MERGED, the index was stale, and a re-run refused because the row was
  // already closed. A tool whose job is to stop half-finished closes must not
  // create one. Every check that can fail now runs first; writes happen only
  // once all three steps are known to be possible.

  // (a) plan the board row
  const rewritten = closeBoardRow(board, lane, shortSha, today())
  if (!rewritten.ok) die(rewritten.reason)

  // (b) plan the ledger stamp
  let stampResult = { stamped: [], skipped: [], missing: [] }
  if (gapNumbers.length > 0) {
    if (!ledgerExists) die(`--gaps was given but ${ledgerPath} does not exist`)
    stampResult = stampGaps(readFileSync(ledgerPath, 'utf8'), gapNumbers, shortSha, today())
    if (stampResult.missing.length > 0)
      die(`gap ledger has no section(s) numbered ${stampResult.missing.join(', ')} — nothing written`)
  }

  // (c) resolve the index generator
  let indexGen = null
  if (!noIndex) {
    const pkgPath = join(ROOT, 'package.json')
    const scripts = existsSync(pkgPath) ? (JSON.parse(readFileSync(pkgPath, 'utf8')).scripts ?? {}) : {}
    const explicit = argValue(argv, '--index-cmd', null)
    indexGen = explicit
      ? { kind: 'shell', name: explicit }
      : INDEX_GENERATORS.find((g) =>
          g.kind === 'npm' ? scripts[g.name] !== undefined : existsSync(join(ROOT, g.name))
        )
    if (!indexGen) {
      // Do NOT quietly skip. The whole point of this tool is that a close is
      // COMPLETE; reporting success on two of three steps is how the drift
      // started in the first place.
      die(
        'no PLANNING/INDEX.md generator found (looked for npm scripts docs:index / gen:index / planning:index and ' +
          'scripts/gen-planning-index.*). That generator is item I4 and has not landed. Re-run with --no-index to ' +
          'close without it, or pass --index-cmd "<command>".'
      )
    }
  }

  // ── WRITE ──────────────────────────────────────────────────────────────────
  const changed = []
  if (!dryRun) writeFileSync(boardPath, rewritten.text, 'utf8')
  changed.push(`SESSION-LANES.md:${rewritten.lineNo} → MERGED ${shortSha}`)

  if (gapNumbers.length > 0) {
    if (!dryRun) writeFileSync(ledgerPath, stampResult.text, 'utf8')
    changed.push(
      `ARCHITECTURE/GAP_LEDGER.md → stamped ${stampResult.stamped.join(', ') || '(none)'}` +
        (stampResult.skipped.length ? `, already-closed skipped: ${stampResult.skipped.join(', ')}` : '')
    )
  }

  if (indexGen) {
    if (!dryRun) {
      const r =
        indexGen.kind === 'npm'
          ? spawnSync('npm', ['run', indexGen.name], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' })
          : indexGen.kind === 'node'
            ? spawnSync(process.execPath, [join(ROOT, indexGen.name)], { cwd: ROOT, stdio: 'inherit' })
            : spawnSync(indexGen.name, { cwd: ROOT, stdio: 'inherit', shell: true })
      if (r.status !== 0) die(`index generator (${indexGen.name}) exited ${r.status}`)
    }
    changed.push(`PLANNING/INDEX.md → regenerated via ${indexGen.kind === 'npm' ? 'npm run ' : ''}${indexGen.name}`)
  }

  const out = (s) => process.stdout.write(s + '\n')
  out(`\n  lane:close — ${lane}${dryRun ? '  (DRY RUN, nothing written)' : ''}`)
  out('  ' + '─'.repeat(60))
  out(`  branch     : ${branch ?? '(none named)'}`)
  out(`  merge sha  : ${shortSha}  (verified: ancestor of ${TRUNK})`)
  for (const c of changed) out(`  wrote      : ${c}`)
  if (noIndex) out('  skipped    : PLANNING/INDEX.md (--no-index)')
  out('  ' + '─'.repeat(60))
  out(`  Verify with: git -C ${ROOT} diff --name-only  (expect exactly the files above)`)
  out(`  Then: npm run lint:lanes  — the row is closed, so R1/R4 no longer fire on it.\n`)
  void indexPath
  process.exit(0)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('[lane:close]', e?.message ?? e)
    process.exit(1)
  })
}
