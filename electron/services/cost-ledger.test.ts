import { describe, it, expect } from 'vitest'
import type { EventRecord, EventFilter } from './event-log'
import {
  BACKGROUND_ROLES,
  COST_WINDOW_MS,
  buildCostLedger,
  collectModelEvents,
  isContractRole,
  parseCostWindow,
  reasonFromModelEventPayload,
  roleFromModelEventPayload,
  summarizeModelEvents,
  usageFromPayload
} from './cost-ledger'

// The cost ledger (cohesion P0, lane C; plan §2.1 "Cost ledger", L7 F7). Pure over an injected
// event list, so these run without SQLite.

let seq = 0
function ev(payload: Record<string, unknown>, createdAt = 1_000_000, type: EventRecord['type'] = 'model.request.completed'): EventRecord {
  return {
    id: `e${++seq}`,
    type,
    createdAt,
    severity: 'info',
    actorKind: 'model',
    payload,
    redaction: 'metadata'
  }
}

const DS = { provider: 'deepseek', model: 'deepseek-v4-flash' }

describe('roleFromModelEventPayload — contract roles pass, legacy labels map', () => {
  it('passes a RouteTask through and knows the background set', () => {
    for (const r of ['chat', 'agentic', 'extraction', 'reviewer', 'jury', 'title', 'embed', 'reason']) {
      expect(roleFromModelEventPayload({ role: r })).toBe(r)
      expect(isContractRole(r)).toBe(true)
    }
    expect(BACKGROUND_ROLES.has('extraction')).toBe(true)
    expect(BACKGROUND_ROLES.has('chat')).toBe(false)
  })

  it('maps the legacy job labels the live spine actually carries', () => {
    expect(roleFromModelEventPayload({ role: 'operator-learning', purpose: 'other' })).toBe('extraction')
    expect(roleFromModelEventPayload({ role: 'judgment-measure-grade', purpose: 'other' })).toBe('extraction')
    expect(roleFromModelEventPayload({ role: 'operator-govern-jury', purpose: 'other' })).toBe('jury')
    expect(roleFromModelEventPayload({ role: 'action-reviewer', purpose: 'other' })).toBe('reviewer')
    expect(roleFromModelEventPayload({ role: 'title-gen', purpose: 'title' })).toBe('title')
    expect(roleFromModelEventPayload({ role: 'rag-embed', purpose: 'other' })).toBe('embed')
    expect(roleFromModelEventPayload({ role: 'turn-beat' })).toBe('extraction')
    expect(roleFromModelEventPayload({ purpose: 'main' })).toBe('chat')
    expect(roleFromModelEventPayload({ role: 'composer', purpose: 'composer' })).toBe('chat')
    expect(roleFromModelEventPayload(undefined)).toBe('chat')
  })
})

describe('reasonFromModelEventPayload — contract reasons pass, legacy errors classify', () => {
  it('passes a classified reason through', () => {
    expect(reasonFromModelEventPayload({ reason: 'rate-limit' })).toBe('rate-limit')
    expect(reasonFromModelEventPayload({ reason: 'made-up' })).toBe('unknown')
  })
  it('classifies by HTTP status first, then by the error text', () => {
    expect(reasonFromModelEventPayload({ httpStatus: 401 })).toBe('unauthorized')
    expect(reasonFromModelEventPayload({ httpStatus: 402 })).toBe('no-credit')
    expect(reasonFromModelEventPayload({ httpStatus: 403 })).toBe('model-access')
    expect(reasonFromModelEventPayload({ httpStatus: 404 })).toBe('not-found')
    expect(reasonFromModelEventPayload({ httpStatus: 429 })).toBe('rate-limit')
    expect(reasonFromModelEventPayload({ errorPreview: '400 credit balance is too low' })).toBe('no-credit')
    expect(reasonFromModelEventPayload({ errorPreview: '401 Invalid Authentication' })).toBe('unauthorized')
    expect(reasonFromModelEventPayload({ errorPreview: 'Project proj_x does not have access to model gpt-5.6' })).toBe('model-access')
    expect(reasonFromModelEventPayload({ errorClass: 'FetchError', errorPreview: 'connect ECONNREFUSED' })).toBe('network')
    expect(reasonFromModelEventPayload({ errorPreview: 'model glm-4.5-airx not found' })).toBe('not-found')
    expect(reasonFromModelEventPayload({ errorPreview: 'something odd' })).toBe('unknown')
    expect(reasonFromModelEventPayload(undefined)).toBe('unknown')
  })
})

