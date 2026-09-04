import { describe, expect, it } from 'vitest'
import { composeChanged, composeHome, pickFocal, rankNeeds, snapshotOf, type HomeInputs, type NoticeLike } from './home-model'

const t = (s: string): string => s
const tf = (s: string, p: Record<string, string | number>): string => s.replace(/\{(\w+)\}/g, (m, k) => (k in p ? String(p[k]) : m))

const NOW = Date.parse('2026-09-03T04:00:00Z')

function notice(over: Partial<NoticeLike> & { id: string }): NoticeLike {
  return {
    kind: 'watch',
    severity: 'info',
    title: `notice ${over.id}`,
    body: 'Some body. More detail.',
    deepLink: null,
    createdAt: NOW - 60_000,
    readAt: null,
    needsDecision: false,
    resolvedAt: null,
    ...over
  }
}

function inputs(over: Partial<HomeInputs> = {}): HomeInputs {
  return {
    now: NOW,
    notices: [],
    counts: { unread: 0, needsDecision: 0 },
    awaitingFacts: 0,
    digest: null,
    engine: {
      resolution: { modelId: 'ollama:qwen3', provider: 'ollama', source: 'policy' },
      health: [{ provider: 'ollama', healthy: true, reason: 'ok', latencyMs: 1200 }],
      providerLabels: { ollama: 'Ollama' },
      modelNames: { 'ollama:qwen3': 'qwen3' }
    },
    index: { indexing: false, docCount: 1191, dir: 'D:/vault' },
    graph: { nodes: 3364, links: 9000 },
    hasModel: true,
    schedules: { schedules: [], runnerEnabled: true },
    automations: { total: 0, enabled: 0, lastRunAt: null, failing: 0 },
    running: { agents: 0, toolCalls: 0, wakeups: 0 },
    stalls: { count: 3, totalMs: 4000, sinceMs: 3_600_000 },
    cost: { costUsd: 0.42, calls: 37, estimated: false },
    backend: { integrityOk: true, backupAgeHours: 3, stuckRuns: 0, ts: '2026-09-03T03:00:00Z' },
    connections: [],
    learning: { awaiting: 0, proving: 0, confirmed: 12, latestFact: null, correctionsQueued: 0 },
    calibration: { predictions: 10, resolved: 4, open: 6, falseAlarms: 1 },
    runs: { done: 0, failed: 0 },
    afterAction: null,
    lastSeen: null,
    unreadable: [],
    ...over
  }
}

describe('rankNeeds', () => {
  it('puts decisions first, then unread newest first, and drops resolved and read rows', () => {
    const rows = [
      notice({ id: 'old-unread', createdAt: NOW - 3_600_000 }),
      notice({ id: 'read', readAt: NOW - 10 }),
      notice({ id: 'owed', needsDecision: true, createdAt: NOW - 7_200_000 }),
      notice({ id: 'resolved', needsDecision: true, resolvedAt: NOW - 5 }),
      notice({ id: 'new-unread', createdAt: NOW - 1000 })
    ]
    expect(rankNeeds(rows).map((n) => n.id)).toEqual(['owed', 'new-unread', 'old-unread'])
  })
})

