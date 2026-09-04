import { describe, it, expect } from 'vitest'
import {
  computeCoherenceHealth,
  scoreWiring,
  scoreIntentFidelity,
  scoreGuardedness,
  scoreLiveness,
  detectCoherenceRegression,
  isHealthy,
  isMonitorDetector,
  type CoherenceHealthDeps,
  type RollupDeps
} from './coherence-health'
import { COHERENCE_MAP, type CoherenceEntry, type WiringState, type CoherenceAxis } from './coherence-map'

const BUILT_AT = '2026-07-17T00:00:00.000Z'

// ──────────────────── fixtures ────────────────────

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

const noRollups: RollupDeps = { brain: null, backend: null, compounding: null }

function deps(map: CoherenceEntry[], over: Partial<CoherenceHealthDeps> = {}): CoherenceHealthDeps {
  return { builtAt: BUILT_AT, map, rollups: noRollups, ...over }
}

// ──────────────────── helpers ────────────────────

describe('coherence-health — helpers', () => {
  it('isHealthy: LIVE and byDesign are healthy; other states are defects', () => {
    expect(isHealthy(entry({ wiringState: 'LIVE', byDesign: false }))).toBe(true)
    expect(isHealthy(entry({ wiringState: 'COLD_BY_DESIGN', byDesign: true }))).toBe(true)
    expect(isHealthy(entry({ wiringState: 'DEAD', byDesign: false }))).toBe(false)
    expect(isHealthy(entry({ wiringState: 'GAP', byDesign: false }))).toBe(false)
    // a byDesign flag laundering: even a COLD state is healthy when byDesign is true
    expect(isHealthy(entry({ wiringState: 'COLD', byDesign: true }))).toBe(true)
  })

  it('isMonitorDetector recognizes scheduled-monitor detectors', () => {
    expect(isMonitorDetector('brain-health-monitor')).toBe(true)
    expect(isMonitorDetector('backend-health-monitor')).toBe(true)
    expect(isMonitorDetector('dead-export')).toBe(false)
  })
})

// ──────────────────── WIRING ────────────────────

describe('coherence-health — WIRING axis', () => {
  it('scores 100 when all wiring loops are LIVE', () => {
    const map = [entry({ wiringState: 'LIVE' }), entry({ wiringState: 'LIVE' })]
    const r = scoreWiring(map)
    expect(r.score).toBe(100)
    expect(r.metrics.liveFraction).toBe(1)
    expect(r.metrics.deadWiring).toBe(0)
  })

  it('a COLD_BY_DESIGN (byDesign) subsystem does NOT tank WIRING', () => {
    const map = [entry({ wiringState: 'LIVE' }), entry({ wiringState: 'COLD_BY_DESIGN', byDesign: true })]
    const r = scoreWiring(map)
    // both count as healthy → 100, not 50
    expect(r.score).toBe(100)
    expect(r.metrics.byDesignCold).toBe(1)
    expect(r.metrics.deadWiring).toBe(0)
  })

  it('a NON-byDesign dead/written-never-read loop IS a defect', () => {
    const map = [
      entry({ wiringState: 'LIVE' }),
      entry({ wiringState: 'WRITTEN_NEVER_READ', byDesign: false }),
      entry({ wiringState: 'GAP', byDesign: false })
    ]
    const r = scoreWiring(map)
    expect(r.metrics.liveFraction).toBeCloseTo(1 / 3, 3)
    expect(r.metrics.deadWiring).toBe(1) // WRITTEN_NEVER_READ
    expect(r.metrics.brokenChains).toBe(1) // GAP
    expect(r.score).toBeCloseTo(33.3, 1)
  })
})

// ──────────────────── INTENT ────────────────────

describe('coherence-health — INTENT-FIDELITY axis', () => {
  it('drift flags are the non-LIVE, non-byDesign intent entries', () => {
    const map = [
      entry({ axis: 'intent', wiringState: 'LIVE' }),
      entry({ axis: 'intent', wiringState: 'COLD_BY_DESIGN', byDesign: true }), // deliberate gate, not drift
      entry({ axis: 'intent', wiringState: 'GAP', byDesign: false }) // drift
    ]
    const r = scoreIntentFidelity(map)
    expect(r.metrics.driftFlags).toBe(1)
    expect(r.metrics.byDesign).toBe(1)
    expect(r.metrics.intentMatched).toBe(2)
    expect(r.score).toBeCloseTo(66.7, 1)
  })
})

// ──────────────────── GUARDEDNESS ────────────────────

