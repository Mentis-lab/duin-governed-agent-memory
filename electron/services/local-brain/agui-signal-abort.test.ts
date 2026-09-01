// R3/Phase-2 — the turn abort signal is threaded into the ONE dispatch seam so that AFTER the
// deadline (or a cancel) queued/in-flight tool work STOPS instead of draining. Every tool call (the
// main loop's parallel windows + the subagent loop) funnels through dispatchAguiTool, so this one
// guard covers both paths.

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-signal-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

import { dispatchAguiTool, type AguiDispatchPolicy } from './agui-dispatch'

const tc = (name: string, args: Record<string, unknown> = {}) => ({
  id: 'x',
  function: { name, arguments: JSON.stringify(args) }
})

function policy(signal: AbortSignal | undefined, over: Partial<AguiDispatchPolicy> = {}): {
  p: AguiDispatchPolicy
  frames: unknown[]
  gate: ReturnType<typeof vi.fn>
} {
  const frames: unknown[] = []
  const gate = vi.fn(async () => ({ allow: true }))
  const p: AguiDispatchPolicy = {
    emit: (f) => frames.push(f),
    notesDir: '',
    threadId: '',
    signal,
    allowsTool: () => true,
    notAvailable: (n) => `Error: tool "${n}" is not available`,
    gate,
    enableRenderArtifact: true,
    enableMcp: true,
    allowSpawn: true,
    spawnDenied: '',
    runSpawn: async () => 'Subagent result:\nSPAWNED',
    renderArtifact: async () => ({ ok: true, errors: [] }),
    callMcp: async () => 'mcp-ok',
    ...over
  }
  return { p, frames, gate }
}

describe('dispatchAguiTool — R3 signal short-circuit', () => {
  it('aborted signal → returns the aborted result WITHOUT gating, executing, or emitting frames', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const { p, frames, gate } = policy(ctl.signal)
    const out = await dispatchAguiTool(tc('read_file', { path: 'a.md' }), p)
    expect(out).toBe('Error: tool "read_file" aborted (turn ended)')
    expect(gate).not.toHaveBeenCalled() // short-circuited before the gate
    expect(frames.length).toBe(0) // no START/END cards for aborted work
  })

  it('aborted signal short-circuits a spawn_agent fan-out too', async () => {
    const ctl = new AbortController()
    ctl.abort()
    const spawn = vi.fn(async () => 'nope')
    const { p } = policy(ctl.signal, { runSpawn: spawn })
    const out = await dispatchAguiTool(tc('spawn_agent', { task: 'go' }), p)
    expect(out).toBe('Error: tool "spawn_agent" aborted (turn ended)')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('un-aborted signal → normal dispatch proceeds (no regression)', async () => {
    const ctl = new AbortController() // not aborted
    const { p, gate } = policy(ctl.signal)
    const out = await dispatchAguiTool(tc('read_file', { path: 'a.md' }), p)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(out).toMatch(/^Error:/) // no vault → clean executor error, but it DID run
    expect(out).not.toMatch(/aborted/)
  })

  it('absent signal → behaves exactly as before (optional field)', async () => {
    const { p, gate } = policy(undefined)
    const out = await dispatchAguiTool(tc('read_file', { path: 'a.md' }), p)
    expect(gate).toHaveBeenCalledTimes(1)
    expect(out).not.toMatch(/aborted/)
  })
})

// The abort read has to happen on BOTH sides of `await p.gate(tc)`, not just before it. The gate
// blocks on a human for an unbounded time (resolveAguiGate: the interactive modal has no timeout;
// the AFK channel roundtrip runs to approvalTimeoutMs, 5 min) while the brain's 90s stall watchdog
// cuts the turn underneath it. An approval that lands after the cut returns `allow: true` on a turn
// that has already sent its terminal frame — and delete_file / run_command carry no signal of their
// own, so the pre-gate check alone let it execute for real.
describe('dispatchAguiTool — an approval that lands AFTER the turn was cut', () => {
  /** A gate that parks like a real approval prompt, then resolves `allow` when the operator answers. */
  function lateApproval() {
    let approve!: () => void
    const answered = new Promise<void>((r) => {
      approve = r
    })
    const gate = vi.fn(async () => {
      await answered
      return { allow: true }
    })
    return { gate, approve }
  }

  it('late allow cannot reach the executor (delete_file on a dead turn)', async () => {
    const ctl = new AbortController()
    const { gate, approve } = lateApproval()
    const { p, frames } = policy(ctl.signal, { gate })

    const pending = dispatchAguiTool(tc('delete_file', { path: 'note.md' }), p)
    ctl.abort() // watchdog cuts the turn while the modal is still up
    approve() // …and only then does the operator click Allow

    expect(await pending).toBe('Error: tool "delete_file" aborted (turn ended)')
    expect(gate).toHaveBeenCalledTimes(1) // it reached the gate — this is the POST-gate guard
    expect(frames.length).toBe(0) // no cards for a turn that already ended
  })

  it('late allow cannot reach spawn, render_artifact or MCP either', async () => {
    const spawn = vi.fn(async () => 'SPAWNED')
    const render = vi.fn(async () => ({ ok: true, errors: [] }))
    const mcp = vi.fn(async () => 'mcp-ok')

    for (const [call, label] of [
      [tc('spawn_agent', { task: 'go' }), 'spawn_agent'],
      [tc('render_artifact', { type: 'html', source: '<p>hi</p>' }), 'render_artifact'],
      [tc('server__do', { a: 1 }), 'server__do']
    ] as const) {
      const ctl = new AbortController()
      const { gate, approve } = lateApproval()
      const { p, frames } = policy(ctl.signal, { gate, runSpawn: spawn, renderArtifact: render, callMcp: mcp })

      const pending = dispatchAguiTool(call, p)
      ctl.abort()
      approve()

      expect(await pending).toBe(`Error: tool "${label}" aborted (turn ended)`)
      expect(frames.length).toBe(0)
    }

    expect(spawn).not.toHaveBeenCalled()
    expect(render).not.toHaveBeenCalled()
    expect(mcp).not.toHaveBeenCalled()
  })

  it('a gate that resolves on a LIVE turn still dispatches normally (no regression)', async () => {
    const ctl = new AbortController() // never aborted
    const { gate, approve } = lateApproval()
    const spawn = vi.fn(async () => 'SPAWNED')
    const { p, frames } = policy(ctl.signal, { gate, runSpawn: spawn })

    const pending = dispatchAguiTool(tc('spawn_agent', { task: 'go' }), p)
    approve()

    expect(await pending).toBe('SPAWNED')
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(frames.length).toBe(2) // START + END
  })
})
