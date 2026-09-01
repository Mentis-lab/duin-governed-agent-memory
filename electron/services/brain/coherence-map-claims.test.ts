import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, basename } from 'path'
import { COHERENCE_MAP, type CoherenceEntry } from './coherence-map'
import { countNonTestReferences, isTestPath, type SourceFile } from './coherence-lint'

// CONSTITUTION property 6 - "claims about ourselves are computed, not typed."
//
// The coherence map is DUIN's self-description, and its central column is hand-written. On
// 2026-07-30 an entry recorded a subsystem as LIVE while nothing in production imported it: the map
// that exists to surface gaps was hiding one. A hand-typed status is a claim that rots, and it rots
// in the most damaging direction.
//
// `WiringState` already defines DEAD as "an exported symbol / path with no non-test caller", which
// is decidable. So this file decides it, using the same reference counter the dead-export detector
// uses, and fails when the typed claim and the computed reality disagree.
//
// SCOPE, deliberately narrow. Only LIVE and DEAD make a checkable assertion about callers.
// COLD / SHADOW / GAP / COLD_BY_DESIGN are claims about runtime behavior or deliberate stance, which
// grep cannot settle - those still need a human, and pretending otherwise would move the rot
// somewhere less visible.

const ROOTS = ['electron', 'src']
const SRC_RE = /\.tsx?$/
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', '.git', 'build', 'coverage'])

/** The map is a DESCRIPTION of the system, not a participant in it. Its evidence strings contain the
 *  very symbol names being counted, so leaving it in the scanned set makes every subsystem look like
 *  a caller of itself. */
const SELF_DESCRIPTION = 'coherence-map.ts'

/** A path that matches no real file, used where the shared counter wants a declaration site to
 *  discount and we have already excluded the declaring file from the set. */
const NO_SUCH_PATH = '<none>'

function collectSources(dir: string, repoRoot: string, acc: SourceFile[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    let isDir: boolean
    try {
      isDir = statSync(full).isDirectory()
    } catch {
      continue
    }
    if (isDir) {
      collectSources(full, repoRoot, acc)
    } else if (SRC_RE.test(name)) {
      try {
        acc.push({ path: relative(repoRoot, full), content: readFileSync(full, 'utf8') })
      } catch {
        /* an unreadable file is not a claim about anything */
      }
    }
  }
}

/**
 * Strip `//` and block comments before counting references.
 *
 * Not cosmetic — it is the difference between this check working and being deleted. DUIN's code
 * explains itself at length, so a symbol is constantly *discussed* in prose near code that does not
 * call it. The brain-client entry is the exact case: `resolveOwed` appears twice in DecisionsPanel,
 * both times inside comments explaining why it is NOT wired. Counting those made the check accuse a
 * correct DEAD entry of lying, which is the failure mode that gets a red test disabled.
 *
 * The shared dead-export detector deliberately does NOT do this: its findings are candidates for
 * adjudication, where over-reporting is cheap. This check is a gate, so it needs the precision.
 * Same counter, different input preparation.
 *
 * A `//` inside a string literal (a URL) truncates that line early. That under-counts, which is the
 * safe direction here: it makes a DEAD claim easier to uphold rather than easier to accuse.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

const repoRoot = process.cwd()
const rawFiles: SourceFile[] = []
for (const r of ROOTS) collectSources(join(repoRoot, r), repoRoot, rawFiles)
const files: SourceFile[] = rawFiles.map((f) => ({
  path: f.path,
  content: stripComments(f.content)
}))

/** `evidence` carries anchors shaped `some-file.ts:someSymbol@123`. Line numbers drift constantly
 *  and are ignored; the file and the symbol are the checkable part. */
const ANCHOR_RE = /([A-Za-z0-9_.-]+\.tsx?):([A-Za-z0-9_$]+)@\d+/g
/** Every filename an entry names, anchored or bare: the subsystem's own surface. */
const FILENAME_RE = /\b([A-Za-z0-9_.-]+\.tsx?)\b/g

interface Anchor {
  file: string
  symbol: string
}