describe('pickFocal — one thing first', () => {
  // "needs you", never "decision": the Decisions surface is a different store, and a Home
  // line calling this a decision sent the operator to a page that could never hold it.
  it('a waiting decision beats everything, and names it in the Needs-you tab\'s language', () => {
    const i = inputs({ notices: [notice({ id: 'd1', needsDecision: true, title: 'Land the staged loop', body: 'It changed 3 files. Review them.', deepLink: 'duin://tool/automations' })], engine: { resolution: null, health: [] } })
    const m = composeHome(i, t, tf)
    expect(m.focal.kind).toBe('need')
    expect(m.focal.title).toBe('1 thing needs you')
    expect(m.focal.why).toBe('Land the staged loop: It changed 3 files.')
    expect(m.focal.action).toEqual({ label: 'Decide', to: { type: 'deepLink', link: 'duin://tool/automations' } })
    // The focal row is not repeated in the list under it.
    expect(m.needs.map((n) => n.id)).toEqual([])
    expect(m.needsTotal).toBe(1)
  })

  it('counts beliefs awaiting ratification as decisions even without a notice', () => {
    const m = composeHome(inputs({ awaitingFacts: 2 }), t, tf)
    expect(m.focal.kind).toBe('need')
    expect(m.focal.title).toBe('2 things need you')
    expect(m.focal.action?.to).toEqual({ type: 'tool', tool: 'learning' })
  })

  it('a dead engine is the focal item when nothing is owed, and points at the fix', () => {
    const m = composeHome(inputs({ engine: { resolution: null, health: [{ provider: 'ollama', healthy: false, reason: 'network', hint: 'Could not reach Ollama.' }], providerLabels: { ollama: 'Ollama' } } }), t, tf)
    expect(m.focal.kind).toBe('machine')
    expect(m.focal.title).toBe('No model is answering')
    expect(m.focal.why).toBe('Ollama: Could not reach Ollama.')
    expect(m.focal.action).toEqual({ label: 'Connect a model', to: { type: 'settings', tab: 'models' } })
  })

  it('a missing brain folder is critical and sends the operator to pick one', () => {
    const m = composeHome(inputs({ index: { indexing: false, docCount: 0, dir: '' } }), t, tf)
    expect(m.focal.title).toBe('No brain folder yet')
    expect(m.focal.action?.label).toBe('Choose a folder')
  })

  it('fresh news outranks an insight; an insight outranks calm', () => {
    const withNews = composeHome(inputs({ notices: [notice({ id: 'n1', title: 'Feishu synced', body: '12 new messages.' })], digest: { insights: [{ id: 'i1', title: 'Two projects share a blocker' }] } }), t, tf)
    expect(withNews.focal.kind).toBe('fresh')
    expect(withNews.focal.title).toBe('1 new thing since you looked')
    const withInsight = composeHome(inputs({ digest: { insights: [{ id: 'i1', title: 'Two projects share a blocker', why: 'both wait on legal' }] } }), t, tf)
    expect(withInsight.focal).toMatchObject({ kind: 'insight', title: 'Two projects share a blocker', why: 'both wait on legal' })
    const calm = composeHome(inputs(), t, tf)
    expect(calm.focal).toMatchObject({ kind: 'calm', title: 'Nothing needs you' })
  })

  it('a warning leads only when nothing else does, with the reason as the headline', () => {
    const m = composeHome(inputs({ schedules: { schedules: [{ name: 'digest', enabled: true, due: false }], runnerEnabled: false } }), t, tf)
    expect(m.focal).toMatchObject({ kind: 'machine', tone: 'warn', title: 'Runner is off, nothing fires', why: 'Loops: 1 scheduled' })
    // A graph rebuild in flight is activity, not a warning: calm still leads.
    const rebuilding = composeHome(inputs({ graph: { nodes: 10, links: 4, stale: true } }), t, tf)
    expect(rebuilding.focal.kind).toBe('calm')
    expect(rebuilding.alive.find((l) => l.id === 'brain')).toMatchObject({ why: 'graph is stale, rebuilding', tone: 'ok' })
  })

  it('the generic come-back nudge never becomes the focal item', () => {
    const m = pickFocal(inputs({ digest: { returnReason: 'As your brain fills…', returnReasonIsDefault: true } }), [], [], t, tf)
    expect(m.kind).toBe('calm')
  })
})

