// FLAG-POLARITY CLAIMS — a comment that states a flag's DEFAULT must agree with the code.
//
// Constitution property 6: where a comment states a MEASURABLE fact, a check should COMPUTE it
// rather than assert it. This computes every flag default from the source of truth (the env read
// itself, or the shipped constant) and fails when a comment claims the opposite polarity.
//
// WHY this class needs a machine. A comment that says "default OFF" over a flag that ships ON is
// worse than no comment: it sends the next reader down a path the code already closed. Three of
// these were found by hand in one pass (uncertainty-gate, raw-escalation, server's resume wiring),
// and every one of them was created the same way -- a flag was flipped default-ON at the READ site
// and the header comment describing it, often in a DIFFERENT FILE, was not touched. Hand-auditing
// cannot keep up with that, because the two halves are never in the same diff.
//
// CROSS-FILE BY CONSTRUCTION. `DUIN_RECALL_UNCERTAINTY` is read in agui-grounding.ts and documented
// in uncertainty-gate.ts; `DUIN_TURN_RESUME` is read in agui-run.ts and documented in server.ts.
// A per-file check would find neither, so defaults are resolved corpus-wide first, then claims are
// scanned against that map.
//
// PAIRING RULE: the polarity token must appear AFTER the variable mention ON THE SAME LINE.
// Both halves are load-bearing:
//   - same line, because a 4-line comment window pulls in the polarity of a NEIGHBOURING flag
//     (measured: 12 hits with a window, 8 same-line, and the 4 extra were all window artefacts);
//   - after the mention, because "Default-off matches the DUIN_FUSE_STALENESS precedent" CITES a
//     flag as precedent for a different flag rather than describing that flag's own default.
//
// SCOPE: production code only. `*.test.ts` and `*.eval.ts` are excluded as claim sources -- they
// discuss flags rather than document them (coherence-health.test.ts quotes a premise it goes on to
// call inverted, and stable-prefix-quality.eval.ts names the gate on a FUTURE flip). They stay in
// scope as DEFINITION sources only where a production read exists.
//
// Pre-existing violations live in KNOWN_MISMATCHES so this lands as a hard gate on NEW ones without
// requiring the cross-lane fixes first. A STALE entry is also a failure: an allowlist that rots is
// the same disease one level up.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../../../', import.meta.url))
const ELECTRON = join(REPO, 'electron')

const posix = (p: string): string => p.split(sep).join('/')
const isTestOrEval = (p: string): boolean => /\.(test|eval)\.ts$/.test(p)

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, acc)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) acc.push(full)
  }
  return acc
}

/** `!== '0'` / `!== 'false'` is an opt-OUT read: the flag ships ON. */
const READ_ON = /process\.env\.([A-Z0-9_]+)\s*!==\s*'(?:0|false)'/g
/** `=== '1'` / `=== 'true'` is an opt-IN read: the flag ships OFF. */
const READ_OFF = /process\.env\.([A-Z0-9_]+)\s*===\s*'(?:1|true)'/g

type Polarity = 'ON' | 'OFF'

/** Resolve each env flag's SHIPPED default from its production read sites, corpus-wide. */
function computeEnvDefaults(files: string[]): Map<string, Polarity> {
  const seen = new Map<string, Set<Polarity>>()
  for (const f of files) {
    // Tests set flags explicitly to drive both arms; that is not a default.
    if (isTestOrEval(f)) continue
    const text = readFileSync(f, 'utf8')
    const add = (v: string, p: Polarity): void => {
      if (!seen.has(v)) seen.set(v, new Set())
      seen.get(v)!.add(p)
    }
    for (const m of text.matchAll(READ_ON)) add(m[1], 'ON')
    for (const m of text.matchAll(READ_OFF)) add(m[1], 'OFF')
  }
  // A flag read with BOTH polarities has no single default to compare a comment against.
  // Reported separately rather than silently dropped -- see the ambiguity test below.
  const out = new Map<string, Polarity>()
  for (const [v, set] of seen) if (set.size === 1) out.set(v, [...set][0])
  return out
}

