// U6 + U7 — terminal emission on the DEFAULT (brain) chat path.
//
// Both defects live in the same mapAndEmit / streamFromDuin pair:
//
//   U7  an interrupted turn emitted chat:done TWICE. mapAndEmit's RUN_ERROR
//       branch emits the annotated ("interrupted") message itself and returned
//       'done', which the caller read as "terminal not yet emitted" and emitted
//       AGAIN via emitDone — un-annotated, with the same `duin-${Date.now()}` id
//       minted in the same synchronous call (guaranteed React key collision).
//       The last-rendered bubble was the one WITHOUT the interruption notice,
//       and the persisted row was un-annotated too: a truncated answer presented
//       as complete.
//
//   U6  Stop DELETED the partial answer. All four abort sites emitted chat:error
//       and set emittedTerminal, skipping the finalize block, so ok stayed false
//       and ipc/chat.ts never saved. The renderer's resetStreaming blanks
//       streamingContent the same tick, so the text was unrecoverable — while the
//       raw provider path persists a [cancelled] marker. The two paths disagreed
//       about what Stop means.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { streamFromDuin, type ChatEmit } from './duin-bridge'
import { deadlineTerminalFrames } from './local-brain/agui-terminal'

// 0 disables the per-read inactivity watchdog so these tests are deterministic
// and never race a 60s timer.
vi.mock('./providers/registry', () => ({ readStreamInactivityMs: (): number => 0 }))

const origFetch = global.fetch
afterEach(() => {
  global.fetch = origFetch
  vi.restoreAllMocks()
})

type Call = [string, Record<string, unknown>]

function recorder(): { emit: ChatEmit; calls: Call[]; channels: () => string[] } {
  const calls: Call[] = []
  const emit = ((ch: string, p: Record<string, unknown>) => {
    calls.push([ch, p])
  }) as unknown as ChatEmit
  return { emit, calls, channels: () => calls.map((c) => c[0]) }
}

function sseBody(frames: Array<Record<string, unknown>>): string {
  return frames.map((f) => `data: ${JSON.stringify(f)}`).join('\n') + '\n'
}

function stubBrain(body: string): void {
  global.fetch = vi.fn(
    async () =>
      new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  ) as unknown as typeof fetch
}

/** A brain whose SSE body this test drives frame by frame. */
function controlledBrain(): {
  push: (frame: Record<string, unknown>) => void
  fail: () => void
  close: () => void
} {
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c
    }
  })
  global.fetch = vi.fn(
    async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  ) as unknown as typeof fetch
  const enc = new TextEncoder()
  return {
    push: (frame) => ctl.enqueue(enc.encode(`data: ${JSON.stringify(frame)}\n`)),
    // What a real aborted fetch does to the body stream.
    fail: () => ctl.error(new Error('The operation was aborted')),
    close: () => ctl.close()
  }
}

async function waitFor(pred: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const CONV = 'conv-terminal-emission'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('U7 — an interrupted turn emits exactly ONE chat:done', () => {
  it('emits a single, annotated terminal for the real deadline frame sequence', async () => {
    const { emit, calls, channels } = recorder()
    // The exact frames the watchdog emits (agui-terminal.deadlineTerminalFrames).
    stubBrain(
      sseBody([
        { type: 'RUN_STARTED' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'Partial answer so ' },
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'far.' },
        ...deadlineTerminalFrames('stalled')
      ])
    )

    const res = await streamFromDuin('q', CONV, { emit, execToken: '' })

    const dones = calls.filter(([ch]) => ch === 'chat:done')
    expect(dones).toHaveLength(1)
    expect(channels().filter((c) => c === 'chat:error')).toHaveLength(0)

    const msg = dones[0][1].message as { id: string; content: string }
    expect(msg.content).toContain('Partial answer so far.')
    expect(msg.content).toContain('(interrupted')

    // The turn is persisted by ipc/chat.ts from the RETURNED text, so the row and
    // the rendered bubble must agree — an un-annotated row is a truncated answer
    // presented as complete.
    expect(res.ok).toBe(true)
    expect(res.text).toContain('(interrupted')
    expect(res.text).toBe(msg.content)
  })

  it('never emits two messages sharing an id (React key collision)', async () => {
    const { emit, calls } = recorder()
    stubBrain(
      sseBody([
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'body' },
        { type: 'RUN_ERROR', message: 'turn stalled — no progress within the idle budget' }
      ])
    )
    await streamFromDuin('q', CONV, { emit, execToken: '' })
    const ids = calls
      .filter(([ch]) => ch === 'chat:done')
      .map(([, p]) => (p.message as { id: string }).id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toHaveLength(1)
  })

  it('a RUN_ERROR with no streamed text is still a single chat:error', async () => {
    const { emit, calls } = recorder()
    stubBrain(sseBody([{ type: 'RUN_ERROR', message: 'boom' }]))
    const res = await streamFromDuin('q', CONV, { emit, execToken: '' })
    expect(calls.filter(([ch]) => ch === 'chat:done')).toHaveLength(0)
    expect(calls.filter(([ch]) => ch === 'chat:error')).toHaveLength(1)
    expect(res.ok).toBe(false)
  })

  it('a clean RUN_FINISHED turn is unchanged: one chat:done, no interruption note', async () => {
    const { emit, calls } = recorder()
    stubBrain(
      sseBody([
        { type: 'TEXT_MESSAGE_CONTENT', delta: 'All done.' },
        { type: 'RUN_FINISHED' }
      ])
    )
    const res = await streamFromDuin('q', CONV, { emit, execToken: '' })
    const dones = calls.filter(([ch]) => ch === 'chat:done')
    expect(dones).toHaveLength(1)
    expect((dones[0][1].message as { content: string }).content).toBe('All done.')
    expect(res.text).toBe('All done.')
    expect(res.ok).toBe(true)
  })
})