describe('coherence-health — GUARDEDNESS axis', () => {
  it('measures detector + monitor coverage across the whole map', () => {
    const map = [
      entry({ detectors: ['brain-health-monitor'] }), // detector + monitor
      entry({ detectors: ['dead-export'] }), // detector, no monitor
      entry({ detectors: [] }) // unguarded
    ]
    const r = scoreGuardedness(map)
    expect(r.metrics.withDetector).toBe(2)
    expect(r.metrics.withMonitor).toBe(1)
    expect(r.metrics.unguarded).toBe(1)
    // 0.6*(2/3) + 0.4*(1/3) = 0.4 + 0.1333 = 0.5333 → 53.3
    expect(r.score).toBeCloseTo(53.3, 1)
  })
})

// ──────────────────── LIVENESS + nested rollups ────────────────────

describe('coherence-health — LIVENESS axis', () => {
  it('with no rollups, LIVENESS is just the fresh fraction of liveness loops', () => {
    const map = [
      entry({ axis: 'liveness', wiringState: 'LIVE' }),
      entry({ axis: 'liveness', wiringState: 'COLD', byDesign: false }) // frozen
    ]
    const r = scoreLiveness(map, noRollups)
    expect(r.metrics.freshFraction).toBe(0.5)
    expect(r.metrics.frozenCount).toBe(1)
    expect(r.metrics.rollupMean).toBe(-1) // none present
    expect(r.score).toBe(50)
  })

  it('nested subsystem-benchmark overalls FOLD into LIVENESS (50/50 with the map)', () => {
    const map = [entry({ axis: 'liveness', wiringState: 'LIVE' })] // mapFresh = 100
    const rollups: RollupDeps = { brain: 92, backend: 80, compounding: 20 }
    const r = scoreLiveness(map, rollups)
    // rollupMean = (92 + 80 + 20)/3 = 64 ; 0.5*100 + 0.5*64 = 82
    expect(r.metrics.rollupMean).toBe(64)
    expect(r.score).toBe(82)
  })

  it('absent rollups are dropped from the mean (only present ones count)', () => {
    const map = [entry({ axis: 'liveness', wiringState: 'LIVE' })]
    const rollups: RollupDeps = { brain: 90, backend: null, compounding: null }
    const r = scoreLiveness(map, rollups)
    expect(r.metrics.rollupMean).toBe(90)
    expect(r.score).toBe(95) // 0.5*100 + 0.5*90
  })

  it('a lint frozen-ledger / benchmark-regression applies a small capped penalty', () => {
    const map = [entry({ axis: 'liveness', wiringState: 'LIVE' })]
    const r = scoreLiveness(map, noRollups, {
      deadExports: 0,
      frozenLedgers: 2,
      unguarded: 0,
      benchmarkRegressions: 1
    })
    // base 100, penalty min(20, 2*5 + 1*5) = 15 → 85
    expect(r.metrics.penalty).toBe(15)
    expect(r.score).toBe(85)
  })
})

// ──────────────────── overall + weakest axis ────────────────────

describe('coherence-health — computeCoherenceHealth', () => {
  it('weights the 4 axes and reports the weakest', () => {
    const map = [
      entry({ axis: 'wiring', wiringState: 'LIVE' }),
      entry({ axis: 'intent', wiringState: 'GAP', byDesign: false }), // intent = 0
      entry({ axis: 'guarded', wiringState: 'LIVE', detectors: ['brain-health-monitor'] }),
      entry({ axis: 'liveness', wiringState: 'LIVE' })
    ]
    const report = computeCoherenceHealth(deps(map))
    expect(report.axes.intentFidelity.score).toBe(0)
    expect(report.weakestAxis).toBe('intentFidelity')
    expect(report.overall).toBeGreaterThan(0)
    expect(report.overall).toBeLessThan(100)
    expect(report.builtAt).toBe(BUILT_AT)
  })

  it('degrades gracefully on an empty map (no throw, axes score 0)', () => {
    const report = computeCoherenceHealth(deps([]))
    expect(report.overall).toBe(0)
    expect(report.axes.wiring.score).toBe(0)
  })
})

// ──────────────────── regression detector ────────────────────

