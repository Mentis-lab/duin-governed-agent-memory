import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import {
  OPERATOR_DENYLIST,
  SAMPLE_DENYLIST,
  LEAK_SCAN_EXCLUDES,
  LOCAL_DENYLIST_FILE,
  findDenylisted,
  loadLocalDenylist
} from './operator-leak-denylist'

// Cold-start A6 — the guard that stops de-personalization regressing.
//
// Two scans:
//   1. PRODUCTION SOURCE. Always runs. Catches a leak at the moment it is written, in review,
//      instead of after it ships.
//   2. PACKAGED ARTIFACT. Runs only when dist/win-unpacked exists, because a source-only scan
//      cannot see what actually got bundled — the spec's acceptance is stated against the asar.
//
// Two widths:
//   - DEFAULT: `electron/` + `src/`, code extensions only. Fast; runs in the blocking suite.
//   - WIDE (`DUIN_LEAK_SCAN_WIDE=1`): the whole publishable tree — bench/, docs/, resources/,
//     scripts/, plugins/, the workflows and the root files — and prose/config extensions too.
//     This is the release gate: the private data that once lived in this repo sat in bench/ and
//     docs/, not in electron/, and a scan that never looked there was exactly as green as no scan.
//     It is opt-in because it walks ~2,800 files and because on a PRIVATE checkout it is EXPECTED
//     to hit the internal material the export pipeline deletes before publishing.
//
// Deliberately a TEST rather than a lint rule: it must fail the same command that gates a build,
// and it must be able to read a build output.

const REPO = resolve(__dirname, '..', '..', '..')
const WIDE = process.env.DUIN_LEAK_SCAN_WIDE === '1'
const SCAN_ROOTS = WIDE
  ? ['electron', 'src', 'bench', 'docs', 'resources', 'scripts', 'plugins', '.github']
  : ['electron', 'src']
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json)$/
const WIDE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|json|jsonl|md|yml|yaml|ps1|cmd|sh|py|html|txt|toml|env|example)$/
const EXT = WIDE ? WIDE_EXT : CODE_EXT
// Directories the wide walk never descends into: generated output, dependencies, and third-party
// minified bundles (`resources/vendor` is upstream code — a hit there is a coincidence of letters,
// not a leak, and it cannot be edited without re-vendoring).
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'coverage', 'release', 'vendor', 'models'])

function walk(dir: string, out: string[] = [], depth = Infinity): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let st: ReturnType<typeof statSync>
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      if (depth > 0) walk(full, out, depth - 1)
    } else if (EXT.test(name)) out.push(full)
  }
  return out
}

/** Every file the current width covers: the roots recursively, plus (wide only) the root files. */
function scanFiles(): string[] {
  const files: string[] = []
  for (const root of SCAN_ROOTS) walk(join(REPO, root), files)
  if (WIDE) walk(REPO, files, 0)
  return files
}

const excluded = (p: string): boolean => LEAK_SCAN_EXCLUDES.some((x) => p.includes(x))

