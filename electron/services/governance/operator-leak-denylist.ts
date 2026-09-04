// operator-leak-denylist — the tokens that must never appear in a shipped DUIN.
//
// Cold-start spec A6. Every other de-personalization item (A1-A5) will regrow: a hardcoded alias
// group, a default track, a keyword regex naming a real partner. Those are all easy to re-add and
// invisible in review. This list plus its test is what makes that impossible rather than merely
// discouraged.
//
// TWO SOURCES, ONE LIST.
//   1. `SAMPLE_DENYLIST` — fictional names that ship in-tree. They exist so the scanner mechanism
//      (word-boundary latin matching, substring CJK matching, the walk, the packaged-artifact scan)
//      is exercised in every checkout, including CI on a public clone. None of them is a real
//      project, company or person.
//   2. A LOCAL file, gitignored: `.leak-denylist.local.json` at the repo root, or whatever path
//      `DUIN_LEAK_DENYLIST_FILE` points at. This is where an operator who builds DUIN from their own
//      vault writes their real identities — the names of their projects, partners and colleagues —
//      so the scan asserts those are absent from the tree. The file never enters git, so the list
//      of things that must not leak cannot itself leak.
//
// Shape of the local file (either form):
//   { "tokens": [ { "token": "Acme Corp", "kind": "org" }, "Jane Doe", ... ] }
//   [ "Acme Corp", { "token": "Jane Doe", "kind": "person" } ]
// A bare string defaults to kind "other". Blank / one-character tokens are dropped: a blank token
// would match every file and make the guard useless-but-green.
//
// Nothing here is loaded at runtime — it is test-only data.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/** A denylisted token plus why it matters, so a failing scan explains itself. */
export interface DenyToken {
  token: string
  kind: 'project' | 'org' | 'person' | 'other'
}

/** Fictional. Keeps the mechanism under test in a tree that carries no real operator identity. */
export const SAMPLE_DENYLIST: DenyToken[] = [
  // Projects
  { token: '夜鸮', kind: 'project' },
  { token: 'yexiao', kind: 'project' },
  // Orgs
  { token: 'Bramblewick Ltd', kind: 'org' },
  { token: 'bramblewick', kind: 'org' },
  { token: '苍梧影业', kind: 'org' },
  { token: 'tarn', kind: 'org' },
  // People
  { token: '钟离墨', kind: 'person' },
  { token: 'wren hollis', kind: 'person' },
  { token: 'ines okonkwo', kind: 'person' }
]

/** Default location of the operator's private list, relative to the repo root. Gitignored. */
export const LOCAL_DENYLIST_FILE = '.leak-denylist.local.json'

const KINDS = new Set<DenyToken['kind']>(['project', 'org', 'person', 'other'])

/** Repo root = three levels up from electron/services/governance. */
export const REPO_ROOT = resolve(__dirname, '..', '..', '..')

/**
 * Read the operator's private denylist. Never throws: a missing, unreadable or malformed file
 * yields an empty list, so a clone without one still runs the sample-backed scan.
 */
/**
 * The MAIN worktree's root, or null when this is not a linked worktree (or git is unavailable).
 *
 * WHY THIS EXISTS. The local denylist is gitignored, so it exists in exactly ONE checkout — and
 * SESSION-LANES.md mandates one WORKTREE PER LANE, where the file is absent. loadLocalDenylist
 * therefore returned [] in every lane, the scan fell back to the fictional SAMPLE_DENYLIST, and
 * it passed while asserting nothing about the operator's real identities. It was not a weak gate,
 * it was an ABSENT gate that reported PASS, which is the worst of the three states.
 *
 * Found 2026-09-03 by running the suite in the shared tree after a night of lane merges: four
 * files carrying the operator's project, his own name and two colleagues' names had reached
 * trunk through worktrees where this scan was green.
 *
 * `--git-common-dir` resolves to the SHARED `.git` from any worktree, so its parent is the main
 * checkout. Best-effort by construction: any failure returns null and the caller degrades to the
 * previous behaviour rather than breaking a public clone that has no git at all.
 */
function mainWorktreeRoot(): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    if (!out) return null
    const common = resolve(REPO_ROOT, out)
    if (!/(^|[\\/])\.git$/.test(common)) return null
    const root = dirname(common)
    return root && root !== REPO_ROOT ? root : null
  } catch {
    return null
  }
}

