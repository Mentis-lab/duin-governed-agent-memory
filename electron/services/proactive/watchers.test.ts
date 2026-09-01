import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChannelRef } from '../channel-dispatch'
import type { DeliveryReceipt } from './delivery-queue'
import {
  DEFAULT_WATCHERS_CONFIG,
  parseWatchersConfig,
  inQuietHours,
  evaluateCalibrationDrift,
  isHighPriority,
  formatForecastNotice,
  formatDriftNotice,
  formatTaskNotice,
  formatJobFailNotice,
  watchForecastResolved,
  watchCalibrationDrift,
  watchHighPriorityTask,
  watchJobFailed,
  watchForecastOwed,
  watchConfidentMiss,
  formatForecastOwedNotice,
  formatConfidentMissNotice,
  readConsolidatedIds,
  writeConsolidatedIds,
  __resetWatchers,
  type WatchersConfig,
  type WatchDeps,
  type ConfidentMissDeps,
  type OwedForecast,
  type ConfidentMiss
} from './watchers'

import { __setDispatcher, listDeliveries } from './delivery-queue'

const REF: ChannelRef = { kind: 'telegram', target: 'chat-1' }

/** A fully-enabled config with a fixed 5-min debounce and no quiet hours. */
function onConfig(over: Partial<WatchersConfig> = {}): WatchersConfig {
  return {
    forecast: true,
    calibration: true,
    task: true,
    jobFail: true,
    forecastOwed: true,
    confidentMiss: true,
    driftThreshold: 0.25,
    debounceMs: 300000,
    quietHours: { start: 0, end: 0 },
    ...over
  }
}

/** A spy enqueue that records calls and returns a delivered receipt. */
function spyEnqueue() {
  const calls: { ref: ChannelRef; text: string; meta: Record<string, unknown> }[] = []
  const fn = vi.fn(
    async (ref: ChannelRef, text: string, meta: Record<string, unknown>): Promise<DeliveryReceipt> => {
      calls.push({ ref, text, meta })
      return { id: `d${calls.length}`, ok: true, status: 'delivered' }
    }
  )
  return { calls, fn }
}

function deps(config: WatchersConfig, enq: WatchDeps['enqueue'], now = 1_000_000): WatchDeps {
  return { config, ref: REF, enqueue: enq, now }
}

beforeEach(() => __resetWatchers())

describe('parseWatchersConfig — tolerant defaults', () => {
  it('empty/garbage → all-OFF canonical defaults', () => {
    expect(parseWatchersConfig(undefined)).toEqual(DEFAULT_WATCHERS_CONFIG)
    expect(parseWatchersConfig(null)).toEqual(DEFAULT_WATCHERS_CONFIG)
    expect(parseWatchersConfig(42)).toEqual(DEFAULT_WATCHERS_CONFIG)
  })
  it('coerces partial + bad-typed fields, keeping valid ones', () => {
    const c = parseWatchersConfig({ forecast: true, debounceMs: 'nope', driftThreshold: 0.4, quietHours: { start: 30, end: -1 } })
    expect(c.forecast).toBe(true)
    expect(c.calibration).toBe(false)
    expect(c.debounceMs).toBe(DEFAULT_WATCHERS_CONFIG.debounceMs) // bad type → default
    expect(c.driftThreshold).toBe(0.4)
    expect(c.quietHours).toEqual({ start: 6, end: 23 }) // 30%24=6, -1→23
  })
  it('rejects a non-positive debounce', () => {
    expect(parseWatchersConfig({ debounceMs: 0 }).debounceMs).toBe(DEFAULT_WATCHERS_CONFIG.debounceMs)
    expect(parseWatchersConfig({ debounceMs: -5 }).debounceMs).toBe(DEFAULT_WATCHERS_CONFIG.debounceMs)
  })
})

