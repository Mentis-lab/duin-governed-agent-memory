import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
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
  watchModelFailure,
  normalizeModelFailurePayload,
  normalizeLedgerRepeatPayload,
  installModelFailureWatcher,
  routeSpineEventToWatchers,
  formatModelFailureTitle,
  formatModelFailureBody,
  FAILURE_NOTICE_DEDUP_MS,
  type ModelFailureInput,
  type WatchersConfig,
  type WatchDeps,
  type ConfidentMissDeps,
  type OwedForecast,
  type ConfidentMiss
} from './watchers'

import { __setDispatcher, listDeliveries } from './delivery-queue'
import { listNotices, __resetNotices } from './notices-store'
import { __forceMemoryFallback, __resetEventLog, recordEvent, type EventRecord } from '../event-log'

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

// ──────────────────── (g) model failure → notice (cohesion P0, lane C) ────────────────────

const FAIL: ModelFailureInput = {
  role: 'extraction',
  provider: 'deepseek',
  modelId: 'deepseek-v4-flash',
  reason: 'no-credit',
  detail: '402 Insufficient Balance',
  recovered: false
}
const providerLabel = (id: string): string => (id === 'deepseek' ? 'DeepSeek' : id)

describe('watchModelFailure — a classified failure becomes a Needs-you notice', () => {
  beforeEach(() => __resetNotices())

  it('a hard failure notifies at once, naming role, provider, reason and the fix', async () => {
    const { calls, fn } = spyEnqueue()
    const r = await watchModelFailure(FAIL, { ...deps(onConfig(), fn), providerLabel })
    expect(r.emitted).toBe(true)
    expect(r.text).toBe('Extraction failed on DeepSeek: no credit')
    const n = listNotices()[0]
    expect(n.title).toBe('Extraction failed on DeepSeek: no credit')
    expect(n.body).toContain('402 Insufficient Balance')
    expect(n.body).toContain('deepseek-v4-flash did not answer and nothing took over.')
    expect(n.body).toContain('DeepSeek has no credit')
    expect(n.deepLink).toBe('duin://settings/models')
    expect(n.severity).toBe('warning')
    expect(n.dedupKey).toBe('failure:extraction|deepseek|no-credit')
    expect(calls[0].meta).toMatchObject({ source: 'watch', kind: 'failure' })
  })

  it('a recovered background failure notifies only on the third inside an hour', async () => {
    const { fn } = spyEnqueue()
    const recovered: ModelFailureInput = { ...FAIL, recovered: true, nextModelId: 'qwen3.8-flash' }
    const d = { ...deps(onConfig(), fn, 1_000_000), providerLabel }
    expect((await watchModelFailure(recovered, d)).skipped).toBe('nothing')
    expect((await watchModelFailure(recovered, { ...d, now: 1_000_000 + 60_000 })).skipped).toBe('nothing')
    expect(listNotices()).toHaveLength(0)
    const third = await watchModelFailure(recovered, { ...d, now: 1_000_000 + 120_000 })
    expect(third.emitted).toBe(true)
    expect(listNotices()[0].body).toContain('3 failures of this kind in the last hour')
    expect(listNotices()[0].body).toContain('fell back to qwen3.8-flash')
  })

  it('failures older than an hour do not count toward the streak', async () => {
    const { fn } = spyEnqueue()
    const recovered: ModelFailureInput = { ...FAIL, recovered: true }
    const d = { ...deps(onConfig(), fn, 1_000_000), providerLabel }
    await watchModelFailure(recovered, d)
    await watchModelFailure(recovered, { ...d, now: 1_000_000 + 1_000 })
    const late = await watchModelFailure(recovered, { ...d, now: 1_000_000 + 61 * 60_000 })
    expect(late.skipped).toBe('nothing')
    expect(listNotices()).toHaveLength(0)
  })

  it('a recovered CHAT failure is never a notice; a hard chat failure is', async () => {
    const { fn } = spyEnqueue()
    const d = { ...deps(onConfig(), fn), providerLabel }
    const chat: ModelFailureInput = { ...FAIL, role: 'chat', recovered: true }
    for (let i = 0; i < 5; i++) expect((await watchModelFailure(chat, { ...d, now: 1_000_000 + i })).skipped).toBe('nothing')
    const hard = await watchModelFailure({ ...chat, recovered: false }, d)
    expect(hard.emitted).toBe(true)
    expect(hard.text).toBe('Chat failed on DeepSeek: no credit')
  })

  it('the same (role, provider, reason) notifies once per 24 h, then again', async () => {
    const { fn } = spyEnqueue()
    const d = { ...deps(onConfig(), fn, 1_000_000), providerLabel }
    expect((await watchModelFailure(FAIL, d)).emitted).toBe(true)
    expect((await watchModelFailure(FAIL, { ...d, now: 1_000_000 + 60 * 60_000 })).skipped).toBe('debounced')
    // A DIFFERENT reason on the same provider is a different fact and is not deduped.
    expect((await watchModelFailure({ ...FAIL, reason: 'network' }, { ...d, now: 1_000_000 + 1 })).emitted).toBe(true)
    expect((await watchModelFailure(FAIL, { ...d, now: 1_000_000 + FAILURE_NOTICE_DEDUP_MS + 1 })).emitted).toBe(true)
  })

  it('quiet hours file the notice without interrupting, and it counts as surfaced', async () => {
    const { calls, fn } = spyEnqueue()
    const now = 1_000_000
    const hour = new Date(now).getHours()
    const cfg = onConfig({ quietHours: { start: hour, end: (hour + 1) % 24 } })
    const r = await watchModelFailure(FAIL, { ...deps(cfg, fn, now), providerLabel })
    expect(r.skipped).toBe('quiet')
    expect(calls).toHaveLength(0)
    expect(listNotices()).toHaveLength(1)
    expect((await watchModelFailure(FAIL, { ...deps(onConfig(), fn, now + 60_000), providerLabel })).skipped).toBe('debounced')
  })

  it('honours watchers.jobFail = false', async () => {
    const { fn } = spyEnqueue()
    const r = await watchModelFailure(FAIL, { ...deps(onConfig({ jobFail: false }), fn), providerLabel })
    expect(r.skipped).toBe('disabled')
    expect(listNotices()).toHaveLength(0)
  })

  it('an unknown provider (construction fingerprint) reads "keeps failing" and carries no key hint', () => {
    const input: ModelFailureInput = { role: 'extraction', provider: 'unknown', reason: 'no-credit', recovered: false }
    expect(formatModelFailureTitle(input, 'the model provider')).toBe('Extraction keeps failing: no credit')
    expect(formatModelFailureBody(input, 'the model provider', 1)).toBe('')
  })

  it('never throws on garbage input', async () => {
    const r = await watchModelFailure({} as never, { ...deps(onConfig(), spyEnqueue().fn), providerLabel })
    expect(typeof r.emitted).toBe('boolean')
  })
})