/** Flags whose production reads disagree with each other. Empty today; a rise means a flag grew a
 *  second, contradictory read and no comment check can be trusted about it. */
function ambiguousEnvFlags(files: string[]): string[] {
  const seen = new Map<string, Set<Polarity>>()
  for (const f of files) {
    if (isTestOrEval(f)) continue
    const text = readFileSync(f, 'utf8')
    const add = (v: string, p: Polarity): void => {
      if (!seen.has(v)) seen.set(v, new Set())
      seen.get(v)!.add(p)
    }
    for (const m of text.matchAll(READ_ON)) add(m[1], 'ON')
    for (const m of text.matchAll(READ_OFF)) add(m[1], 'OFF')
  }
  return [...seen].filter(([, s]) => s.size > 1).map(([v]) => v).sort()
}

/**
 * The rerank stage is NOT an env flag -- it is a settings default, so it needs its own computation.
 * Read the SHIPPED constant out of rerank.ts rather than importing it: rerank.ts pulls event-log ->
 * database -> the native sqlite binding, and a suite that cannot load its native dep SKIPS rather
 * than fails, which is precisely the hole a schema regression has already shipped through.
 * Parsing the constant keeps this check honest with zero native surface.
 */
function computeRerankDefault(): { value: string; polarity: Polarity } {
  const src = readFileSync(join(ELECTRON, 'services', 'rag', 'rerank.ts'), 'utf8')
  const m = src.match(/export\s+const\s+DEFAULT_RERANK_MODE\s*:\s*RerankMode\s*=\s*'([a-z-]+)'/)
  if (!m) throw new Error('DEFAULT_RERANK_MODE not found in rerank.ts - update this check')
  return { value: m[1], polarity: m[1] === 'off' ? 'OFF' : 'ON' }
}

