import { beforeEach, describe, expect, it, vi } from 'vitest'

// chat-store reaches for `window.api` inside its actions. The suite runs under
// the node environment (no jsdom), so stub the global BEFORE importing the
// store module.
const cancel = vi.fn()
;(globalThis as unknown as { window: unknown }).window = {
  api: { chat: { cancel } }
}

const { useChatStore } = await import('./chat-store')

beforeEach(() => {
  cancel.mockClear()
  useChatStore.setState({
    activeConversationId: null,
    isStreaming: false,
    streamingConversationId: null
  })
})

describe('chat-store — cancelStream targets the streaming conversation', () => {
  it('cancels the STREAMING conversation after the user navigated to another one', () => {
    // Turn is in flight in A; the user clicked B in the sidebar. selectConversation
    // moves activeConversationId but deliberately leaves the streaming lock alone,
    // so Stop is still rendered while the two ids diverge.
    useChatStore.setState({
      activeConversationId: 'B',
      isStreaming: true,
      streamingConversationId: 'A'
    })

    useChatStore.getState().cancelStream()

    // Must be 'A'. The main handler filters strictly on conversationId, so
    // cancelling 'B' aborts nothing and A's turn keeps running tools.
    expect(cancel).toHaveBeenCalledWith('A')
    expect(cancel).not.toHaveBeenCalledWith('B')
  })

  it('cancels the active conversation when it IS the streaming one', () => {
    useChatStore.setState({
      activeConversationId: 'A',
      isStreaming: true,
      streamingConversationId: 'A'
    })

    useChatStore.getState().cancelStream()

    expect(cancel).toHaveBeenCalledWith('A')
  })

  it('falls back to the active conversation when nothing is streaming', () => {
    useChatStore.setState({
      activeConversationId: 'B',
      isStreaming: false,
      streamingConversationId: null
    })

    useChatStore.getState().cancelStream()

    expect(cancel).toHaveBeenCalledWith('B')
  })

  it('ignores a forwarded DOM event and still cancels the streaming conversation', () => {
    // Regression: the Stop button rendered onClick={onCancel}, which handed
    // cancelStream(conversationId?) the React MouseEvent as its first arg. That
    // truthy object became the abort target, so window.api.chat.cancel(<event>)
    // matched no run in the main handler (strict === on conversationId) and
    // generation kept streaming. cancelStream must treat a non-string arg as
    // "no explicit id" and fall back to the streaming conversation.
    useChatStore.setState({
      activeConversationId: 'B',
      isStreaming: true,
      streamingConversationId: 'A'
    })

    const fakeMouseEvent = {
      type: 'click',
      preventDefault: () => {},
      nativeEvent: {}
    } as unknown as string

    useChatStore.getState().cancelStream(fakeMouseEvent)

    expect(cancel).toHaveBeenCalledWith('A')
    expect(cancel).not.toHaveBeenCalledWith(fakeMouseEvent)
    expect(useChatStore.getState().isStreaming).toBe(false)
  })

  it('releases the streaming lock in every case', () => {
    useChatStore.setState({
      activeConversationId: 'B',
      isStreaming: true,
      streamingConversationId: 'A'
    })

    useChatStore.getState().cancelStream()

    expect(useChatStore.getState().isStreaming).toBe(false)
    expect(useChatStore.getState().streamingConversationId).toBeNull()
  })
})
