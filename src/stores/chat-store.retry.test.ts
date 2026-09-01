import { beforeEach, describe, expect, it, vi } from 'vitest'

// chat-store reaches for `window.api` inside its actions. The suite runs under
// the node environment (no jsdom), so stub the global BEFORE importing the store.
;(globalThis as unknown as { window: unknown }).window = { api: {} }

const { useChatStore } = await import('./chat-store')

// retryLastSend re-issues the remembered send for the failed turn's conversation.
// The transcript's turn-error notice (useChat's chat:error handler) calls this as
// its onActivate — the one-click retry a silently-dying turn never had.
describe('chat-store — retryLastSend', () => {
  let sent: Array<{ content: string; skillIds: string[] }>

  beforeEach(() => {
    sent = []
    useChatStore.setState({
      activeConversationId: 'A',
      isStreaming: false,
      lastSendByConv: { A: { content: 'hello again', skillIds: ['s1'] } },
      // Replace the heavy real sendMessage with a recorder — retryLastSend's own
      // guards (active conversation, not streaming, has a remembered send) are
      // what this suite pins.
      sendMessage: vi.fn(async (content: string, skillIds: string[]) => {
        sent.push({ content, skillIds })
      }) as never
    })
  })

  it('re-sends the remembered content for the active conversation', () => {
    useChatStore.getState().retryLastSend('A')
    expect(sent).toEqual([{ content: 'hello again', skillIds: ['s1'] }])
  })

  it('does nothing for a non-active conversation', () => {
    useChatStore.getState().retryLastSend('B')
    expect(sent).toEqual([])
  })

  it('does nothing while a stream is in flight', () => {
    useChatStore.setState({ isStreaming: true })
    useChatStore.getState().retryLastSend('A')
    expect(sent).toEqual([])
  })

  it('does nothing when no send was recorded', () => {
    useChatStore.setState({ lastSendByConv: {} })
    useChatStore.getState().retryLastSend('A')
    expect(sent).toEqual([])
  })
})
