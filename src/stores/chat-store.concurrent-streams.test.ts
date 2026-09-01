import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, ToolCallEvent, ToolCallResultEvent } from '@/lib/types'

// chat-store reaches for `window.api` inside its actions. The suite runs under
// the node environment (no jsdom), so stub the global BEFORE importing the
// store module — same pattern as chat-store.cancel.test.ts.
const send = vi.fn()
const cancel = vi.fn()
const generateTitle = vi.fn(async () => ({ success: false as const, error: 'off' }))
const list = vi.fn(async () => ({ success: true as const, data: [] }))
const getMessages = vi.fn(async (_id: string) => ({ success: true as const, data: [] as Message[] }))
const updateTitle = vi.fn(async () => ({ success: true as const, data: null }))
const create = vi.fn()

;(globalThis as unknown as { window: unknown }).window = {
  // toast-store schedules its auto-dismiss off window.setTimeout.
  setTimeout: (cb: () => void, ms: number) => setTimeout(cb, ms),
  clearTimeout: (h: unknown) => clearTimeout(h as never),
  api: {
    chat: { send, cancel, generateTitle },
    conversation: { list, getMessages, updateTitle, create },
    model: { setActive: vi.fn() }
  }
}

const { useChatStore } = await import('./chat-store')
type StreamingState = import('./chat-store').StreamingState
const { usePlanStore } = await import('./plan-store')

// plan-store's loader is fire-and-forget from selectConversation and would
// otherwise reach for IPC namespaces this stub does not carry.
usePlanStore.setState({ loadForConversation: vi.fn(async () => {}) } as never)

