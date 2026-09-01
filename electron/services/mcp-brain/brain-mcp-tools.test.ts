import { describe, it, expect } from 'vitest'
import { BRAIN_TOOLS, buildBrainRequest, normalizeBase } from './brain-mcp-tools'

describe('brain-mcp-tools (C2)', () => {
  it('every tool has a name, a /state or /learn route, and a valid object schema', () => {
    for (const t of BRAIN_TOOLS) {
      expect(t.name).toMatch(/^duin_/)
      expect(t.route.startsWith('/')).toBe(true)
      expect(t.inputSchema.type).toBe('object')
      expect(t.inputSchema.additionalProperties).toBe(false)
    }
    // names unique
    expect(new Set(BRAIN_TOOLS.map((t) => t.name)).size).toBe(BRAIN_TOOLS.length)
  })

  it('normalizeBase defaults to the loopback brain + strips trailing slashes', () => {
    expect(normalizeBase(undefined)).toBe('http://127.0.0.1:8799')
    expect(normalizeBase('')).toBe('http://127.0.0.1:8799')
    expect(normalizeBase('http://127.0.0.1:8799/')).toBe('http://127.0.0.1:8799')
  })

  it('builds a GET read request with no body', () => {
    const r = buildBrainRequest('duin_decisions', {}, undefined)
    expect(r).toEqual({ url: 'http://127.0.0.1:8799/state/decisions', method: 'GET' })
  })

  it('item 9: duin_measure_facts (POST write) + duin_efficacy (GET read) map to the right routes', () => {
    const m = buildBrainRequest('duin_measure_facts', {}, undefined)
    expect(m.method).toBe('POST')
    expect(m.url).toBe('http://127.0.0.1:8799/state/measure-facts')
    const e = buildBrainRequest('duin_efficacy', {}, undefined)
    expect(e).toEqual({ url: 'http://127.0.0.1:8799/state/efficacy', method: 'GET' })
  })

  it('builds a POST write with only the schema-declared fields', () => {
    const r = buildBrainRequest('duin_resolve_decision', { id: 'D1', action: 'resolve', note: 'done', junk: 'x' }, undefined)
    expect(r.method).toBe('POST')
    expect(r.url).toBe('http://127.0.0.1:8799/state/resolve-node')
    expect(JSON.parse(r.body!)).toEqual({ id: 'D1', action: 'resolve', note: 'done' }) // junk dropped
  })

  it('rejects an unknown tool', () => {
    expect(() => buildBrainRequest('duin_nope', {}, undefined)).toThrow(/unknown tool/)
  })

  it('rejects a write missing a required arg', () => {
    expect(() => buildBrainRequest('duin_capture_work', {}, undefined)).toThrow(/missing required arg: text/)
    expect(() => buildBrainRequest('duin_resolve_decision', { id: 'D1' }, undefined)).toThrow(/missing required arg: action/)
  })

  it('refuses to WRITE to a non-loopback brain (mis-set base guard), but reads are allowed', () => {
    expect(() => buildBrainRequest('duin_capture_work', { text: 'x' }, 'http://evil.example.com')).toThrow(/non-loopback/)
    // a read to a non-loopback base is permitted (no operator data is written)
    expect(buildBrainRequest('duin_decisions', {}, 'http://192.168.1.5:8799').method).toBe('GET')
    // loopback writes pass
    expect(buildBrainRequest('duin_capture_work', { text: 'x' }, 'http://localhost:8799').method).toBe('POST')
  })
})
