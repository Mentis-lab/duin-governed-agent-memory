import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { PRODUCTION_NEIGHBOUR_CAP, runFourStages, rawVaultCorpus, zhipuKey, ZHIPU_BASE } from './eval-harness'

// C9 — the eval harness has ONE owner, and that agreement is held by this test rather than by
// review. Same shape as electron/shared/memory-source.test.ts.
//
// WHY, and it is not tidiness. `runFourStages` existed in THREE eval files and two had already
// diverged on the load-bearing line — the neighbour cap handed to `mergeGraphNeighbors`.
// agentic-bypass passed the absolute literal `8`; the owner and the shipped server.ts pass
// `hits.length + 2`. Those agree only when the pool is exactly 6, so every probe whose citation
// count was not 6 was measured at the WRONG breadth — while that file's own header promised the
// stages were "called EXACTLY as server.ts calls them". The instrument asserted it could not drift,
// and had. The published A/B/S/B+ deltas were measured on the wrong cap for those probes.
//
// An import alone cannot stop someone declaring a local copy again next to it, so this asserts the
// ABSENCE. It lands as *.test.ts (not *.eval.ts) deliberately: the evals need a live provider and a
// seeded scratch vault, so they do not run in the default suite — a guard living there would never
// execute. vitest's include is electron/**/*.test.ts, so this one does.

const REPO = join(__dirname, '..', '..', '..', '..')
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf-8')

/** Every eval that was carrying a copy. Adding a new .eval.ts does not silently escape this. */
const CONSUMERS = [
  'electron/services/brain/agentic-bypass.eval.ts',
  'electron/services/brain/aggregation-arms.eval.ts',
  'electron/services/brain/prolong-arms.eval.ts',
  'electron/services/brain/retrieve-code-regression.eval.ts',
  'electron/services/brain/transfer-ab-heldout.eval.ts',
  'electron/services/local-brain/stable-prefix-quality.eval.ts'
  // The public source tree ships without the private eval suites; the guard then has nothing to
  // hold and skips rather than failing on a missing file.
].filter((rel) => existsSync(join(__dirname, '..', '..', '..', '..', rel)))

// Local re-declaration of anything this module owns. Deliberately matches with or without
// `export`, and `const|let` for the base URL.
const REDECLARATIONS: Array<[string, RegExp]> = [
  ['runFourStages', /(?:export\s+)?(?:async\s+)?function\s+runFourStages\s*\(/],
  ['StageCtx', /(?:export\s+)?interface\s+StageCtx\b/],
  ['rawVaultCorpus', /(?:export\s+)?function\s+rawVaultCorpus\s*\(/],
  ['zhipuKey', /(?:export\s+)?function\s+zhipuKey\s*\(/],
  ['ZHIPU_BASE', /(?:export\s+)?(?:const|let)\s+ZHIPU_BASE\s*[:=]/]
]

describe('eval-harness — one owner, held by a test', () => {
  it.skipIf(CONSUMERS.length === 0)('is the ONLY declaration — no eval file redeclares what this module owns', () => {
    for (const rel of CONSUMERS) {
      const body = read(rel)
      for (const [name, re] of REDECLARATIONS) {
        expect(
          body,
          `${rel} must IMPORT ${name} from __fixtures__/eval-harness, not redeclare it. ` +
            `A local copy is how the neighbour cap silently diverged from server.ts.`
        ).not.toMatch(re)
      }
    }
  })

  it.skipIf(CONSUMERS.length === 0)('every consumer actually reaches this module', () => {
    for (const rel of CONSUMERS) {
      expect(read(rel), `${rel} should import the shared harness`).toContain(
        '__fixtures__/eval-harness'
      )
    }
  })

  // The divergence itself, pinned as a value rather than as prose. server.ts merges
  // `hits.length + NEIGHBOUR_SLOTS` with NEIGHBOUR_SLOTS = 2.
  it('the production neighbour cap is poolSize + 2, not a literal', () => {
    expect(PRODUCTION_NEIGHBOUR_CAP(6)).toBe(8)
    expect(PRODUCTION_NEIGHBOUR_CAP(4)).toBe(6)
    expect(PRODUCTION_NEIGHBOUR_CAP(12)).toBe(14)
    // The exact trap: the old literal 8 is RIGHT at a pool of 6 and wrong everywhere else, which is
    // why the drift survived review.
    expect(PRODUCTION_NEIGHBOUR_CAP(6)).toBe(8)
    expect(PRODUCTION_NEIGHBOUR_CAP(7)).not.toBe(8)
  })

  it.skipIf(CONSUMERS.length === 0)('no eval file hardcodes a bare neighbour cap into mergeGraphNeighbors', () => {
    for (const rel of CONSUMERS) {
      expect(read(rel), `${rel} must not pass a literal cap to mergeGraphNeighbors`).not.toMatch(
        /mergeGraphNeighbors\([^)]*,\s*\d+\s*\)/
      )
    }
  })

  it('zhipuKey takes the userData dir as a PARAMETER, so no call site closes over a module global', () => {
    // The locals each closed over their own module-level dir (UD, or REAL_USERDATA in
    // stable-prefix-quality). Parameterising is what let one definition serve all six.
    expect(zhipuKey.length).toBe(1)
    // Absent/unreadable keys.json degrades to null rather than throwing, so an eval can fall back
    // to its local-only arms.
    expect(zhipuKey(join(REPO, 'no', 'such', 'dir'))).toBeNull()
  })

  it('exports the pieces the evals import, with the shapes they rely on', () => {
    expect(ZHIPU_BASE).toBe('https://open.bigmodel.cn/api/paas/v4/')
    expect(typeof runFourStages).toBe('function')
    expect(typeof rawVaultCorpus).toBe('function')
  })

  it('rawVaultCorpus reads markdown off disk and tolerates a missing root', () => {
    expect(rawVaultCorpus(join(REPO, 'no', 'such', 'vault'))).toEqual({})
    // ASSETS/ is a real tracked directory; whatever it holds, keys must be forward-slashed
    // relative paths ending in .md, never absolute and never backslashed.
    const corpus = rawVaultCorpus(join(REPO, 'ARCHITECTURE'))
    for (const key of Object.keys(corpus)) {
      expect(key.endsWith('.md'), `${key} should be a .md file`).toBe(true)
      expect(key).not.toMatch(/\\/)
      expect(key).not.toMatch(/^[A-Za-z]:/)
    }
  })
})