describe('inQuietHours (pure)', () => {
  const at = (h: number) => new Date(2026, 0, 1, h, 30, 0).getTime()
  it('start===end disables the window', () => {
    expect(inQuietHours(at(3), { start: 0, end: 0 })).toBe(false)
    expect(inQuietHours(at(3), { start: 9, end: 9 })).toBe(false)
  })
  it('same-day window', () => {
    expect(inQuietHours(at(10), { start: 9, end: 17 })).toBe(true)
    expect(inQuietHours(at(8), { start: 9, end: 17 })).toBe(false)
    expect(inQuietHours(at(17), { start: 9, end: 17 })).toBe(false) // end exclusive
  })
  it('window wrapping midnight', () => {
    const q = { start: 22, end: 7 }
    expect(inQuietHours(at(23), q)).toBe(true)
    expect(inQuietHours(at(3), q)).toBe(true)
    expect(inQuietHours(at(12), q)).toBe(false)
  })
})

describe('evaluateCalibrationDrift (pure)', () => {
  it('flags the worst ungated tier past threshold', () => {
    const confCal = {
      high: { useful_rate: 0.5, observed: 40, gated: false }, // drift |0.5-0.925|=0.425
      med: { useful_rate: 0.7, observed: 40, gated: false }, // drift |0.7-0.675|=0.025
      low: { useful_rate: 0.25, observed: 40, gated: false }
    }
    const f = evaluateCalibrationDrift(confCal, 0.25)
    expect(f).not.toBeNull()
    expect(f!.tier).toBe('high')
    expect(f!.drift).toBeCloseTo(0.425, 3)
    expect(f!.n).toBe(40)
  })
  it('ignores gated tiers (too few samples) and untagged rows', () => {
    const confCal = {
      high: { useful_rate: 0.1, observed: 3, gated: true }, // huge drift but gated
      untagged: { useful_rate: 0.0, observed: 99, gated: false } // no stated confidence
    }
    expect(evaluateCalibrationDrift(confCal, 0.2)).toBeNull()
  })
  it('null when nothing exceeds threshold, and on empty input', () => {
    const confCal = { high: { useful_rate: 0.9, observed: 30, gated: false } } // drift 0.025
    expect(evaluateCalibrationDrift(confCal, 0.25)).toBeNull()
    expect(evaluateCalibrationDrift({}, 0.25)).toBeNull()
    expect(evaluateCalibrationDrift(null, 0.25)).toBeNull()
  })
  it('treats gated:1 (numeric) as gated', () => {
    const confCal = { low: { useful_rate: 1.0, observed: 5, gated: 1 } }
    expect(evaluateCalibrationDrift(confCal, 0.2)).toBeNull()
  })
})

describe('isHighPriority (pure)', () => {
  it('recognizes P0/high/urgent words + markers', () => {
    for (const v of ['P0', 'p1', 'High', 'HIGHEST', 'urgent', 'critical', 'important', '🔴', '⏫'])
      expect(isHighPriority(v)).toBe(true)
  })
  it('rejects low/none/garbage', () => {
    for (const v of ['low', 'medium', 'p3', '', '  ', 'someday', 5 as unknown])
      expect(isHighPriority(v)).toBe(false)
  })
})

describe('formatters (pure)', () => {
  it('forecast singular vs plural + sample bullets', () => {
    expect(formatForecastNotice(1)).toContain('A forecast just resolved')
    const many = formatForecastNotice(3, ['a', 'b', 'c', 'd'])
    expect(many).toContain('3 forecasts just resolved')
    expect(many).toContain('• a')
    expect(many).not.toContain('• d') // capped at 3
  })
  it('drift shows both rates', () => {
    const t = formatDriftNotice({ tier: 'high', observed: 0.5, expected: 0.925, drift: 0.425, n: 40 })
    expect(t).toContain('high-confidence')
    expect(t).toContain('50%')
    expect(t).toContain('93%')
  })
  it('task + job-fail fall back to ids when label/title blank', () => {
    expect(formatTaskNotice({ taskId: 'T7', priority: 'P0' })).toContain('T7')
    expect(formatJobFailNotice({ automationId: 'A9', error: '' })).toContain('A9')
    expect(formatJobFailNotice({ automationId: 'A9', error: '' })).toContain('unknown error')
  })
})