function anchorsOf(evidence: string): Anchor[] {
  const out: Anchor[] = []
  const seen = new Set<string>()
  ANCHOR_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = ANCHOR_RE.exec(evidence)) !== null) {
    const key = `${m[1]}:${m[2]}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file: m[1], symbol: m[2] })
  }
  return out
}

/** Every file the entry names, plus the map itself. These are "inside the subsystem". */
function clusterFilesOf(evidence: string): Set<string> {
  const out = new Set<string>([SELF_DESCRIPTION])
  FILENAME_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FILENAME_RE.exec(evidence)) !== null) out.add(m[1])
  return out
}

/** Resolve a bare filename to real non-test paths in the source set. */
function resolveFile(name: string): string[] {
  return files.filter((f) => basename(f.path) === name && !isTestPath(f.path)).map((f) => f.path)
}

/**
 * Non-test references to `symbol` from OUTSIDE the subsystem's own files.
 *
 * The exclusion is the load-bearing part, and a false positive taught it. The How-You-Decide entry
 * is correctly DEAD - its own `gap` field says the card is never mounted - yet its helpers are
 * referenced by that very card. Counting a subsystem's internal wiring as proof of life would have
 * called that entry a liar. A cluster that only calls itself is still unreached, so the caller has
 * to come from a file the entry does not name.
 *
 * Grep-based, inheriting the dead-export detector's precision caveats: dynamic dispatch and
 * re-export barrels can read as uncalled, and a mention inside a comment reads as a call.
 */
function externalReferenceCount(symbol: string, cluster: Set<string>): number {
  const outside = files.filter((f) => !cluster.has(basename(f.path)))
  return countNonTestReferences(symbol, NO_SUCH_PATH, outside)
}

/** Entries claiming LIVE whose entire evidence set is unreached from outside the subsystem. */
function liveContradictions(entries: readonly CoherenceEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.wiringState !== 'LIVE') continue
    const anchors = anchorsOf(e.evidence)
    if (anchors.length === 0) continue
    const cluster = clusterFilesOf(e.evidence)
    if (anchors.every((a) => externalReferenceCount(a.symbol, cluster) === 0)) {
      out.push(
        `${e.subsystem}: claims LIVE, but no anchor [${anchors
          .map((a) => `${a.file}:${a.symbol}`)
          .join(', ')}] is referenced from outside the subsystem`
      )
    }
  }
  return out
}

/** Entries claiming DEAD that something outside the subsystem actually calls. */
function deadContradictions(entries: readonly CoherenceEntry[]): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.wiringState !== 'DEAD') continue
    const cluster = clusterFilesOf(e.evidence)
    for (const a of anchorsOf(e.evidence)) {
      const refs = externalReferenceCount(a.symbol, cluster)
      if (refs > 0) {
        out.push(
          `${e.subsystem}: claims DEAD, but ${a.file}:${a.symbol} has ${refs} reference(s) from outside the subsystem`
        )
      }
    }
  }
  return out
}

/** How many entries the two checks above actually adjudicate. */
function adjudicatedCount(entries: readonly CoherenceEntry[]): number {
  return entries.filter(
    (e) =>
      (e.wiringState === 'LIVE' || e.wiringState === 'DEAD') && anchorsOf(e.evidence).length > 0
  ).length
}

function fixture(over: Partial<CoherenceEntry>): CoherenceEntry {
  return {
    subsystem: 'fixture',
    designIntent: 'x',
    wiringState: 'LIVE',
    evidence: 'x',
    detectors: [],
    axis: 'wiring',
    byDesign: false,
    leverage: 'low',
    ...over
  } as CoherenceEntry
}

// A check nobody has watched fail is not a check. These run the real logic against synthetic
// entries whose right answer is known, so a future refactor that quietly neuters the comparison
// breaks here instead of going green forever.
describe('the check has teeth', () => {
  it('catches the historical bug: LIVE claimed over a symbol nothing calls', () => {
    const found = liveContradictions([
      fixture({
        subsystem: 'phantom',
        wiringState: 'LIVE',
        evidence: 'Anchors: coherence-map-claims.test.ts:aSymbolNothingCouldPossiblyCall@1'
      })
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('claims LIVE')
  })

  it('catches a DEAD claim over a symbol that is genuinely called across modules', () => {
    // `loadBrain` is called from chat.ts, agui-grounding.ts and ipc/settings.ts, so a DEAD claim
    // on it is definitively wrong.
    const found = deadContradictions([
      fixture({
        subsystem: 'phantom',
        wiringState: 'DEAD',
        evidence: 'Anchors: brain-root.ts:loadBrain@1'
      })
    ])
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('claims DEAD')
  })

  it('does not accuse a DEAD cluster whose only callers are inside itself', () => {
    // The How-You-Decide shape: helpers referenced only from within the subsystem's own files.
    // `countNonTestReferences` is real and exercised, but its only non-test caller lives in the
    // very file the entry names — so the cluster is still unreached from outside, and DEAD stands.
    expect(
      deadContradictions([
        fixture({
          subsystem: 'phantom',
          wiringState: 'DEAD',
          evidence: 'Anchors: coherence-lint.ts:countNonTestReferences@1'
        })
      ])
    ).toEqual([])
  })
})

describe('the source set is real', () => {
  it('scanned a plausible number of files', () => {
    // Guards everything below: if the walk silently returned nothing, every assertion would pass
    // vacuously and the check would be worse than absent.
    expect(files.length).toBeGreaterThan(200)
  })
})

describe('coherence map claims match computed reality', () => {
  it('every anchored file still exists', () => {
    const missing: string[] = []
    for (const e of COHERENCE_MAP) {
      for (const a of anchorsOf(e.evidence)) {
        if (resolveFile(a.file).length === 0) missing.push(`${e.subsystem} -> ${a.file}`)
      }
    }
    expect(missing, `evidence names files that no longer exist:\n${missing.join('\n')}`).toEqual([])
  })

  it('actually adjudicates a meaningful share of the map', () => {
    // Without this, the two checks below pass by adjudicating nothing — an entry set that drifted
    // to unanchored prose would read as a clean bill of health.
    expect(adjudicatedCount(COHERENCE_MAP)).toBeGreaterThanOrEqual(4)
  })

  it('no LIVE entry has all of its anchors uncalled', () => {
    // Conservative on purpose: the counter is grep-based, so a single wired anchor vindicates the
    // entry. Only an entry whose ENTIRE evidence set is unreached from outside is contradicted -
    // exactly the brain-client shape that shipped a false LIVE.
    const contradicted = liveContradictions(COHERENCE_MAP)
    expect(contradicted, contradicted.join('\n')).toEqual([])
  })

  it('no DEAD entry has a live external caller', () => {
    // The other direction, and the one that quietly hides finished work: an entry left at DEAD
    // after the gap was closed understates the system and wastes the next reader's time.
    const contradicted = deadContradictions(COHERENCE_MAP)
    expect(contradicted, contradicted.join('\n')).toEqual([])
  })

  it('every entry carries evidence something can be checked against', () => {
    const empty = COHERENCE_MAP.filter((e) => !e.evidence.trim()).map((e) => e.subsystem)
    expect(empty, `entries with no evidence:\n${empty.join('\n')}`).toEqual([])
  })
})
