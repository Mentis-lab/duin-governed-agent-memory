import { describe, it, expect, vi } from 'vitest'

vi.mock('../providers/registry', () => ({ routeModel: () => null, chatOnce: async () => ({ content: '' }) }))

import {
  tokenize,
  extractLabels,
  buildMessages,
  parseSimResponse,
  consistencyGate,
  classifyRiskDeltas,
  simulateDecision,
  commitDecisionForecast
} from './decision-simulator'

describe('tokenize', () => {
  it('keeps content words, drops stopwords/short, handles CJK', () => {
    const t = tokenize('The 北澜 launch risk is high')
    expect(t.has('北澜')).toBe(true)
    expect(t.has('launch')).toBe(true)
    expect(t.has('the')).toBe(false) // stopword
    expect(t.has('is')).toBe(false) // short/stopword
  })
})

describe('extractLabels', () => {
  it('pulls label-ish string fields recursively, deduped + capped', () => {
    const json = { risks: [{ headline: 'Channel slip' }, { title: 'Budget overrun' }], nested: { name: 'Channel slip' } }
    const labels = extractLabels(json)
    expect(labels).toContain('Channel slip')
    expect(labels).toContain('Budget overrun')
    expect(labels.filter((l) => l === 'Channel slip').length).toBe(1) // deduped
  })
})

describe('buildMessages', () => {
  it('embeds decision, option, and grounded state', () => {
    const msgs = buildMessages('Pick a channel', 'ctx', { id: 'a', label: 'Go with B站' }, { risks: ['slip'], entities: ['北澜'] })
    expect(msgs[0].role).toBe('system')
    const u = msgs[1].content
    expect(u).toContain('Pick a channel')
    expect(u).toContain('Go with B站')
    expect(u).toContain('slip')
    expect(u).toContain('北澜')
  })
})

describe('parseSimResponse', () => {
  it('parses fenced/embedded JSON tolerantly', () => {
    const r = parseSimResponse('here:\n{"consequences":[{"text":"X happens","horizon":"near","basis":"slip"}],"riskDeltas":[{"risk":"slip","direction":"up","why":"more load"}]}\nend')
    expect(r.consequences).toHaveLength(1)
    expect(r.consequences[0].horizon).toBe('near')
    expect(r.riskDeltas[0].direction).toBe('up')
  })
  it('returns empty on junk, defaults bad horizon to mid', () => {
    expect(parseSimResponse('no json').consequences).toHaveLength(0)
    const r = parseSimResponse('{"consequences":[{"text":"abc","horizon":"whenever","basis":""}]}')
    expect(r.consequences[0].horizon).toBe('mid')
  })
})

describe('consistencyGate', () => {
  const grounded = { risks: ['channel slip'], entities: ['北澜 launch'] }
  it('supports a consequence whose basis overlaps grounded state', () => {
    const g = consistencyGate([{ text: 'slip worsens', horizon: 'near', basis: 'channel slip' }], grounded)
    expect(g[0].supported).toBe(true)
    expect(g[0].note).toBeUndefined()
  })
  it('flags a speculative (no-basis) consequence', () => {
    const g = consistencyGate([{ text: 'aliens land', horizon: 'far', basis: '' }], grounded)
    expect(g[0].supported).toBe(false)
    expect(g[0].note).toContain('speculative')
  })
  it('flags a basis not found in the grounded state', () => {
    const g = consistencyGate([{ text: 'stock crashes', horizon: 'mid', basis: 'interest rates' }], grounded)
    expect(g[0].supported).toBe(false)
    expect(g[0].note).toContain('not supported')
  })
})

describe('classifyRiskDeltas', () => {
  it("keeps up/down for a known risk, forces 'new' for an unknown one", () => {
    const d = classifyRiskDeltas(
      [{ risk: 'channel slip', direction: 'up', why: '' }, { risk: 'lawsuit', direction: 'down', why: '' }],
      ['channel slip risk']
    )
    expect(d[0].direction).toBe('up') // known
    expect(d[1].direction).toBe('new') // unknown → new
  })
})

