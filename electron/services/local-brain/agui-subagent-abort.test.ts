// R3/Phase-2 — runSubagent's tool-execution loop stops draining queued tool calls the instant the
// parent turn's deadline/cancel fires (before this, the fan-out kept draining past the 180s deadline
// because the loop only checked the signal between rounds, never before each queued call).

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '.tmp-agui-subagent-abort-test' },
  BrowserWindow: { getAllWindows: () => [] }
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))

const chatStreamMock = vi.fn<(...a: unknown[]) => unknown>()
const dispatchMock = vi.fn<(...a: unknown[]) => Promise<string>>(async () => 'tool-ran')
vi.mock('../providers/registry', () => ({ chatStream: (...a: unknown[]) => chatStreamMock(...a) }))
vi.mock('./agui-dispatch', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>
  return { ...actual, dispatchAguiTool: (...a: unknown[]) => dispatchMock(...a) }
})

import { runSubagent } from './agui-subagent'

describe('runSubagent — R3 tool-loop stops on abort mid-round', () => {
  it('breaks before dispatching queued tool calls once the signal aborts', async () => {
    chatStreamMock.mockReset()
    dispatchMock.mockClear()
    const ctl = new AbortController()
    const readCall = { id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }
    // The model returns tool calls, then the turn deadline fires (signal aborts) before the loop
    // dispatches them — mimics the fan-out that ran past the 180s deadline.
    chatStreamMock.mockImplementation((...args: unknown[]) => {
      const cbs = args[3] as { onDone: (c: string, t: unknown[]) => void }
      cbs.onDone('partial answer', [readCall])
      ctl.abort()
      return Promise.resolve()
    })
    const out = await runSubagent('do work', '/vault', 'model-x', ctl.signal)
    expect(chatStreamMock).toHaveBeenCalledTimes(1) // one round, then the loop-top guard exits
    expect(dispatchMock).not.toHaveBeenCalled() // queued tool call NOT drained after abort
    expect(typeof out).toBe('string')
  })

  it('an already-aborted signal never even calls the model', async () => {
    chatStreamMock.mockReset()
    dispatchMock.mockClear()
    const ctl = new AbortController()
    ctl.abort()
    const out = await runSubagent('do work', '/vault', 'model-x', ctl.signal)
    expect(chatStreamMock).not.toHaveBeenCalled()
    expect(dispatchMock).not.toHaveBeenCalled()
    expect(out).toBe('(subagent produced no final text)')
  })
})