describe('normalizeModelFailurePayload — contract and legacy payloads', () => {
  it('reads a roles.ts ModelFailurePayload verbatim', () => {
    const n = normalizeModelFailurePayload({
      role: 'jury',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      reason: 'model-access',
      detail: '403 does not have access',
      recovered: true,
      nextModelId: 'kimi-k2.6'
    })
    expect(n).toEqual({
      role: 'jury',
      provider: 'anthropic',
      modelId: 'claude-haiku-4-5',
      reason: 'model-access',
      detail: '403 does not have access',
      recovered: true,
      nextModelId: 'kimi-k2.6',
      legacy: false
    })
  })

  it('maps a legacy background payload: job label + purpose other + 402 → extraction / no-credit / hard fail', () => {
    const n = normalizeModelFailurePayload({
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      role: 'operator-learning',
      purpose: 'other',
      httpStatus: 402,
      errorPreview: '402 Insufficient Balance'
    })
    expect(n).toMatchObject({ role: 'extraction', provider: 'deepseek', modelId: 'deepseek-v4-flash', reason: 'no-credit', recovered: false, legacy: true })
    expect(n.detail).toBe('402 Insufficient Balance')
  })

  it('maps legacy jury / title / main-turn payloads to their roles', () => {
    expect(normalizeModelFailurePayload({ role: 'operator-govern-jury', purpose: 'other' }).role).toBe('jury')
    expect(normalizeModelFailurePayload({ purpose: 'title' }).role).toBe('title')
    expect(normalizeModelFailurePayload({ purpose: 'main' }).role).toBe('chat')
    expect(normalizeModelFailurePayload(undefined)).toMatchObject({ role: 'chat', provider: 'unknown', reason: 'unknown', recovered: false })
  })

  it('maps failure_ledger.repeated construct fingerprints and ignores the rest', () => {
    const n = normalizeLedgerRepeatPayload({ fingerprint: 'construct:extraction:quota', kind: 'runtime_failed', count: 4 })
    expect(n).toMatchObject({ role: 'extraction', provider: 'unknown', reason: 'no-credit', recovered: false, legacy: true })
    expect(n?.detail).toContain('4 times')
    expect(normalizeLedgerRepeatPayload({ fingerprint: 'proof:abc', count: 2 })).toBeNull()
    expect(normalizeLedgerRepeatPayload(undefined)).toBeNull()
  })
})

