import { describe, it, expect } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'
import { DshChild, mapSessionEvent } from './dsh-adapter'
import type { ExecutorEvent } from './executor-types'

// The adapter against a fake runtime that replays dsh's real frame shapes (0.1.1-rc.2). No
// model, no network. The contract these pin: initialize/prompt/shutdown round-trips, the event
// mapping, an unknown method's error, and the stop ladder against a child that will not leave.

const FIXTURE = join(__dirname, '__fixtures__', 'fake-dsh-runtime.cjs')

function launch(mode: string, onEvent: (e: ExecutorEvent) => void): DshChild {
  return DshChild.launch({
    spec: { command: process.execPath, args: [FIXTURE], cwd: tmpdir(), env: { ...(process.env as Record<string, string>), FAKE_DSH_MODE: mode } },
    onEvent,
    requestTimeoutMs: 10_000
  })
}

const until = (pred: () => boolean, ms = 10_000): Promise<void> =>
  new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = (): void => {
      if (pred()) return resolve()
      if (Date.now() - t0 > ms) return reject(new Error('timed out'))
      setTimeout(tick, 10)
    }
    tick()
  })

describe('mapSessionEvent — dsh vocabulary → ExecutorEvent', () => {
  it('assistant/message yields the text AND the per-step usage', () => {
    const out = mapSessionEvent('s', {
      type: 'assistant/message',
      data: { step: 2, message: { content: [{ type: 'reasoning', text: 'r' }, { type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }] }, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, reasoningTokens: 4 } }
    })
    expect(out).toEqual([
      { type: 'assistant.text', sessionId: 's', step: 2, text: 'hello world' },
      { type: 'usage', sessionId: 's', step: 2, usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 4 } }
    ])
  })

  it('tool/call keeps the raw arguments string; tool/result reads the tool-result block', () => {
    expect(mapSessionEvent('s', { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })).toEqual([
      { type: 'tool.call', sessionId: 's', callId: 'c1', name: 'bash', args: '{"command":"ls"}' }
    ])
    expect(
      mapSessionEvent('s', { type: 'tool/result', data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'Error: blocked' }] }] } } })
    ).toEqual([{ type: 'tool.result', sessionId: 's', callId: 'c1', ok: false, text: 'Error: blocked' }])
  })

  it('turn/end carries reason.kind; unknown types become `other`, never throw', () => {
    expect(mapSessionEvent('s', { type: 'turn/end', data: { reason: { kind: 'max-tokens' } } })).toEqual([{ type: 'turn.end', sessionId: 's', reason: 'max-tokens' }])
    expect(mapSessionEvent('s', { type: 'something/new', data: {} })).toEqual([{ type: 'other', sessionId: 's', eventType: 'something/new' }])
    expect(mapSessionEvent('s', null)).toEqual([])
  })
})

describe('DshChild — the wire against a fake runtime', () => {
  it('initialize → prompt → events → idle → shutdown exits', async () => {
    const events: ExecutorEvent[] = []
    const child = launch('happy', (e) => events.push(e))
    const init = await child.initialize({ cwd: tmpdir(), provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 1024 })
    expect(init.serverInfo.name).toBe('fake-dsh')
    const receipt = await child.prompt('job-1', 'say hi')
    expect(receipt.messageId).toBe('msg-1')
    await until(() => events.some((e) => e.type === 'status' && e.status === 'idle'))
    const types = events.map((e) => e.type)
    expect(types).toContain('assistant.text')
    expect(types).toContain('usage')
    expect(types).toContain('tool.call')
    expect(types).toContain('tool.result')
    expect(types).toContain('turn.end')
    expect(events.find((e) => e.type === 'assistant.text')).toMatchObject({ text: 'Done: wrote hello.txt' })
    expect(events.find((e) => e.type === 'tool.call')).toMatchObject({ name: 'bash', callId: 'call_1' })
    // stderr is captured, never lost
    expect(events.some((e) => e.type === 'child.stderr' && e.line.includes('fake-dsh: initialized'))).toBe(true)
    expect(await child.shutdown()).toBe(true)
    const exit = await child.exited
    expect(exit.code).toBe(0)
    expect(child.hasExited).toBe(true)
  }, 20_000)

  it('an unknown method rejects with the runtime error, and the child is still usable', async () => {
    const child = launch('happy', () => {})
    await child.initialize({ cwd: tmpdir(), provider: 'deepseek-official', model: 'm' })
    // @ts-expect-error — reaching the private request path on purpose
    await expect(child.request('no/such', {})).rejects.toThrow(/unknown method/)
    expect(await child.shutdown()).toBe(true)
    await child.exited
  }, 20_000)

  it('the stop ladder ends a child that ignores shutdown and stdin EOF', async () => {
    const child = launch('noexit', () => {})
    await child.initialize({ cwd: tmpdir(), provider: 'deepseek-official', model: 'm' })
    const t0 = Date.now()
    await child.stop()
    expect(child.hasExited).toBe(true)
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 30_000)

  it('after exit, requests reject instead of hanging', async () => {
    const child = launch('happy', () => {})
    await child.initialize({ cwd: tmpdir(), provider: 'deepseek-official', model: 'm' })
    await child.shutdown()
    await child.exited
    await expect(child.prompt('x', 'y')).rejects.toThrow(/exited/)
  }, 20_000)
})
