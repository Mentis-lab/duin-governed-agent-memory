#!/usr/bin/env node
/**
 * lane-guard — pre-commit guard against the cross-lane work-sweep.
 *
 * WHY THIS EXISTS
 * ---------------
 * 6545f48 ("docs: second pass...") swept SEVEN uncommitted source files belonging to a
 * parallel session into an unrelated docs commit; dacf8c7 exists only to disclose it.
 * Nothing was lost, but the branch history now attributes one session's work to another's
 * commit. SESSION-LANES.md had already mandated separate worktrees a week before it
 * happened — prose did not prevent it, so this is the mechanical version.
 *
 * Two independent checks, either of which aborts the commit:
 *
 *   1. STAGED COUNT.  More than MAX_STAGED (12) paths in one commit is the shape a
 *      `git add -A` in a shared tree makes. Legitimate wide commits exist; they take
 *      the documented escape.
 *   2. LANE SCOPE.    Every staged path must fall inside the lane this session declared.
 *      The lane is resolved from $LANE_FILES, else from the row in SESSION-LANES.md
 *      matching $LANE or the current branch. If NO lane can be resolved the scope check
 *      degrades to an advisory warning — an unresolvable lane must never wedge a commit,
 *      because a guard that blocks work nobody can unblock gets uninstalled.
 *
 * ESCAPE HATCH (documented, deliberate, single):
 *
 *      LANE_OVERRIDE=1 git commit …
 *
 * Read-only: this script never stages, unstages, checks out or resets anything.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

const MAX_STAGED = 12
// git's canonical empty-tree object — lets the guard work on a repo with no commits yet,
// where `git diff --cached` alone errors out on the missing HEAD.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

// Paths every lane is always allowed to touch: the coordination board itself (you must be
// able to claim/release your row) and this guard's own escape documentation.
const ALWAYS_ALLOWED = [/^SESSION-LANES\.md$/]

// Branch names that are never a lane. `main` used to inherit the MERGED `executor-p1` row
// by bare substring (its file list names `electron/main.ts`), which blocked every ordinary
// commit on the public default branch with "README.md outside lane".
const NOT_A_LANE = new Set(['main', 'master', 'trunk', 'develop', 'HEAD'])

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}
function gitQuiet(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

function stagedPaths() {
  const hasHead = gitQuiet(['rev-parse', '--verify', '--quiet', 'HEAD']) !== null
  const out = hasHead
    ? git(['diff', '--cached', '--name-only'])
    : git(['diff', '--cached', '--name-only', EMPTY_TREE])
  return out
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Current lane key: explicit $LANE wins, else the branch name. */
function laneKey() {
  if (process.env.LANE) return process.env.LANE.trim()
  const br = (gitQuiet(['rev-parse', '--abbrev-ref', 'HEAD']) || '').trim()
  return br && br !== 'HEAD' ? br : ''
}

/**
 * Turn one backticked token from the board into a matcher, or null if it is not a path.
 *
 * The board's "files owned" cell also holds branch names, worktree paths and commit SHAs
 * in backticks. Treating `duin/loop-surface-completion` as a path prefix would let a lane
 * commit anything under a directory that does not exist, so a token only counts as a path
 * when it carries a source extension, a glob, a trailing slash, or actually exists.
 */
const EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|cmd|sh|py|css|html)$/i
function toPattern(tok) {
  if (!tok || tok.startsWith('../') || tok.startsWith('~')) return null
  if (/^[0-9a-f]{7,40}$/i.test(tok)) return null // commit sha
  const looksPath =
    tok.includes('*') || tok.endsWith('/') || EXT.test(tok) || existsSync(tok)
  return looksPath ? tok.replace(/^\.\//, '') : null
}

/** Glob → RegExp. `**` crosses directory separators, `*` does not. */
function globToRe(glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
        if (glob[i + 1] === '/') i++ // `a/**/b` should also match `a/b`
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') re += '[^/]'
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp('^' + re + '$')
}

function matches(path, pattern) {
  const p = path.replace(/\\/g, '/')
  const pat = pattern.replace(/\\/g, '/')
  // Bare filename (no separator): match on basename, so `coherence-map.ts` on the board
  // covers electron/services/brain/coherence-map.ts without spelling the directory.
  if (!pat.includes('/')) return globToRe(pat).test(p.split('/').pop())
  // Directory prefix: `.github/`, `electron/**`, `scripts/hooks/`.
  const prefix = pat.replace(/\*+$/, '').replace(/\/+$/, '')
  if (prefix && (p === prefix || p.startsWith(prefix + '/'))) return true
  return globToRe(pat).test(p)
}

/** Resolve {patterns, row} for this session, or {patterns: null} when it cannot be known. */
function resolveLane() {
  if (process.env.LANE_FILES) {
    const patterns = process.env.LANE_FILES.split(/[;,\s]+/).map(toPattern).filter(Boolean)
    return { patterns, row: `$LANE_FILES=${process.env.LANE_FILES}`, source: 'LANE_FILES' }
  }
  const key = laneKey()
  if (!key || NOT_A_LANE.has(key) || !existsSync('SESSION-LANES.md')) return { patterns: null }

  const board = readFileSync('SESSION-LANES.md', 'utf8')
  const rows = board
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|') && !/^\s*\|[\s|:-]+\|\s*$/.test(l))
  // The short lane key ("lane-ci" from duin/lane-ci) is matched too, so a row can be claimed
  // under either the branch or a human name. Whole tokens only: a key must not hit the inside
  // of a path (`main` in `electron/main.ts`, `test` in `x.test.ts`, `src` in `src/**`), and a
  // key shorter than four characters is too generic to name a row at all.
  const short = key.replace(/^.*\//, '')
  const token = (s) => new RegExp('(?<![\\w./-])' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w./-])')
  const hit = rows.find(
    (r) =>
      !/_\(example\)_/.test(r) &&
      (token(key).test(r) || (short.length >= 4 && !NOT_A_LANE.has(short) && token(short).test(r)))
  )
  if (!hit) return { patterns: null }

  const toks = [...hit.matchAll(/`([^`]+)`/g)].map((m) => m[1])
  const patterns = toks.map(toPattern).filter(Boolean)
  if (patterns.length === 0) return { patterns: null, row: hit }
  return { patterns, row: hit.trim(), source: 'SESSION-LANES.md' }
}

// ------------------------------------------------------------------ main
function fail(lines) {
  // ASCII only: this text is printed by a hook that runs under cmd.exe, Git Bash and CI
  // alike, and a box-drawing character renders as mojibake in at least one of them.
  console.error('')
  console.error('  +-- lane-guard: COMMIT BLOCKED ' + '-'.repeat(37))
  for (const l of lines) console.error('  | ' + l)
  console.error('  |')
  console.error('  | If this commit really is meant to be this wide, take the escape:')
  console.error('  |     LANE_OVERRIDE=1 git commit ...')
  console.error('  | (or `npm run hooks:uninstall` to remove all hooks.)')
  console.error('  +' + '-'.repeat(67))
  console.error('')
  process.exit(1)
}

if (process.env.LANE_OVERRIDE === '1') {
  console.log('[lane-guard] LANE_OVERRIDE=1 — scope checks skipped by request.')
  process.exit(0)
}

const staged = stagedPaths()
if (staged.length === 0) process.exit(0)

if (staged.length > MAX_STAGED) {
  fail([
    `${staged.length} paths staged; the limit is ${MAX_STAGED}.`,
    'A commit this wide is the shape `git add -A` makes in a shared tree —',
    'that is how 6545f48 swept seven files belonging to another session.',
    '',
    ...staged.slice(0, 15).map((f) => '  ' + f),
    ...(staged.length > 15 ? [`  … and ${staged.length - 15} more`] : [])
  ])
}

const { patterns, row, source } = resolveLane()
if (!patterns) {
  // Deliberately not fatal. See the header: an unresolvable lane must not wedge a commit.
  console.log(
    '[lane-guard] no lane row resolved for this session — scope check skipped ' +
      '(staged count OK). Declare one in SESSION-LANES.md or set LANE_FILES to enable it.'
  )
  process.exit(0)
}

const outside = staged.filter(
  (f) => !ALWAYS_ALLOWED.some((re) => re.test(f)) && !patterns.some((p) => matches(f, p))
)
if (outside.length > 0) {
  fail([
    `${outside.length} staged path(s) fall outside this session's lane.`,
    `lane source : ${source}`,
    `violated row: ${String(row).slice(0, 200)}`,
    `lane covers : ${patterns.join(' , ')}`,
    '',
    'outside the lane:',
    ...outside.slice(0, 15).map((f) => '  ' + f),
    ...(outside.length > 15 ? [`  … and ${outside.length - 15} more`] : [])
  ])
}

console.log(`[lane-guard] ${staged.length} staged path(s), all within lane. OK.`)
