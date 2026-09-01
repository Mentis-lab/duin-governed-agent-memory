import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  detectRegression,
  toLedgerEntry,
  appendEntry,
  readLastEntry,
  historyPath,
  runBrainHealthMonitor,
  brainHealthMonitorEnabled,
  type HealthLedgerEntry
} from './brain-health-monitor'
import type { BrainHealthReport } from './brain-health'

// ──────────────────── fixtures ────────────────────

function entry(
  over: {
    overall?: number
    axes?: Partial<HealthLedgerEntry['axes']>
    componentCount?: number
    dedupRate?: number
    entityNoteConnectivity?: number
    totalEntities?: number
    ts?: string
  } = {}
): HealthLedgerEntry {
  return {
    ts: over.ts ?? '2026-07-16T02:00:00.000Z',
    overall: over.overall ?? 80,
    axes: { coherence: 80, grounding: 75, freshness: 70, purity: 85, ...(over.axes ?? {}) },
    componentCount: over.componentCount ?? 3,
    dedupRate: over.dedupRate ?? 0.05,
    entityNoteConnectivity: over.entityNoteConnectivity ?? 0.8,
    totalEntities: over.totalEntities ?? 40
  }
}

/** Build a minimal-but-valid BrainHealthReport (only coherence.metrics is read by toLedgerEntry). */
function makeReport(o: {
  overall?: number
  coherence?: number
  grounding?: number
  freshness?: number
  purity?: number
  componentCount?: number
  dedupRate?: number
  entityNoteConnectivity?: number
  totalEntities?: number
  builtAt?: string
} = {}): BrainHealthReport {
  const axis = (score: number, metrics: Record<string, number> = {}) => ({ score, metrics, notes: '' })
  return {
    overall: o.overall ?? 80,
    weakestAxis: 'freshness',
    axes: {
      coherence: axis(o.coherence ?? 80, {
        componentCount: o.componentCount ?? 3,
        dedupRate: o.dedupRate ?? 0.05,
        entityNoteConnectivity: o.entityNoteConnectivity ?? 0.8,
        totalEntities: o.totalEntities ?? 40
      }),
      grounding: axis(o.grounding ?? 75),
      freshness: axis(o.freshness ?? 70),
      purity: axis(o.purity ?? 85)
    },
    builtAt: o.builtAt ?? '2026-07-16T02:00:00.000Z'
  }
}

// ──────────────────── detectRegression (PURE) ────────────────────

describe('detectRegression', () => {
  it('flags nothing when the rebuild is stable or improving', () => {
    const prev = entry()
    const curr = entry({ overall: 82, axes: { coherence: 82 } })
    expect(detectRegression(prev, curr)).toEqual([])
  })

  it('flags a coherence axis drop > 10', () => {
    const prev = entry({ axes: { coherence: 85 } })
    const curr = entry({ axes: { coherence: 70 } }) // -15
    const msgs = detectRegression(prev, curr)
    expect(msgs.some((m) => /coherence axis dropped 85→70/.test(m))).toBe(true)
  })

  it('does NOT flag an axis drop of exactly the threshold or less', () => {
    const prev = entry({ axes: { coherence: 85 } })
    const curr = entry({ axes: { coherence: 75 } }) // -10 (not > 10)
    expect(detectRegression(prev, curr).some((m) => /coherence axis dropped/.test(m))).toBe(false)
  })

  it('flags an overall drop > 5', () => {
    const prev = entry({ overall: 80 })
    const curr = entry({ overall: 72 }) // -8
    expect(detectRegression(prev, curr).some((m) => /overall dropped 80→72/.test(m))).toBe(true)
  })

  it('flags componentCount INCREASE (fragmentation returning)', () => {
    const prev = entry({ componentCount: 3 })
    const curr = entry({ componentCount: 9 })
    expect(detectRegression(prev, curr).some((m) => /componentCount rose 3→9/.test(m))).toBe(true)
  })

  it('flags dedupRate INCREASE (dupes returning)', () => {
    const prev = entry({ dedupRate: 0.05 })
    const curr = entry({ dedupRate: 0.18 })
    expect(detectRegression(prev, curr).some((m) => /dedupRate rose/.test(m))).toBe(true)
  })

  it('flags entityNoteConnectivity DROP > 0.1 (orphans returning)', () => {
    const prev = entry({ entityNoteConnectivity: 0.8 })
    const curr = entry({ entityNoteConnectivity: 0.6 }) // -0.2
    expect(detectRegression(prev, curr).some((m) => /entityNoteConnectivity dropped/.test(m))).toBe(true)
  })

  it('does NOT flag a connectivity drop at/under the threshold', () => {
    const prev = entry({ entityNoteConnectivity: 0.8 })
    const curr = entry({ entityNoteConnectivity: 0.7 }) // -0.1 (not > 0.1)
    expect(detectRegression(prev, curr).some((m) => /entityNoteConnectivity/.test(m))).toBe(false)
  })

  it('flags a totalEntities DROP > 30% (construction collapse the monitor used to score as a win)', () => {
    // The exact churn P3 targets: a 260-entity graph clobbered down to 44 by a degraded rebuild.
    const prev = entry({ totalEntities: 260 })
    const curr = entry({ totalEntities: 44 }) // −83%
    const msgs = detectRegression(prev, curr)
    expect(msgs.some((m) => /totalEntities dropped 260→44/.test(m))).toBe(true)
  })

  it('does NOT flag a totalEntities drop at/under the 30% threshold', () => {
    const prev = entry({ totalEntities: 100 })
    const curr = entry({ totalEntities: 70 }) // exactly −30% (not > 30%)
    expect(detectRegression(prev, curr).some((m) => /totalEntities dropped/.test(m))).toBe(false)
  })

  it('does NOT flag a totalEntities INCREASE (a growing graph is not a regression)', () => {
    const prev = entry({ totalEntities: 100 })
    const curr = entry({ totalEntities: 160 })
    expect(detectRegression(prev, curr).some((m) => /totalEntities dropped/.test(m))).toBe(false)
  })

  it('flags an absolute axis floor even with no prior entry', () => {
    const curr = entry({ axes: { grounding: 35 } }) // < 40
    const msgs = detectRegression(null, curr)
    expect(msgs.some((m) => /FLOOR: grounding/.test(m))).toBe(true)
  })

  it('with no prior entry, only floors can fire (no delta regressions)', () => {
    const curr = entry({ overall: 90, axes: { coherence: 90, grounding: 90, freshness: 90, purity: 90 } })
    expect(detectRegression(null, curr)).toEqual([])
  })
})

