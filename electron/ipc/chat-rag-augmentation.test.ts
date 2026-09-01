import { describe, it, expect, beforeEach, vi } from 'vitest'

// Regression test for the dead RAG chat-augmentation layer.
//
// `augmentForChat` is documented as "the single entry point the chat handler
// calls to enrich a turn with retrieved context", and three production comments
// (file-handler.ts:86, ipc/rag.ts:535/543, chat-store.ts:206) describe it as
// live — but it had ZERO importers repo-wide. Attached documents were ingested,
// chipped in the UI, and then never reached the model. This test drives the real
// `runHeadlessTurn` (the function `chat:send` delegates to) and asserts that the
// retrieved block lands in the system prompt handed to the provider.
//
// Before the fix both assertions fail: augmentForChat is never called, and
// buildSystemPrompt has no retrieved-context parameter to receive it.

const state = {
  augmentCalls: [] as Array<Record<string, unknown>>,
  systemPromptArgs: [] as unknown[][],
  augmentResult: null as unknown,
  augmentThrows: false
}

// ── the two modules under test ──────────────────────────────────────────────
vi.mock('../services/rag/chat-augmentation', () => ({
  augmentForChat: vi.fn(async (opts: Record<string, unknown>) => {
    state.augmentCalls.push(opts)
    if (state.augmentThrows) throw new Error('embedder worker died')
    return state.augmentResult
  })
}))

vi.mock('../services/system-prompt-builder', () => ({
  buildSystemPrompt: vi.fn((...args: unknown[]) => {
    state.systemPromptArgs.push(args)
    // Mirror the real builder closely enough to prove end-to-end delivery: the
    // retrieved block is the 12th positional parameter.
    const retrieved = args[11]
    return ['SYSTEM', typeof retrieved === 'string' ? retrieved : ''].filter(Boolean).join('\n\n')
  })
}))

// ── settings.json feeds the rag config block ────────────────────────────────
const SETTINGS = { rag: { fusedTopN: 5, citationRequired: true } }
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => JSON.stringify(SETTINGS)
}))

// ── provider: capture the assembled messages, then end the turn ─────────────
const seenMessages: unknown[][] = []
vi.mock('../services/providers/registry', () => ({
  chatStream: vi.fn(
    async (
      messages: unknown[],
      _model: string,
      _tools: unknown,
      cb: { onDone: (c: string, tc: unknown, r?: string) => Promise<void> | void }
    ) => {
      seenMessages.push(messages)
      await cb.onDone('ok', [], undefined)
    }
  ),
  resolveModel: () => ({ supportsTools: false, contextWindow: 128_000 }),
  getProviderForModel: () => 'openai',
  chatOnce: vi.fn(),
  routeModel: (m: string) => m,
  resolveCompletionModel: (m: string) => m
}))

// chat-history is the seam where the system prompt becomes an API message.
vi.mock('../services/chat-history', () => ({
  buildApiMessagesFromStoredMessages: (systemPrompt: string) => [
    { role: 'system', content: systemPrompt }
  ]
}))

