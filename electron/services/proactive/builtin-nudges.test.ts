import { describe, it, expect, beforeEach } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import type { ChannelRef } from '../channel-dispatch'
import type { HomeDigest } from '../brain/home-digest'
import type { CalibrationReport } from '../brain/types'
import type { DeliveryReceipt } from './delivery-queue'
import type { OperatorIdentity } from './approval-roundtrip'
import type { DigestMode } from './smart-digest'
import type { DeliverDigestResult } from './smart-digest'
import { setPendingInteractionsPath, resolveByReply, type PendingInteraction } from './pending-interactions'
import { __resetNudges, handleNudgeReply } from './nudges'
import {
  shouldFireForecastNudge,
  fireForecastNudge,
  readNudgeConfig,
  __resetForecastNudgeDebounce,
  DEFAULT_FORECAST_NUDGE_THRESHOLD,
  DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS,
  type NudgeConfig
} from './builtin-nudges'

const OP: OperatorIdentity = { channelId: 'telegram', userId: 'op-1' }
const TWOWAY: ChannelRef = { kind: 'telegram', target: 'op-1' }

function cfg(over: Partial<NudgeConfig> = {}): NudgeConfig {
  return { enabled: true, operator: OP, homeChannel: TWOWAY, threshold: 3, ...over }
}

function digestFixture(): HomeDigest {
  return { tracks: [], insights: [], needs: [], away: null, returnReason: 'x', generatedAt: '2026-07-14T00:00:00Z' }
}
function calFixture(): CalibrationReport {
  return { buckets: [], totals: { logged: 0, resolved: 0, hit_rate: null }, recent: [] }
}

beforeEach(() => {
  setPendingInteractionsPath(mkdtempSync(join(tmpdir(), 'bnudge-')))
  __resetNudges()
  __resetForecastNudgeDebounce()
})

// ──────────────────── pure gate ────────────────────

describe('shouldFireForecastNudge', () => {
  it('fires only when enabled + operator + two-way channel + threshold met', () => {
    expect(shouldFireForecastNudge({ enabled: true, dueCount: 3, threshold: 3, operator: OP, homeChannelKind: 'telegram' })).toBe(true)
  })
  it('does not fire when disabled', () => {
    expect(shouldFireForecastNudge({ enabled: false, dueCount: 5, threshold: 3, operator: OP, homeChannelKind: 'telegram' })).toBe(false)
  })
  it('does not fire below threshold', () => {
    expect(shouldFireForecastNudge({ enabled: true, dueCount: 2, threshold: 3, operator: OP, homeChannelKind: 'telegram' })).toBe(false)
  })
  it('does not fire without an operator', () => {
    expect(shouldFireForecastNudge({ enabled: true, dueCount: 5, threshold: 3, operator: null, homeChannelKind: 'telegram' })).toBe(false)
    expect(shouldFireForecastNudge({ enabled: true, dueCount: 5, threshold: 3, operator: { channelId: '', userId: '' }, homeChannelKind: 'telegram' })).toBe(false)
  })
  it('does not fire on a one-way push channel (operator cannot reply)', () => {
    expect(shouldFireForecastNudge({ enabled: true, dueCount: 5, threshold: 3, operator: OP, homeChannelKind: 'push' })).toBe(false)
  })
})

// ──────────────────── config reader ────────────────────

describe('readNudgeConfig', () => {
  it('is disabled by default (no env opt-in)', () => {
    const c = readNudgeConfig({} as NodeJS.ProcessEnv)
    expect(c.enabled).toBe(false)
    expect(c.threshold).toBe(DEFAULT_FORECAST_NUDGE_THRESHOLD)
  })
  it('honors the DUIN_PROACTIVE_NUDGES opt-in and threshold override', () => {
    const c = readNudgeConfig({ DUIN_PROACTIVE_NUDGES: '1', DUIN_FORECAST_NUDGE_THRESHOLD: '5' } as unknown as NodeJS.ProcessEnv)
    expect(c.enabled).toBe(true)
    expect(c.threshold).toBe(5)
  })
})

// ──────────────────── fireForecastNudge ────────────────────