describe('operator leak denylist — sources', () => {
  it('the denylist is non-empty and self-consistent', () => {
    expect(OPERATOR_DENYLIST.length).toBeGreaterThan(0)
    // A blank token would match every file and make the guard useless-but-green.
    expect(OPERATOR_DENYLIST.every((d) => d.token.trim().length > 1)).toBe(true)
    // The shipped sample is always part of the effective list, so the mechanism is exercised
    // even in a checkout that carries no local file.
    for (const s of SAMPLE_DENYLIST) {
      expect(OPERATOR_DENYLIST.some((d) => d.token === s.token)).toBe(true)
    }
  })

  it('reads the operator-private list from a file, tolerating both shapes and junk rows', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duin-denylist-'))
    try {
      const f = join(dir, LOCAL_DENYLIST_FILE)
      writeFileSync(
        f,
        JSON.stringify({
          tokens: [
            { token: 'Acme Corp', kind: 'org' },
            'Jane Doe',
            { token: 'x', kind: 'person' }, // one char — dropped
            { token: '  ', kind: 'org' }, // blank — dropped
            { token: 'Widget', kind: 'not-a-kind' }, // unknown kind → other
            42,
            null
          ]
        })
      )
      expect(loadLocalDenylist(f)).toEqual([
        { token: 'Acme Corp', kind: 'org' },
        { token: 'Jane Doe', kind: 'other' },
        { token: 'Widget', kind: 'other' }
      ])
      writeFileSync(f, JSON.stringify(['Bare String', { token: 'Typed', kind: 'project' }]))
      expect(loadLocalDenylist(f)).toEqual([
        { token: 'Bare String', kind: 'other' },
        { token: 'Typed', kind: 'project' }
      ])
      writeFileSync(f, '{ not json')
      expect(loadLocalDenylist(f)).toEqual([])
      expect(loadLocalDenylist(join(dir, 'missing.json'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the local list never enters git', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf-8')
    expect(ignore.split(/\r?\n/)).toContain(LOCAL_DENYLIST_FILE)
  })
})

describe('operator leak scan — production source', () => {
  // THE GATE'S OWN FAILURE MODE IS SILENCE, so this asserts the gate can see.
  //
  // The local denylist is gitignored, so it exists in exactly one checkout, and this repo
  // mandates one WORKTREE PER LANE. loadLocalDenylist resolved it from the worktree root
  // alone, so in every lane it returned [] — the scan fell back to the fictional sample list
  // and passed while asserting nothing about the operator's real identities. Four files
  // carrying his project, his own name and two colleagues' names reached trunk that way
  // (2026-09-03), each through a worktree where this suite was green.
  //
  // Skips on a public clone, which legitimately has no local list; there is nothing to see
  // there and nothing to assert.
  it('reads the main checkout\'s denylist even from a linked worktree', () => {
    let mainRoot: string | null = null
    try {
      const common = resolve(
        REPO,
        execFileSync('git', ['rev-parse', '--git-common-dir'], {
          cwd: REPO,
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore']
        }).trim()
      )
      if (/(^|[\\/])\.git$/.test(common)) mainRoot = dirname(common)
    } catch {
      return // no git: nothing to resolve, nothing to assert
    }
    const candidates = [join(REPO, LOCAL_DENYLIST_FILE)]
    if (mainRoot) candidates.push(join(mainRoot, LOCAL_DENYLIST_FILE))
    const present = candidates.find((p) => existsSync(p))
    if (!present) return // public clone
    expect(loadLocalDenylist().length).toBeGreaterThan(0)
  })

  // Every exclusion is a hole in the guard, so the SET is pinned: widening it has to be a
  // deliberate, reviewed edit to this list rather than a one-line addition nobody notices.
  it('the exclusion set is exactly the audited one', () => {
    expect([...LEAK_SCAN_EXCLUDES].sort()).toEqual(
      [
        '__fixtures__',
        '.eval.ts',
        '.test.ts',
        '.test.tsx',
        LOCAL_DENYLIST_FILE,
        'operator-leak-denylist.ts',
        'operator-leak-scan.test.ts'
      ].sort()
    )
  })

  // The `.test.*` / `.eval.ts` exclusions rest on ONE claim: those files are never bundled, because
  // the build emits only what is transitively imported from electron.vite.config.ts's entries. That
  // claim is only true while nothing in production imports one — so assert it instead of trusting it.
  // If a production module ever imports a harness file, this fails and the exclusion must go.
  it('no production module imports a test or eval harness (what makes the exclusions safe)', () => {
    const IMPORT_RE = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
    const offenders: string[] = []
    for (const root of ['electron', 'src']) {
      for (const file of walk(join(REPO, root))) {
        if (excluded(file) || !CODE_EXT.test(file)) continue // the harness files themselves may import each other
        let text: string
        try {
          text = readFileSync(file, 'utf-8')
        } catch {
          continue
        }
        for (const m of text.matchAll(IMPORT_RE)) {
          const spec = m[1]
          if (/\.(test|eval)(\.tsx?)?$/.test(spec) || spec.includes('__fixtures__')) {
            offenders.push(`${relative(REPO, file)} → ${spec}`)
          }
        }
      }
    }
    expect(
      offenders,
      `A production module imports a test/eval harness, so those files DO reach the bundle and ` +
        `LEAK_SCAN_EXCLUDES no longer holds:\n${offenders.join('\n')}`
    ).toEqual([])
  })

  it(`finds nothing denylisted in ${WIDE ? 'the publishable tree' : 'electron/ or src/'}`, () => {
    const offenders: string[] = []
    for (const file of scanFiles()) {
      if (excluded(file)) continue
      let text: string
      try {
        text = readFileSync(file, 'utf-8')
      } catch {
        continue
      }
      const hits = findDenylisted(text)
      if (hits.length) {
        offenders.push(`${relative(REPO, file)} → ${hits.map((h) => `${h.kind}:${h.token}`).join(', ')}`)
      }
    }
    // The message IS the fix instruction — a bare boolean here would be a puzzle at 2am.
    expect(
      offenders,
      `Operator-identifying tokens found in ${WIDE ? 'the publishable tree' : 'production source'}.\n` +
        `These ship to every user and, for aliases/tracks, are load-bearing at runtime.\n` +
        `Move them to per-vault state (.duin/_state/) instead of hardcoding.\n\n` +
        offenders.join('\n')
    ).toEqual([])
  })
})

describe('operator leak scan — packaged artifact', () => {
  const asar = join(REPO, 'dist', 'win-unpacked', 'resources', 'app.asar')
  const built = existsSync(asar)

  // An artifact OLDER than the source it was built from describes a build that no longer exists —
  // gating on it reports leaks that are already fixed and never goes green until someone rebuilds.
  // Skipped-with-a-warning, never silently passed: a stale artifact is exactly as uninformative as
  // no artifact, and the warning below says so.
  const newestSource = (): number => {
    let newest = 0
    for (const root of ['electron', 'src']) {
      for (const f of walk(join(REPO, root))) {
        if (excluded(f)) continue
        try {
          newest = Math.max(newest, statSync(f).mtimeMs)
        } catch {
          /* unreadable — ignore */
        }
      }
    }
    return newest
  }
  const stale = built && statSync(asar).mtimeMs < newestSource()

  it.skipIf(!built || stale)('finds nothing denylisted in the packaged app.asar', () => {
    // The asar is a binary container, but the bundled JS inside it is plain UTF-8, so a raw
    // substring scan is exactly the check the spec's acceptance describes (`grep -c` == 0).
    const buf = readFileSync(asar)
    const text = buf.toString('utf-8')
    const hits = findDenylisted(text)
    const detail = hits
      .map((h) => {
        const re = new RegExp(h.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
        return `${h.kind}:${h.token} ×${(text.match(re) ?? []).length}`
      })
      .join(', ')
    expect(
      hits,
      `Operator-identifying tokens are present in the SHIPPED bundle: ${detail}\n` +
        `dist/win-unpacked/resources/app.asar must contain none of them.`
    ).toEqual([])
  })

  it('reports when the artifact scan was skipped, so a green run is not mistaken for coverage', () => {
    // A skipped artifact scan is the failure mode that let this ship in the first place: the
    // source looked clean and nobody checked the bundle. Make the gap visible.
    if (!built) {
      console.warn(
        '[leak-scan] dist/win-unpacked not present — ARTIFACT scan skipped. ' +
          'Source scan alone does NOT satisfy the cold-start acceptance; run a build first.'
      )
    } else if (stale) {
      console.warn(
        '[leak-scan] app.asar is OLDER than the scanned source — ARTIFACT scan skipped. ' +
          'It describes a superseded build. Rebuild before treating the artifact as verified.'
      )
    }
    expect(true).toBe(true)
  })
})

describe('findDenylisted — matching precision', () => {
  // A raw substring scan once failed the packaged-artifact check on a five-letter org token
  // matching a Vim option name inside the Shiki syntax grammar that ships in the bundle. The
  // danger of fixing that is over-correcting into a scanner that no longer catches anything, so
  // both directions are pinned here against the SHIPPED sample list (never the local file, so the
  // cases mean the same thing in every checkout): real leaks must still fire, coincidental
  // substrings must not.
  const hits = (s: string) => findDenylisted(s, SAMPLE_DENYLIST).length > 0

  it.each([
    ['standalone latin token', 'the tarn partnership'],
    ['punctuated', 'org:tarn, deal notes'],
    ['quoted', 'entity "tarn" appears here'],
    ['multi-word latin token', 'met with Bramblewick Ltd today'],
    ['latin token inside a path', 'notes/people/wren hollis.md'],
    // Chinese has no word delimiters, so a token inside a longer run is a GENUINE hit and
    // must keep substring semantics.
    ['CJK inside a longer run', '这次夜鸮合作降级为单场试玩会'],
    ['CJK project name', '《夜鸮》二测排期'],
    ['CJK person inside prose', '和钟离墨确认了排期']
  ])('still catches a real leak: %s', (_label, text) => {
    expect(hits(text)).toBe(true)
  })

  it.each([
    ['the regression: swallowed by a longer identifier', 'set untarnished=2'],
    ['swallowed at the other edge', 'tarnish helper function'],
    ['digits glue it to an identifier', 'tarn2 is a variable'],
    ['clean text', 'nothing operator-identifying in this line']
  ])('does not fire on: %s', (_label, text) => {
    expect(hits(text)).toBe(false)
  })
})