describe('watch* entry points — fire / silent-when-off', () => {
  it('forecast fires the notice when enabled + resolved>0', async () => {
    const { calls, fn } = spyEnqueue()
    const r = await watchForecastResolved({ resolved: 2 }, deps(onConfig(), fn))
    expect(r.emitted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('2 forecasts just resolved')
    expect(calls[0].ref).toEqual(REF)
    expect(calls[0].meta).toMatchObject({ source: 'watch', kind: 'forecast' })
  })
  it('forecast SILENT when flagged off', async () => {
    const { fn } = spyEnqueue()
    const r = await watchForecastResolved({ resolved: 5 }, deps(onConfig({ forecast: false }), fn))
    expect(r.emitted).toBe(false)
    expect(r.skipped).toBe('disabled')
    expect(fn).not.toHaveBeenCalled()
  })
  it('forecast silent when resolved===0 (nothing to say)', async () => {
    const { fn } = spyEnqueue()
    const r = await watchForecastResolved({ resolved: 0 }, deps(onConfig(), fn))
    expect(r.emitted).toBe(false)
    expect(r.skipped).toBe('nothing')
    expect(fn).not.toHaveBeenCalled()
  })

  it('calibration drift fires on a drifting ungated tier', async () => {
    const { calls, fn } = spyEnqueue()
    const confCal = { high: { useful_rate: 0.5, observed: 40, gated: false } }
    const r = await watchCalibrationDrift(confCal, deps(onConfig(), fn))
    expect(r.emitted).toBe(true)
    expect(calls[0].text).toContain('Calibration drift')
  })
  it('calibration drift SILENT when off, and when no tier drifts', async () => {
    const { fn } = spyEnqueue()
    const drift = { high: { useful_rate: 0.5, observed: 40, gated: false } }
    expect((await watchCalibrationDrift(drift, deps(onConfig({ calibration: false }), fn))).skipped).toBe('disabled')
    const noDrift = { high: { useful_rate: 0.9, observed: 40, gated: false } }
    expect((await watchCalibrationDrift(noDrift, deps(onConfig(), fn))).skipped).toBe('nothing')
    expect(fn).not.toHaveBeenCalled()
  })

  it('task fires only for high priority', async () => {
    const { calls, fn } = spyEnqueue()
    const hi = await watchHighPriorityTask({ taskId: 'T1', title: 'Ship it', priority: 'P0' }, deps(onConfig(), fn))
    expect(hi.emitted).toBe(true)
    expect(calls[0].text).toContain('Ship it')
    const lo = await watchHighPriorityTask({ taskId: 'T2', title: 'Later', priority: 'low' }, deps(onConfig(), fn))
    expect(lo.emitted).toBe(false)
    expect(lo.skipped).toBe('nothing')
    expect(calls).toHaveLength(1)
  })
  it('task SILENT when flagged off', async () => {
    const { fn } = spyEnqueue()
    const r = await watchHighPriorityTask({ taskId: 'T3', priority: 'P0' }, deps(onConfig({ task: false }), fn))
    expect(r.skipped).toBe('disabled')
    expect(fn).not.toHaveBeenCalled()
  })

  it('job-fail fires and carries the error', async () => {
    const { calls, fn } = spyEnqueue()
    const r = await watchJobFailed({ automationId: 'A1', label: 'Nightly sync', error: 'boom' }, deps(onConfig(), fn))
    expect(r.emitted).toBe(true)
    expect(calls[0].text).toContain('Nightly sync')
    expect(calls[0].text).toContain('boom')
    expect(calls[0].meta).toMatchObject({ kind: 'jobFail' })
  })
  it('job-fail SILENT when flagged off', async () => {
    const { fn } = spyEnqueue()
    const r = await watchJobFailed({ automationId: 'A2', error: 'boom' }, deps(onConfig({ jobFail: false }), fn))
    expect(r.skipped).toBe('disabled')
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('debounce / coalesce', () => {
  it('coalesces a burst of the same kind within the window', async () => {
    const { calls, fn } = spyEnqueue()
    const cfg = onConfig({ debounceMs: 10_000 })
    const r1 = await watchForecastResolved({ resolved: 1 }, deps(cfg, fn, 1000))
    const r2 = await watchForecastResolved({ resolved: 1 }, deps(cfg, fn, 5000)) // within window
    expect(r1.emitted).toBe(true)
    expect(r2.emitted).toBe(false)
    expect(r2.skipped).toBe('debounced')
    expect(calls).toHaveLength(1)
    // Past the window → fires again.
    const r3 = await watchForecastResolved({ resolved: 1 }, deps(cfg, fn, 12_000))
    expect(r3.emitted).toBe(true)
    expect(calls).toHaveLength(2)
  })
  it('dedup is per-task-id: two different high-priority tasks both fire', async () => {
    const { calls, fn } = spyEnqueue()
    const cfg = onConfig({ debounceMs: 10_000 })
    await watchHighPriorityTask({ taskId: 'T1', priority: 'P0' }, deps(cfg, fn, 1000))
    await watchHighPriorityTask({ taskId: 'T2', priority: 'P0' }, deps(cfg, fn, 1500))
    await watchHighPriorityTask({ taskId: 'T1', priority: 'P0' }, deps(cfg, fn, 2000)) // repeat T1 → coalesced
    expect(calls).toHaveLength(2)
  })
  it('drift dedup is per-tier', async () => {
    const { calls, fn } = spyEnqueue()
    const cfg = onConfig({ debounceMs: 10_000 })
    const high = { high: { useful_rate: 0.5, observed: 40, gated: false } }
    await watchCalibrationDrift(high, deps(cfg, fn, 1000))
    await watchCalibrationDrift(high, deps(cfg, fn, 2000)) // same tier → coalesced
    expect(calls).toHaveLength(1)
  })
})

describe('quiet hours suppression', () => {
  it('suppresses inside the window, emits outside', async () => {
    const { fn } = spyEnqueue()
    const cfg = onConfig({ quietHours: { start: 22, end: 7 } })
    const night = new Date(2026, 0, 1, 23, 0, 0).getTime()
    const day = new Date(2026, 0, 1, 12, 0, 0).getTime()
    const q = await watchJobFailed({ automationId: 'A1', error: 'x' }, deps(cfg, fn, night))
    expect(q.skipped).toBe('quiet')
    __resetWatchers()
    const d = await watchJobFailed({ automationId: 'A1', error: 'x' }, deps(cfg, fn, day))
    expect(d.emitted).toBe(true)
  })
})

describe('forecast-owed watcher (e) — replaces forecast_adjudication_trigger.py', () => {
  const OWED: OwedForecast[] = [
    { id: 'f1', predicted: 'ship by Q3', confidence: 0.7, days_overdue: 5 },
    { id: 'f2', predicted: 'hire closes', confidence: 0.6, days_overdue: 2 }
  ]

  it('fires ONE nudge pointing at the verdict route when forecasts are owed', async () => {
    const { calls, fn } = spyEnqueue()
    const r = await watchForecastOwed({ owed: OWED, vaultDir: '/v' }, deps(onConfig(), fn))
    expect(r.emitted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('2 forecasts have passed their review date')
    expect(calls[0].text).toContain('POST /state/forecast-verdict')
    expect(calls[0].meta).toMatchObject({ source: 'watch', kind: 'forecastOwed' })
  })

  it('no-op when nothing is owed', async () => {
    const { fn } = spyEnqueue()
    const r = await watchForecastOwed({ owed: [], vaultDir: '/v' }, deps(onConfig(), fn))
    expect(r.emitted).toBe(false)
    expect(r.skipped).toBe('nothing')
    expect(fn).not.toHaveBeenCalled()
  })

  it('SILENT when flagged off', async () => {
    const { fn } = spyEnqueue()
    const r = await watchForecastOwed({ owed: OWED, vaultDir: '/v' }, deps(onConfig({ forecastOwed: false }), fn))
    expect(r.skipped).toBe('disabled')
    expect(fn).not.toHaveBeenCalled()
  })

  it('does NOT re-nudge an unchanged owed set on a later tick (past the time-window)', async () => {
    const { calls, fn } = spyEnqueue()
    const cfg = onConfig({ debounceMs: 1000 })
    await watchForecastOwed({ owed: OWED, vaultDir: '/v' }, deps(cfg, fn, 1000))
    // Well past the 1s time-debounce, but the owed SET is unchanged → still coalesced.
    const r2 = await watchForecastOwed({ owed: OWED, vaultDir: '/v' }, deps(cfg, fn, 500_000))
    expect(r2.emitted).toBe(false)
    expect(r2.skipped).toBe('debounced')
    expect(calls).toHaveLength(1)
  })

  it('re-fires when a NEW forecast joins the owed set (signature changed)', async () => {
    const { calls, fn } = spyEnqueue()
    const cfg = onConfig({ debounceMs: 1000 })
    await watchForecastOwed({ owed: OWED, vaultDir: '/v' }, deps(cfg, fn, 1000))
    const grown = [...OWED, { id: 'f3', predicted: 'new one', confidence: 0.8, days_overdue: 1 }]
    const r2 = await watchForecastOwed({ owed: grown, vaultDir: '/v' }, deps(cfg, fn, 500_000))
    expect(r2.emitted).toBe(true)
    expect(calls).toHaveLength(2)
  })
})

describe('confident-miss watcher (f) — replaces surprise_consolidation_trigger.py', () => {
  const MISSES: ConfidentMiss[] = [
    { id: 'm1', predicted: 'rates hold', confidence: 0.9 },
    { id: 'm2', predicted: 'deal lands', confidence: 0.65 }
  ]

  /** An in-memory consolidated-id store standing in for the vault state file. */
  function memStore() {
    let ids = new Set<string>()
    const d: Pick<ConfidentMissDeps, 'readConsolidated' | 'writeConsolidated'> = {
      readConsolidated: () => new Set(ids),
      writeConsolidated: (_v, next) => {
        ids = new Set(next)
      }
    }
    return { get: () => ids, deps: d }
  }

  it('fires ONE reflect-and-capture nudge (no corrections write) on fresh confident misses', async () => {
    const { calls, fn } = spyEnqueue()
    const store = memStore()
    const r = await watchConfidentMiss(
      { misses: MISSES, vaultDir: '/v' },
      { ...deps(onConfig(), fn), ...store.deps }
    )
    expect(r.emitted).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].text).toContain('confident forecasts were refuted')
    expect(calls[0].meta).toMatchObject({ kind: 'confidentMiss' })
    // Both ids recorded as consolidated (persisted only after the emit).
    expect([...store.get()].sort()).toEqual(['m1', 'm2'])
  })

  it('dedups per-id: a miss already consolidated does not nudge again', async () => {
    const { calls, fn } = spyEnqueue()
    const store = memStore()
    await watchConfidentMiss({ misses: MISSES, vaultDir: '/v' }, { ...deps(onConfig(), fn), ...store.deps })
    // Same misses next tick → all already consolidated → nothing fresh.
    const r2 = await watchConfidentMiss({ misses: MISSES, vaultDir: '/v' }, { ...deps(onConfig(), fn, 999_999), ...store.deps })
    expect(r2.emitted).toBe(false)
    expect(r2.skipped).toBe('nothing')
    expect(calls).toHaveLength(1)
  })

  it('re-fires only for a NEW miss, carrying just the fresh one', async () => {
    const { calls, fn } = spyEnqueue()
    const store = memStore()
    await watchConfidentMiss({ misses: MISSES, vaultDir: '/v' }, { ...deps(onConfig(), fn), ...store.deps })
    const grown = [...MISSES, { id: 'm3', predicted: 'launch slips', confidence: 0.8 }]
    const r2 = await watchConfidentMiss({ misses: grown, vaultDir: '/v' }, { ...deps(onConfig(), fn, 999_999), ...store.deps })
    expect(r2.emitted).toBe(true)
    expect(calls).toHaveLength(2)
    expect(calls[1].text).toContain('A confident forecast was refuted') // singular — only m3 was fresh
    expect([...store.get()].sort()).toEqual(['m1', 'm2', 'm3'])
  })

  it('no-op when there are no confident misses', async () => {
    const { fn } = spyEnqueue()
    const store = memStore()
    const r = await watchConfidentMiss({ misses: [], vaultDir: '/v' }, { ...deps(onConfig(), fn), ...store.deps })
    expect(r.emitted).toBe(false)
    expect(r.skipped).toBe('nothing')
    expect(fn).not.toHaveBeenCalled()
  })

  it('SILENT when flagged off, and does NOT persist consolidated ids', async () => {
    const { fn } = spyEnqueue()
    const store = memStore()
    const r = await watchConfidentMiss(
      { misses: MISSES, vaultDir: '/v' },
      { ...deps(onConfig({ confidentMiss: false }), fn), ...store.deps }
    )
    expect(r.skipped).toBe('disabled')
    expect(store.get().size).toBe(0) // no emit → nothing marked (retries when re-enabled)
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('consolidated-id store (persistent dedup file)', () => {
  let vault: string
  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'duin-watch-'))
  })
  afterEach(() => rmSync(vault, { recursive: true, force: true }))

  it('round-trips ids through .duin/_state/surprise-consolidated.json', () => {
    expect(readConsolidatedIds(vault)).toEqual(new Set()) // missing file → empty
    writeConsolidatedIds(vault, new Set(['b', 'a']))
    expect(readConsolidatedIds(vault)).toEqual(new Set(['a', 'b']))
  })

  it('a real-store confident-miss pass persists and then dedups across a fresh read', async () => {
    const { calls, fn } = spyEnqueue()
    const misses: ConfidentMiss[] = [{ id: 'z1', predicted: 'p', confidence: 0.9 }]
    const r1 = await watchConfidentMiss({ misses, vaultDir: vault }, deps(onConfig(), fn))
    expect(r1.emitted).toBe(true)
    expect(readConsolidatedIds(vault)).toEqual(new Set(['z1']))
    // A second pass reads the on-disk set → nothing fresh.
    const r2 = await watchConfidentMiss({ misses, vaultDir: vault }, deps(onConfig(), fn, 999_999))
    expect(r2.skipped).toBe('nothing')
    expect(calls).toHaveLength(1)
  })
})

describe('formatters (owed / confident-miss)', () => {
  it('owed notice: singular head + verdict route', () => {
    const t = formatForecastOwedNotice([{ id: 'f1', predicted: 'x', confidence: 0.7, days_overdue: 3 }])
    expect(t).toContain('A forecast has passed its review date')
    expect(t).toContain('POST /state/forecast-verdict')
    expect(t).toContain('3d overdue')
  })
  it('confident-miss notice: plural head + confidence shown', () => {
    const t = formatConfidentMissNotice([
      { id: 'm1', predicted: 'a', confidence: 0.9 },
      { id: 'm2', predicted: 'b', confidence: 0.6 }
    ])
    expect(t).toContain('2 confident forecasts were refuted')
    expect(t).toContain('0.90')
  })
})

describe('routes through the REAL delivery-queue (no injected enqueue)', () => {
  afterEach(() => __setDispatcher())
  it('a job-fail enqueues a delivered record via the queue', async () => {
    const seen: { ref: ChannelRef; text: string }[] = []
    __setDispatcher(async (ref, text) => {
      seen.push({ ref, text })
      return { ok: true }
    })
    // config enabled + ref injected, but NO enqueue override → real delivery-queue.
    const r = await watchJobFailed(
      { automationId: 'A42', label: 'Backup', error: 'disk full' },
      { config: onConfig(), ref: REF, now: 2_000_000 }
    )
    expect(r.emitted).toBe(true)
    expect(r.receipt?.status).toBe('delivered')
    // The queue really forwarded through channel-dispatch (our stub) to the home ref.
    expect(seen).toHaveLength(1)
    expect(seen[0].ref).toEqual(REF)
    expect(seen[0].text).toContain('Backup')
    // And the queue retained a delivered record.
    expect(listDeliveries('delivered').some((d) => d.meta.kind === 'jobFail')).toBe(true)
  })
})

describe('never throws', () => {
  it('an enqueue that rejects resolves to {emitted:false, error}', async () => {
    const bad: WatchDeps['enqueue'] = async () => {
      throw new Error('channel exploded')
    }
    const r = await watchJobFailed({ automationId: 'A1', error: 'x' }, deps(onConfig(), bad))
    expect(r.emitted).toBe(false)
    expect(r.skipped).toBe('error')
  })
})
