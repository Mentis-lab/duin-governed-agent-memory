import { describe, it, expect } from 'vitest'
import { AskUserRuntime, type AskUserAwaitingEvent } from '../services/ask-user-runtime'

// U11 — the prior audit flagged the single-slot answer loss as REASONED, not
// exercised, and asked for it to be reproduced with two genuinely concurrent
// questions. This drives the real producer.
//
// Why it lives here rather than beside the renderer queue it vindicates:
// tsconfig.web.json lists its cross-process imports FILE-BY-FILE (see the
// comments in that file), so a src/ test importing electron/services fails
// typecheck with TS6307. The renderer half of this proof —
// enqueue/dequeue/buildAnswer over the same event shape — is in
// src/components/chat/ask-user-queue.test.ts.

function drainEvents(): { runtime: AskUserRuntime; emitted: AskUserAwaitingEvent[] } {
  const emitted: AskUserAwaitingEvent[] = []
  let seq = 0
  const runtime = new AskUserRuntime({
    emit: (e) => emitted.push(e),
    genId: () => `req-${++seq}`
  })
  return { runtime, emitted }
}

describe('two concurrent ask_user_question calls', () => {
  it('both stay in flight, and the old last-event-wins renderer stranded the first', async () => {
    const { runtime, emitted } = drainEvents()

    // The two production producers: a chat turn (carries conversationId) and a
    // workflow (electron/ipc/workflows.ts, which does not).
    const fromChat = runtime.ask({
      question: 'Ship it?',
      header: 'chat',
      options: [{ label: 'yes' }, { label: 'no' }],
      conversationId: 'conv-1'
    })
    const fromWorkflow = runtime.ask({
      question: 'Which branch?',
      header: 'workflow',
      options: [{ label: 'main' }, { label: 'dev' }]
    })

    // Concurrency is real, not theoretical: the runtime holds both.
    expect(runtime.size()).toBe(2)
    expect(emitted.map((e) => e.requestId)).toEqual(['req-1', 'req-2'])

    // The OLD renderer stored the broadcast in ONE useState slot:
    //     onAwaiting((raw) => setEvent(raw))
    // ...so the second event overwrote the first and req-1 became unreachable
    // from the UI while its caller stayed parked.
    let singleSlot: AskUserAwaitingEvent | null = null
    for (const e of emitted) singleSlot = e
    expect(singleSlot!.requestId).toBe('req-2')
    expect(runtime.list().map((l) => l.requestId)).toContain('req-1')

    // `ask-user:list` is what lets the renderer recover the stranded one. It
    // was registered with zero callers; AskUserModal now calls it on mount.
    expect(runtime.list()).toHaveLength(2)
    expect(runtime.list().map((l) => l.header)).toEqual(['chat', 'workflow'])

    // Answering each in queue order resolves each caller with its OWN answer
    // — the outcome the single slot made impossible. The payloads are exactly
    // what the renderer's buildAnswer() emits (asserted in the src test).
    expect(runtime.respond('req-1', { kind: 'single', label: 'yes', header: 'chat' })).toBe(true)
    expect(runtime.respond('req-2', { kind: 'single', label: 'dev', header: 'workflow' })).toBe(true)

    await expect(fromChat).resolves.toEqual({ kind: 'single', label: 'yes', header: 'chat' })
    await expect(fromWorkflow).resolves.toEqual({
      kind: 'single',
      label: 'dev',
      header: 'workflow'
    })
    expect(runtime.size()).toBe(0)
  })

  it('list() carries what a reloaded renderer needs to re-surface both', () => {
    const { runtime } = drainEvents()
    void runtime.ask({ question: 'a?', header: 'h1', options: [{ label: 'x' }, { label: 'y' }] })
    void runtime.ask({ question: 'b?', header: 'h2', options: [{ label: 'x' }, { label: 'y' }] })

    const listed = runtime.list()
    expect(listed).toHaveLength(2)
    for (const l of listed) {
      expect(typeof l.requestId).toBe('string')
      expect(typeof l.question).toBe('string')
      expect(typeof l.header).toBe('string')
      expect(typeof l.askedAt).toBe('number')
    }
    // Documented gap, and the reason a recovered entry renders its free-text
    // path instead of chips: list() does NOT carry options / multiSelect /
    // timeoutMs. Enriching it is a main-process change, out of this lane.
    expect(Object.keys(listed[0]).sort()).toEqual(['askedAt', 'header', 'question', 'requestId'])
  })
})

describe('answering after the timeout (U11b)', () => {
  it('comes back unmatched instead of looking delivered', async () => {
    let fire: (() => void) | null = null
    const runtime = new AskUserRuntime({
      emit: () => {},
      genId: () => 'late',
      schedule: (cb) => {
        fire = cb
        return { cancel: () => {} }
      }
    })
    const pending = runtime.ask({
      question: 'still there?',
      header: 'h',
      options: [{ label: 'x' }, { label: 'y' }]
    })

    fire!()

    // The renderer discarded this false and closed the modal as though the
    // answer had landed. It now renders an expired / not-delivered state.
    expect(runtime.respond('late', { kind: 'single', label: 'x', header: 'h' })).toBe(false)
    await expect(pending).resolves.toEqual({ kind: 'timeout' })
  })

  it('cancelling an already-resolved question is also unmatched, so Cancel must dismiss locally', () => {
    let fire: (() => void) | null = null
    const runtime = new AskUserRuntime({
      emit: () => {},
      genId: () => 'gone',
      schedule: (cb) => {
        fire = cb
        return { cancel: () => {} }
      }
    })
    void runtime.ask({ question: 'q?', header: 'h', options: [{ label: 'x' }, { label: 'y' }] })
    fire!()
    expect(runtime.respond('gone', { kind: 'cancelled' })).toBe(false)
  })
})
