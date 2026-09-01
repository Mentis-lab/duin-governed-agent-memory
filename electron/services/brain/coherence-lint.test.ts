import { describe, it, expect } from 'vitest'
import {
  findDeadExports,
  findFrozenLedgers,
  findUnguarded,
  findBenchmarkRegressions,
  lintCoherence,
  isTestPath,
  FROZEN_LEDGER_STALE_HOURS,
  type SourceFile,
  type LedgerStat,
  type BenchmarkSlice
} from './coherence-lint'
import type { CoherenceEntry } from './coherence-map'

function entry(over: Partial<CoherenceEntry> = {}): CoherenceEntry {
  return {
    subsystem: 'x',
    designIntent: 'do a thing',
    wiringState: 'LIVE',
    evidence: 'file.ts:1',
    detectors: ['a-detector'],
    axis: 'wiring',
    byDesign: false,
    ...over
  }
}

// ──────────────────── dead-export (heuristic) ────────────────────

describe('coherence-lint — dead-export', () => {
  it('finds an exported function with no non-test caller, ignores a called one', () => {
    const files: SourceFile[] = [
      {
        path: 'a.ts',
        content: `export function usedFn() { return 1 }\nexport function deadFn() { return 2 }`
      },
      { path: 'b.ts', content: `import { usedFn } from './a'\nconsole.log(usedFn())` }
    ]
    const findings = findDeadExports(files)
    const subjects = findings.map((f) => f.subject)
    expect(subjects).toContain('deadFn')
    expect(subjects).not.toContain('usedFn')
  })

  it('a symbol referenced ONLY by its own test is still dead (test callers are excluded)', () => {
    const files: SourceFile[] = [
      { path: 'a.ts', content: `export const onlyTested = () => 42` },
      { path: 'a.test.ts', content: `import { onlyTested } from './a'\nexpect(onlyTested()).toBe(42)` }
    ]
    const findings = findDeadExports(files)
    expect(findings.map((f) => f.subject)).toContain('onlyTested')
  })

  it('const arrow exports are detected too, and const values are not', () => {
    const files: SourceFile[] = [
      { path: 'a.ts', content: `export const deadArrow = (x: number) => x * 2\nexport const NOT_A_FN = 5` },
      { path: 'b.ts', content: `// this file references nothing` }
    ]
    const findings = findDeadExports(files)
    const subjects = findings.map((f) => f.subject)
    expect(subjects).toContain('deadArrow')
    expect(subjects).not.toContain('NOT_A_FN') // not function-shaped → not scanned
  })

  it('marks its findings heuristic (candidates, not auto-applied)', () => {
    const files: SourceFile[] = [{ path: 'a.ts', content: `export function deadFn() {}` }]
    expect(findDeadExports(files)[0].precision).toBe('heuristic')
  })

  it('isTestPath recognizes .test/.spec and __tests__', () => {
    expect(isTestPath('a.test.ts')).toBe(true)
    expect(isTestPath('a.spec.tsx')).toBe(true)
    expect(isTestPath('src/a.ts')).toBe(false)
  })
})

// ──────────────────── frozen-ledger ────────────────────

describe('coherence-lint — frozen-ledger', () => {
  const now = Date.parse('2026-07-17T00:00:00.000Z')
  const H = 3_600_000

  it('flags a ledger lagging the freshest sibling by > threshold', () => {
    const ledgers: LedgerStat[] = [
      { name: 'brain-health-history.jsonl', mtimeMs: now - 1 * H }, // fresh
      { name: 'claim-ledger.jsonl', mtimeMs: now - (FROZEN_LEDGER_STALE_HOURS + 25) * H } // frozen ~2 days
    ]
    const findings = findFrozenLedgers(ledgers, now)
    expect(findings).toHaveLength(1)
    expect(findings[0].subject).toBe('claim-ledger.jsonl')
  })

  it('does not flag when all siblings advanced together', () => {
    const ledgers: LedgerStat[] = [
      { name: 'a.jsonl', mtimeMs: now - 1 * H },
      { name: 'b.jsonl', mtimeMs: now - 2 * H }
    ]
    expect(findFrozenLedgers(ledgers, now)).toHaveLength(0)
  })

  it('needs at least two siblings to compare (a lone idle ledger is not "frozen")', () => {
    const ledgers: LedgerStat[] = [{ name: 'a.jsonl', mtimeMs: now - 1000 * H }]
    expect(findFrozenLedgers(ledgers, now)).toHaveLength(0)
  })
})

// ──────────────────── unguarded ────────────────────

describe('coherence-lint — unguarded', () => {
  it('flags a detector-less map entry, exact precision', () => {
    const map = [entry({ subsystem: 'guarded-one', detectors: ['x'] }), entry({ subsystem: 'bare', detectors: [] })]
    const findings = findUnguarded(map)
    expect(findings).toHaveLength(1)
    expect(findings[0].subject).toBe('bare')
    expect(findings[0].precision).toBe('exact')
  })
})

// ──────────────────── benchmark-regression ────────────────────

describe('coherence-lint — benchmark-regression', () => {
  it('flags a nested-benchmark overall that dropped beyond the threshold', () => {
    const slices: BenchmarkSlice[] = [
      { name: 'brain', prevOverall: 92, currOverall: 80 }, // −12
      { name: 'backend', prevOverall: 90, currOverall: 89 }, // −1, ignored
      { name: 'compounding', prevOverall: null, currOverall: 21 } // insufficient history
    ]
    const findings = findBenchmarkRegressions(slices)
    expect(findings.map((f) => f.subject)).toEqual(['brain'])
  })
})

// ──────────────────── aggregate ────────────────────

describe('coherence-lint — lintCoherence', () => {
  it('rolls detectors into a summary; map-only input yields exact unguarded findings', () => {
    const map = [entry({ detectors: [] }), entry({ detectors: ['x'] })]
    const report = lintCoherence({ map })
    expect(report.summary.unguarded).toBe(1)
    expect(report.summary.deadExports).toBe(0)
    expect(report.summary.frozenLedgers).toBe(0)
  })

  it('runs every detector when all inputs are supplied', () => {
    const now = Date.now()
    const report = lintCoherence({
      map: [entry({ detectors: [] })],
      sources: [{ path: 'a.ts', content: 'export function deadFn() {}' }],
      ledgers: [
        { name: 'fresh.jsonl', mtimeMs: now },
        { name: 'stale.jsonl', mtimeMs: now - (FROZEN_LEDGER_STALE_HOURS + 10) * 3_600_000 }
      ],
      nowMs: now,
      benchmarks: [{ name: 'brain', prevOverall: 92, currOverall: 70 }]
    })
    expect(report.summary.deadExports).toBe(1)
    expect(report.summary.frozenLedgers).toBe(1)
    expect(report.summary.unguarded).toBe(1)
    expect(report.summary.benchmarkRegressions).toBe(1)
  })
})