// ── heavy boundaries chat.ts loads but this test does not exercise ──────────
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  app: { getPath: () => '/tmp/lamprey-test' }
}))
vi.mock('../services/tool-registry', () => ({
  toolRegistry: {
    getById: () => undefined,
    hasHandler: () => false,
    getDescriptors: () => [],
    executeNative: vi.fn(),
    recordCallStart: vi.fn(),
    recordCallEnd: vi.fn()
  },
  isMutatingDescriptor: () => false,
  isParallelizableDescriptor: () => false
}))
vi.mock('../services/conversation-store', () => ({
  saveMessage: vi.fn((m: Record<string, unknown>) => ({ ...m, id: 'msg1' })),
  getMessages: vi.fn(() => []),
  createConversation: vi.fn(() => ({ id: 'conv1' })),
  isPlanModeActive: vi.fn(() => false),
  setPlanModeActive: vi.fn()
}))
vi.mock('../services/memory-store', () => ({
  addMemory: vi.fn(),
  buildMemoryBlock: () => '',
  buildMemoryIndexBlock: () => ''
}))
vi.mock('../services/brain/brain-root', () => ({
  loadBrain: () => null,
  buildBrainGroundingBlock: () => ''
}))
vi.mock('../services/hooks-runner', () => ({
  fireHooks: vi.fn(async () => ({ blocked: false, blockReason: undefined, logs: [] }))
}))
vi.mock('../services/chat-events', () => ({ emitChatEvent: vi.fn() }))
vi.mock('../services/debug-trace', () => ({ trace: vi.fn() }))
vi.mock('../services/providers/capability-tracker', () => ({
  recordCapabilityCheck: vi.fn(),
  isDowngraded: () => false
}))
vi.mock('../services/tool-unlock-state', () => ({
  activateLazySurface: vi.fn(),
  isLazyActive: () => false,
  isSurfaceDowngraded: () => false,
  unlockTools: vi.fn(),
  getUnlockedTools: () => [],
  recordMalformedSearch: () => 0
}))
vi.mock('../services/agent-run-phase', () => ({ inferPhaseFromDescriptor: () => 'acting' }))
vi.mock('../services/model-tool-surface', () => ({ TOOL_SEARCH_TOOL_NAME: 'tool_search' }))
vi.mock('../services/event-log', () => ({
  recordEvent: vi.fn(),
  boundedJsonPreview: (x: unknown) => x
}))
vi.mock('../services/duin-bridge', () => ({ streamFromDuin: vi.fn() }))
vi.mock('../services/chapters-store', () => ({
  buildChaptersBlock: () => '',
  createChapter: vi.fn()
}))
vi.mock('../services/context-compressor', () => ({
  compressOldestMessages: () => null,
  getEffectiveMessages: () => []
}))
vi.mock('../services/async-event-bridge', () => ({
  buildTaskNotificationsBlock: () => '',
  drainAsyncEventsForPrompt: () => [],
  takeAsyncEventsForPrompt: () => [],
  markAsyncEventsDelivered: () => {}
}))
const agentsMdMock = vi.hoisted(() => ({ content: '', duplicates: false }))
vi.mock('../services/agents-md-loader', () => ({
  readAgentsMd: () => agentsMdMock.content,
  agentsMdDuplicates: () => agentsMdMock.duplicates
}))
vi.mock('../services/mcp-manager', () => ({ mcpManager: { callTool: vi.fn() } }))
vi.mock('../services/skill-loader', () => ({ listSkills: () => [], getSkillContent: () => '' }))
vi.mock('../services/ghost-reply-guard', () => ({
  turnEndedGhosted: () => false,
  isUserAbortError: () => false,
  buildGhostReplyNotice: () => ''
}))
vi.mock('../services/workspace-state', () => ({ getActiveWorkspace: () => '/ws' }))
vi.mock('../services/research/adapter-cascade', () => ({
  readDeepResearchSettings: () => ({ autoTrigger: false })
}))
vi.mock('../services/research/intent', () => ({ routeChatTurn: vi.fn(async () => null) }))
vi.mock('../services/research', () => ({
  runDeepResearch: vi.fn(),
  FabricatedCitationError: class extends Error {},
  DeepResearchCancelledError: class extends Error {},
  NoSourcesError: class extends Error {}
}))
vi.mock('../services/agentic-coding-config', () => ({
  loadAgenticCodingConfig: () => ({ mode: false, skills: [] })
}))
vi.mock('../services/ask-user-runtime', () => ({ getAskUserRuntime: () => null }))
vi.mock('../services/loop-runner', () => ({ setLoopTurnRunner: vi.fn() }))
vi.mock('../services/act/external-action', () => ({
  setActExecContext: vi.fn(),
  clearActExecContext: vi.fn()
}))
vi.mock('../services/brain-history', () => ({ buildBrainHistory: () => [] }))
vi.mock('../services/capture-hook', () => ({ runCaptureHook: vi.fn() }))
vi.mock('./chat-validation', () => ({ validateChatSendRequest: () => ({ ok: true }) }))

import { runHeadlessTurn } from './chat'
import { augmentForChat } from '../services/rag/chat-augmentation'

