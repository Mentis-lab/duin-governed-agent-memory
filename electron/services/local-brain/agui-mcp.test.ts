import { describe, it, expect } from 'vitest'
import { buildMcpToolSchemas, splitMcpToolName } from './agui-mcp'

describe('buildMcpToolSchemas', () => {
  it('namespaces each tool as serverId__toolName with a valid schema', () => {
    const out = buildMcpToolSchemas([
      {
        serverId: 'feishu',
        tools: [
          { name: 'send_message', description: 'send a msg', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }
        ]
      }
    ])
    expect(out).toHaveLength(1)
    expect(out[0].type).toBe('function')
    expect(out[0].function.name).toBe('feishu__send_message')
    expect(out[0].function.description).toBe('send a msg')
    expect(out[0].function.parameters).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
  })

  it('falls back to an empty object schema when inputSchema is missing/invalid', () => {
    const out = buildMcpToolSchemas([
      { serverId: 'node-repl', tools: [{ name: 'noarg' }, { name: 'bad', inputSchema: 42 }] }
    ])
    expect(out.map((t) => t.function.parameters)).toEqual([
      { type: 'object', properties: {} },
      { type: 'object', properties: {} }
    ])
  })

  it('handles multiple servers and preserves order', () => {
    const out = buildMcpToolSchemas([
      { serverId: 'a', tools: [{ name: 't1' }, { name: 't2' }] },
      { serverId: 'b', tools: [{ name: 't3' }] }
    ])
    expect(out.map((t) => t.function.name)).toEqual(['a__t1', 'a__t2', 'b__t3'])
  })

  it('skips malformed servers/tools without throwing', () => {
    const out = buildMcpToolSchemas([
      { serverId: '', tools: [{ name: 'x' }] }, // no serverId
      { serverId: 'ok', tools: [{ name: '' } as any, { name: 'good' }] }, // one bad tool name
      null as any,
      { serverId: 'z', tools: null as any } // tools not array
    ])
    expect(out.map((t) => t.function.name)).toEqual(['ok__good'])
  })

  it('empty / nullish input → empty list', () => {
    expect(buildMcpToolSchemas([])).toEqual([])
    expect(buildMcpToolSchemas(undefined)).toEqual([])
    expect(buildMcpToolSchemas(null)).toEqual([])
  })
})

describe('splitMcpToolName', () => {
  it('splits a namespaced name, preserving further __ in the tool part', () => {
    expect(splitMcpToolName('feishu__send_message')).toEqual({ serverId: 'feishu', toolName: 'send_message' })
    expect(splitMcpToolName('srv__a__b')).toEqual({ serverId: 'srv', toolName: 'a__b' })
  })
  it('returns null for a non-namespaced or malformed name', () => {
    expect(splitMcpToolName('read_file')).toBeNull()
    expect(splitMcpToolName('__x')).toBeNull() // empty serverId
    expect(splitMcpToolName('x__')).toBeNull() // empty toolName
    expect(splitMcpToolName(undefined)).toBeNull()
  })
})
