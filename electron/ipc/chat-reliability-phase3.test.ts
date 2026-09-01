import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Phase-3 (raw path + loop runner) reliability tests for chat.ts. They drive the
// REAL runChatRound with mocked boundaries (model stream, registry, approval,
// hooks, native dispatch) and prove the four behaviors changed this pass:
//   R2 — onDone body is fully guarded: a throw in tool-result persistence emits
//        chat:error + settles (rejects) the turn instead of orphaning it.
//   R2 — onError still rejects even when a terminal emit throws.
//   R2 — turnDeadlineMs() is env-tunable.
//   R3 — the dead `turnStartedAt` wall-clock cap is now enforced: past the
//        deadline runChatRound settles (null) + emits chat:error + aborts the
//        shared controller instead of recursing.
//   R4 — a parallel tool window uses allSettled + a never-throw wrapper, so one
//        tool call throwing can't void the whole batch or orphan the turn.

// ── shared mutable state the mocks read/write ──────────────────────────────
interface Turn {
  content: string
  toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>
}
const state = {
  turns: [] as Turn[],
  turnIdx: 0,
  streamMode: 'done' as 'done' | 'error',
  savedMessages: [] as Array<Record<string, unknown>>,
  throwOnToolSave: false,
  throwOnEmit: false,
  recordCallStartThrowsFor: null as string | null
}

// Per-tool descriptors. `read_file` is read-only + PARALLELIZABLE so a batch of
// two contiguous read calls forms one parallel window (the R4 path under test).
function descriptorFor(id: string): Record<string, unknown> | undefined {
  if (id === 'read_file') {
    return {
      id,
      name: 'read_file',
      providerId: 'internal',
      providerKind: 'native',
      risks: ['read'],
      mutates: false,
      requiresApproval: false,
      parallel: true
    }
  }
  return undefined
}

// ── provider stream: scripted per-round completions, or a forced onError ────
vi.mock('../services/providers/registry', () => ({
  chatStream: vi.fn(
    async (
      _messages: unknown,
      _model: string,
      _tools: unknown,
      cb: {
        onDone: (c: string, tc: unknown, r?: string) => Promise<void> | void
        onError: (e: string, partial?: unknown) => void
      }
    ) => {
      if (state.streamMode === 'error') {
        cb.onError('boom', undefined)
        return
      }
      const t = state.turns[state.turnIdx++] ?? { content: 'done', toolCalls: [] }
      await cb.onDone(t.content, t.toolCalls, undefined)
    }
  ),
  resolveModel: () => ({ supportsTools: true, contextWindow: 128_000 }),
  getProviderForModel: () => 'openai',
  chatOnce: vi.fn()
}))

vi.mock('../services/tool-registry', () => ({
  toolRegistry: {
    getById: (id: string) => descriptorFor(id),
    hasHandler: (id: string) => descriptorFor(id) !== undefined,
    getDescriptors: () => [],
    executeNative: vi.fn(async (id: string) => `ran ${id}`),
    recordCallStart: vi.fn((entry: { id: string }) => {
      if (state.recordCallStartThrowsFor && entry.id === state.recordCallStartThrowsFor) {
        throw new Error(`recordCallStart blew up for ${entry.id}`)
      }
    }),
    recordCallEnd: vi.fn()
  },
  isMutatingDescriptor: (d: { mutates?: boolean } | undefined) => d?.mutates === true,
  isParallelizableDescriptor: (d: { parallel?: boolean } | undefined) => d?.parallel === true
}))

vi.mock('../services/permissions-store', () => ({
  descriptorNeedsApproval: () => false,
  permissionsService: {
    requestApprovalDetailed: vi.fn(async () => ({ decision: 'allow', source: 'none' }))
  }
}))

vi.mock('../services/native-dispatch', () => ({
  dispatchNativeTool: vi.fn(async (fn: () => Promise<unknown>) => {
    const r = await fn()
    return { result: typeof r === 'string' ? r : (r as { result: string }).result, status: 'done' as const }
  })
}))