/** A live stream slot, shaped like sendMessage builds one. */
function streamSlot(overrides: Partial<StreamingState> = {}): StreamingState {
  return {
    isStreaming: true,
    streamingContent: '',
    streamingReasoning: '',
    streamingDocuments: [],
    streamStartedAt: 1000,
    lastActivityAt: 1000,
    streamingVitals: null,
    runPhase: 'understanding',
    toolCalls: [],
    ...overrides
  }
}

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function resetStore() {
  useChatStore.setState({
    conversations: [],
    streams: {},
    activeConversationId: null,
    messages: [],
    messageQueue: [],
    isStreaming: false,
    streamingConversationId: null,
    streamingContent: '',
    streamingReasoning: '',
    streamingDocuments: [],
    streamStartedAt: null,
    lastActivityAt: null,
    streamingVitals: null,
    toolCalls: [],
    toolCallsByMessageId: {},
    pendingAttachments: [],
    runPhase: null
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  list.mockResolvedValue({ success: true, data: [] })
  getMessages.mockResolvedValue({ success: true, data: [] })
  updateTitle.mockResolvedValue({ success: true, data: null })
  resetStore()
})

// ───────────────────────────────────────────────────────────────────────────
// D1 — the send promise settles at TURN END, so `activeConversationId` at that
// moment is whatever the user is looking at, not the conversation the turn
// belonged to. Anything the settle path resolves off the ACTIVE id is wrong.
// ───────────────────────────────────────────────────────────────────────────
describe('chat-store — a failed turn errors ITS OWN conversation, not the visible one', () => {
  it('does not tear down a healthy concurrent stream when another turn fails', async () => {
    const gate = deferred<{ success: false; error: string }>()
    send.mockReturnValue(gate.promise)

    useChatStore.setState({ activeConversationId: 'A', messages: [] })

    const inFlight = useChatStore.getState().sendMessage('hello from A', [])
    expect(useChatStore.getState().streams.A?.isStreaming).toBe(true)

    // The user starts a second turn in B and stays there while A is still running.
    useChatStore.setState({
      activeConversationId: 'B',
      streamingConversationId: 'B',
      isStreaming: true,
      messages: [],
      streams: { ...useChatStore.getState().streams, B: streamSlot() }
    })

    gate.resolve({ success: false, error: 'A blew up' })
    await inFlight

    const s = useChatStore.getState()
    // A's dead slot must be reaped...
    expect(s.streams.A).toBeUndefined()
    // ...and B's LIVE stream must survive. Before the fix the error was applied
    // to activeConversationId, which killed B's bubble and left A streaming
    // forever (composer locked whenever the user navigated back to A).
    expect(s.streams.B?.isStreaming).toBe(true)
    expect(s.isStreaming).toBe(true)
  })

  it('errors its own conversation when chat:send throws', async () => {
    useChatStore.setState({ activeConversationId: 'A', messages: [] })
    let rejectFn!: (e: unknown) => void
    send.mockReturnValue(
      new Promise((_res, rej) => {
        rejectFn = rej
      })
    )

    const inFlight = useChatStore.getState().sendMessage('hello from A', [])
    useChatStore.setState({
      activeConversationId: 'B',
      streamingConversationId: 'B',
      isStreaming: true,
      streams: { ...useChatStore.getState().streams, B: streamSlot() }
    })

    rejectFn(new Error('transport died'))
    await inFlight

    const s = useChatStore.getState()
    expect(s.streams.A).toBeUndefined()
    expect(s.streams.B?.isStreaming).toBe(true)
  })
})

describe('chat-store — auto-title names the conversation the turn was sent to', () => {
  it('titles the sent conversation even after the user opened a new chat', async () => {
    const gate = deferred<{ success: true; data: { conversationId: string } }>()
    send.mockReturnValue(gate.promise)

    useChatStore.setState({ activeConversationId: 'A', messages: [] })
    const inFlight = useChatStore.getState().sendMessage('what is a lamprey', [])

    // User clicks "New chat" mid-stream — createConversation swaps the active id
    // and empties the visible message list.
    useChatStore.setState({ activeConversationId: 'B', messages: [] })

    gate.resolve({ success: true, data: { conversationId: 'A' } })
    await inFlight

    // Before the fix this read `get().activeConversationId` and counted the
    // VISIBLE messages, so A was never titled (it stayed "New Chat" forever)
    // and, when B already had a turn of its own, B got renamed with A's prompt.
    expect(updateTitle).toHaveBeenCalledWith('A', 'what is a lamprey')
    expect(updateTitle).not.toHaveBeenCalledWith('B', expect.anything())
  })
})

// ───────────────────────────────────────────────────────────────────────────
// D2 — the prompt queue is global but every entry belongs to one conversation.
// ───────────────────────────────────────────────────────────────────────────
describe('chat-store — a queued prompt drains into the chat it was typed in', () => {
  it('does not fire A"s queued prompt into whatever conversation is on screen', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      streams: { A: streamSlot() },
      isStreaming: true,
      streamingConversationId: 'A'
    })
    useChatStore.getState().enqueueMessage('follow-up for A', [])

    // The user wanders off to B (not streaming) before A's turn lands.
    useChatStore.setState({ activeConversationId: 'B', isStreaming: false })

    useChatStore.getState().drainQueue()

    // Before the fix drainQueue popped the entry and called sendMessage(), which
    // resolves its target from activeConversationId — A's follow-up was posted
    // into B.
    expect(send).not.toHaveBeenCalled()
    expect(useChatStore.getState().messageQueue).toHaveLength(1)
  })

  it('still drains normally once the owning conversation is back on screen', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      streams: { A: streamSlot() },
      isStreaming: true,
      streamingConversationId: 'A'
    })
    useChatStore.getState().enqueueMessage('follow-up for A', [])
    send.mockResolvedValue({ success: true, data: { conversationId: 'A' } })

    // A's turn finished: slot gone, still on A.
    useChatStore.setState({ streams: {}, isStreaming: false, streamingConversationId: null })
    useChatStore.getState().drainQueue()

    expect(send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'A' }))
    expect(useChatStore.getState().messageQueue).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// D3 — tool calls from a background conversation.