describe('fireForecastNudge', () => {
  it('skips when the gate fails', async () => {
    const res = await fireForecastNudge(1, {
      config: cfg(),
      getDigest: digestFixture,
      getCalibration: calFixture
    })
    expect(res.nudged).toBe(false)
    expect(res.skipped).toBe('gate')
  })

  it('sends the nudge and a Y reply delivers the morning digest', async () => {
    const enqCalls: { text: string; meta: Record<string, unknown> }[] = []
    const enq = async (_ref: ChannelRef, text: string, meta: Record<string, unknown>): Promise<DeliveryReceipt> => {
      enqCalls.push({ text, meta })
      return { id: `d${enqCalls.length}`, ok: true, status: 'delivered' }
    }
    // Real sendNudge (so the interaction is created), but inject the enqueue seam via
    // a wrapper sendNudge that forwards our enqueue.
    const { sendNudge } = await import('./nudges')
    const sendWithEnq: typeof sendNudge = (input, deps) => sendNudge(input, { ...deps, enqueue: enq })

    let deliverCalls = 0
    const fakeDeliver = async (mode: DigestMode): Promise<DeliverDigestResult> => {
      deliverCalls++
      expect(mode).toBe('morning')
      return { delivered: true, text: 'brief' }
    }

    const res = await fireForecastNudge(4, {
      config: cfg(),
      getDigest: digestFixture,
      getCalibration: calFixture,
      sendNudge: sendWithEnq,
      deliverDigest: fakeDeliver
    })
    expect(res.nudged).toBe(true)
    // The question went out
    expect(enqCalls[0].text).toContain('4 forecasts due')
    expect(enqCalls[0].meta).toMatchObject({ nudgeType: 'forecast-due' })

    // Operator replies Y → runtime resolves the nudge, follow-up delivers the digest.
    const resolved = resolveByReply('telegram', 'op-1', 'Y') as PendingInteraction
    expect(resolved.id).toBe(res.interactionId)
    const ack = await handleNudgeReply(resolved, 'Y')
    expect(deliverCalls).toBe(1)
    expect(ack).toBe('Sending your brief now.')
  })

  it('a N reply does NOT deliver the digest', async () => {
    const enq = async (): Promise<DeliveryReceipt> => ({ id: 'd1', ok: true, status: 'delivered' })
    const { sendNudge } = await import('./nudges')
    const sendWithEnq: typeof sendNudge = (input, deps) => sendNudge(input, { ...deps, enqueue: enq })
    let deliverCalls = 0
    const res = await fireForecastNudge(4, {
      config: cfg(),
      getDigest: digestFixture,
      getCalibration: calFixture,
      sendNudge: sendWithEnq,
      deliverDigest: async () => { deliverCalls++; return { delivered: true } }
    })
    const resolved = resolveByReply('telegram', 'op-1', 'no') as PendingInteraction
    const ack = await handleNudgeReply(resolved, 'no')
    expect(deliverCalls).toBe(0)
    expect(ack).toContain('keep them queued')
    void res
  })
})

// ──────────────────── coalescing (regression: proactive-spam guard) ────────────────────

describe('fireForecastNudge — coalescing (no per-tick spam)', () => {
  it('readNudgeConfig exposes the debounce default and honors the env override', () => {
    expect(readNudgeConfig({} as NodeJS.ProcessEnv).debounceMs).toBe(DEFAULT_FORECAST_NUDGE_DEBOUNCE_MS)
    expect(readNudgeConfig({ DUIN_FORECAST_NUDGE_DEBOUNCE_MS: '90000' } as unknown as NodeJS.ProcessEnv).debounceMs).toBe(90000)
  })

  it('re-nudges are suppressed within the window, then allowed once it elapses', async () => {
    let sends = 0
    const enq = async (): Promise<DeliveryReceipt> => ({ id: `d${++sends}`, ok: true, status: 'delivered' })
    const { sendNudge } = await import('./nudges')
    const sendWithEnq: typeof sendNudge = (input, deps) => sendNudge(input, { ...deps, enqueue: enq })
    const base = {
      config: cfg({ debounceMs: 60_000 }),
      getDigest: digestFixture,
      getCalibration: calFixture,
      sendNudge: sendWithEnq
    }

    // Tick 1 (t=0): fires.
    const first = await fireForecastNudge(4, { ...base, now: 0 })
    expect(first.nudged).toBe(true)
    expect(sends).toBe(1)

    // Tick 2 (t=15min-equivalent, but here t=30s < 60s window): coalesced, NO send.
    const second = await fireForecastNudge(4, { ...base, now: 30_000 })
    expect(second.nudged).toBe(false)
    expect(second.skipped).toBe('debounced')
    expect(second.interactionId).toBeUndefined()
    expect(sends).toBe(1) // still only the first nudge went out — no per-tick spam

    // Once the window elapses (t=61s): a fresh nudge is allowed again.
    const third = await fireForecastNudge(4, { ...base, now: 61_000 })
    expect(third.nudged).toBe(true)
    expect(sends).toBe(2)
  })

  it('a different operator is NOT coalesced by another operator\'s recent nudge', async () => {
    let sends = 0
    const enq = async (): Promise<DeliveryReceipt> => ({ id: `d${++sends}`, ok: true, status: 'delivered' })
    const { sendNudge } = await import('./nudges')
    const sendWithEnq: typeof sendNudge = (input, deps) => sendNudge(input, { ...deps, enqueue: enq })

    const opA: OperatorIdentity = { channelId: 'telegram', userId: 'op-A' }
    const opB: OperatorIdentity = { channelId: 'telegram', userId: 'op-B' }
    await fireForecastNudge(4, { config: cfg({ operator: opA, debounceMs: 60_000 }), getDigest: digestFixture, getCalibration: calFixture, sendNudge: sendWithEnq, now: 0 })
    const b = await fireForecastNudge(4, { config: cfg({ operator: opB, debounceMs: 60_000 }), getDigest: digestFixture, getCalibration: calFixture, sendNudge: sendWithEnq, now: 1_000 })
    expect(b.nudged).toBe(true)
    expect(sends).toBe(2) // both operators nudged; the window is per-operator
  })
})