// ──────────────────── toLedgerEntry (PURE) ────────────────────

describe('toLedgerEntry', () => {
  it('projects a report onto a well-formed compact entry', () => {
    const e = toLedgerEntry(
      makeReport({ overall: 77, coherence: 66, componentCount: 4, dedupRate: 0.1, entityNoteConnectivity: 0.7, totalEntities: 42 })
    )
    expect(e).toEqual({
      ts: '2026-07-16T02:00:00.000Z',
      overall: 77,
      axes: { coherence: 66, grounding: 75, freshness: 70, purity: 85 },
      componentCount: 4,
      dedupRate: 0.1,
      entityNoteConnectivity: 0.7,
      totalEntities: 42
    })
  })
})

// ──────────────────── ledger I/O ────────────────────

describe('ledger I/O', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'bhm-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('historyPath lands under .duin/_state (claim-ledger convention); null without a vault', () => {
    expect(historyPath(vault)).toBe(join(vault, '.duin', '_state', 'brain-health-history.jsonl'))
    expect(historyPath(null)).toBeNull()
    expect(historyPath('')).toBeNull()
  })

  it('appendEntry writes a well-formed JSONL line that readLastEntry round-trips', () => {
    const e = toLedgerEntry(makeReport({ overall: 81 }))
    appendEntry(vault, e)
    const p = historyPath(vault)!
    expect(existsSync(p)).toBe(true)
    expect(readLastEntry(vault)).toEqual(e)
  })

  it('readLastEntry returns the MOST RECENT of several appended entries', () => {
    appendEntry(vault, toLedgerEntry(makeReport({ overall: 60 })))
    appendEntry(vault, toLedgerEntry(makeReport({ overall: 90 })))
    expect(readLastEntry(vault)?.overall).toBe(90)
  })

  it('readLastEntry returns null when no ledger exists', () => {
    expect(readLastEntry(vault)).toBeNull()
  })
})

// ──────────────────── the fire-and-forget wrapper ────────────────────

describe('runBrainHealthMonitor', () => {
  let vault: string
  const OLD = process.env.DUIN_BRAIN_HEALTH_MONITOR
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'bhm-'))
    delete process.env.DUIN_BRAIN_HEALTH_MONITOR // default-ON
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_BRAIN_HEALTH_MONITOR
    else process.env.DUIN_BRAIN_HEALTH_MONITOR = OLD
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  it('default-ON: appends a ledger line for a completed rebuild', async () => {
    await runBrainHealthMonitor(vault, () => makeReport({ overall: 83 }))
    expect(readLastEntry(vault)?.overall).toBe(83)
  })

  it('WARNs on a regression vs the prior entry', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runBrainHealthMonitor(vault, () => makeReport({ overall: 80, coherence: 85 }))
    await runBrainHealthMonitor(vault, () => makeReport({ overall: 80, coherence: 60 })) // coherence -25
    expect(warn.mock.calls.flat().some((a) => String(a).includes('coherence axis dropped'))).toBe(true)
    // and still records the (regressed) entry
    expect(readLastEntry(vault)?.axes.coherence).toBe(60)
  })

  it('SWALLOWS a monitor error (rebuild-safe): a throwing compute never rejects, writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      runBrainHealthMonitor(vault, () => {
        throw new Error('boom')
      })
    ).resolves.toBeUndefined()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('flag-OFF (DUIN_BRAIN_HEALTH_MONITOR=0) ⇒ no-op: no compute, no ledger write', async () => {
    process.env.DUIN_BRAIN_HEALTH_MONITOR = '0'
    expect(brainHealthMonitorEnabled()).toBe(false)
    const compute = vi.fn(() => makeReport())
    await runBrainHealthMonitor(vault, compute)
    expect(compute).not.toHaveBeenCalled()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })
})