describe('coherence-health — detectCoherenceRegression', () => {
  const base = () =>
    computeCoherenceHealth(
      deps([
        entry({ axis: 'wiring', wiringState: 'LIVE' }),
        entry({ axis: 'intent', wiringState: 'LIVE' }),
        entry({ axis: 'guarded', wiringState: 'LIVE', detectors: ['brain-health-monitor'] }),
        entry({ axis: 'liveness', wiringState: 'LIVE' })
      ])
    )

  it('no regressions when unchanged', () => {
    const r = base()
    expect(detectCoherenceRegression(r, r)).toEqual([])
  })

  it('flags an axis drop', () => {
    const prev = base()
    const curr = computeCoherenceHealth(
      deps([
        entry({ axis: 'wiring', wiringState: 'DEAD', byDesign: false }), // wiring 0
        entry({ axis: 'intent', wiringState: 'LIVE' }),
        entry({ axis: 'guarded', wiringState: 'LIVE', detectors: ['brain-health-monitor'] }),
        entry({ axis: 'liveness', wiringState: 'LIVE' })
      ])
    )
    const msgs = detectCoherenceRegression(prev, curr)
    expect(msgs.some((m) => m.includes('wiring axis dropped'))).toBe(true)
    expect(msgs.some((m) => m.includes('deadWiring rose'))).toBe(true)
  })

  it('fires absolute floors even with prev === null', () => {
    const curr = computeCoherenceHealth(deps([entry({ axis: 'wiring', wiringState: 'DEAD', byDesign: false })]))
    const msgs = detectCoherenceRegression(null, curr)
    expect(msgs.some((m) => m.startsWith('FLOOR:'))).toBe(true)
  })
})

// ──────────────────── seeded-map integrity ────────────────────

const VALID_STATES: WiringState[] = [
  'LIVE',
  'COLD',
  'WRITTEN_NEVER_READ',
  'SHADOW',
  'COLD_BY_DESIGN',
  'GAP',
  'DEAD'
]
const VALID_AXES: CoherenceAxis[] = ['wiring', 'intent', 'guarded', 'liveness']