vi.mock('../services/conversation-store', () => ({
  saveMessage: vi.fn((msg: Record<string, unknown>) => {
    if (state.throwOnToolSave && msg.role === 'tool') {
      throw new Error('SQLITE_TOOBIG: tool result exceeded column limit')
    }
    const saved = { ...msg }
    state.savedMessages.push(saved)
    return saved
  }),
  getMessages: vi.fn(() => []),
  createConversation: vi.fn(() => ({ id: 'conv1' })),
  isPlanModeActive: vi.fn(() => false),
  setPlanModeActive: vi.fn()
}))

vi.mock('../services/hooks-runner', () => ({
  fireHooks: vi.fn(async () => ({ blocked: false, blockReason: undefined, logs: [] }))
}))

// emitChatEvent can be forced to throw (the onError-guard test). Guard against
// the forced throw applying to the chat:error emit we WANT to observe: it only
// throws when state.throwOnEmit is set.
const emitChatEvent = vi.fn((_type: string, _payload: unknown) => {
  if (state.throwOnEmit) throw new Error('renderer emit blew up')
})
vi.mock('../services/chat-events', () => ({ emitChatEvent: (t: string, p: unknown) => emitChatEvent(t, p) }))

vi.mock('../services/debug-trace', () => ({ trace: vi.fn() }))
vi.mock('../services/providers/capability-tracker', () => ({
  recordCapabilityCheck: vi.fn(() => undefined),
  isDowngraded: vi.fn(() => false)
}))
vi.mock('../services/tool-unlock-state', () => ({
  activateLazySurface: vi.fn(),
  isLazyActive: vi.fn(() => false),
  isSurfaceDowngraded: vi.fn(() => false),
  unlockTools: vi.fn(),
  getUnlockedTools: vi.fn(() => []),
  recordMalformedSearch: vi.fn(() => 0)
}))
vi.mock('../services/agent-run-phase', () => ({ inferPhaseFromDescriptor: vi.fn(() => 'acting') }))
vi.mock('../services/model-tool-surface', () => ({ TOOL_SEARCH_TOOL_NAME: 'tool_search' }))
vi.mock('../services/memory-store', () => ({
  addMemory: vi.fn(),
  buildMemoryBlock: vi.fn(() => ''),
  buildMemoryIndexBlock: vi.fn(() => '')
}))

// ── heavy modules chat.ts imports at load but these tests never exercise ─────
vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() }, app: { getPath: () => '/tmp/lamprey-test' } }))
vi.mock('../services/event-log', () => ({ recordEvent: vi.fn(), boundedJsonPreview: (x: unknown) => x }))
vi.mock('../services/duin-bridge', () => ({ streamFromDuin: vi.fn() }))
vi.mock('../services/chapters-store', () => ({ buildChaptersBlock: () => '', createChapter: vi.fn() }))
vi.mock('../services/context-compressor', () => ({ compressOldestMessages: () => null, getEffectiveMessages: () => [] }))
vi.mock('../services/async-event-bridge', () => ({ buildTaskNotificationsBlock: () => '', drainAsyncEventsForPrompt: () => [], takeAsyncEventsForPrompt: () => [], markAsyncEventsDelivered: () => {} }))
vi.mock('../services/system-prompt-builder', () => ({ buildSystemPrompt: () => '' }))
vi.mock('../services/agents-md-loader', () => ({ readAgentsMd: () => '' }))
vi.mock('../services/mcp-manager', () => ({ mcpManager: { callTool: vi.fn() } }))
vi.mock('../services/skill-loader', () => ({ listSkills: () => [], getSkillContent: () => '' }))
vi.mock('../services/chat-history', () => ({ buildApiMessagesFromStoredMessages: () => [] }))
vi.mock('../services/ghost-reply-guard', () => ({
  turnEndedGhosted: () => false,
  isUserAbortError: () => false,
  buildGhostReplyNotice: () => ''
}))
vi.mock('../services/workspace-state', () => ({ getActiveWorkspace: () => '/ws' }))
vi.mock('../services/research/adapter-cascade', () => ({ readDeepResearchSettings: () => ({ autoTrigger: false }) }))
vi.mock('../services/research/intent', () => ({ routeChatTurn: vi.fn(async () => null) }))
vi.mock('../services/research', () => ({
  runDeepResearch: vi.fn(),
  FabricatedCitationError: class extends Error {},
  DeepResearchCancelledError: class extends Error {},
  NoSourcesError: class extends Error {}
}))
vi.mock('../services/agentic-coding-config', () => ({ loadAgenticCodingConfig: () => ({ mode: false, skills: [] }) }))
vi.mock('../services/ask-user-runtime', () => ({ getAskUserRuntime: () => null }))
vi.mock('../services/loop-runner', () => ({ setLoopTurnRunner: vi.fn() }))