describe('installModelFailureWatcher — the spine feeds the watcher', () => {
  beforeEach(() => {
    __resetEventLog()
    __forceMemoryFallback()
    __resetNotices()
  })

  it('a model.request.failed recorded on the spine is a notice in the same tick', async () => {
    const { fn } = spyEnqueue()
    installModelFailureWatcher({ ...deps(onConfig(), fn), providerLabel })
    recordEvent({
      type: 'model.request.failed',
      actorKind: 'model',
      payload: { role: 'jury', provider: 'anthropic', modelId: 'claude-haiku-4-5', reason: 'no-credit', recovered: false }
    })
    expect(listNotices()).toHaveLength(1)
    expect(listNotices()[0].title).toBe('Jury failed on anthropic: no credit')
    await new Promise((r) => setTimeout(r, 0))
  })

  it('installing twice keeps one subscription; reset detaches it', () => {
    const { fn } = spyEnqueue()
    const off1 = installModelFailureWatcher({ ...deps(onConfig(), fn), providerLabel })
    const off2 = installModelFailureWatcher({ ...deps(onConfig(), fn), providerLabel })
    expect(off1).toBe(off2)
    __resetWatchers()
    recordEvent({ type: 'model.request.failed', actorKind: 'model', payload: { role: 'jury', provider: 'x', reason: 'network', recovered: false } })
    expect(listNotices()).toHaveLength(0)
  })

  it('routeSpineEventToWatchers ignores unrelated events', () => {
    const ev: EventRecord = {
      id: 'e1',
      type: 'chat.error',
      createdAt: 1,
      severity: 'error',
      actorKind: 'system',
      payload: {},
      redaction: 'metadata'
    }
    expect(routeSpineEventToWatchers(ev, {})).toBeNull()
  })
})

// ── Boot wiring (P0 audit C1, 2026-09-03) ──
// The subscription used to be a module-load side effect at the bottom of watchers.ts, so whether
// the watcher was live depended on which module imported the file first. It is now an explicit
// call in electron/main.ts. These lock that: the call exists, it precedes startLocalBrain (the
// first place a model call can fail), and watchers.ts no longer installs itself.
describe('installModelFailureWatcher — installed by an explicit boot call, not at module load', () => {
  const mainSrc = readFileSync(join(__dirname, '..', '..', 'main.ts'), 'utf-8')
  const selfSrc = readFileSync(join(__dirname, 'watchers.ts'), 'utf-8')

  it('electron/main.ts imports and calls installModelFailureWatcher() before startLocalBrain()', () => {
    expect(mainSrc).toMatch(/import \{ installModelFailureWatcher \} from '\.\/services\/proactive\/watchers'/)
    const call = mainSrc.search(/^\s*installModelFailureWatcher\(\)/m)
    const brain = mainSrc.indexOf('startLocalBrain().catch')
    expect(call).toBeGreaterThan(-1)
    expect(brain).toBeGreaterThan(-1)
    expect(call).toBeLessThan(brain)
  })

  it('watchers.ts has no module-load self-install', () => {
    expect(selfSrc).not.toMatch(/^\s*installModelFailureWatcher\(/m)
  })
})