describe('simulateDecision', () => {
  const ground = async () => ({ risks: ['channel slip'], entities: ['北澜 launch'] })
  const modelText =
    '{"consequences":[{"text":"slip worsens","horizon":"near","basis":"channel slip"},{"text":"aliens","horizon":"far","basis":""}],"riskDeltas":[{"risk":"channel slip","direction":"up","why":"load"}]}'

  it('simulates each option, gates consequences, counts flagged', async () => {
    const res = await simulateDecision(
      { decision: 'D', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { ground, runModel: async () => modelText }
    )
    expect(res.modelUsed).toBe(true)
    expect(res.options).toHaveLength(2)
    expect(res.options[0].consequences[0].supported).toBe(true)
    expect(res.options[0].consequences[1].supported).toBe(false) // speculative
    expect(res.options[0].flagged).toBe(1)
    expect(res.options[0].riskDeltas[0].direction).toBe('up')
    expect(res.options[0].forecast.predicted).toContain('slip worsens') // lead = first supported
  })

  it('degrades gracefully with no model (modelUsed=false + note)', async () => {
    const res = await simulateDecision(
      { decision: 'D', options: [{ id: 'a', label: 'A' }] },
      { ground, runModel: async () => null }
    )
    expect(res.modelUsed).toBe(false)
    expect(res.note).toContain('No model')
    expect(res.options[0].consequences).toHaveLength(0)
  })

  it('caps options at 5 and skips blank labels', async () => {
    const opts = Array.from({ length: 8 }, (_, i) => ({ id: String(i), label: i === 0 ? '  ' : `opt${i}` }))
    const res = await simulateDecision({ decision: 'D', options: opts }, { ground, runModel: async () => '{}' })
    expect(res.options.length).toBe(5)
    expect(res.options.every((o) => o.label.trim())).toBe(true)
  })
})

describe('commitDecisionForecast', () => {
  it('posts an idempotent stable id and chosen-option predicted text to the native gate with NUMERIC confidence', async () => {
    let body: Record<string, unknown> = {}
    let origin = ''
    const res = await commitDecisionForecast(
      { decision: 'Pick channel', optionId: 'go-bili', predicted: 'slip worsens', track: '北澜', confidence: 0.6, now: () => new Date('2026-06-29') },
      async (o, b) => {
        origin = o
        body = b
        return { ok: true, id: String(b.id) }
      }
    )
    expect(res.ok).toBe(true)
    expect(origin).toBe('http://127.0.0.1:8799') // native gate, NOT the retired :8765 sidecar
    expect(body.id).toBe('decsim:pick-channel:go-bili') // stable → idempotent re-commit
    expect(body.eval_by).toBe('2026-07-29') // +30d
    expect(body.confidence).toBe(0.6) // NUMERIC (native writer rejects strings like 'med')
    expect(typeof body.confidence).toBe('number')
    expect(body.track).toBe('北澜')
  })

  it('treats a duplicate-id 400 ("forecast id already exists") as ok:true via the DEFAULT poster (re-commit is idempotent)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false, // HTTP 400
      json: async () => ({ ok: false, id: 'decsim:d:o', error: 'forecast id already exists' })
    }))
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    try {
      const res = await commitDecisionForecast({ decision: 'd', optionId: 'o', predicted: 'p' })
      expect(res.ok).toBe(true) // duplicate-id is a no-op success, not a UI error
      expect(res.id).toBe('decsim:d:o')
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('defaults confidence to 0.5 and clamps out-of-range to [0,1]', async () => {
    let b1: Record<string, unknown> = {}
    await commitDecisionForecast({ decision: 'd', optionId: 'o', predicted: 'p' }, async (_o, b) => { b1 = b; return { ok: true } })
    expect(b1.confidence).toBe(0.5) // default
    let b2: Record<string, unknown> = {}
    await commitDecisionForecast({ decision: 'd', optionId: 'o', predicted: 'p', confidence: 1.7 }, async (_o, b) => { b2 = b; return { ok: true } })
    expect(b2.confidence).toBe(1) // clamped
  })
})