describe('usageFromPayload — numeric, legacy-redacted, prompt-only', () => {
  it('reads NormalizedUsage buckets (cache write bills as input)', () => {
    expect(usageFromPayload({ usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 400, cacheWriteTokens: 5, promptTokens: 505 } })).toEqual({
      present: true,
      redacted: false,
      inputTokens: 105,
      outputTokens: 20,
      cachedTokens: 400
    })
  })
  it('flags a historically redacted block and tolerates a missing one', () => {
    expect(usageFromPayload({ usage: { inputTokens: '[redacted]', outputTokens: '[redacted]' } })).toMatchObject({ present: true, redacted: true })
    expect(usageFromPayload({})).toMatchObject({ present: false, redacted: false })
    expect(usageFromPayload({ usage: { promptTokens: 50, completionTokens: 5 } })).toMatchObject({ inputTokens: 50, outputTokens: 5 })
  })
})

describe('summarizeModelEvents — per role, per provider, honestly priced', () => {
  it('prices DeepSeek from the table, other cloud models at the fallback (estimated), local at $0, exact when given', () => {
    const events = [
      ev({ ...DS, role: 'operator-learning', purpose: 'other', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 1_000_000 } }),
      ev({ provider: 'openai', model: 'gpt-5.5', role: 'operator-govern-jury', purpose: 'other', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 1_000_000 } }),
      ev({ provider: 'ollama', model: 'qwen3-ctx:latest', role: 'judgment-measure-grade', purpose: 'other', usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 500 } }),
      ev({ ...DS, role: 'chat', costUsd: 0.5, usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 10 } }),
      ev({ ...DS, role: 'turn-beat', purpose: 'other', usage: { inputTokens: '[redacted]', outputTokens: '[redacted]' } }),
      ev({ ...DS, role: 'reflection-rollup', purpose: 'other' }),
      ev({ ...DS, role: 'x' }, 1, 'model.request.failed')
    ]
    const s = summarizeModelEvents(events)
    expect(s.totals.calls).toBe(6)
    expect(s.totals.metered).toBe(4)
    expect(s.totals.exact).toBe(1)
    expect(s.totals.estimatedCalls).toBe(1)
    expect(s.totals.redactedCalls).toBe(1)
    // 1M deepseek-v4-flash input at $0.28 + gpt-5.5 fallback 1M in ($1) + 1M out ($3) + exact 0.5 + ollama 0.
    expect(s.totals.costUsd).toBeCloseTo(0.28 + 4 + 0.5, 6)
    expect(s.byRole.extraction.calls).toBe(4)
    expect(s.byRole.jury.costUsd).toBeCloseTo(4, 6)
    expect(s.byRole.chat.costUsd).toBeCloseTo(0.5, 6)
    expect(s.byProvider.ollama.costUsd).toBe(0)
    expect(s.byProvider.deepseek.calls).toBe(4)
    expect(s.byJob['operator-learning'].inputTokens).toBe(1_000_000)
    expect(s.chatEventsWithUsage).toBe(1)
  })
})

