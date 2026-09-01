import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { existsSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  toLedgerEntry,
  ledgerEntryToHealth,
  appendEntry,
  readLastEntry,
  historyPath,
  runCoherenceHealthMonitor,
  coherenceHealthMonitorEnabled,
  type CoherenceHealthLedgerEntry
} from './coherence-health-monitor'
import { computeCoherenceHealth, type CoherenceHealth, type AxisReport } from './coherence-health'
import { COHERENCE_MAP } from './coherence-map'

// ──────────────────── fixtures ────────────────────

function axis(score: number, metrics: Record<string, number> = {}): AxisReport {
  return { score, metrics, notes: '' }
}

/** Build a full CoherenceHealth report. Defaults model a healthy system; override per-test. */
function health(over: Partial<CoherenceHealth> = {}): CoherenceHealth {
  const base: CoherenceHealth = {
    overall: 74.9,
    weakestAxis: 'guardedness',
    builtAt: '2026-07-17T00:00:00.000Z',
    axes: {
      wiring: axis(60, { liveFraction: 0.6, deadWiring: 1 }),
      intentFidelity: axis(100, { driftFlags: 0 }),
      guardedness: axis(65.2, { detectorCoverage: 0.889, monitorCoverage: 0.296 }),
      liveness: axis(69.5, { frozenCount: 2 })
    }
  }
  return { ...base, ...over }
}

// ──────────────────── pure projection round-trip ────────────────────

describe('toLedgerEntry / ledgerEntryToHealth', () => {
  it('projects a report onto a compact, well-formed ledger entry', () => {
    const e = toLedgerEntry(health())
    expect(e).toEqual({
      ts: '2026-07-17T00:00:00.000Z',
      overall: 74.9,
      axes: { wiring: 60, intentFidelity: 100, guardedness: 65.2, liveness: 69.5 },
      weakestAxis: 'guardedness',
      liveFraction: 0.6,
      deadWiring: 1,
      driftFlags: 0,
      detectorCoverage: 0.889,
      monitorCoverage: 0.296,
      frozenCount: 2
    } satisfies CoherenceHealthLedgerEntry)
  })

  it('rebuilds the regression-relevant CoherenceHealth shape from a stored entry', () => {
    const rebuilt = ledgerEntryToHealth(toLedgerEntry(health()))
    expect(rebuilt.overall).toBe(74.9)
    expect(rebuilt.axes.wiring.score).toBe(60)
    expect(rebuilt.axes.wiring.metrics.deadWiring).toBe(1)
    expect(rebuilt.axes.intentFidelity.metrics.driftFlags).toBe(0)
    expect(rebuilt.axes.liveness.metrics.frozenCount).toBe(2)
  })

  it('non-finite metrics coerce to 0 (never NaN in the ledger)', () => {
    const e = toLedgerEntry(health({ axes: { ...health().axes, wiring: axis(0, {}) } }))
    expect(e.liveFraction).toBe(0)
    expect(e.deadWiring).toBe(0)
  })
})

// ──────────────────── re-score over the UPDATED map (the point of closing the gap) ────────────────────

