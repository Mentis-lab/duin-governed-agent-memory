import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  toLedgerEntry,
  detectRegression,
  historyPath,
  readLastEntry,
  appendEntry,
  runCompoundingHealthMonitor,
  compoundingHealthMonitorEnabled,
  type CompoundingLedgerEntry
} from './compounding-health-monitor'
import type { CompoundingHealth } from './compounding-health'

// ──────────────────── fixtures ────────────────────

function axis(score: number, metrics: Record<string, number> = {}) {
  return { score, metrics, notes: '' }
}

function report(over: Partial<CompoundingHealth> = {}): CompoundingHealth {
  const base: CompoundingHealth = {
    overall: 60,
    weakestAxis: 'compounding',
    unmeasuredAxes: [],
    builtAt: '2026-07-16T00:00:00.000Z',
    axes: {
      stability: axis(80),
      metabolism: axis(70),
      compounding: axis(40),
      grounding: axis(65)
    }
  }
  return { ...base, ...over }
}

// ──────────────────── projection ────────────────────

describe('toLedgerEntry', () => {
  it('projects onto a compact entry with overall TOP-LEVEL (the rollup reads it)', () => {
    const e = toLedgerEntry(report())
    expect(e).toEqual({
      ts: '2026-07-16T00:00:00.000Z',
      overall: 60,
      axes: { stability: 80, metabolism: 70, compounding: 40, grounding: 65 },
      weakestAxis: 'compounding',
      unmeasuredCount: 0
    } satisfies CompoundingLedgerEntry)
  })

  it('counts unmeasured axes', () => {
    const e = toLedgerEntry(report({ unmeasuredAxes: ['metabolism', 'grounding'] }))
    expect(e.unmeasuredCount).toBe(2)
  })
})

// ──────────────────── regression detection ────────────────────

describe('detectRegression', () => {
  const entry = (over: Partial<CompoundingLedgerEntry> = {}): CompoundingLedgerEntry => ({
    ts: 't',
    overall: 60,
    axes: { stability: 80, metabolism: 70, compounding: 40, grounding: 65 },
    weakestAxis: 'compounding',
    unmeasuredCount: 0,
    ...over
  })

  it('no prior + healthy ⇒ no regressions', () => {
    expect(detectRegression(null, entry())).toEqual([])
  })

  it('overall drop beyond threshold trips', () => {
    const out = detectRegression(entry({ overall: 70 }), entry({ overall: 60 }))
    expect(out.some((m) => /overall dropped 70→60/.test(m))).toBe(true)
  })

  it('an overall drop within threshold does NOT trip', () => {
    expect(detectRegression(entry({ overall: 63 }), entry({ overall: 60 }))).toEqual([])
  })

  it('a per-axis drop beyond threshold trips', () => {
    const prev = entry({ axes: { stability: 80, metabolism: 70, compounding: 60, grounding: 65 } })
    const curr = entry({ axes: { stability: 80, metabolism: 70, compounding: 40, grounding: 65 } })
    const out = detectRegression(prev, curr)
    expect(out.some((m) => /compounding axis dropped 60→40/.test(m))).toBe(true)
  })

  it('rising unmeasuredCount trips (a measured axis went dark)', () => {
    const out = detectRegression(entry({ unmeasuredCount: 0 }), entry({ unmeasuredCount: 2 }))
    expect(out.some((m) => /unmeasuredAxes rose 0→2/.test(m))).toBe(true)
  })

  it('absolute floor fires on the first run for a genuinely low MEASURED axis', () => {
    const out = detectRegression(null, entry({ axes: { stability: 80, metabolism: 70, compounding: 10, grounding: 65 } }))
    expect(out.some((m) => /FLOOR: compounding/.test(m))).toBe(true)
  })

  it('an unmeasured 0-axis does NOT floor-trip (cold-start neutral, not a collapse)', () => {
    const out = detectRegression(
      null,
      entry({ axes: { stability: 80, metabolism: 0, compounding: 40, grounding: 65 }, unmeasuredCount: 1 })
    )
    expect(out.some((m) => /FLOOR: metabolism/.test(m))).toBe(false)
  })
})

// ──────────────────── ledger I/O ────────────────────

describe('compounding-health ledger I/O', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'chm-c-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('historyPath lands under .duin/_state; null without a vault', () => {
    expect(historyPath(vault)).toBe(join(vault, '.duin', '_state', 'compounding-health-history.jsonl'))
    expect(historyPath(null)).toBeNull()
    expect(historyPath('')).toBeNull()
  })

  it('appendEntry writes a JSONL line readLastEntry round-trips (newest wins)', () => {
    appendEntry(vault, toLedgerEntry(report({ overall: 50 })))
    appendEntry(vault, toLedgerEntry(report({ overall: 55 })))
    expect(existsSync(historyPath(vault)!)).toBe(true)
    expect(readLastEntry(vault)?.overall).toBe(55)
  })

  it('readLastEntry is null when no ledger exists', () => {
    expect(readLastEntry(vault)).toBeNull()
  })
})

// ──────────────────── the fire-and-forget wrapper ────────────────────

describe('runCompoundingHealthMonitor', () => {
  let vault: string
  const OLD = process.env.DUIN_COMPOUNDING_HEALTH_MONITOR

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'chm-c-'))
    delete process.env.DUIN_COMPOUNDING_HEALTH_MONITOR // default-ON
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_COMPOUNDING_HEALTH_MONITOR
    else process.env.DUIN_COMPOUNDING_HEALTH_MONITOR = OLD
    vi.restoreAllMocks()
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('default-ON: computes and appends a well-formed ledger line (overall top-level)', async () => {
    await runCompoundingHealthMonitor(vault, () => report({ overall: 61 }))
    const last = readLastEntry(vault)
    expect(last?.overall).toBe(61)
    expect(last?.axes).toEqual({ stability: 80, metabolism: 70, compounding: 40, grounding: 65 })
  })

  it('WARNs on a regression vs the prior run and still records the new line', async () => {
    appendEntry(vault, toLedgerEntry(report({ overall: 70 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runCompoundingHealthMonitor(vault, () => report({ overall: 55 }))
    const warned = warn.mock.calls.flat().map(String)
    expect(warned.some((m) => /overall dropped/.test(m))).toBe(true)
    expect(readLastEntry(vault)?.overall).toBe(55)
  })

  it('SWALLOWS a compute error (app-safe): never rejects, writes nothing', async () => {
    await expect(
      runCompoundingHealthMonitor(vault, () => {
        throw new Error('boom')
      })
    ).resolves.toBeUndefined()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('flag-OFF ⇒ no-op: no compute, no ledger write', async () => {
    process.env.DUIN_COMPOUNDING_HEALTH_MONITOR = '0'
    expect(compoundingHealthMonitorEnabled()).toBe(false)
    const compute = vi.fn(() => report())
    await runCompoundingHealthMonitor(vault, compute)
    expect(compute).not.toHaveBeenCalled()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })
})
