import { describe, it, expect } from 'vitest'
import {
  engineStateFrom,
  engineConnected,
  unwrapIpc,
  spendLine,
  spendCaveat,
  fmtTokens,
  fmtUsd,
  type EngineHealth,
  type EngineResolution,
  type CostLedgerView
} from './BrainStatusPanel'

// The Status hub's engine and spend rows (cohesion P0, lane C). "Connected" used to be
// graph-derived — a dead chat engine over a healthy graph rendered green (2026-09-02 L5 F2).
// The branch decisions are pure and pinned here; the JSX is untestable in this node-only env.

const RES: EngineResolution = { task: 'chat', modelId: 'deepseek-v4-flash', provider: 'deepseek', chain: ['deepseek-v4-flash'], source: 'policy' }
const OK: EngineHealth = { provider: 'deepseek', healthy: true, reason: 'ok', checkedAt: 1 }
const DEAD: EngineHealth = { provider: 'anthropic', healthy: false, reason: 'no-credit', detail: 'credit balance is too low', hint: 'Top up' }

describe('engineStateFrom — the header dot answers for the engine, not the graph', () => {
  it('without the router bridge the engine is unknown, never connected', () => {
    const s = engineStateFrom(false, RES, [OK])
    expect(s.phase).toBe('no-bridge')
    expect(engineConnected(s)).toBe(false)
  })

  it('an unasked resolution is loading; a null one is an honest "no engine" with the dead providers', () => {
    expect(engineStateFrom(true, undefined, null).phase).toBe('loading')
    const s = engineStateFrom(true, null, [OK, DEAD])
    expect(s).toEqual({ phase: 'no-engine', unhealthy: [DEAD] })
    expect(engineConnected(s)).toBe(false)
  })

  it('connected requires a resolution AND a healthy probe of its provider', () => {
    const good = engineStateFrom(true, RES, [OK, DEAD])
    expect(good).toMatchObject({ phase: 'ready', healthy: true, health: OK })
    expect(engineConnected(good)).toBe(true)

    const bad = engineStateFrom(true, { ...RES, provider: 'anthropic', modelId: 'claude-fable-5' }, [OK, DEAD])
    expect(bad).toMatchObject({ phase: 'ready', healthy: false, health: DEAD })
    expect(engineConnected(bad)).toBe(false)

    const unprobed = engineStateFrom(true, RES, [])
    expect(unprobed).toMatchObject({ phase: 'ready', healthy: null, health: null })
    expect(engineConnected(unprobed)).toBe(false)
  })
})

describe('unwrapIpc — the envelope never reads as data when it failed', () => {
  it('unwraps success, nulls failure, passes bare values', () => {
    expect(unwrapIpc<{ a: number }>({ success: true, data: { a: 1 } })).toEqual({ a: 1 })
    expect(unwrapIpc({ success: false, error: 'nope' })).toBeNull()
    expect(unwrapIpc({ success: true })).toBeNull()
    expect(unwrapIpc<number>(3)).toBe(3)
    expect(unwrapIpc(undefined)).toBeNull()
  })
})

describe('spend row formatting', () => {
  const view = (over: Partial<CostLedgerView['totals']> = {}, estimated = false): CostLedgerView => ({
    window: '24h',
    since: 0,
    estimated,
    totals: { calls: 57, costUsd: 0.0412, inputTokens: 12_340, outputTokens: 4_100, metered: 50, estimatedCalls: 0, redactedCalls: 0, ...over }
  })

  it('formats tokens and dollars at the precision the figure deserves', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(2_500_000)).toBe('2.5M')
    expect(fmtUsd(0)).toBe('$0.00')
    expect(fmtUsd(0.0012)).toBe('$0.0012')
    expect(fmtUsd(1.234)).toBe('$1.23')
  })

  it('writes one line and a caveat only when the ledger says estimated', () => {
    expect(spendLine(view())).toBe('$0.04 · 57 calls · 12.3k in / 4.1k out')
    expect(spendLine(view({ calls: 1 }))).toContain('1 call ·')
    expect(spendCaveat(view())).toBeNull()
    expect(spendCaveat(view({ redactedCalls: 3, estimatedCalls: 2 }, true))).toBe(
      'estimated — 3 calls with redacted counters (before the fix); 2 priced at the fallback rate'
    )
    expect(spendCaveat(view({}, true))).toBe('estimated')
  })
})