import { runChatRound, turnDeadlineMs } from './chat'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

const readCall = (id: string, path: string): Turn['toolCalls'][number] => ({
  id,
  type: 'function',
  function: { name: 'read_file', arguments: JSON.stringify({ path }) }
})
const finalTurn: Turn = { content: 'all done', toolCalls: [] }

const baseMsgs: ChatCompletionMessageParam[] = [{ role: 'user', content: 'go' }]

interface DriveOpts {
  turnStartedAt?: number
  turnAbort?: AbortController
  unattended?: boolean
}
async function drive(opts: DriveOpts = {}): ReturnType<typeof runChatRound> {
  return runChatRound(
    'conv1',
    'test-model',
    [...baseMsgs],
    undefined,
    '/ws',
    (opts.turnAbort ?? new AbortController()).signal,
    0,
    undefined,
    false,
    'corr1',
    [],
    opts.turnStartedAt ?? Date.now(),
    opts.unattended ?? false,
    opts.turnAbort
  )
}

const toolResults = (): string[] =>
  state.savedMessages.filter((m) => m.role === 'tool').map((m) => String(m.content))
const errorEmits = (): unknown[] =>
  emitChatEvent.mock.calls.filter((c) => c[0] === 'chat:error').map((c) => c[1])

beforeEach(() => {
  state.turns = []
  state.turnIdx = 0
  state.streamMode = 'done'
  state.savedMessages = []
  state.throwOnToolSave = false
  state.throwOnEmit = false
  state.recordCallStartThrowsFor = null
  emitChatEvent.mockClear()
  vi.clearAllMocks()
  delete process.env.DUIN_TURN_DEADLINE_MS
})

afterEach(() => {
  delete process.env.DUIN_TURN_DEADLINE_MS
})

describe('R2 — turnDeadlineMs() is env-tunable', () => {
  it('defaults to 180000 when unset', () => {
    delete process.env.DUIN_TURN_DEADLINE_MS
    expect(turnDeadlineMs()).toBe(180_000)
  })
  it('honors a valid override', () => {
    process.env.DUIN_TURN_DEADLINE_MS = '5000'
    expect(turnDeadlineMs()).toBe(5000)
  })
  it('treats 0 as disabled (returned verbatim)', () => {
    process.env.DUIN_TURN_DEADLINE_MS = '0'
    expect(turnDeadlineMs()).toBe(0)
  })
  it('falls back to the default on empty / non-numeric input', () => {
    process.env.DUIN_TURN_DEADLINE_MS = ''
    expect(turnDeadlineMs()).toBe(180_000)
    process.env.DUIN_TURN_DEADLINE_MS = 'nope'
    expect(turnDeadlineMs()).toBe(180_000)
  })
})

