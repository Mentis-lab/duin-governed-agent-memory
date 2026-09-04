import { describe, it, expect, vi, beforeEach } from 'vitest'

// Per-turn scripted model responses + a record of tool executions.
let turns: Array<{ content: string; toolCalls: Array<{ id: string; function: { name: string; arguments: string } }> }>
let turnIdx: number
let execCalls: Array<{ name: string; args: unknown; cap: string[] | undefined; ws: string }>

vi.mock('./providers/registry', () => ({
  chatStream: vi.fn(
    async (
      _messages: unknown,
      _modelId: string,
      _tools: unknown,
      callbacks: { onDone: (c: string, tc: unknown) => void }
    ) => {
      const t = turns[turnIdx++] ?? { content: 'done', toolCalls: [] }
      callbacks.onDone(t.content, t.toolCalls.map((x) => ({ id: x.id, type: 'function', function: x.function })))
    }
  ),
  resolveModel: () => ({ supportsTools: true }),
  routeModel: () => null
}))

vi.mock('./tool-exec', () => ({
  executeToolCall: vi.fn(async (name: string, args: unknown, ctx: { capabilityAllowedTools?: string[]; workspacePath: string }) => {
    execCalls.push({ name, args, cap: ctx.capabilityAllowedTools, ws: ctx.workspacePath })
    return { result: `ran ${name}`, status: 'ok', approvalSource: 'capability' }
  })
}))

vi.mock('./tool-registry', () => ({
  toolRegistry: {
    getOpenAITools: () => [
      { type: 'function', function: { name: 'read_file', description: '', parameters: {} } },
      { type: 'function', function: { name: 'apply_patch', description: '', parameters: {} } }
    ],
    getDescriptors: () => [{ id: 'read_file' }, { id: 'apply_patch' }, { id: 'shell_command' }]
  }
}))

vi.mock('./workspace-state', () => ({ getActiveWorkspace: () => '/ws' }))

import { agenticForkRunner } from './agentic-fork-runner'

const baseInput = {
  messages: [{ role: 'user' as const, content: 'go' }],
  modelId: 'glm-5.2-1m',
  signal: new AbortController().signal,
  agentType: 'general',
  runId: 'r1'
}

beforeEach(() => {
  turns = []
  turnIdx = 0
  execCalls = []
  vi.clearAllMocks()
})

describe('agenticForkRunner', () => {
  it('a tool-less agent offers no tools and returns the completion (today behavior)', async () => {
    turns = [{ content: 'plain answer', toolCalls: [] }]
    const out = await agenticForkRunner({ ...baseInput, allowedTools: [] })
    expect(out).toBe('plain answer')
    expect(execCalls).toHaveLength(0)
  })

  it('executes a tool call, feeds the result back, then returns the final content', async () => {
    turns = [
      { content: '', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.md"}' } }] },
      { content: 'grounded answer', toolCalls: [] }
    ]
    const out = await agenticForkRunner({ ...baseInput, allowedTools: ['read_file'] })
    expect(out).toBe('grounded answer')
    expect(execCalls).toHaveLength(1)
    expect(execCalls[0].name).toBe('read_file')
    expect(execCalls[0].args).toEqual({ path: 'a.md' })
    // The run's allow-list IS the capability allow-list (fail-closed gate).
    expect(execCalls[0].cap).toEqual(['read_file'])
    expect(execCalls[0].ws).toBe('/ws')
  })

  it("'*' grants every registered tool id as the capability list", async () => {
    turns = [
      { content: '', toolCalls: [{ id: 'c1', function: { name: 'apply_patch', arguments: '{}' } }] },
      { content: 'ok', toolCalls: [] }
    ]
    await agenticForkRunner({ ...baseInput, allowedTools: '*' })
    expect(execCalls[0].cap).toEqual(['read_file', 'apply_patch', 'shell_command'])
  })

  it('stops at the tool-call cap without looping forever', async () => {
    // Every turn keeps requesting a tool → the cap (40) must terminate it.
    turns = Array.from({ length: 60 }, () => ({
      content: 'x',
      toolCalls: [{ id: 'c', function: { name: 'read_file', arguments: '{}' } }]
    }))
    const out = await agenticForkRunner({ ...baseInput, allowedTools: ['read_file'] })
    expect(execCalls.length).toBeLessThanOrEqual(40)
    expect(typeof out === 'object' ? out.output : out).toBe('x')
  })

  it('survives malformed tool arguments (empty args, tool self-corrects)', async () => {
    turns = [
      { content: '', toolCalls: [{ id: 'c1', function: { name: 'read_file', arguments: 'not json' } }] },
      { content: 'recovered', toolCalls: [] }
    ]
    const out = await agenticForkRunner({ ...baseInput, allowedTools: ['read_file'] })
    expect(execCalls[0].args).toEqual({})
    expect(out).toBe('recovered')
  })
})
