import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-dispatch-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import {
  dispatchAguiTool,
  parseBrainFallbackCalls,
  fallbackParseMiss,
  type AguiDispatchPolicy
} from './agui-dispatch'

// C3 gate — the unified dispatcher's routing table. This is the regression net
// the golden test does NOT provide: it covers the gate/allow-set/spawn/render/mcp
// branches and the frame emission, including the historically unit-untested
// subagent path (allow-set rejection, gated-without-exec denial, depth-cap
// refusal, silent frames). One dispatcher, two policies.

const tc = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'x',
  function: { name, arguments: JSON.stringify(args) }
})

const SUBAGENT_TOOLS = new Set([
  'write_file', 'read_file', 'list_dir', 'edit_file', 'delete_file', 'move_file', 'create_dir',
  'search_files', 'glob_files', 'run_command', 'web_fetch', 'web_search'
])
const SUBAGENT_GATED = new Set(['delete_file', 'move_file', 'run_command'])

function mainPolicy(over: Partial<AguiDispatchPolicy> = {}): { p: AguiDispatchPolicy; frames: any[] } {
  const frames: any[] = []
  const p: AguiDispatchPolicy = {
    emit: (f) => frames.push(f),
    notesDir: '',
    threadId: '',
    allowsTool: () => true,
    notAvailable: (n) => `Error: tool "${n}" is not available`,
    gate: async () => ({ allow: true }),
    enableRenderArtifact: true,
    enableMcp: true,
    allowSpawn: true,
    spawnDenied: '',
    runSpawn: async () => 'Subagent result:\nSPAWNED',
    renderArtifact: async () => ({ ok: true, errors: [] }),
    callMcp: async () => 'mcp-ok',
    ...over
  }
  return { p, frames }
}

function subPolicy(execOk: boolean, depth: number): { p: AguiDispatchPolicy; frames: any[] } {
  const frames: any[] = []
  const p: AguiDispatchPolicy = {
    emit: (f) => frames.push(f), // spy (real subagent passes noop)
    notesDir: '',
    threadId: '',
    allowsTool: (n) => SUBAGENT_TOOLS.has(n),
    notAvailable: (n) => `Error: tool "${n}" is not available to a subagent`,
    gate: async (t) => {
      const name = t?.function?.name
      if (SUBAGENT_GATED.has(name) && !execOk) return { allow: false, reason: `Denied: ${name}` }
      return { allow: true }
    },
    enableRenderArtifact: false,
    enableMcp: false,
    allowSpawn: depth < 2,
    spawnDenied: 'Error: tool "spawn_agent" is not available at this nesting depth',
    runSpawn: async () => 'Subagent result:\nCHILD'
  }
  return { p, frames }
}

