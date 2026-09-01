import { describe, it, expect } from 'vitest'
import { normalizeToolsForProvider, dedupeToolsByName } from './schema-normalizer'

const tool = (name: string, description = 'd') => ({
  type: 'function' as const,
  function: { name, description, parameters: {} }
})

describe('dedupeToolsByName — providers 400 on duplicate tool names', () => {
  it('keeps the FIRST occurrence and reports the dropped names', () => {
    const brainNative = tool('search_notes', 'brain')
    const input = [brainNative, tool('write_todos'), tool('search_notes', 'mcp-shadow'), tool('web_fetch')]
    const { tools, dropped } = dedupeToolsByName(input)
    expect(tools.map((t) => t.function.name)).toEqual(['search_notes', 'write_todos', 'web_fetch'])
    // first-wins: the surviving search_notes is the brain native, not the MCP shadow
    expect(tools[0]).toBe(brainNative)
    expect(dropped).toEqual(['search_notes'])
  })

  it('is a no-op (no drops) when every name is already unique', () => {
    const input = [tool('a'), tool('b'), tool('c')]
    const { tools, dropped } = dedupeToolsByName(input)
    expect(tools).toHaveLength(3)
    expect(dropped).toEqual([])
  })

  it('drops unnamed entries and collapses 3+ copies to one', () => {
    const input = [tool('x'), tool('x'), tool('x'), { type: 'function', function: { name: '', description: '', parameters: {} } } as never]
    const { tools, dropped } = dedupeToolsByName(input)
    expect(tools.map((t) => t.function.name)).toEqual(['x'])
    expect(dropped).toEqual(['x', 'x', '(unnamed)'])
  })

  it('handles an empty list', () => {
    expect(dedupeToolsByName([])).toEqual({ tools: [], dropped: [] })
  })
})

const simpleTool = {
  name: 'simple_tool',
  description: 'A simple tool',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'A command' }
    },
    required: ['command'],
    additionalProperties: false
  }
}

const toolWithNested = {
  name: 'nested_tool',
  description: 'Tool with nested objects',
  inputSchema: {
    type: 'object',
    properties: {
      config: {
        type: 'object',
        properties: {
          timeout: { type: 'number' }
        },
        required: ['timeout'],
        additionalProperties: false
      }
    },
    required: ['config']
  }
}

const toolWithUnsupportedNonStructural = {
  name: 'quirky_tool',
  description: 'Has unsupported non-structural keywords',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' }
    },
    required: ['query'],
    additionalProperties: false,
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'quirky',
    patternProperties: { '^x-': { type: 'string' } }
  }
}

const toolWithOneOf = {
  name: 'oneof_tool',
  description: 'Uses oneOf which is structural and unsupported',
  inputSchema: {
    type: 'object',
    oneOf: [
      { properties: { a: { type: 'string' } } },
      { properties: { b: { type: 'number' } } }
    ]
  }
}

const coreToolWithOneOf = {
  name: 'shell_command',
  description: 'Core tool with oneOf',
  inputSchema: {
    type: 'object',
    oneOf: [{ properties: { cmd: { type: 'string' } } }]
  }
}

const coreTool = {
  name: 'workspace_context',
  description: 'Core tool',
  inputSchema: {
    type: 'object',
    properties: { cwd: { type: 'string' } },
    additionalProperties: false
  }
}

describe('normalizeToolsForProvider', () => {
  it('passes through simple valid tools', () => {
    const result = normalizeToolsForProvider([simpleTool], 'deepseek')
    expect(result.tools).toHaveLength(1)
    expect(result.warnings).toHaveLength(0)
    const t = result.tools[0]
    expect(t.type).toBe('function')
    expect(t.function.name).toBe('simple_tool')
    expect(t.function.parameters.type).toBe('object')
    expect(t.function.parameters.additionalProperties).toBe(false)
  })

  it('handles tools with nested objects', () => {
    const result = normalizeToolsForProvider([toolWithNested], 'deepseek')
    expect(result.tools).toHaveLength(1)
    expect(result.warnings).toHaveLength(0)
    const params = result.tools[0].function.parameters
    const config = (params.properties as Record<string, unknown>).config as Record<string, unknown>
    expect(config.type).toBe('object')
  })

  it('strips non-structural unsupported keywords', () => {
    const result = normalizeToolsForProvider([toolWithUnsupportedNonStructural], 'deepseek')
    expect(result.tools).toHaveLength(1)
    const params = result.tools[0].function.parameters
    expect(params.$schema).toBeUndefined()
    expect(params.$id).toBeUndefined()
    expect(params.patternProperties).toBeUndefined()
    // Core properties should remain
    expect(params.properties).toBeDefined()
    expect(params.required).toEqual(['query'])
  })

  it('drops non-core tools with structural unsupported keywords', () => {
    const result = normalizeToolsForProvider([toolWithOneOf], 'deepseek')
    expect(result.tools).toHaveLength(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('oneOf')
    expect(result.warnings[0]).toContain('oneof_tool')
  })

  it('drops (does NOT throw on) core tools with structural unsupported keywords, keeping the rest', () => {
    // Resilience: a single malformed tool must never abort the whole tool build
    // (which handed the chat ZERO tools). The bad core tool is dropped with a
    // loud CORE-tagged warning; a valid tool in the same batch still survives.
    const result = normalizeToolsForProvider([coreToolWithOneOf, coreTool], 'deepseek')
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].function.name).toBe('workspace_context')
    expect(result.warnings.some((w) => /shell_command/.test(w) && /oneOf/.test(w) && /CORE TOOL/.test(w))).toBe(
      true
    )
  })

  it('core tools pass through normally when valid', () => {
    const result = normalizeToolsForProvider([coreTool], 'deepseek')
    expect(result.tools).toHaveLength(1)
    expect(result.warnings).toHaveLength(0)
  })

  it('handles mixed valid and invalid tools', () => {
    const result = normalizeToolsForProvider(
      [simpleTool, toolWithOneOf, coreTool],
      'deepseek'
    )
    expect(result.tools).toHaveLength(2) // simpleTool + coreTool
    expect(result.warnings).toHaveLength(1) // oneof_tool dropped
  })

  it('handles empty tool list', () => {
    const result = normalizeToolsForProvider([], 'deepseek')
    expect(result.tools).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('adds type:object when missing from inputSchema', () => {
    const result = normalizeToolsForProvider([{
      name: 'no_type_tool',
      description: 'Schema without explicit type',
      inputSchema: {
        properties: { x: { type: 'string' } }
      }
    }], 'deepseek')
    expect(result.tools).toHaveLength(1)
    expect(result.tools[0].function.parameters.type).toBe('object')
  })
})
