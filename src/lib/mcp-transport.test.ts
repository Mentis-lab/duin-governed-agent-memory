import { describe, it, expect } from 'vitest'
import { transportLabel, isRemote } from './mcp-transport'

describe('transportLabel — answers "what happens if I connect this?"', () => {
  it('calls a stdio server Local', () => {
    const t = transportLabel('stdio')
    expect(t.label).toBe('Local')
    expect(t.hint).toMatch(/this computer/i)
  })

  it('calls an http or sse server Remote', () => {
    expect(transportLabel('http', 'https://example.com/mcp').label).toBe('Remote')
    expect(transportLabel('sse', 'https://example.com/sse').label).toBe('Remote')
  })

  it('treats a local byte-stream url as Local, not Remote', () => {
    // Shipping MCP clients accept unix:// and pipe:// in the url field, so "has a
    // url" is not the same question as "leaves this machine".
    expect(transportLabel('http', 'unix:///tmp/mcp.sock').label).toBe('Local')
    expect(transportLabel('http', 'pipe://./mcp').label).toBe('Local')
  })

  it('never leaks the protocol word as the label', () => {
    for (const t of ['stdio', 'sse', 'http'] as const) {
      expect(transportLabel(t, 'https://x.test').label).not.toMatch(/stdio|sse|http/i)
    }
  })

  it('flags only the cases that hand data to someone else', () => {
    expect(isRemote('stdio')).toBe(false)
    expect(isRemote('http', 'unix:///tmp/s.sock')).toBe(false)
    expect(isRemote('http', 'https://example.com/mcp')).toBe(true)
  })
})