describe('collectModelEvents — pages past the spine list cap without duplicates', () => {
  function fakeList(all: EventRecord[]) {
    return (f: EventFilter): EventRecord[] =>
      all
        .filter((e) => (Array.isArray(f.type) ? f.type.includes(e.type) : f.type === e.type))
        .filter((e) => (f.sinceMs === undefined || e.createdAt >= f.sinceMs) && (f.untilMs === undefined || e.createdAt <= f.untilMs))
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, f.limit ?? 200)
  }
  it('collects 2,500 events across three pages of 1,000', () => {
    const all: EventRecord[] = []
    for (let i = 0; i < 2_500; i++) all.push(ev({ ...DS, role: 'x', purpose: 'other' }, 10_000 + i))
    const { events, truncated } = collectModelEvents({ sinceMs: 0, untilMs: 20_000, list: fakeList(all) })
    expect(events).toHaveLength(2_500)
    expect(new Set(events.map((e) => e.id)).size).toBe(2_500)
    expect(truncated).toBe(false)
  })
  it('reports truncation at maxRows instead of silently stopping', () => {
    const all: EventRecord[] = []
    for (let i = 0; i < 2_500; i++) all.push(ev({ ...DS }, 10_000 + i))
    const { events, truncated } = collectModelEvents({ sinceMs: 0, untilMs: 20_000, list: fakeList(all), maxEvents: 1_500 })
    expect(events.length).toBeGreaterThanOrEqual(1_500)
    expect(truncated).toBe(true)
  })
  it('respects the window bounds', () => {
    const all = [ev({ ...DS }, 5), ev({ ...DS }, 15), ev({ ...DS }, 25)]
    expect(collectModelEvents({ sinceMs: 10, untilMs: 20, list: fakeList(all) }).events).toHaveLength(1)
  })
})

describe('buildCostLedger — two declared sources, published limits', () => {
  const now = 10_000_000_000
  const list = (f: EventFilter): EventRecord[] =>
    [ev({ ...DS, role: 'operator-learning', purpose: 'other', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, promptTokens: 1000 } }, now - 60_000)]
      .filter((e) => e.createdAt >= (f.sinceMs ?? 0) && e.createdAt <= (f.untilMs ?? Infinity))

  it('adds journal chat spend inside the window, attributes it, and names both sources', () => {
    const ledger = buildCostLedger({
      window: '24h',
      now,
      list,
      journalTurns: [
        { at: now - 120_000, model: 'deepseek-v4-flash', end: { costUsd: 0.25, meteredCalls: 3 } },
        { at: now - 2 * COST_WINDOW_MS['24h'], model: 'deepseek-v4-flash', end: { costUsd: 9 } },
        { at: now - 1_000, model: 'deepseek-v4-flash', end: {} }
      ],
      providerOf: () => 'deepseek'
    })
    expect(ledger.window).toBe('24h')
    expect(ledger.since).toBe(now - COST_WINDOW_MS['24h'])
    expect(ledger.until).toBe(now)
    expect(ledger.sources.map((s) => s.name)).toEqual(['events', 'journal'])
    expect(ledger.sources[1]).toMatchObject({ rows: 1, costUsd: 0.25 })
    expect(ledger.byRole.chat).toMatchObject({ costUsd: 0.25, calls: 3, exact: 1 })
    expect(ledger.byRole.extraction.calls).toBe(1)
    expect(ledger.byProvider.deepseek.calls).toBe(4)
    expect(ledger.totals.costUsd).toBeCloseTo(0.25 + (1000 * 0.28 + 100 * 0.42) / 1e6, 9)
    expect(ledger.estimated).toBe(false)
    expect(ledger.limits).toMatchObject({ truncated: false, journalTurns: 3, journalTurnsInWindow: 1, overlapPossible: false })
    expect(ledger.limits.pricing).toContain('fallback')
  })

  it('says estimated when a counter was redacted or a fallback price was used', () => {
    const redactedList = (): EventRecord[] => [ev({ ...DS, role: 'turn-beat', purpose: 'other', usage: { inputTokens: '[redacted]' } }, now - 1)]
    expect(buildCostLedger({ window: '7d', now, list: redactedList }).estimated).toBe(true)
    const fallbackList = (): EventRecord[] => [ev({ provider: 'openai', model: 'gpt-5.5', role: 'x', purpose: 'other', usage: { inputTokens: 10, outputTokens: 1 } }, now - 1)]
    expect(buildCostLedger({ window: '7d', now, list: fallbackList }).estimated).toBe(true)
  })

  it('parses the window leniently', () => {
    expect(parseCostWindow('7d')).toBe('7d')
    expect(parseCostWindow('24h')).toBe('24h')
    expect(parseCostWindow('garbage')).toBe('24h')
    expect(parseCostWindow(null)).toBe('24h')
  })
})
