import { beforeEach, describe, expect, it, vi } from 'vitest'

// P0 model plane — the composer picker writes a PIN for the active conversation and never a
// global setting (L5 F6: `setModel` used to rewrite settings.defaultModel through
// model.setActive). New chats start unpinned (AUTO_ENGINE); a pin picked on the home composer
// belongs to the chat created next; a retry re-runs the failed row without a second bubble.

// The real toast store schedules dismissals on window.setTimeout and the plan store reaches
// for window.api.plan on every conversation switch — neither is under test here.
vi.mock('@/stores/toast-store', () => ({
  toast: { success: () => {}, error: () => {}, warning: () => {}, info: () => {} },
  useToastStore: { getState: () => ({ show: () => 0 }) }
}))
vi.mock('@/stores/plan-store', () => ({
  usePlanStore: { getState: () => ({ loadForConversation: async () => {}, clear: () => {} }) }
}))

const setActive = vi.fn(async () => ({ success: true }))
const setConversationModel = vi.fn(async () => ({ success: true }))
const appendSystem = vi.fn(async () => ({ success: true, data: null }))
const create = vi.fn(async (model: string) => ({
  success: true,
  data: { id: 'NEW', title: '', model, createdAt: 0, updatedAt: 0, messageCount: 0 }
}))
const list = vi.fn(async () => ({ success: true, data: [] }))
const resolve = vi.fn(async () => ({ success: true, data: null }))
const send = vi.fn(async (req: { conversationId: string }) => ({ success: true, data: { conversationId: req.conversationId } }))

;(globalThis as unknown as { window: unknown }).window = {
  api: {
    model: { setActive, resolve, list: async () => ({ success: true, data: [] }) },
    conversation: { setModel: setConversationModel, appendSystem, create, list, updateTitle: async () => ({ success: true }) },
    chat: { send }
  }
}

const { useChatStore } = await import('./chat-store')
const { useModelStore } = await import('./model-store')
const { AUTO_ENGINE } = await import('@/lib/types')

beforeEach(() => {
  setActive.mockClear()
  setConversationModel.mockClear()
  appendSystem.mockClear()
  create.mockClear()
  resolve.mockClear()
  send.mockClear()
  useChatStore.setState({
    activeConversationId: 'A',
    activeModel: AUTO_ENGINE,
    pendingPin: null,
    messages: [],
    conversations: [],
    isStreaming: false,
    streams: {},
    lastSendByConv: {},
    loadConversations: vi.fn(async () => true) as never
  })
  useModelStore.setState({ models: [], resolution: null, resolvedFor: AUTO_ENGINE })
})

describe('chat-store.setModel — a per-conversation pin, never a global default', () => {
  it('writes conversation.setModel for the active chat and NEVER model.setActive', async () => {
    await useChatStore.getState().setModel('d-flash')
    expect(setConversationModel).toHaveBeenCalledWith('A', 'd-flash')
    expect(setActive).not.toHaveBeenCalled()
    expect(useChatStore.getState().activeModel).toBe('d-flash')
    // The renderer's engine view is re-resolved FOR THE PIN.
    expect(resolve).toHaveBeenCalledWith('chat', 'd-flash')
  })

  it('writes the pin even when the conversation has no messages yet (first turn is truthful)', async () => {
    useChatStore.setState({ messages: [] })
    await useChatStore.getState().setModel('a-pro')
    expect(setConversationModel).toHaveBeenCalledWith('A', 'a-pro')
    expect(appendSystem).not.toHaveBeenCalled() // no "Switched to" marker in an empty chat
  })

  it('AUTO_ENGINE clears the pin (stored as the sentinel) and resolves from policy', async () => {
    useChatStore.setState({ activeModel: 'a-pro' })
    await useChatStore.getState().setModel(AUTO_ENGINE)
    expect(setConversationModel).toHaveBeenCalledWith('A', AUTO_ENGINE)
    expect(resolve).toHaveBeenCalledWith('chat', undefined)
  })

  it('rolls the pin back when the write is refused', async () => {
    setConversationModel.mockResolvedValueOnce({ success: false, error: 'db locked' } as never)
    await useChatStore.getState().setModel('d-flash')
    expect(useChatStore.getState().activeModel).toBe(AUTO_ENGINE)
  })
})

describe('chat-store.createConversation — new chats start unpinned', () => {
  it('creates on AUTO_ENGINE without reading any global model', async () => {
    useChatStore.setState({ activeConversationId: null, activeModel: 'a-pro' })
    await useChatStore.getState().createConversation()
    expect(create).toHaveBeenCalledWith(AUTO_ENGINE)
    expect(useChatStore.getState().activeModel).toBe(AUTO_ENGINE)
  })

  it('a pin picked on the home composer (no conversation yet) is consumed by the next chat only', async () => {
    useChatStore.setState({ activeConversationId: null })
    await useChatStore.getState().setModel('d-pro')
    expect(setConversationModel).not.toHaveBeenCalled() // nothing to pin yet
    expect(useChatStore.getState().pendingPin).toBe('d-pro')
    await useChatStore.getState().createConversation()
    expect(create).toHaveBeenLastCalledWith('d-pro')
    expect(useChatStore.getState().pendingPin).toBeNull()
    useChatStore.setState({ activeConversationId: null })
    await useChatStore.getState().createConversation()
    expect(create).toHaveBeenLastCalledWith(AUTO_ENGINE)
  })
})

describe('chat-store.retryLastSend — re-runs the failed row, no duplicate bubble (L5 F9)', () => {
  it('sends the remembered content again without appending a second user message', async () => {
    useChatStore.setState({
      messages: [{ id: 'u1', role: 'user', content: 'hello again', timestamp: 1, conversationId: 'A', model: 'd-flash' }],
      lastSendByConv: { A: { content: 'hello again', skillIds: [] } }
    })
    useChatStore.getState().retryLastSend('A')
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(useChatStore.getState().messages.filter((m) => m.role === 'user')).toHaveLength(1)
    // The request itself carries the pin/sentinel — main resolves AUTO_ENGINE from policy.
    expect(send.mock.calls[0][0]).toMatchObject({ conversationId: 'A', model: AUTO_ENGINE, content: 'hello again' })
  })

  it('a fresh send of the same text (not a retry) still appends a bubble', async () => {
    useChatStore.setState({
      messages: [{ id: 'u1', role: 'user', content: 'hello again', timestamp: 1, conversationId: 'A', model: 'd-flash' }]
    })
    await useChatStore.getState().sendMessage('hello again', [])
    expect(useChatStore.getState().messages.filter((m) => m.role === 'user')).toHaveLength(2)
  })
})