// ───────────────────────────────────────────────────────────────────────────
describe('chat-store — tool calls land in their own conversation"s slot', () => {
  const evt = (cid: string, callId: string): ToolCallEvent => ({
    callId,
    conversationId: cid,
    serverId: 'srv',
    toolName: 'search',
    args: { q: 'x' }
  })

  it('records a background conversation"s tool call without touching the visible one', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      streams: { A: streamSlot(), B: streamSlot() },
      toolCalls: []
    })

    useChatStore.getState().addToolCall(evt('B', 'call-1'), 'B')

    const s = useChatStore.getState()
    expect(s.streams.B?.toolCalls.map((t) => t.callId)).toEqual(['call-1'])
    // Must NOT bleed into A's slot or A's visible chip.
    expect(s.streams.A?.toolCalls).toEqual([])
    expect(s.toolCalls).toEqual([])
  })

  it('resolves a background tool call"s result in the right slot', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      streams: { A: streamSlot(), B: streamSlot() }
    })
    useChatStore.getState().addToolCall(evt('B', 'call-1'), 'B')

    const result: ToolCallResultEvent = {
      callId: 'call-1',
      conversationId: 'B',
      result: 'ok',
      duration: 12
    }
    useChatStore.getState().updateToolCall(result, 'B')

    const s = useChatStore.getState()
    expect(s.streams.B?.toolCalls[0].status).toBe('success')
    expect(s.streams.B?.toolCalls[0].result).toBe('ok')
    expect(s.toolCalls).toEqual([])
  })

  it('freezes a background turn"s tool calls onto its finished message', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      streams: { A: streamSlot(), B: streamSlot() }
    })
    useChatStore.getState().addToolCall(evt('B', 'call-1'), 'B')

    const message: Message = {
      id: 'msg-b',
      role: 'assistant',
      content: 'done',
      timestamp: 5,
      conversationId: 'B'
    }
    useChatStore.getState().finishStream(message, 'B')

    expect(useChatStore.getState().toolCallsByMessageId['msg-b']?.map((t) => t.callId)).toEqual([
      'call-1'
    ])
  })
})

// ───────────────────────────────────────────────────────────────────────────
// D4 — selectConversation and in-flight history loads.
// ───────────────────────────────────────────────────────────────────────────
describe('chat-store — selectConversation and live streams', () => {
  it('keeps the live turn"s tool cards when switching INTO a streaming chat', async () => {
    const live = {
      callId: 'call-live',
      serverId: 'srv',
      toolName: 'search',
      args: {},
      status: 'running' as const
    }
    useChatStore.setState({
      activeConversationId: 'B',
      streams: { A: streamSlot({ toolCalls: [live] }) }
    })
    // Nothing persisted yet for the in-flight turn.
    getMessages.mockResolvedValue({ success: true, data: [] })

    await useChatStore.getState().selectConversation('A')

    // Before the fix history hydration ran unconditionally and replaced the live
    // list with [], so the in-flight tool cards vanished on switch-back and the
    // 'running' one never resolved.
    expect(useChatStore.getState().toolCalls.map((t) => t.callId)).toEqual(['call-live'])
    expect(useChatStore.getState().streams.A?.toolCalls.map((t) => t.callId)).toEqual(['call-live'])
  })

  it('does not drop another conversation"s history into the visible list', async () => {
    const gate = deferred<{ success: true; data: Message[] }>()
    getMessages.mockReturnValueOnce(gate.promise as never)

    useChatStore.setState({ activeConversationId: null, messages: [] })
    const pending = useChatStore.getState().selectConversation('A')

    // The user clicks B before A's history comes back.
    const bMessage: Message = {
      id: 'b1',
      role: 'assistant',
      content: 'B content',
      timestamp: 2,
      conversationId: 'B'
    }
    useChatStore.setState({ activeConversationId: 'B', messages: [bMessage] })

    gate.resolve({
      success: true,
      data: [
        { id: 'a1', role: 'assistant', content: 'A content', timestamp: 1, conversationId: 'A' }
      ]
    })
    await pending

    // Before the fix A's transcript was written into the store while B was on
    // screen — conversation A literally rendered inside conversation B.
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['b1'])
  })
})