const ON_TOKEN = /(?:defaults?[\s-]+(?:to\s+)?ON\b|\bON\s+by\s+default\b)/i
const OFF_TOKEN = /(?:defaults?[\s-]+(?:to\s+)?OFF\b|\bOFF\s+by\s+default\b)/i
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/
// Markdown emphasis only. NOT underscore: it is part of the flag name, and stripping it made an
// earlier version of this check silently find ZERO mismatches including the one it was written for.
const stripEmphasis = (s: string): string => s.replace(/[*`]/g, '')

export interface Mismatch {
  /** repo-relative posix path */
  file: string
  line: number
  subject: string
  claim: Polarity
  actual: Polarity
  text: string
}

/** Scan production comments for a polarity claim that contradicts the computed default. */
function findMismatches(files: string[], defaults: Map<string, Polarity>, rerank: Polarity): Mismatch[] {
  const out: Mismatch[] = []
  for (const f of files) {
    if (isTestOrEval(f)) continue
    const rel = posix(relative(REPO, f))
    const lines = readFileSync(f, 'utf8').split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i]
      if (!COMMENT_LINE.test(raw)) continue
      const line = stripEmphasis(raw)
      const claimsOn = ON_TOKEN.test(line)
      const claimsOff = OFF_TOKEN.test(line)
      // Neither token, or both on one line -> no single unambiguous claim to check.
      if (claimsOn === claimsOff) continue
      const claim: Polarity = claimsOn ? 'ON' : 'OFF'
      const tokenAt = line.search(claimsOn ? ON_TOKEN : OFF_TOKEN)

      const subjects: [string, Polarity][] = []
      // Env flags mentioned on this line, keyed to their computed default.
      for (const m of line.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) {
        const actual = defaults.get(m[1])
        // Mention must come BEFORE the polarity token, else the flag is being CITED, not described.
        if (actual && m.index !== undefined && m.index < tokenAt) subjects.push([m[1], actual])
      }
      // The one settings-backed subject this check covers.
      if (line.includes('rerankMode')) {
        const at = line.indexOf('rerankMode')
        if (at < tokenAt) subjects.push(['rag.rerankMode', rerank])
      }

      for (const [subject, actual] of subjects) {
        if (claim !== actual) {
          out.push({ file: rel, line: i + 1, subject, claim, actual, text: raw.trim() })
        }
      }
    }
  }
  return out
}

/**
 * Pre-existing mismatches, keyed `path::SUBJECT` -- NOT by line number, which drifts (a prior
 * review's anchors ran 8-11 low and read as false positives for it). Every entry below was verified
 * against the read site named in its reason.
 *
 * All four are OUT OF LANE for the `ground` lane that added this check, which owns only
 * agui-grounding.ts / uncertainty-gate.ts / brain-root.ts. They are recorded here so the gate is
 * live for NEW mismatches immediately; fixing them is a one-line comment edit for whoever owns
 * those files.
 */
const KNOWN_MISMATCHES: Record<string, string> = {
  // Reads `process.env.DUIN_RECALL_ESCALATE !== '0'` in agui-grounding.ts (default ON).
  'electron/services/local-brain/raw-escalation.ts::DUIN_RECALL_ESCALATE':
    'header says default OFF; the read in agui-grounding.ts ships it ON',
  // Reads `process.env.DUIN_TURN_RESUME !== '0'` in agui-run.ts turnResumeEnabled (default ON).
  'electron/services/local-brain/server.ts::DUIN_TURN_RESUME':
    'two comments say default OFF; turnResumeEnabled in agui-run.ts ships it ON',
  // DEFAULT_RERANK_MODE = 'local-cross-encoder' in rag/rerank.ts, i.e. the stage FIRES on a stock
  // install.
  'electron/services/local-brain/server.ts::rag.rerankMode':
    'says "Off by default"; DEFAULT_RERANK_MODE ships local-cross-encoder'
}

// KNOWN GAP, recorded rather than papered over. rag/rerank.ts contradicts ITSELF -- its mode list
// ("Slow per-pair but high quality. Off by default.") and its header ("Either pipe is OFF by
// default in settings") both predate the flip its OWN DEFAULT_RERANK_MODE docblock describes. This
// check does NOT catch them, because neither line names `rerankMode` and the same-line pairing rule
// is what keeps the check free of false positives. Widening the rule to a comment BLOCK was
// measured and regressed precision (12 hits vs 8, all 4 extras spurious), so the rule stays and the
// gap is written down. Fixing those two lines is an out-of-lane edit for whoever owns rag/.

const key = (m: Mismatch): string => `${m.file}::${m.subject}`

describe('flag-polarity claims (computed, not asserted)', () => {
  const files = walk(ELECTRON)
  const defaults = computeEnvDefaults(files)
  const rerank = computeRerankDefault()
  const mismatches = findMismatches(files, defaults, rerank.polarity)

  it('resolves a real corpus of flag defaults (guards against a silently-empty scan)', () => {
    // An earlier draft found zero mismatches because the flag names never matched. A check that
    // scans nothing passes forever, so pin the floor: this is a lower bound, not a target.
    expect(files.length).toBeGreaterThan(400)
    expect(defaults.size).toBeGreaterThan(30)
    expect(defaults.get('DUIN_RECALL_UNCERTAINTY')).toBe('ON')
    expect(rerank.value).toBe('local-cross-encoder')
  })

  it('has no flag read with contradictory production polarities', () => {
    expect(ambiguousEnvFlags(files)).toEqual([])
  })

  it('has no NEW comment claiming a polarity the code contradicts', () => {
    const fresh = mismatches.filter((m) => !(key(m) in KNOWN_MISMATCHES))
    expect(
      fresh.map((m) => `${m.file}:${m.line} ${m.subject} says ${m.claim}, code ships ${m.actual} | ${m.text}`)
    ).toEqual([])
  })

  it('has no STALE allowlist entry (a fixed comment must leave the list)', () => {
    const live = new Set(mismatches.map(key))
    expect([...Object.keys(KNOWN_MISMATCHES)].filter((k) => !live.has(k))).toEqual([])
  })
})

// ── Structural claims made in comments elsewhere, computed here ──
//
// Same disease as the polarity class, different shape: these comments assert that some code does
// NOT exist. That is exactly the kind of claim that silently rots, because the person who adds the
// missing piece has no reason to read the comment that said it was missing. Each test below FAILS
// when the claim stops being true, which forces the comment to be updated in the same change.
//
// Neither test endorses the gap it pins. They are truth-guards on prose, not a decision to leave
// the mechanism cold — see the notes on each.
describe('structural claims made in comments (computed, not asserted)', () => {
  const files = walk(ELECTRON)

  it('retrieval tunables are read-only: no writer exists anywhere (G5)', () => {
    // brain-native-routes-2.ts explains the sweep response's ABSENT `applied` field with:
    //   "there is no writeRetrievalTunables() in the repo (retrieval-tunables.ts exports read +
    //    clamp only), so this route can never adopt a sweep result."
    // If a writer ever lands, that comment becomes false AND the sweep route gains the ability to
    // mutate live retrieval — which the backlog flags as needing an explicit operator decision
    // about widening RSI's reach, not a silent addition. So this fails loudly on the writer.
    const writers = files
      .filter((f) => !isTestOrEval(f))
      .filter((f) => /\bfunction\s+writeRetrievalTunables\b/.test(readFileSync(f, 'utf8')))
      .map((f) => posix(relative(REPO, f)))
    expect(writers).toEqual([])

    // ...and the module itself exports only read/clamp helpers, so "read-only" is a computed
    // property of its surface rather than a promise in a docblock.
    const tunables = readFileSync(join(ELECTRON, 'services', 'local-brain', 'retrieval-tunables.ts'), 'utf8')
    const exported = [...tunables.matchAll(/export\s+function\s+([A-Za-z0-9_]+)/g)].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(0)
    expect(exported.filter((n) => /^(write|save|persist|adopt|apply)/i.test(n))).toEqual([])
  })

  it('no scheduled tick accrues grounding-staleness outcomes yet (G6)', () => {
    // agui-grounding.ts's staleness-fusion branch states, correctly today:
    //   "the grounding-staleness ledger is currently fed by the judge-keyed
    //    /debug/grounding-eval-live route (no background accrual tick yet)".
    // That is why stalenessTrust is null on a default install and the fusion branch never fires.
    //
    // This is a KNOWN COLD MECHANISM, not dead code: it has a real writer (the debug route) and no
    // runtime motion, which means UNEXERCISED. The fix is to land the accrual tick in
    // measure-tick.ts — an out-of-lane file for the lane that wrote this test. When that lands,
    // this test fails, and the comment above must be corrected in the same change instead of
    // quietly becoming a lie in the other direction.
    const tickCallers = files
      .filter((f) => /-tick\.ts$/.test(f) && !isTestOrEval(f))
      .filter((f) => readFileSync(f, 'utf8').includes('recordGroundingStalenessOutcomes'))
      .map((f) => posix(relative(REPO, f)))
    expect(tickCallers).toEqual([])

    // Pin the claim's other half: the accrual function exists and has exactly one production
    // caller (the debug route). If it drops to zero the comment is wrong the other way.
    const producers = files
      .filter((f) => !isTestOrEval(f))
      .filter((f) => /\brecordGroundingStalenessOutcomes\s*\(/.test(readFileSync(f, 'utf8')))
      .map((f) => posix(relative(REPO, f)))
    expect(producers).toContain('electron/services/local-brain/brain-native-routes-2.ts')
  })
})