describe('COHERENCE_MAP live re-score (current corrected map)', () => {
  // Rollups {brain 92, backend 90, compounding 21}. The map reflects the self-improve-bridge
  // wiring corrections (three WRITTEN_NEVER_READ/SHADOW entries → LIVE against real readers;
  // corrections→binding drain → COLD_BY_DESIGN) that took WIRING 60→100, PLUS this pass's two
  // fixes:
  //   RAG document ingest  liveness GAP→LIVE — pdf-parse v1→v2 break fixed in both loaders
  //                         (pdf.ts + iwork.ts), verified extracting real text from a 34-page PDF.
  //   notes-accumulation liveness monitor  NEW guarded-axis entry — an EVENT-triggered watchdog
  //                         (notes-liveness-monitor.ts, hooked into notes-watcher) that catches a
  //                         frozen construction/metabolism loop the moment notes accumulate on it.
  // Net: GUARDEDNESS 67.4→77.1 — the new event-monitor took withMonitor 8→9, then the DEDICATED
  // compounding-health-monitor (writes compounding-health-history.jsonl on the coherence daily tick,
  // closing the map's standing "no scheduled compounding writer" gap) credited 6 loops backed by a
  // compounding-health:* metric → withMonitor 9→15. unguarded still 2 (RAG + proof_receipts carry no
  // detector). LIVENESS 69.5→76.7 (RAG unfrozen). overall 87.4→90.8. Wiring stays 100.
  // NB weakest flips to LIVENESS here purely as a FIXTURE artifact: the pinned compounding rollup (21)
  // is artificially low, so liveness (76.7) sits a hair under guardedness (77.1). LIVE, the new
  // compounding writer feeds a real (higher) rollup, so live liveness clears guardedness again.
  // 2026-07-23: 11 adversarially-verified subsystems (duin-gap-verify) graduated in from the handbook
  // catalog — 2 fixed LIVE (Channel→Foresight bridge, brain-client resolve), 9 open verified gaps. The
  // 9 gaps honestly drop the live map: overall 90.8→76.7, WIRING 100→68.8 (deadWiring 0→1),
  // GUARDEDNESS 77.1→69.2 (unguarded 2→4, new gaps carry no detector yet), LIVENESS 76.7→61.1 (frozen
  // loops). This is the benchmark TRACKING real verified gaps, exactly as intended — closing them lifts it.
  const report = computeCoherenceHealth({
    builtAt: 'x',
    map: COHERENCE_MAP,
    rollups: { brain: 92, backend: 90, compounding: 21 }
  })

  // 2026-07-25: four of those verified gaps were CLOSED, and the map was corrected to say so —
  // which is the whole point of a benchmark that tracks real gaps. WIRING 70.6→88.2 (safe-undo
  // gained a production producer, so deadWiring 1→0; multi-query and the entity-graph store became
  // honestly by-design cold, so byDesignCold 4→6). GUARDEDNESS 69→72 (unguarded 4→2: the closed
  // gaps now carry test detectors). LIVENESS 61.1→65.7 (transfer-A/B turns on a clock instead of
  // only on a manual POST). Overall 77.2→84, still weakest on liveness.
  // 2026-07-30: WIRING 88.2→83.3 and overall 84→82.5, and that DROP is the point. The
  // brain-client write seam was recorded LIVE with its gap "resolved" while nothing in the app
  // imported it; correcting the state to DEAD was not enough, because the entry sat on the
  // `guarded` axis and scoreWiring filters to axis==='wiring' — so the correction moved no number
  // and the gap stayed as hidden as before. Moving it onto the wiring axis is what makes it
  // count: subsystems 17→18, deadWiring 0→1. A benchmark that only ever improves is not measuring.
  // 2026-08-03: WIRING 83.3→77.8, and this drop is the point in the same way the 2026-07-30 one
  // was. The persistent entity-graph entry was COLD_BY_DESIGN + byDesign:true, justified by
  // "DUIN_ENTITY_GRAPH defaults OFF". The flag is `!== '0'` — default ON — so the store fills on
  // every install and the exemption was resting on an inverted read. byDesign is load-bearing
  // twice: it puts the entry in the healthy numerator (coherence-health.ts:138-139) AND
  // coherence-map-claims.test.ts declines to adjudicate COLD_BY_DESIGN, so a wrong claim parked
  // there is invisible to both the score and the only machine check. Re-scored to COLD +
  // byDesign:false: liveOrByDesign 15→14, byDesignCold 6→5, deadWiring unchanged at 1 (COLD is not
  // in DEAD_WIRING_STATES — the store IS read, by its own writers and by kg-query.ts; what it
  // lacks is an operator surface).
  // 2026-08-14 (W1/W2): WIRING 77.8→78.9 — the causal-survival-credit loop entered the map LIVE
  // (subsystems 18→19, liveOrByDesign 14→15); the Rule-of-Two floor entered on the guarded axis.
  // GUARDEDNESS 71.4→70.9 by the SAME honest mechanism as 2026-08-02 below: the new entry carries
  // a TEST detector, not a *-monitor, so the denominator grows while withMonitor stays flat.
  // Overall 80.8→81, still weakest on liveness.
  // 2026-08-17 (Brain API review): WIRING 78.9→75. The Connected Agents operator surface
  // entered the map as SHADOW — main-process IPC and preload bindings both live, zero
  // renderer callers — so the denominator grew while liveOrByDesign did not. This is the
  // map catching something that had been invisible: the pairing notice told the operator to
  // approve in a screen that was never built, and nothing scored the fact that the human
  // half of the membrane has no UI. A 3.9-point drop for a surface we already shipped
  // without is the description getting more accurate, not the system getting worse.
  // Same day, later: 75 → 80 when the Agents pane shipped and that SHADOW became LIVE. The
  // map briefly held the honest bad number, then the number improved because the SYSTEM did —
  // which is the loop working in both directions rather than a score being managed.
  it('WIRING is 80 — 16/20 live-or-by-design, ONE dead (brain-client, unadopted)', () => {
    expect(report.axes.wiring.score).toBe(80)
    expect(report.axes.wiring.metrics.subsystems).toBe(20)
    expect(report.axes.wiring.metrics.liveOrByDesign).toBe(16)
    expect(report.axes.wiring.metrics.deadWiring).toBe(1)
    // 5 → 4 on 2026-08-21 (W2): the RSI row is LIVE now (engage-time staging + ratify UI),
    // no longer a by-design cold-hold; liveOrByDesign is unchanged because the row was
    // already counted there under its old state.
    expect(report.axes.wiring.metrics.byDesignCold).toBe(4)
  })

  it('GUARDEDNESS is 70 (withMonitor 15; unguarded 2 — the Agents pane arrived with tests)', () => {
    // 72 → 71.4 on 2026-08-02, and the drop is HONEST rather than a regression. Two subsystems were
    // added to the map (the agentic retriever, and the runCode tool), both of which had been
    // missing entirely — the retriever produces every grounded answer and was unmapped. Both carry
    // detectors, but TEST detectors, not `*-monitor` ones, so they enlarge the denominator without
    // adding to `withMonitor`. The score correctly says: more of this system is now described, and
    // the newly-described part is guarded by tests rather than by anything watching at runtime.
    // 71.4 → 70.9 → 70.7 on 2026-08-14 for the same reason twice (Rule-of-Two floor, then the
    // W3 action-reviewer: both test-guarded, no monitor — denominator grows, withMonitor flat).
    // 70.7 → 70.2 on 2026-08-17, third time, same mechanism: the Brain API's native memory
    // surface and the legacy exec-token bypass entered the guarded axis carrying test
    // detectors only. Nothing WATCHES either at runtime — no monitor notices a paired agent
    // reading unusually hard, or the bypass file reappearing — and the score says so.
    // 70.2 → 68.8 on 2026-08-17, and this one is NOT the usual test-detector dilution: the
    // 68.8 → 70 later the same day: the Connected Agents entry briefly carried `detectors: []`
    // — an honest zero, since nothing checks that a preload API has a renderer caller, which is
    // exactly how a fully-wired IPC dangled an inch short of the glass unnoticed. It now carries
    // real test detectors because the pane shipped with them. Still no *-monitor: nothing
    // WATCHES this at runtime, so it stays out of withMonitor.
    expect(report.axes.guardedness.score).toBe(70)
    expect(report.axes.guardedness.metrics.withMonitor).toBe(15)
    expect(report.axes.guardedness.metrics.unguarded).toBe(2)
  })

  it('INTENT is 100; LIVENESS is 65.7 (the moat-fit litmus now runs on a clock)', () => {
    expect(report.axes.intentFidelity.score).toBe(100)
    expect(report.axes.liveness.score).toBe(65.7)
  })

  it('overall is 81.1; weakest axis is liveness', () => {
    // 82.5 → 82.4 from the guardedness move; 82.4 → 80.8 on 2026-08-03 from the entity-graph
    // byDesign correction above. Both drops are corrections to the map, not regressions in the
    // system — the system did not get worse, the description stopped flattering it.
    // 80.8 → 81 on 2026-08-14: two genuinely new LIVE organs (W1/W2) entered the map.
    // 81 → 80.9 → 79.4 → 81.1 across 2026-08-17. The membrane got its first three rows and the
    // score DROPPED 1.6, because two of them were real weaknesses that had simply never been
    // scored: the exec-token bypass, which is running right now, and an operator surface that
    // stopped one component short of existing. Building that component earned 1.7 back. The
    // dip and the recovery are the same mechanism — describe it honestly, then fix what the
    // description exposes. A map that had only ever gone up would be the suspicious one.
    expect(report.overall).toBe(81.1)
    expect(report.weakestAxis).toBe('liveness')
  })
})