const RETRIEVED = [
  '<retrieved_context>',
  '  <source id="1" name="spec.pdf" page="12">The retry budget is 3 attempts.</source>',
  '</retrieved_context>'
].join('\n')

const turn = (promptBody: string): Promise<unknown> =>
  runHeadlessTurn({
    conversationId: 'conv1',
    model: 'gpt-4o',
    correlationId: 'corr-1',
    promptBody,
    suppressDoneEvent: true
  })

beforeEach(() => {
  state.augmentCalls = []
  state.systemPromptArgs = []
  state.augmentThrows = false
  state.augmentResult = {
    retrievalId: 'ret-1',
    context: { block: RETRIEVED, sourceMap: [{ id: 1 }] },
    chunks: [],
    scopes: ['col-1'],
    stats: { lexHitsTotal: 1, vecHitsTotal: 1, durationMs: 4 }
  }
  seenMessages.length = 0
  agentsMdMock.content = ''
  agentsMdMock.duplicates = false
})

// BRAIN.md is both DUIN's operating-instructions file and the second entry of
// the brain identity block, read by two independent loaders off two
// independently-resolved roots. It used to ship in both, spending the file's
// whole length twice and putting two potentially-disagreeing copies of the
// contract in one prompt.
describe('runHeadlessTurn — the operating contract is not shipped twice', () => {
  it('passes <agents_md> through when it is a file the identity block does not have', async () => {
    agentsMdMock.content = '# BRAIN\nPropose, do not act.'
    await turn('hi')
    expect(state.systemPromptArgs[0][3]).toBe('# BRAIN\nPropose, do not act.')
  })

  it('drops the duplicate when the identity block already carries that same file', async () => {
    agentsMdMock.content = '# BRAIN\nPropose, do not act.'
    agentsMdMock.duplicates = true
    await turn('hi')
    expect(state.systemPromptArgs[0][3]).toBe('')
  })
})

describe('runHeadlessTurn — RAG augmentation is wired to the send path', () => {
  it('calls augmentForChat with the turn query, conversation, and rag settings', async () => {
    await turn('what does the spec say about the retry budget?')

    expect(augmentForChat).toHaveBeenCalled()
    expect(state.augmentCalls[0]).toMatchObject({
      conversationId: 'conv1',
      query: 'what does the spec say about the retry budget?',
      correlationId: 'corr-1',
      settings: { fusedTopN: 5, citationRequired: true }
    })
  })

  it('delivers the retrieved_context block into the prompt the model receives', async () => {
    await turn('what does the spec say about the retry budget?')

    // The block reached buildSystemPrompt...
    expect(state.systemPromptArgs[0][11]).toBe(RETRIEVED)
    // ...and survived all the way into the messages sent to the provider. This
    // is the assertion whose absence let the dead layer ship.
    const system = seenMessages[0].find(
      (m) => (m as { role?: string }).role === 'system'
    ) as { content: string }
    expect(system.content).toContain('<retrieved_context>')
    expect(system.content).toContain('The retry budget is 3 attempts.')
  })

  it('passes no block when the conversation has no attachments', async () => {
    state.augmentResult = null
    await turn('unrelated question')

    expect(state.systemPromptArgs[0][11]).toBeUndefined()
    const system = seenMessages[0].find(
      (m) => (m as { role?: string }).role === 'system'
    ) as { content: string }
    expect(system.content).not.toContain('<retrieved_context>')
  })

  it('emits no empty tag when retrieval returned zero chunks', async () => {
    state.augmentResult = {
      retrievalId: 'ret-2',
      context: { block: '', sourceMap: [] },
      chunks: [],
      scopes: ['col-1'],
      stats: { lexHitsTotal: 0, vecHitsTotal: 0, durationMs: 1 }
    }
    await turn('off-topic question')

    expect(state.systemPromptArgs[0][11]).toBeUndefined()
  })

  it('survives a retrieval failure instead of sinking the turn', async () => {
    state.augmentThrows = true
    const result = await turn('what does the spec say?')

    // Retrieval is an enrichment, not a precondition — the turn still completes.
    expect(result).not.toBeNull()
    expect(state.systemPromptArgs[0][11]).toBeUndefined()
  })
})