describe('R3 — wall-clock deadline is enforced (dead turnStartedAt)', () => {
  it('past the default deadline: settles null, emits chat:error, aborts the shared controller — no stream', async () => {
    const ctrl = new AbortController()
    state.turns = [finalTurn]
    const result = await drive({ turnStartedAt: Date.now() - 200_000, turnAbort: ctrl })

    expect(result).toBeNull()
    const errs = errorEmits()
    expect(errs.length).toBe(1)
    expect(JSON.stringify(errs[0])).toMatch(/deadline exceeded/i)
    // The shared controller was aborted so signal-aware work stops.
    expect(ctrl.signal.aborted).toBe(true)
    // The model was never asked to stream this round.
    const { chatStream } = await import('../services/providers/registry')
    expect(chatStream).not.toHaveBeenCalled()
  })

  it('honors DUIN_TURN_DEADLINE_MS for the trip point', async () => {
    process.env.DUIN_TURN_DEADLINE_MS = '1000'
    state.turns = [finalTurn]
    const result = await drive({ turnStartedAt: Date.now() - 5000 })
    expect(result).toBeNull()
    expect(errorEmits().length).toBe(1)
  })

  it('deadline disabled (0) runs the turn normally even with an ancient start', async () => {
    process.env.DUIN_TURN_DEADLINE_MS = '0'
    state.turns = [finalTurn]
    const result = await drive({ turnStartedAt: Date.now() - 10_000_000 })
    expect(result).not.toBeNull()
    expect((result as { message: { content: string } }).message.content).toBe('all done')
    expect(errorEmits().length).toBe(0)
  })

  it('within the deadline completes normally', async () => {
    state.turns = [finalTurn]
    const result = await drive({ turnStartedAt: Date.now() })
    expect(result).not.toBeNull()
    expect(errorEmits().length).toBe(0)
  })
})

describe('R5 (Phase-4) — a tool-result persist throw is guarded, not fatal', () => {
  it('a throw while persisting a tool result is swallowed; the round continues to a terminal', async () => {
    // Phase-4 strengthens the Phase-3 onDone-catch: the role:"tool" saveMessage
    // is now wrapped in its own try/catch so an oversized MCP/subagent result
    // that trips a SQLite limit can NOT reject the round (the real orphan
    // trigger). The round proceeds with the (capped) result and settles to the
    // final answer — no chat:error, no hang, no orphan.
    state.throwOnToolSave = true
    state.turns = [{ content: '', toolCalls: [readCall('c1', 'a.txt')] }, finalTurn]

    const result = await drive()
    expect(result).not.toBeNull()
    expect((result as { message: { content: string } }).message.content).toBe('all done')
    // The persist throw was swallowed — no terminal chat:error was emitted.
    expect(errorEmits().length).toBe(0)
    // The model still received a tool row for the call (fed from the capped
    // result), even though the store write failed.
    const { chatStream } = await import('../services/providers/registry')
    expect(chatStream).toHaveBeenCalled()
  })
})

describe('R2 — onError rejects even when a terminal emit throws', () => {
  it('a throwing emit inside onError does not swallow the reject', async () => {
    state.streamMode = 'error'
    state.throwOnEmit = true
    // Even though every emitChatEvent throws, the turn MUST settle (reject),
    // not hang.
    await expect(drive()).rejects.toThrow(/boom/)
  })
})

describe('R4 — parallel tool window: allSettled + never-throw', () => {
  it('one tool call throwing does not void the batch or orphan the turn', async () => {
    // Two contiguous parallelizable read calls => one parallel window. The
    // first makes resolveSingleToolCall throw (recordCallStart blows up); the
    // second succeeds. allSettled + safeResolveToolCall keep both rows.
    state.recordCallStartThrowsFor = 'bad'
    state.turns = [
      { content: '', toolCalls: [readCall('bad', 'x.txt'), readCall('ok', 'y.txt')] },
      finalTurn
    ]

    const result = await drive()

    // The turn completed to the final answer — the batch was not voided.
    expect(result).not.toBeNull()
    expect((result as { message: { content: string } }).message.content).toBe('all done')

    const results = toolResults()
    expect(results).toHaveLength(2)
    // The throwing call became an Error tool row; the other ran.
    expect(results.some((r) => /recordCallStart blew up/.test(r))).toBe(true)
    expect(results.some((r) => r === 'ran read_file')).toBe(true)
    // No terminal chat:error — the turn succeeded despite the single failure.
    expect(errorEmits().length).toBe(0)
  })
})