describe('composeAlive — the machine as one line each, with the why', () => {
  it('reads the engine from the router and says it answers, with latency', () => {
    const m = composeHome(inputs(), t, tf)
    const engine = m.alive.find((l) => l.id === 'engine')
    expect(engine).toMatchObject({ value: 'qwen3 · Ollama', why: 'answering · 1.2s', tone: 'ok' })
  })

  it('warns when the resolved provider is failing but another is healthy', () => {
    const m = composeHome(inputs({ engine: { resolution: { modelId: 'deepseek-chat', provider: 'deepseek' }, health: [{ provider: 'deepseek', healthy: false, reason: 'quota', hint: 'Top up the balance.' }, { provider: 'ollama', healthy: true, reason: 'ok' }] } }), t, tf)
    const engine = m.alive.find((l) => l.id === 'engine')
    expect(engine).toMatchObject({ tone: 'warn', why: 'deepseek is failing: Top up the balance.' })
  })

  it('brain line: notes and nodes, and the graph waits for a model when there is none', () => {
    const m = composeHome(inputs({ hasModel: false }), t, tf)
    expect(m.alive.find((l) => l.id === 'brain')).toMatchObject({ value: '1,191 notes · 3,364 nodes', why: 'graph waits for a model', tone: 'warn' })
  })

  it('loops: a switched-off runner is a warning, not a count', () => {
    const m = composeHome(inputs({ schedules: { schedules: [{ name: 'digest', enabled: true, due: false }], runnerEnabled: false } }), t, tf)
    expect(m.alive.find((l) => l.id === 'loops')).toMatchObject({ value: '1 scheduled', why: 'runner is off, nothing fires', tone: 'warn', to: { type: 'settings', tab: 'loops' } })
    const on = composeHome(inputs({ schedules: { schedules: [{ name: 'digest', enabled: true, due: true }, { name: 'sweep', enabled: true, due: false }], runnerEnabled: true }, automations: { total: 1, enabled: 1, lastRunAt: NOW - 3 * 3_600_000, failing: 0 } }), t, tf)
    expect(on.alive.find((l) => l.id === 'loops')).toMatchObject({ value: '3 scheduled', why: '1 due now · last ran 3h ago', tone: 'ok' })
  })

  it('harness: the blocked fraction and a stale backup surface as words, spend as the why', () => {
    const m = composeHome(inputs({ stalls: { count: 40, totalMs: 300_000, sinceMs: 3_600_000 }, backend: { integrityOk: true, backupAgeHours: 40, stuckRuns: 0, ts: 'x' } }), t, tf)
    const h = m.alive.find((l) => l.id === 'harness')
    expect(h).toMatchObject({ tone: 'warn', value: 'last backup 40h ago', why: 'window blocked 8.3% of the time' })
    const calm = composeHome(inputs(), t, tf).alive.find((l) => l.id === 'harness')
    expect(calm).toMatchObject({ value: 'calm', why: '$0.42 today', tone: 'ok' })
  })

  it('harness: the blocked fraction is not judged in the first minutes after launch', () => {
    const m = composeHome(inputs({ stalls: { count: 9, totalMs: 7_000, sinceMs: 10_000 } }), t, tf)
    expect(m.alive.find((l) => l.id === 'harness')).toMatchObject({ value: 'calm', tone: 'ok' })
    expect(m.focal.kind).toBe('calm')
  })

  it('sources appear only when one is configured', () => {
    expect(composeHome(inputs(), t, tf).alive.some((l) => l.id === 'sources')).toBe(false)
    const m = composeHome(inputs({ connections: [{ id: 'feishu', label: 'Feishu', configured: true, enabled: true, lastSyncMs: NOW - 2 * 3_600_000, lastError: null }] }), t, tf)
    expect(m.alive.find((l) => l.id === 'sources')).toMatchObject({ value: 'Feishu synced 2h ago', tone: 'ok' })
  })
})

describe('composeChanged — deltas against the last session', () => {
  it('is quiet with no baseline and nothing learned', () => {
    expect(composeChanged(inputs({ calibration: null }), t, tf)).toEqual([])
  })

  it('reports notes and nodes added since the snapshot, and learning, runs, forecasts', () => {
    const seen = { ...snapshotOf(inputs()), at: NOW - 8 * 3_600_000, docCount: 1180, nodes: 3300, resolvedForecasts: 2 }
    const lines = composeChanged(
      inputs({ lastSeen: seen, learning: { awaiting: 1, proving: 2, confirmed: 12, latestFact: 'Tessa prefers concise replies', correctionsQueued: 0 }, runs: { done: 3, failed: 1 }, afterAction: { toolErrors: 2, chatErrors: 0 } }),
      t,
      tf
    )
    expect(lines.map((l) => l.text)).toEqual([
      '11 notes read · 64 nodes added',
      '1 belief awaits your ratification · 2 facts proving out',
      'Learned: Tessa prefers concise replies',
      '3 runs finished · 1 run failed',
      '2 forecasts resolved',
      'Last conversation: 2 tool errors'
    ])
    expect(lines[0].to).toEqual({ type: 'tool', tool: 'brain' })
    expect(lines[2].to).toEqual({ type: 'tool', tool: 'learning' })
  })

  it('never reports a negative delta', () => {
    const seen = { ...snapshotOf(inputs()), at: NOW - 1000, docCount: 2000, nodes: 9999 }
    expect(composeChanged(inputs({ lastSeen: seen, calibration: null }), t, tf)).toEqual([])
  })
})

describe('snapshotOf', () => {
  it('captures the counters the next session diffs against', () => {
    expect(snapshotOf(inputs())).toEqual({ at: NOW, docCount: 1191, nodes: 3364, facts: 12, resolvedForecasts: 4, runsDone: 0, runsFailed: 0 })
  })
})