describe('dispatchAguiTool — unified routing (main + subagent policies)', () => {
  it('gate denial: returns the reason and emits START+END', async () => {
    const { p, frames } = mainPolicy({ gate: async () => ({ allow: false, reason: 'blocked by posture' }) })
    const out = await dispatchAguiTool(tc('run_command', { command: 'ls' }), p)
    expect(out).toBe('blocked by posture')
    expect(frames.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END'])
    expect(frames[1].result).toBe('blocked by posture')
  })

  it('simple tool (main): executes via AGUI_TOOLS, emits START+END', async () => {
    const { p, frames } = mainPolicy()
    // read_file with no vault → clean error result string; no fs needed.
    const out = await dispatchAguiTool(tc('read_file', { path: 'x.md' }), p)
    expect(out).toMatch(/^Error:/) // executor produced a model-facing error (not a throw)
    expect(frames.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END'])
  })

  it('spawn_agent (main): runs the spawn, emits START + "subagent finished" END', async () => {
    const { p, frames } = mainPolicy()
    const out = await dispatchAguiTool(tc('spawn_agent', { task: 'do a thing' }), p)
    expect(out).toBe('Subagent result:\nSPAWNED')
    expect(frames.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END'])
    expect(frames[1].result).toBe('subagent finished')
  })

  it('spawn_agent with empty task: error, no runSpawn', async () => {
    const spawn = vi.fn(async () => 'nope')
    const { p } = mainPolicy({ runSpawn: spawn })
    const out = await dispatchAguiTool(tc('spawn_agent', { task: '   ' }), p)
    expect(out).toBe('Error: task is required')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('render_artifact success (main): emits START + ARTIFACT + END', async () => {
    const { p, frames } = mainPolicy()
    const out = await dispatchAguiTool(tc('render_artifact', { type: 'html', source: '<p>hi</p>' }), p)
    expect(out).toContain('Rendered the html artifact successfully')
    expect(frames.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'ARTIFACT', 'TOOL_CALL_END'])
  })

  it('render_artifact failure (main): reports errors, no ARTIFACT frame', async () => {
    const { p, frames } = mainPolicy({ renderArtifact: async () => ({ ok: false, errors: ['boom', 'bad'] }) })
    const out = await dispatchAguiTool(tc('render_artifact', { type: 'svg', source: 'x' }), p)
    expect(out).toContain('FAILED validation with 2 error(s)')
    expect(frames.map((f) => f.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_END'])
  })

  it('MCP tool (main): routes through callMcp, truncates long END', async () => {
    const { p, frames } = mainPolicy({ callMcp: async () => 'x'.repeat(500) })
    const out = await dispatchAguiTool(tc('server__do', { a: 1 }), p)
    expect(out).toBe('x'.repeat(500))
    expect(frames[1].result.endsWith('…')).toBe(true)
    expect(frames[1].result.length).toBe(201)
  })

  it('unknown tool (main): not-available, no frames', async () => {
    const { p, frames } = mainPolicy()
    const out = await dispatchAguiTool(tc('nonexistent_tool'), p)
    expect(out).toBe('Error: tool "nonexistent_tool" is not available')
    expect(frames.length).toBe(0)
  })

  // ── subagent policy ──
  it('subagent: tool outside the allow-set is refused with the subagent message, no frames', async () => {
    const { p, frames } = subPolicy(true, 0)
    const out = await dispatchAguiTool(tc('start_command', { command: 'x' }), p)
    expect(out).toBe('Error: tool "start_command" is not available to a subagent')
    expect(frames.length).toBe(0)
  })

  it('subagent: gated tool without exec token is denied', async () => {
    const { p } = subPolicy(false, 0)
    const out = await dispatchAguiTool(tc('delete_file', { path: 'x' }), p)
    expect(out).toBe('Denied: delete_file')
  })

  it('subagent: gated tool WITH exec token runs (reaches executor)', async () => {
    const { p } = subPolicy(true, 0)
    const out = await dispatchAguiTool(tc('delete_file', { path: 'x' }), p)
    expect(out).toMatch(/^Error:/) // no vault → clean executor error, but it was NOT gate-denied
    expect(out).not.toBe('Denied: delete_file')
  })

  it('subagent: spawn refused at/over the depth cap', async () => {
    const { p, frames } = subPolicy(true, 2)
    const out = await dispatchAguiTool(tc('spawn_agent', { task: 'deep' }), p)
    expect(out).toBe('Error: tool "spawn_agent" is not available at this nesting depth')
    expect(frames.length).toBe(0)
  })

  it('subagent: render_artifact / MCP are not available (disabled)', async () => {
    const { p } = subPolicy(true, 0)
    expect(await dispatchAguiTool(tc('render_artifact', { type: 'html', source: 'x' }), p)).toBe(
      'Error: tool "render_artifact" is not available to a subagent'
    )
    expect(await dispatchAguiTool(tc('server__do'), p)).toBe('Error: tool "server__do" is not available to a subagent')
  })
})

// Capabilities ① — non-native-model fallback parsing (parse-only, mirrors chat.ts).
describe('parseBrainFallbackCalls — non-native-model fallback JSON → native tool_calls', () => {
  const descriptors = [
    {
      name: 'read_file',
      description: 'Read a vault file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
    }
  ]

  it('parses a fallback tool-call JSON into the native tool_calls shape', () => {
    const content = '{"action": "read_file", "input": {"path": "notes/a.md"}}'
    const calls = parseBrainFallbackCalls(content, descriptors)
    expect(calls).not.toBeNull()
    expect(calls!.length).toBe(1)
    expect(calls![0].type).toBe('function')
    expect(calls![0].function.name).toBe('read_file')
    expect(JSON.parse(calls![0].function.arguments)).toEqual({ path: 'notes/a.md' })
    expect(typeof calls![0].id).toBe('string')
  })

  it('returns null for an explicit final answer', () => {
    expect(parseBrainFallbackCalls('{"action": "final", "answer": "done"}', descriptors)).toBeNull()
  })

  it('returns null for plain prose (no JSON contract)', () => {
    expect(parseBrainFallbackCalls('Here is my answer, no tool needed.', descriptors)).toBeNull()
  })

  it('returns null for an unknown tool name (not in descriptors)', () => {
    expect(parseBrainFallbackCalls('{"action": "nonexistent", "input": {}}', descriptors)).toBeNull()
  })

  // `null` meant three different things: a genuine prose answer, a well-formed envelope with no
  // calls, and JSON the model clearly INTENDED as a tool call that we could not read. The third is
  // a DROPPED tool call, and sharing a representation with the first meant a local model's broken
  // JSON was served to the user as its reply — no frame, no log, no telemetry.
  describe('fallbackParseMiss — why there were no calls', () => {
    it('separates unreadable JSON from a genuine prose answer', () => {
      expect(fallbackParseMiss('Sure, here is the summary you asked for.', descriptors)).toBe('final-answer')
      // Balanced-looking JSON that does not parse: the model tried and we could not read it.
      expect(fallbackParseMiss('{"action": "read_file", "input": {oops}}', descriptors)).toBe('unparseable')
    })

    it('reports null when calls WERE produced', () => {
      const ok = '{"action": "read_file", "input": {"path": "a.md"}}'
      expect(parseBrainFallbackCalls(ok, descriptors)).not.toBeNull()
      expect(fallbackParseMiss(ok, descriptors)).toBeNull()
    })
  })
})