export function loadLocalDenylist(file?: string): DenyToken[] {
  const explicit = file ?? process.env.DUIN_LEAK_DENYLIST_FILE
  let path = explicit ?? resolve(REPO_ROOT, LOCAL_DENYLIST_FILE)
  if (!explicit && !existsSync(path)) {
    // A linked worktree keeps no copy; read the main checkout's instead.
    const main = mainWorktreeRoot()
    if (main) path = resolve(main, LOCAL_DENYLIST_FILE)
  }
  if (!existsSync(path)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return []
  }
  const rows = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { tokens?: unknown }).tokens)
      ? ((raw as { tokens: unknown[] }).tokens)
      : []
  const out: DenyToken[] = []
  for (const row of rows) {
    if (typeof row === 'string') {
      if (row.trim().length > 1) out.push({ token: row.trim(), kind: 'other' })
      continue
    }
    if (!row || typeof row !== 'object') continue
    const t = (row as { token?: unknown }).token
    const k = (row as { kind?: unknown }).kind
    if (typeof t !== 'string' || t.trim().length <= 1) continue
    out.push({ token: t.trim(), kind: KINDS.has(k as DenyToken['kind']) ? (k as DenyToken['kind']) : 'other' })
  }
  return out
}

/** Sample + local, de-duplicated on the lowercased token. Computed once per process. */
export const OPERATOR_DENYLIST: DenyToken[] = (() => {
  const seen = new Set<string>()
  const merged: DenyToken[] = []
  for (const d of [...SAMPLE_DENYLIST, ...loadLocalDenylist()]) {
    const key = d.token.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(d)
  }
  return merged
})()

/** Paths the scan skips. Kept tiny and justified — every exclusion is a hole in the guard.
 *  - the denylist itself and its test (they must contain the tokens to work)
 *  - the operator's private list (only reachable by the tree-wide scan; it IS the token list)
 *  - test files and fixtures (they never enter the production bundle)
 *  - `*.eval.ts` live measurement harnesses, for the SAME reason and on the same evidence:
 *      · they are vitest suites, run only by `vitest.eval.config.ts`, whose `include` is
 *        `electron` + `.eval.ts` — deliberately outside the default suite;
 *      · no production module imports one (the reverse: they import production code);
 *      · `electron.vite.config.ts` builds `out/` from four explicit rollup entries
 *        (electron/main.ts, electron/cli.ts, rag/embeddings/worker.ts, rag/ocr/paddle-worker.ts)
 *        plus src/index.html — a module not transitively imported from an entry is never emitted;
 *      · `electron-builder.yml` ships the `out` tree, package.json and node_modules only. NO
 *        `electron` source is packaged, so a `.eval.ts` cannot reach app.asar by any path.
 *    An eval measures retrieval against the operator's REAL vault, so its probes must name real
 *    entities to mean anything; de-personalizing them would delete the measurement. The packaged-
 *    artifact scan below is the backstop: if this reasoning is ever wrong, the asar scan catches it. */
export const LEAK_SCAN_EXCLUDES = [
  'operator-leak-denylist.ts',
  'operator-leak-scan.test.ts',
  LOCAL_DENYLIST_FILE,
  '.test.ts',
  '.test.tsx',
  '.eval.ts',
  '__fixtures__'
]

/** A token made only of latin letters/digits and separators — the kind that can be swallowed
 *  by a longer identifier. CJK tokens fail this test and keep substring semantics. */
const LATIN_TOKEN = /^[a-z0-9][a-z0-9 ._-]*$/i

/**
 * Case-insensitive for latin tokens; CJK has no case so it is unaffected.
 *
 * Latin tokens are matched on WORD BOUNDARIES, not as raw substrings. A short latin token is
 * otherwise swallowed by ordinary identifiers: a five-letter org token once matched a Vim option
 * name inside the Shiki syntax grammar that ships in the bundle, and failed the packaged-
 * artifact scan on a pure false positive. A leak scan that cries wolf on its own dependencies
 * gets muted, which costs exactly the protection it exists to provide.
 *
 * CJK tokens keep substring matching, and must: Chinese text has no word delimiters, so a
 * project name appearing inside a longer run of characters is a genuine hit, not a coincidence.
 */
export function findDenylisted(text: string, list: DenyToken[] = OPERATOR_DENYLIST): DenyToken[] {
  const hay = text.toLowerCase()
  return list.filter((d) => {
    const t = d.token.toLowerCase()
    if (!LATIN_TOKEN.test(t)) return hay.includes(t)
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    return new RegExp(`(?<![a-z0-9])${esc}(?![a-z0-9])`, 'i').test(hay)
  })
}