describe('COHERENCE_MAP — seed integrity', () => {
  it('is non-empty and every entry has evidence + a valid axis/state', () => {
    expect(COHERENCE_MAP.length).toBeGreaterThan(15)
    for (const e of COHERENCE_MAP) {
      expect(e.subsystem.trim().length, `subsystem: ${e.subsystem}`).toBeGreaterThan(0)
      expect(e.evidence.trim().length, `evidence for ${e.subsystem}`).toBeGreaterThan(0)
      expect(VALID_STATES, `state for ${e.subsystem}`).toContain(e.wiringState)
      expect(VALID_AXES, `axis for ${e.subsystem}`).toContain(e.axis)
    }
  })

  it('every byDesign entry explains WHY (the honesty pivot must be justified)', () => {
    for (const e of COHERENCE_MAP.filter((x) => x.byDesign)) {
      expect(e.byDesignWhy?.trim().length, `byDesignWhy for ${e.subsystem}`).toBeGreaterThan(0)
    }
  })

  // ── The map's census, computed rather than typed (property 6) ──
  //
  // coherence-map.ts used to carry these counts in a hand-written docblock. On 2026-08-03 every one
  // was stale — it claimed ~27 entries against an actual 42, byDesign 3 against 8, and named three
  // wiringStates (WRITTEN_NEVER_READ / SHADOW / GAP) that no entry used. A file whose whole job is
  // catching drift in OTHER subsystems had drifted about itself, undetected, because nothing
  // checked. These assertions are that check: adding or re-scoring an entry now fails here until
  // the new total is acknowledged deliberately.
  it('COHERENCE_MAP census matches the asserted counts (update deliberately when adding an entry)', () => {
    // 48 → 52 on 2026-09-03: the P0 cohesion build's four boot-path mechanisms (role router +
    // health probe, failure → notice watcher, main log + cost ledger, live-eval suite), each
    // wiring-audited against the explicit call on the boot path, not against an export.
    expect(COHERENCE_MAP.length).toBe(52)

    const byAxis: Record<string, number> = {}
    for (const e of COHERENCE_MAP) byAxis[e.axis] = (byAxis[e.axis] ?? 0) + 1
    // W1/W2 (2026-08-14): +1 guarded (Rule-of-Two session floor), +1 wiring (causal survival credit).
    // W3 (2026-08-14): +1 guarded (per-action reviewer lane).
    // Brain API (2026-08-17): +2 guarded — the native read/write surface and the legacy
    // exec-token bypass that currently undercuts it. The membrane had NO row before this,
    // which is why "an external agent can read the vault" was never scored at all.
    // Review pass, same day: +1 wiring — the Connected Agents operator surface, SHADOW
    // (IPC + preload live, no renderer caller). Found by asking who consumes the API rather
    // than by trusting that a shipped IPC means a reachable feature.
    // P0 wiring audit (2026-09-03): +1 wiring (role router + health probe), +2 guarded (failure →
    // notice watcher; main log + cost ledger — both are the observability infrastructure), +1
    // intent (the live-eval suite measures the running app against the plan's acceptance probes).
    expect(byAxis).toEqual({ wiring: 21, intent: 8, guarded: 12, liveness: 11 })

    // 8, not 9: the persistent entity-graph entry lost its exemption on 2026-08-03 when the
    // "DUIN_ENTITY_GRAPH defaults OFF" premise it rested on turned out to be inverted.
    // 7, not 8 (2026-08-17): whole-note grounding lost its exemption the same way — its
    // by-design justification was "full-note egress to cloud stays opt-in", and the operator
    // took that opt-in (DUIN_WHOLENOTE_ALLOW_CLOUD=1 in both launchers). A deliberate stance
    // that has since been reversed is not still a deliberate stance; the entry is LIVE and
    // carries a real privacy gap instead of an exemption.
    // 7 → 6 on 2026-08-21 (W2 considerate-RSI): the RSI proposer/enactor row flipped
    // COLD_BY_DESIGN → LIVE. Same honesty rule as the whole-note flip above: the by-design
    // justification was "enactment held cold pending a human-ratify seam", and W2 BUILT that
    // seam (stage-below-earned-tier + Needs-you ratify UI + engage-time tick) — a stance that
    // has been fulfilled is not still a hold, it is the shipped shape.
    // 2026-09-02 (W3): the seam projection is no longer a by-design hold — it ships ON for every install.
    expect(COHERENCE_MAP.filter((e) => e.byDesign === true).length).toBe(5)
  })

  it('every wiringState the map names in prose is one the map actually uses', () => {
    // The stale docblock listed six states as "spanned" when only four were in play. Assert the
    // live distribution instead, so an unused state cannot be claimed and a new one cannot appear
    // silently.
    const byState: Record<string, number> = {}
    for (const e of COHERENCE_MAP) byState[e.wiringState] = (byState[e.wiringState] ?? 0) + 1
    // W1/W2+W3 (2026-08-14): +3 LIVE (Rule-of-Two floor, causal credit, action-reviewer).
    // 2026-08-17: whole-note grounding moved COLD_BY_DESIGN -> LIVE. The operator accepted
    // cloud egress (DUIN_WHOLENOTE_ALLOW_CLOUD=1 in both launchers), so P8 no longer gates
    // the branch closed and it genuinely runs — the by-design exemption no longer applies.
    // Brain API (2026-08-17): +1 COLD (the native read/write surface — built and tested, but
    // un-deployed and held by no principal), +1 LIVE (the legacy exec-token bypass, which is
    // very much turning: the file is on disk on this machine right now), and +1 SHADOW —
    // the first entry ever to use that state. SHADOW means "computed but never surfaced",
    // which is exactly a full IPC + preload chain with no screen on the end of it — and it
    // went back to LIVE the same day when the Agents pane shipped, so the map holds 32 LIVE
    // and no SHADOW again. The state existed in the vocabulary for years without ever being
    // used; the first thing it described was found by asking who CONSUMES a shipped API.
    // 32/7 → 33/6 on 2026-08-21: W2 moved the RSI proposer/enactor row CBD → LIVE (see the
    // byDesign census note above for the reason). The row stays LIVE — the ratify seam is wired
    // and reachable (keyless turn-end + the operator ratify IPC, both live on any install) — but
    // its EVIDENCE text was corrected 2026-08-22 (F2) to state the real limit: the engage-time
    // advance fires only in the keyless branch, so the loop does not self-advance from a normal
    // chat turn on a model-connected (live) install. Census unchanged; the fix is honesty in the
    // evidence, not a state flip (PARTIAL is not a scored state here).
    // 2026-09-02 (W3): seam projection COLD_BY_DESIGN → LIVE (default ON, provisional facts projected).
    // 2026-09-03 (P0 wiring audit): +4 LIVE — each proven by its boot-path call and an isolated
    // boot on a keyless instance, not by the presence of an export.
    expect(byState).toEqual({ LIVE: 38, COLD_BY_DESIGN: 5, COLD: 6, DEAD: 3 })
  })

  it('the seeded map computes a finite report over all 4 axes', () => {
    const report = computeCoherenceHealth(
      deps(COHERENCE_MAP, { rollups: { brain: 92, backend: 90, compounding: 21 } })
    )
    expect(report.overall).toBeGreaterThan(0)
    expect(report.overall).toBeLessThanOrEqual(100)
    for (const axis of ['wiring', 'intentFidelity', 'guardedness', 'liveness'] as const) {
      expect(report.axes[axis].score).toBeGreaterThanOrEqual(0)
      expect(report.axes[axis].score).toBeLessThanOrEqual(100)
    }
  })
})
