import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getCalibration, recordDecision, getDecisionLoop, __resetDecisions, isProviderStarvedBuild } from './index'
import { loadKindRates } from './calibration-weight'

// The in-memory Store abstraction (demo/override/onboarding-seed/source-switch) was retired in the
// two-brain fuse — the facade now reads the fs-native Stack-B substrate. The old store-resolution
// tests went with it. What remains is store-agnostic: calibration + the made-decisions register.

afterEach(() => {
  __resetDecisions()
})

describe('brain facade', () => {
  it('returns an empty calibration report when persistence is disabled (test env)', () => {
    const c = getCalibration()
    expect(c.totals.logged).toBe(0)
    expect(c.buckets).toHaveLength(0)
  })

  it('recordDecision registers a made decision (label resolved from the substrate graph)', () => {
    const after = recordDecision('some-node', 'cleared')
    expect(after.made.some((m) => m.node_id === 'some-node')).toBe(true)
    expect(getDecisionLoop().made.some((m) => m.node_id === 'some-node')).toBe(true)
  })
})

// Item 1 (E1) load-bearing invariant: getCalibration projects the SAME scored ledger
// (forecast-track-record.json) that loadKindRates reads, and both select the rate through
// the shared empiricalRateForKind helper, so per-kind rate MUST match: coupling kinds →
// useful_rate, signal → efficacy_rate, other forecast kinds → hit_rate.
describe('getCalibration ↔ loadKindRates parity (E1)', () => {
  let dir: string
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('per-kind rate == loadKindRates rate (coupling → useful_rate, signal → efficacy_rate)', () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-parity-'))
    const state = join(dir, '.duin', '_state')
    mkdirSync(state, { recursive: true })
    const track = {
      generated: '2026-07-07',
      patterns: {
        driver: { mode: 'forecast', fired: 30, materialized: 18, averted: 4, refuted: 8, unobserved: 0, hit_rate: 0.6, useful_rate: 0.733 },
        'decision-window': { mode: 'signal', fired: 25, materialized: 5, averted: 20, refuted: 0, unobserved: 0, hit_rate: null, efficacy_rate: 0.8 }
      }
    }
    writeFileSync(join(state, 'forecast-track-record.json'), JSON.stringify(track), 'utf-8')

    const buckets = getCalibration(dir).buckets
    const rates = loadKindRates(dir)
    for (const b of buckets) {
      expect(b.hit_rate).toBe(rates.get(b.kind)!.rate)
    }
    // spot the actual values
    expect(buckets.find((b) => b.kind === 'driver')!.hit_rate).toBe(0.733) // coupling → useful_rate, NOT hit_rate(0.6)
    expect(buckets.find((b) => b.kind === 'decision-window')!.hit_rate).toBe(0.8) // signal → efficacy_rate
  })
})

// ── extraction breaker: the partial-outage gap ──────────────────────────────
// The breaker watches build STATUS, and 'model-error' only fires when EVERY batch fails. The
// real outage was partial: 21 of 32 batches refused for quota while the build still reported
// 'built', so the breaker never tripped and the doomed paid calls repeated every ~30 minutes
// for weeks. These pin the rule that closes that gap.
describe('isProviderStarvedBuild', () => {
  it('trips when MOST batches were refused for quota', () => {
    expect(isProviderStarvedBuild({ providerDropped: 21, totalBatches: 32 })).toBe(true)
  })

  it('does not trip on a minority of quota drops - ordinary flakiness must not pause builds', () => {
    expect(isProviderStarvedBuild({ providerDropped: 2, totalBatches: 32 })).toBe(false)
    expect(isProviderStarvedBuild({ providerDropped: 16, totalBatches: 32 })).toBe(false) // exactly half
  })

  it('is inert when the run reported no batch accounting at all', () => {
    expect(isProviderStarvedBuild({})).toBe(false)
    expect(isProviderStarvedBuild({ providerDropped: 5 })).toBe(false)
    expect(isProviderStarvedBuild({ totalBatches: 32 })).toBe(false)
  })

  it('never trips on a zero-batch run (no division-by-zero surprise)', () => {
    expect(isProviderStarvedBuild({ providerDropped: 0, totalBatches: 0 })).toBe(false)
  })
})