describe('U6 — Stop keeps the partial answer instead of deleting it', () => {
  it('finalizes an aborted stream as a kept chat:done marked "(stopped by you)"', async () => {
    const { emit, calls } = recorder()
    const brain = controlledBrain()
    const ac = new AbortController()

    const p = streamFromDuin('q', CONV, { emit, execToken: '', signal: ac.signal })
    brain.push({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Half an answer' })
    await waitFor(() => calls.some(([ch]) => ch === 'chat:chunk'))

    // User presses Stop: the fetch aborts, which errors the body stream.
    ac.abort()
    brain.fail()
    const res = await p

    const dones = calls.filter(([ch]) => ch === 'chat:done')
    expect(dones).toHaveLength(1)
    expect(calls.filter(([ch]) => ch === 'chat:error')).toHaveLength(0)
    const msg = dones[0][1].message as { content: string }
    expect(msg.content).toContain('Half an answer')
    expect(msg.content).toContain('stopped by you')

    // ok:true is what makes ipc/chat.ts persist the row — without it the answer
    // survives only in renderer state, which resetStreaming clears the same tick.
    expect(res.ok).toBe(true)
    expect(res.text).toBe(msg.content)
  })

  it('also finalizes when the abort is observed at the read-loop top', async () => {
    const { emit, calls } = recorder()
    const brain = controlledBrain()
    const ac = new AbortController()

    const p = streamFromDuin('q', CONV, { emit, execToken: '', signal: ac.signal })
    brain.push({ type: 'TEXT_MESSAGE_CONTENT', delta: 'Partial' })
    await waitFor(() => calls.some(([ch]) => ch === 'chat:chunk'))

    ac.abort()
    // A frame that arrives after the abort makes the loop iterate and observe it.
    brain.push({ type: 'TEXT_MESSAGE_CONTENT', delta: ' more' })
    const res = await p

    expect(calls.filter(([ch]) => ch === 'chat:done')).toHaveLength(1)
    expect(res.ok).toBe(true)
    expect(res.text).toContain('stopped by you')
  })

  it('an abort with nothing streamed yet still reports an error (nothing to keep)', async () => {
    const { emit, calls } = recorder()
    stubBrain(sseBody([{ type: 'RUN_FINISHED' }]))
    const ac = new AbortController()
    ac.abort() // already aborted before the first fetch

    const res = await streamFromDuin('q', CONV, { emit, execToken: '', signal: ac.signal })

    expect(calls.filter(([ch]) => ch === 'chat:done')).toHaveLength(0)
    expect(calls.filter(([ch]) => ch === 'chat:error')).toHaveLength(1)
    expect(res.ok).toBe(false)
  })
})

// The remaining two incompleteness exits annotated only the EMITTED bubble and returned the
// raw accumulator, so the annotation never reached the two surfaces that read the return value:
// ipc/chat.ts persists `r.text` (a reopened transcript showed a truncated answer as complete and
// replayed it to the model as finished history) and channel-runtime.ts returns `result.text` (the
// Slack/Telegram reply read as a finished answer). Asserting on the chat:done payload alone —
// which the U6/U7 tests above already did — passes either way, which is why this survived.
describe('a kept partial is annotated in the RETURNED text, not just the emitted bubble', () => {
  it('annotates the return when the stream ends with no terminal frame', async () => {
    const { emit, calls } = recorder()
    // Body with content but no RUN_FINISHED/RUN_ERROR: brain crash / dropped socket on a
    // non-resumable brain. Falls through to the finalize block after the reconnect loop.
    stubBrain(sseBody([{ type: 'TEXT_MESSAGE_CONTENT', delta: 'Answer cut mid-' }]))

    const res = await streamFromDuin('q', CONV, { emit, execToken: '' })

    const dones = calls.filter(([ch]) => ch === 'chat:done')
    expect(dones).toHaveLength(1)
    const msg = dones[0][1].message as { content: string }
    expect(msg.content).toContain('(interrupted')

    expect(res.ok).toBe(true) // ok:true is what makes ipc/chat.ts persist this row
    expect(res.text).toContain('Answer cut mid-')
    expect(res.text).toContain('(interrupted')
    expect(res.text).toBe(msg.content) // stored row and rendered bubble must agree
  })

  it('annotates the return when the stream trips the MAX_STREAM_CHARS cap', async () => {
    const { emit, calls } = recorder()
    const brain = controlledBrain()
    const p = streamFromDuin('q', CONV, { emit, execToken: '' })
    // One enqueued chunk = one read(), so the frame is parsed before the cap is checked.
    // MAX_STREAM_CHARS is 5_000_000 and module-private, so the cap has to be tripped for real.
    brain.push({ type: 'TEXT_MESSAGE_CONTENT', delta: 'x'.repeat(5_000_001) })
    const res = await p

    const dones = calls.filter(([ch]) => ch === 'chat:done')
    expect(dones).toHaveLength(1)
    const msg = dones[0][1].message as { content: string }
    // Compare as booleans: a failed toContain on a 5MB string would dump it into the report.
    expect(msg.content.includes('character stream limit')).toBe(true)
    expect(res.ok).toBe(true)
    expect(res.text.includes('character stream limit')).toBe(true)
    expect(res.text === msg.content).toBe(true)
  })
})