// ──────────────────── ledger I/O ────────────────────

describe('coherence-health ledger I/O', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'chm-'))
  })
  afterEach(() => {
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  })

  it('historyPath lands under .duin/_state; null without a vault', () => {
    expect(historyPath(vault)).toBe(join(vault, '.duin', '_state', 'coherence-health-history.jsonl'))
    expect(historyPath(null)).toBeNull()
    expect(historyPath('')).toBeNull()
  })

  it('appendEntry writes a JSONL line that readLastEntry round-trips; returns the newest', () => {
    const a = toLedgerEntry(health({ overall: 70 }))
    const b = toLedgerEntry(health({ overall: 75 }))
    appendEntry(vault, a)
    appendEntry(vault, b)
    expect(existsSync(historyPath(vault)!)).toBe(true)
    expect(readLastEntry(vault)?.overall).toBe(75)
  })

  it('readLastEntry is null when no ledger exists', () => {
    expect(readLastEntry(vault)).toBeNull()
  })
})

// ──────────────────── the fire-and-forget wrapper ────────────────────

describe('runCoherenceHealthMonitor', () => {
  let vault: string
  const OLD = process.env.DUIN_COHERENCE_HEALTH_MONITOR

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'chm-'))
    delete process.env.DUIN_COHERENCE_HEALTH_MONITOR // default-ON
  })
  afterEach(() => {
    if (OLD === undefined) delete process.env.DUIN_COHERENCE_HEALTH_MONITOR
    else process.env.DUIN_COHERENCE_HEALTH_MONITOR = OLD
    try {
      rmSync(vault, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks()
  })

  it('default-ON: computes and appends a well-formed ledger line', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    await runCoherenceHealthMonitor({ vaultDir: vault }, () => health({ overall: 74.9 }))
    const last = readLastEntry(vault)
    expect(last?.overall).toBe(74.9)
    expect(last?.axes).toEqual({ wiring: 60, intentFidelity: 100, guardedness: 65.2, liveness: 69.5 })
    expect(last?.monitorCoverage).toBe(0.296)
  })

  it('WARNs on a regression vs the prior entry and still records the new line', async () => {
    // Seed a healthy prior run.
    appendEntry(vault, toLedgerEntry(health({ overall: 74.9 })))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    // A markedly worse current report: overall + wiring collapse, deadWiring rises.
    await runCoherenceHealthMonitor({ vaultDir: vault }, () =>
      health({
        overall: 50,
        axes: {
          wiring: axis(20, { liveFraction: 0.2, deadWiring: 4 }),
          intentFidelity: axis(100, { driftFlags: 0 }),
          guardedness: axis(65.2, { detectorCoverage: 0.889, monitorCoverage: 0.296 }),
          liveness: axis(69.5, { frozenCount: 2 })
        }
      })
    )
    const warned = warn.mock.calls.flat().map(String)
    expect(warned.some((m) => /overall dropped/.test(m))).toBe(true)
    expect(warned.some((m) => /wiring axis dropped/.test(m))).toBe(true)
    expect(warned.some((m) => /deadWiring rose/.test(m))).toBe(true)
    expect(readLastEntry(vault)?.overall).toBe(50)
  })

  it('SWALLOWS a compute error (app-safe): a throwing compute never rejects, writes nothing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      runCoherenceHealthMonitor({ vaultDir: vault }, () => {
        throw new Error('boom')
      })
    ).resolves.toBeUndefined()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })

  it('flag-OFF (DUIN_COHERENCE_HEALTH_MONITOR=0) ⇒ no-op: no compute, no ledger write', async () => {
    process.env.DUIN_COHERENCE_HEALTH_MONITOR = '0'
    expect(coherenceHealthMonitorEnabled()).toBe(false)
    const compute = vi.fn(() => health())
    await runCoherenceHealthMonitor({ vaultDir: vault }, compute)
    expect(compute).not.toHaveBeenCalled()
    expect(existsSync(historyPath(vault)!)).toBe(false)
  })
})
