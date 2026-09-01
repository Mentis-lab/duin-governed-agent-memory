import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import type {
  AgentRunPhase,
  Conversation,
  DocumentAttachment,
  Message,
  ProcessedFile,
  ToolCallEvent,
  ToolCallResultEvent,
  ToolProviderKind,
  ToolRisk,
  ForkParams
} from '@/lib/types'
import { useSettingsStore } from '@/stores/settings-store'
import { useModelStore } from '@/stores/model-store'
import { usePlanStore } from '@/stores/plan-store'
import { toast } from '@/stores/toast-store'
import { useNavHistoryStore } from '@/stores/nav-history-store'
import { useBrainStore } from '@/stores/brain-store'
import { useUiStore } from '@/stores/ui-store'
import { getRecentUserPromptsFrom } from '@/lib/recent-prompts'
import { useInlineNoticesStore } from '@/stores/inline-notices-store'
import { shouldUnlinkCollection, singleFlight } from './chat-attachment-helpers'

/** The graph node a conversation is scoped to ("asking in context"). Snapshotted
 *  per-conversation so the reference survives the note being closed/deselected. */
export type ChatContextRef = { id: string; label: string; kind: string }

export interface ToolCallState {
  callId: string
  serverId: string
  toolName: string
  args: Record<string, unknown>
  status: 'pending' | 'running' | 'success' | 'error' | 'denied'
  result?: string
  duration?: number
  // Descriptor metadata mirrored from the chat:tool-call event so the
  // card renders plain-English label, risk badges, and a live elapsed
  // timer without an extra registry round-trip.
  title?: string
  risks?: ToolRisk[]
  providerKind?: ToolProviderKind
  startedAt?: number
  // True when MessageList must skip rendering a ToolUseCard for this call —
  // see LampreyToolDescriptor.transcriptHidden.
  transcriptHidden?: boolean
}

/** A rendered artifact (render_artifact output) kept so the Artifacts panel can
 *  list them for the user to re-open and inspect, instead of only ever showing
 *  the single transient one. Accumulates per conversation. */
export interface ArtifactEntry {
  id: string
  type: string
  source: string
  title?: string
  createdAt: number
}

/** One conversation's streaming slot. Concurrent streams keep per-conversation
 *  state in the `streams` map so switching to a new chat doesn't clobber (or
 *  cancel) another conversation's in-flight turn; the top-level streaming*
 *  fields mirror whichever conversation is currently in view. */
export interface StreamingState {
  isStreaming: boolean
  streamingContent: string
  streamingReasoning: string
  streamingDocuments: DocumentAttachment[]
  streamStartedAt: number | null
  lastActivityAt: number | null
  streamingVitals: {
    lastChunkAt: number
    msSinceLastChunk: number
    chunkCount: number
    tokenEstimate: number
    attemptElapsedMs: number
  } | null
  runPhase: AgentRunPhase | null
  toolCalls: ToolCallState[]
}

interface ChatState {
  conversations: Conversation[]
  /** Per-conversation streaming slots (concurrent streams). Keyed by
   *  conversation id; absent when that conversation has no live/parked turn. */
  streams: Record<string, StreamingState>
  activeConversationId: string | null
  /** The chat overlay was dismissed (X / click-outside). Lives in the store —
   *  not local to ChatView — so selecting a conversation (even the already-active
   *  one) can re-open it. Otherwise a dismissed chat can never be reopened. */
  chatDismissed: boolean
  /** The chat overlay is in its expanded (large) state. In the store rather than
   *  local to ChatView because App owns the layout gutter around the chat column
   *  and has to drop it while expanded — otherwise the expanded panel can never
   *  reach the edge of its own column (the gutter's `overflow-hidden` clips any
   *  negative margin ChatView could apply from the inside). Deliberately NOT in
   *  `partialize`: expanding is a per-session view choice, not a saved preference. */
  chatExpanded: boolean
  messages: Message[]
  isStreaming: boolean
  /** The conversation whose turn is currently streaming. Lets a terminal
   *  (done/error) event clear the streaming lock even if the user has since
   *  navigated to another conversation — otherwise isStreaming sticks true and
   *  the composer is locked for every model. */
  streamingConversationId: string | null
  streamingContent: string
  /** Live chain-of-thought captured off the provider's reasoning channel
   *  (DeepSeek `delta.reasoning_content`, OpenRouter `delta.reasoning`).
   *  Reset when a new stream starts; cleared on finishStream/streamError. */
  streamingReasoning: string
  /** Documents the model emitted via `create_document` during the current
   *  in-flight turn. Appended on `chat:document-created`; cleared on
   *  finishStream/streamError. The persisted message returned by chat:done
   *  already carries the same attachments, so the live buffer is only for
   *  rendering during the streaming bubble. */
  streamingDocuments: DocumentAttachment[]
  streamStartedAt: number | null
  /** Wall-clock of the LAST real stream activity (content OR reasoning chunk).
   *  Refreshed on every appendStreamChunk / appendReasoningChunk so the renderer
   *  stall-watchdog can measure time-since-last-activity on the DEFAULT brain path
   *  too — which never emits streaming-vitals (only the raw provider path does).
   *  Without this the watchdog degrades to the static turn-start time and
   *  force-aborts healthy long/large brain turns. */
  lastActivityAt: number | null
  /** T4 — last streaming-vitals heartbeat (lastChunkAt, chunkCount, etc.).
   *  Null when no stream is active or the provider hasn't fired a heartbeat
   *  yet. Drives the "Ns since last chunk" indicator in the streaming pill. */
  streamingVitals: {
    lastChunkAt: number
    msSinceLastChunk: number
    chunkCount: number
    tokenEstimate: number
    attemptElapsedMs: number
  } | null
  activeModel: string
  /** Composer reasoning-effort selection. Sent per turn; the backend falls back
   *  to the settings global default when omitted. Only meaningful for reasoning
   *  models (the composer hides the control otherwise). */
  reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  toolCalls: ToolCallState[]
  /** Per-turn tool calls keyed by the owning assistant message id — powers each
   *  completed turn's inline TurnActivityTimeline. Live turn uses `toolCalls`. */
  toolCallsByMessageId: Record<string, ToolCallState[]>
  /** Artifacts rendered this conversation (newest last), so the Artifacts panel
   *  can list them for re-opening. Reset on conversation switch, not per turn. */
  artifacts: ArtifactEntry[]
  pendingAttachments: ProcessedFile[]
  attachmentsProcessing: boolean
  // Codex-style run-phase pill source. Null when no run is active; set by the
  // chat:phase IPC stream from electron/ipc/chat.ts. Cleared on terminal
  // phases (done/error) so the pill disappears when the model finishes.
  runPhase: AgentRunPhase | null

  loadConversations: (signal?: AbortSignal) => Promise<boolean>
  selectConversation: (id: string) => Promise<void>
  setChatDismissed: (dismissed: boolean) => void
  setChatExpanded: (expanded: boolean) => void
  createConversation: () => Promise<string>
  forkFromMessage: (messageId: string, opts?: Partial<ForkParams>) => Promise<string | null>
  deleteConversation: (id: string) => Promise<void>
  sendMessage: (content: string, activeSkillIds: string[]) => Promise<void>
  /** Last sendMessage input per conversation, kept so a failed turn's transcript
   *  notice can offer one-click retry (chat:error renders a TranscriptNotice
   *  whose onActivate calls retryLastSend). In-memory only — a retry after an
   *  app restart just means re-typing, which is the pre-existing behavior. */
  lastSendByConv: Record<string, { content: string; skillIds: string[] }>
  retryLastSend: (conversationId: string) => void
  /** Node the chat is scoped to, PINNED per conversation. Snapshotted from the
   *  live graph selection (brain-store.chatContext) on the first context-bearing
   *  turn and reused every turn after — so closing/deselecting the note does NOT
   *  drop the reference. Cleared only by the "✕" on the context chip. */
  conversationContexts: Record<string, ChatContextRef>
  clearConversationContext: (conversationId: string | null) => void
  // Prompt queue — line up messages while a turn is streaming; each drains
  // automatically when the current turn finishes (success OR error).
  // `conversationId` is stamped at enqueue time: the queue is one global list
  // but every entry belongs to the chat it was typed into, and drainQueue
  // resolves its target from activeConversationId. Without the stamp, walking
  // away from a streaming conversation posted its queued follow-up into
  // whatever chat happened to be on screen when the turn landed.
  messageQueue: Array<{ content: string; skillIds: string[]; conversationId: string | null }>
  enqueueMessage: (content: string, skillIds: string[]) => void
  removeQueued: (index: number) => void
  clearQueue: () => void
  drainQueue: () => void
  /** Edit a queued prompt's text in place (durable — the queue is persisted). */
  editQueued: (index: number, content: string) => void
  /** Move a queued prompt from one position to another (drag-reorder the chips). */
  reorderQueue: (from: number, to: number) => void
  /** "Send now" a queued prompt: dispatch it immediately when idle, else float it to the front so
   *  it drains first when the current turn ends (a second concurrent turn on one conversation is
   *  not supported, so we never start one over a live stream). */
  sendQueuedNow: (index: number) => void
  /** Composer STEERING — inject `content` into the FOREGROUND running turn (chat:steer). When no
   *  live run catches it (race: the turn just ended), fall back to enqueuing a durable new turn. */
  steerActiveTurn: (content: string, skillIds?: string[]) => Promise<void>
  cancelStream: (conversationId?: string) => void
  setModel: (model: string) => Promise<void>
  setReasoningEffort: (effort: 'low' | 'medium' | 'high' | 'max') => void
  addArtifact: (entry: ArtifactEntry) => void
  appendStreamChunk: (content: string, conversationId?: string) => void
  appendReasoningChunk: (content: string, conversationId?: string) => void
  appendStreamingDocument: (doc: DocumentAttachment, conversationId?: string) => void
  finishStream: (message: Message, conversationId?: string) => void
  streamError: (error: string, conversationId?: string) => void
  /** Release the streaming lock WITHOUT appending a message — used when a
   *  terminal event arrives for a stream the user has navigated away from. */
  resetStreaming: (conversationId?: string) => void
  /** Clear ONLY the visible streamed answer body mid-stream — the brain is
   *  re-generating clean prose after discarding a tool-call preamble. Keeps the
   *  stream lock, reasoning, tool cards, and vitals intact (the turn continues). */
  resetStreamBuffer: (conversationId?: string) => void
  setStreamingVitals: (
    v: ChatState['streamingVitals'],
    conversationId?: string
  ) => void
  addToolCall: (event: ToolCallEvent, conversationId?: string) => void
  updateToolCall: (event: ToolCallResultEvent, conversationId?: string) => void
  clearToolCalls: () => void
  setRunPhase: (phase: AgentRunPhase | null, conversationId?: string) => void
  addAttachments: (files: ProcessedFile[]) => void
  removeAttachment: (index: number) => void
  clearAttachments: () => void
  setAttachmentsProcessing: (v: boolean) => void
  /**
   * Fluidity J1: most-recent-first list of the user's prior prompts in the
   * active conversation. Used by ChatInput's ↑/↓ history walker. Strips the
   * attachment-block suffix that buildAttachmentBlock appends at send time
   * so the recalled text is what the user originally typed.
   */
  getRecentUserPrompts: (limit?: number) => string[]
  /** Dispatcher for RAG ingest progress events. Wired in App.tsx from
   *  window.api.rag.document.onProgress so the store doesn't own the IPC
   *  subscription lifecycle. */
  _updateRagAttachmentProgress: (event: {
    jobId: string
    documentId: string
    phase: string
    progress: number
    chunkCount?: number
    error?: string
  }) => void
}

function extOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

function buildAttachmentBlock(file: ProcessedFile): string {
  if (file.error) return `\n\n[Attachment ${file.name}: ${file.error}]`
  if (file.kind === 'text') {
    const lang = extOf(file.name)
    const open = lang ? '```' + lang : '```'
    const close = '```'
    return '\n\n[Attachment ' + file.name + ']\n' + open + '\n' + file.content + '\n' + close
  }
  if (file.kind === 'pdf') {
    return `\n\n[PDF ${file.name}]\n${file.content || '(no extractable text)'}`
  }
  if (file.kind === 'binary') {
    return `\n\n[Attachment ${file.name}: ${file.previewText || 'binary file, content not included.'}]`
  }
  if (file.kind === 'rag-pending') {
    // The file's content reaches the model via augmentForChat's
    // <retrieved_context> block at chat-send time, not inline here. We
    // leave a one-line marker so the model knows a corpus is attached
    // and can reason about citation expectations even before the first
    // <retrieved_context> arrives.
    const phase = file.ragPhase ?? 'queued'
    if (phase === 'ready') {
      return `\n\n[Indexed corpus: ${file.name} — ${file.ragChunkCount ?? '?'} chunks available via retrieval]`
    }
    if (phase === 'error') {
      return `\n\n[Attachment ${file.name}: indexing failed${file.error ? ` — ${file.error}` : ''}]`
    }
    return `\n\n[Indexing ${file.name} — chunks not yet available for this turn]`
  }
  if (file.kind === 'image') {
    // OCR (flag-gated upstream): when the main-process file handler extracted
    // text from the image, surface it as a groundable text block. Without OCR
    // text an image still contributes nothing here (the vision path carries it),
    // so this falls through to the empty return exactly as before.
    if (file.ocrText) {
      return `\n\n[Image "${file.name}" — extracted text]\n${file.ocrText}`
    }
    return ''
  }
  return ''
}

// One-way migration for the retired `raw:` model-id prefix. The Advanced
// "talk to a raw model" picker rows are gone — no UI can emit the prefix —
// but a conversation.model column or defaultModel written while they existed
// can still carry it. Strip it once at every read boundary so the store only
// ever holds plain catalog ids; never write the prefix back.
const stripRetiredRawPrefix = (id: string): string =>
  id.startsWith('raw:') ? id.slice('raw:'.length) : id

// Persist fallback for non-browser environments (the store is imported under a node-only test env
// with no localStorage). An in-memory StateStorage keeps persist a harmless no-op there instead of
// throwing at import time; the real app always resolves window.localStorage below.
const memoryStorage: StateStorage = (() => {
  const m = new Map<string, string>()
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => {
      m.set(k, v)
    },
    removeItem: (k) => {
      m.delete(k)
    }
  }
})()

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === 'string' && err.trim()) return err
  return fallback
}

// Walk a freshly-loaded message list and synthesize ToolCallState entries
// for every recorded tool invocation, pairing each assistant tool_call with
// its matching tool-role result message. Used by selectConversation so the
// ToolActivityChip re-populates on conversation reopen — without this the
// chip stays empty until a new live event arrives, hiding every prior turn's
// work from the user. Descriptor metadata (title, risks, providerKind) is
// not persisted, so historical entries leave those undefined; the cards
// gracefully fall back to toolName + args.
function hydrateToolCallsFromHistory(messages: Message[]): ToolCallState[] {
  const resultsByCallId = new Map<
    string,
    { result: string; timestamp: number }
  >()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultsByCallId.set(m.toolCallId, {
        result: m.content,
        timestamp: m.timestamp
      })
    }
  }
  const out: ToolCallState[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    for (const tc of m.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(tc.function.arguments)
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        // Arguments string isn't valid JSON — leave args empty. ToolUseCard
        // renders the raw arguments string as a fallback when args is empty.
      }
      const r = resultsByCallId.get(tc.id)
      out.push({
        callId: tc.id,
        // Descriptor data isn't persisted; 'history' is a neutral marker that
        // tells the renderer this entry came from a reopen, not a live run.
        serverId: 'history',
        toolName: tc.function.name,
        args,
        status: r ? 'success' : 'error',
        result: r?.result,
        startedAt: m.timestamp,
        duration: r ? Math.max(0, r.timestamp - m.timestamp) : undefined
      })
    }
  }
  return out
}

// Same synthesis as hydrateToolCallsFromHistory, but KEYED BY the owning
// assistant message id so each turn's TurnActivityTimeline shows only its own
// tool calls (not the flat conversation total). Persists a turn's trace inline
// after it completes / on reopen — the "leave the tool calling there so it can
// be inspected" contract.
function hydrateToolCallsByMessage(messages: Message[]): Record<string, ToolCallState[]> {
  const resultsByCallId = new Map<string, { result: string; timestamp: number }>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) {
      resultsByCallId.set(m.toolCallId, { result: m.content, timestamp: m.timestamp })
    }
  }
  const byMessage: Record<string, ToolCallState[]> = {}
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.toolCalls) continue
    const list: ToolCallState[] = []
    for (const tc of m.toolCalls) {
      let args: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse(tc.function.arguments)
        if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>
      } catch {
        // raw arguments fallback (ToolUseCard renders the string)
      }
      const r = resultsByCallId.get(tc.id)
      list.push({
        callId: tc.id,
        serverId: 'history',
        toolName: tc.function.name,
        args,
        status: r ? 'success' : 'error',
        result: r?.result,
        startedAt: m.timestamp,
        duration: r ? Math.max(0, r.timestamp - m.timestamp) : undefined
      })
    }
    if (list.length) byMessage[m.id] = list
  }
  return byMessage
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
  conversations: [],
  activeConversationId: null,
  chatDismissed: false,
  chatExpanded: false,
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
  // New/home conversation default — the DUIN brain agent, matching
  // settings.defaultModel + model-store so the composer shows the same model the
  // status bar / active-model resolve to. Per-conversation switching still wins:
  // selectConversation() overwrites this with conv.model, and setModel() persists
  // explicit user choices. Sourced from the settings store so the two stay in sync
  // instead of carrying a second hardcoded literal.
  activeModel: stripRetiredRawPrefix(useSettingsStore.getState().settings.defaultModel),
  reasoningEffort: (useSettingsStore.getState().settings as { reasoningEffort?: 'low' | 'medium' | 'high' | 'max' })
    .reasoningEffort ?? 'low',
  toolCalls: [],
  toolCallsByMessageId: {},
  artifacts: [],
  pendingAttachments: [],
  attachmentsProcessing: false,
  runPhase: null,
  streams: {},
  lastSendByConv: {},
  retryLastSend: (conversationId: string) => {
    const s = get()
    // Retry only makes sense for the conversation on screen, and never while a
    // stream is already in flight (the composer is locked then anyway).
    if (s.isStreaming || conversationId !== s.activeConversationId) return
    const last = s.lastSendByConv[conversationId]
    if (!last) return
    void get().sendMessage(last.content, last.skillIds)
  },
  conversationContexts: {},

  clearConversationContext: (conversationId: string | null) => {
    if (!conversationId) return
    set((s) => {
      if (!(conversationId in s.conversationContexts)) return {}
      const next = { ...s.conversationContexts }
      delete next[conversationId]
      return { conversationContexts: next }
    })
  },

  loadConversations: async (signal) => {
    const result = await window.api.conversation.list()
    if (signal?.aborted) return false
    if (result.success) {
      set({ conversations: result.data })
      return true
    }
    return false
  },

  selectConversation: async (id: string) => {
    // Always re-open the chat overlay when a conversation is selected (even the
    // already-active one — the user clicked it to view it). Cleared BEFORE the
    // same-id early-return so re-clicking a dismissed conversation reopens it.
    set({ chatDismissed: false })
    if (get().activeConversationId === id) return
    useNavHistoryStore.getState().push(id)
    // Sync the flat streaming-view fields from the per-conversation stream
    // slot so switching to a conversation that's mid-stream shows its live
    // streaming state (content bubble, reasoning, phase pill, tool calls).
    const stream = get().streams[id]
    set({
      activeConversationId: id,
      toolCalls: stream?.toolCalls ?? [],
      artifacts: [],
      runPhase: stream?.runPhase ?? null,
      isStreaming: stream?.isStreaming ?? false,
      streamingConversationId: stream?.isStreaming ? id : (get().streamingConversationId === id ? null : get().streamingConversationId),
      streamingContent: stream?.streamingContent ?? '',
      streamingReasoning: stream?.streamingReasoning ?? '',
      streamingDocuments: stream?.streamingDocuments ?? [],
      streamingVitals: stream?.streamingVitals ?? null,
      streamStartedAt: stream?.streamStartedAt ?? null,
      lastActivityAt: stream?.lastActivityAt ?? null
    })
    const result = await window.api.conversation.getMessages(id)
    // The user can click a THIRD conversation while this IPC is in flight (very
    // easy to do with concurrent streams — you switch to watch the other one).
    // Writing `id`'s transcript into the store at that point renders one
    // conversation's history inside another. Bail if we're no longer the
    // conversation on screen; the winning select() owns the view.
    if (get().activeConversationId !== id) return
    if (result.success) {
      // A conversation with a LIVE turn keeps the live tool cards: the in-flight
      // calls are not persisted yet, so history hydration would erase them —
      // and any card left in 'running' would never resolve, because the result
      // event is routed by conversation into the same slot we just discarded.
      const live = get().streams[id]
      set({
        messages: result.data,
        // Rehydrate the tool-activity chip from history so reopening a
        // previously-finished conversation still shows what work the model
        // did, not an empty chip. Live events from a new turn will append
        // to this list via addToolCall.
        toolCalls: live?.isStreaming ? live.toolCalls : hydrateToolCallsFromHistory(result.data),
        toolCallsByMessageId: hydrateToolCallsByMessage(result.data)
      })
    }
    const conv = get().conversations.find((c) => c.id === id)
    if (conv) {
      set({ activeModel: stripRetiredRawPrefix(conv.model) })
    }
    // Load the plan for the new active conversation. Fire-and-forget — the
    // plan checklist renders empty until the snapshot arrives, which is fine.
    void usePlanStore.getState().loadForConversation(id)
    // A prompt queued in THIS conversation is only drained by its own terminal
    // event; if that already fired while the user was elsewhere, the entry is
    // stranded. Coming back is the other moment it can safely launch.
    setTimeout(() => get().drainQueue(), 80)
  },

  createConversation: async () => {
    // Do NOT cancel in-flight streams — concurrent streams are supported.
    // The previous conversation's stream continues in the background; its
    // per-conversation stream slot keeps its state and syncs back when the
    // user returns to it.
    //
    // New chats start from the GLOBAL active model — the last explicit picker
    // choice, persisted via model.setActive — not from whichever conversation was
    // last on screen. selectConversation overwrites the composer model with the
    // viewed conversation's pin, so without this read, browsing an old chat
    // silently changed what the NEXT chat would use, and model.getActive()
    // disagreed with observable behavior (QA 2026-08-24, F7).
    let model = get().activeModel
    try {
      const active = await window.api.model.getActive()
      if (active?.success && typeof active.data === 'string' && active.data) {
        model = stripRetiredRawPrefix(active.data)
      }
    } catch {
      /* store value is the fallback */
    }
    try {
      const result = await window.api.conversation.create(model)
      if (result.success) {
        const conv = result.data
        useNavHistoryStore.getState().push(conv.id)
        set((state) => ({
          activeModel: model,
          conversations: [conv, ...state.conversations],
          activeConversationId: conv.id,
          messages: [],
          toolCalls: [],
          runPhase: null,
          // New chat is an escape hatch: never inherit a stuck streaming lock or
          // a dismissed-overlay flag from a previous hung turn.
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamStartedAt: null,
          lastActivityAt: null,
          chatDismissed: false
        }))
        // Fresh conversation starts with an empty plan; load to seed the store
        // (also drops any stale snapshot from the previous active conversation).
        void usePlanStore.getState().loadForConversation(conv.id)
        return conv.id
      }
      const msg = result.error ?? 'Could not create conversation'
      console.error('[chat-store] conversation:create failed:', msg)
      toast.error(msg)
    } catch (err) {
      const msg = errorMessage(err, 'Could not create conversation')
      console.error('[chat-store] conversation:create threw:', err)
      toast.error(msg)
    }
    return ''
  },

  forkFromMessage: async (messageId: string, opts: Partial<ForkParams> = {}) => {
    const state = get()
    const sourceConversationId = state.activeConversationId
    if (!sourceConversationId) return null
    const message = state.messages.find((m) => m.id === messageId)
    if (!message) {
      toast.error('Could not find the message to fork from')
      return null
    }
    const result = await window.api.conversation.fork({
      sourceConversationId,
      sourceMessageId: messageId,
      seedKind: opts.seedKind ?? 'message',
      seedContent: opts.seedContent ?? message.content,
      includeRagAttachments: opts.includeRagAttachments ?? true,
      workspaceMode: opts.workspaceMode ?? 'current',
      titleOverride: opts.titleOverride
    })
    if (!result.success) {
      toast.error(result.error ?? 'Could not create fork')
      return null
    }
    const nextId = (result.data as { conversationId: string }).conversationId
    await get().loadConversations()
    await get().selectConversation(nextId)
    toast.success('Fork created')
    return nextId
  },

  deleteConversation: async (id: string) => {
    const result = await window.api.conversation.delete(id)
    if (!result?.success) {
      // The handler archives the transcript before deleting and returns an error rather than proceed
      // if that write fails. Keep the conversation in the list when that happens — dropping it here
      // would show the user a deleted thread that is still in the database.
      toast.error(`Failed to delete conversation: ${result?.error ?? 'unknown error'}`)
      return
    }
    const archivePath = (result.data as { archivePath?: string | null } | null)?.archivePath
    toast.success(
      archivePath
        ? `Conversation deleted — transcript kept at ${archivePath}`
        : 'Conversation deleted'
    )
    const wasActive = get().activeConversationId === id
    set((state) => ({
      conversations: state.conversations.filter((c) => c.id !== id),
      activeConversationId: wasActive ? null : state.activeConversationId,
      messages: wasActive ? [] : state.messages,
      // Drop in-flight chat-side state for the deleted conversation so the
      // welcome screen (and any subsequent fresh conversation) starts clean
      // — without this the previous tool cards / run-phase pill / plan
      // checklist linger because ChatView mounts them unconditionally.
      toolCalls: wasActive ? [] : state.toolCalls,
      runPhase: wasActive ? null : state.runPhase
    }))
    if (wasActive) {
      // Plan store is its own zustand store; the state set above can't
      // reach it. Same lifecycle — clear when the owning conversation
      // disappears.
      usePlanStore.getState().clear()
    }
  },

  sendMessage: async (content: string, activeSkillIds: string[]) => {
    const state = get()
    let conversationId = state.activeConversationId

    if (!conversationId) {
      conversationId = await get().createConversation()
      if (!conversationId) return
    }

    // A fresh send supersedes any prior failed-turn notice for this conversation,
    // and is remembered so that notice's one-click retry can re-issue it.
    useInlineNoticesStore.getState().dismiss(conversationId, `turn-error-${conversationId}`)
    set((s) => ({
      lastSendByConv: {
        ...s.lastSendByConv,
        [conversationId as string]: { content, skillIds: activeSkillIds }
      }
    }))

    // Resolve attachments + vision check. activeModel is always a plain catalog
    // id here: the retired `raw:` prefix is stripped once at the read
    // boundaries (initial value + selectConversation), never carried.
    const pending = state.pendingAttachments
    const baseModelId = state.activeModel
    const allModels = useModelStore.getState().models
    // `duin-brain` is a SENTINEL, not a model — it never calls a provider itself
    // (registry.ts: its `provider` field is cosmetic). The brain picks the real
    // engine in resolveAnswerModel(): an explicit `brainEngine`, else
    // `defaultModel`. So the sentinel's own catalog flag says nothing about
    // whether this turn can see an image — resolve it to the ENGINE and read
    // that model's capability instead. Mirroring the brain's own precedence
    // keeps one source of truth rather than inventing a second.
    const resolveEngineId = (id: string): string => {
      if (id !== 'duin-brain') return id
      const s = useSettingsStore.getState().settings
      const engine = typeof s.brainEngine === 'string' && s.brainEngine !== 'auto' ? s.brainEngine : ''
      const candidate = engine || (typeof s.defaultModel === 'string' ? s.defaultModel : '')
      // `defaultModel` itself DEFAULTS to the sentinel, so on a stock install this
      // resolves to nothing. That is not a failure — it means the brain will pick
      // via its tier policy, which the renderer genuinely cannot see.
      return candidate && candidate !== 'duin-brain' ? candidate : ''
    }
    const engineId = resolveEngineId(baseModelId)
    // Guard the empty id: `find(m => m.id === '')` would match a malformed custom
    // model row and read ITS capability.
    const modelInfo = engineId ? allModels.find((m) => m.id === engineId) : undefined
    const images = pending.filter((f) => f.kind === 'image')

    // Three-state capability, not two. The renderer can be CERTAIN a model sees,
    // CERTAIN it doesn't, or genuinely NOT KNOW — the last case is the default
    // install (`defaultModel: 'duin-brain'`, `brainEngine: 'auto'`), where the
    // engine is chosen by a tier policy the renderer has no view of.
    //
    // Collapsing "unknown" into "cannot see" is what makes a feature look dead:
    // every image on a stock install would be dropped even with a vision model
    // keyed and ready. So when in doubt, SEND — the brain re-resolves the engine
    // and strips the images itself if it can't use them, emitting a STEP that
    // says why. It is the only layer that actually knows.
    const visionCertain = modelInfo?.supportsVision === true
    const visionImpossible = modelInfo?.supportsVision === false
    const visionPossible = !visionImpossible // certain OR unknown

    // Only images that can neither be seen NOR read are truly lost.
    const droppedImages = visionPossible ? [] : images.filter((f) => !f.ocrText)
    if (droppedImages.length > 0) {
      const label = modelInfo?.name ?? state.activeModel
      toast.warning(
        `${label} does not support images — ${droppedImages.length} image attachment${droppedImages.length === 1 ? '' : 's'} dropped.`
      )
    }

    const visionImages = visionPossible
      ? images
          .filter((f) => !!f.content && f.content.startsWith('data:'))
          .map((f) => ({ mimeType: f.mimeType, dataUrl: f.content }))
      : []

    // ── Note-context pinning ───────────────────────────────────────────────
    // The note the chat is "about" must survive the note being closed /
    // deselected. Read the LIVE graph selection once, PIN it to this
    // conversation, then reuse the pinned reference on every subsequent turn —
    // even after brain-store.chatContext goes null. Without this, deselecting a
    // note dropped the reference from the very next turn and the brain lost the
    // thread (it fell back to guessing from "recent notes").
    const liveContext = useBrainStore.getState().chatContext
    if (liveContext) {
      set((s) => ({
        conversationContexts: { ...s.conversationContexts, [conversationId]: liveContext }
      }))
    }
    const pinnedContext = liveContext ?? get().conversationContexts[conversationId] ?? null
    const contentWithContext = pinnedContext
      ? `About the ${pinnedContext.kind} "${pinnedContext.label}": ${content}`
      : content

    // Non-image attachments, plus — on a NON-vision model only — any image that
    // carries OCR text (its extracted text becomes a groundable block via
    // buildAttachmentBlock). Flag-off ⇒ no image has ocrText ⇒ this is exactly
    // the old non-image set, same order.
    //
    // The `!supportsVision` guard is load-bearing: OCR is ON by default, so
    // without it a vision model received the SAME image twice — once as a real
    // image_url block (visionImages, above) and again as an "[Image … extracted
    // text]" block. That burned tokens and, worse, let garbled OCR sit next to
    // the picture and contradict what the model could actually see.
    // Suppress the OCR block only when we are CERTAIN the model sees the image —
    // not merely when it's possible. If the renderer guesses "vision" but the brain
    // re-resolves to a text-only engine and strips the parts, suppressing OCR here
    // would leave the turn with neither the picture nor its text. Duplicating a
    // little text in the uncertain case is cheap; losing the content is not.
    const attachmentFiles = pending.filter(
      (f) => f.kind !== 'image' || (!visionCertain && !!f.ocrText)
    )
    const attachmentBlocks = attachmentFiles.map(buildAttachmentBlock).join('')
    const augmentedContent = attachmentBlocks
      ? `${contentWithContext}${attachmentBlocks}`
      : contentWithContext
    // The user's BUBBLE shows their raw prompt — the "About the …" node-context
    // prefix is grounding for the brain (still sent below + via the context field),
    // not something to restate in the transcript on every turn.
    const displayContent = attachmentBlocks ? `${content}${attachmentBlocks}` : content

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: displayContent,
      timestamp: Date.now(),
      conversationId,
      model: state.activeModel
    }

    // Captured BEFORE the send. `chat:send` resolves at TURN END, so everything
    // after the await runs at a moment when the user may be looking at a
    // different conversation — nothing in the settle path may read
    // activeConversationId or the visible `messages` list to decide what this
    // turn was.
    const isFirstUserTurn = state.messages.filter((m) => m.role === 'user').length === 0

    const now = Date.now()
    const streamState: StreamingState = {
      isStreaming: true,
      streamingContent: '',
      streamingReasoning: '',
      streamingDocuments: [],
      streamStartedAt: now,
      lastActivityAt: now,
      streamingVitals: null,
      runPhase: 'understanding',
      toolCalls: []
    }
    set((s) => ({
      messages: [...s.messages, userMessage],
      streams: { ...s.streams, [conversationId]: streamState },
      isStreaming: true,
      streamingConversationId: conversationId,
      streamingContent: '',
      streamingReasoning: '',
      streamingDocuments: [],
      streamingVitals: null,
      streamStartedAt: now,
      lastActivityAt: now,
      toolCalls: [],
      runPhase: 'understanding',
      pendingAttachments: []
    }))

    // UB-6 (Unburdening Phase, 2026-06-10) — the per-turn agentMode override
    // died with the pipeline; every turn is single-agent.
    let result
    try {
      result = await window.api.chat.send({
        conversationId,
        model: state.activeModel,
        content: augmentedContent,
        activeSkillIds,
        // Fix 2 — thread the pinned node through to the brain so it can ground
        // on the exact note (stable id → content) instead of re-parsing the
        // "About the …" label out of the prose every turn.
        ...(pinnedContext ? { context: pinnedContext } : {}),
        // Per-conversation reasoning-effort override (only sent for reasoning
        // models; the backend falls back to the settings default otherwise).
        ...(state.reasoningEffort ? { reasoningEffort: state.reasoningEffort } : {}),
        ...(visionImages.length ? { images: visionImages } : {}),
        // The composer's permissions pill. Read from ui-store here so all three
        // send callers (ChatInput onSend, MethodsColumn, retry) carry it without a
        // new arg. The gate meets it against the env floor (pill can only tighten).
        permissionsMode: useUiStore.getState().permissionsMode,
        // Response language, read from settings so the reply is written in the operator's
        // chosen language regardless of the notes' language. 'auto'/unset → omitted → the
        // brain emits no directive (byte-for-byte the old request). The main process also
        // fills this from settings for turns that omit it, so headless paths still get one.
        ...(() => {
          const lang = useSettingsStore.getState().settings.language
          return lang === 'en' || lang === 'zh' || lang === 'ja' ? { language: lang } : {}
        })()
      })
    } catch (err) {
      const msg = errorMessage(err, 'Message failed')
      console.error('[chat-store] chat:send threw:', err)
      toast.error(msg)
      // Scope the failure to the conversation THIS turn ran in. Falling back to
      // activeConversationId reaped a healthy concurrent stream's slot (its
      // bubble vanished mid-answer) and left the failed conversation's slot
      // marked streaming forever, locking its composer on the way back.
      get().streamError(msg, conversationId)
      return
    }

    if (!result.success) {
      const msg = result.error ?? 'Message failed'
      console.error('[chat-store] chat:send failed:', msg)
      toast.error(msg)
      get().streamError(msg, conversationId)
      return
    }

    if (result.data.conversationId !== conversationId) {
      set({
        activeConversationId: result.data.conversationId,
        streamingConversationId: result.data.conversationId
      })
    }

    // Auto-title: first message sets conversation title. Both the "is this the
    // first turn?" test and the target id come from the pre-send snapshot — the
    // visible list belongs to whatever chat is on screen NOW, which after a
    // long turn is routinely a different one.
    if (isFirstUserTurn) {
      const fallback = content.slice(0, 40)
      const titleConversationId = result.data.conversationId || conversationId
      await window.api.conversation.updateTitle(titleConversationId, fallback)
      await get().loadConversations()

      // Optional AI-generated title (fire-and-forget; falls back silently on error)
      if (useSettingsStore.getState().settings.aiGeneratedTitles) {
        void window.api.chat.generateTitle(content, get().activeModel).then(async (titleResult) => {
          if (
            titleResult.success &&
            typeof titleResult.data === 'string' &&
            titleResult.data.trim()
          ) {
            await window.api.conversation.updateTitle(titleConversationId, titleResult.data.trim())
            await get().loadConversations()
          }
        })
      }
    }
  },

  cancelStream: (conversationId?: string) => {
    // Cancel the STREAMING conversation's turn (or the explicitly-passed one),
    // falling back to the active conversation only when nothing is streaming.
    // With concurrent streams the user may have navigated away from the in-flight
    // conversation, so activeConversationId is NOT necessarily the one to abort —
    // targeting it would leave the real stream running and waste tokens/tools.
    //
    // Guard: only a STRING is a real conversation id. A caller that forwards a DOM
    // event (e.g. onClick={onCancel} instead of onClick={() => onCancel()}) would
    // pass a truthy MouseEvent here; without this coercion it would become the abort
    // target and window.api.chat.cancel(<event>) matches no run (main filters by
    // strict ===), so Stop would silently abort nothing. Non-strings fall through to
    // the streaming/active fallback instead.
    const explicitId = typeof conversationId === 'string' ? conversationId : undefined
    const id = explicitId ?? get().streamingConversationId ?? get().activeConversationId ?? undefined
    if (id) {
      window.api.chat.cancel(id)
    }
    // Reset the matching stream slot, not all streaming state.
    get().resetStreaming(id)
    // Launch any queued prompt now that the stream is cancelled. finishStream /
    // streamError drain the queue on normal completion, but a user-initiated cancel
    // fired NEITHER — so a prompt queued during the stream was stranded and Stop
    // appeared to do nothing. Deferred a tick so resetStreaming's slot clear is
    // observed by drainQueue's per-conversation streaming guard.
    setTimeout(() => get().drainQueue(), 80)
  },

  setChatDismissed: (dismissed: boolean) => set({ chatDismissed: dismissed }),
  setChatExpanded: (expanded: boolean) => set({ chatExpanded: expanded }),

  setReasoningEffort: (effort: 'low' | 'medium' | 'high' | 'max') => {
    set({ reasoningEffort: effort })
    // Persist as the durable global default so the choice survives restarts and
    // the backend can fall back to it.
    void useSettingsStore.getState().updateSettings({ reasoningEffort: effort })
  },

  addArtifact: (entry: ArtifactEntry) =>
    set((s) => {
      // De-dupe by source so re-rendering the same artifact (or a fix-loop
      // retry) doesn't stack duplicate list rows; keep the newest metadata.
      const rest = s.artifacts.filter((a) => a.source !== entry.source)
      return { artifacts: [...rest, entry] }
    }),

  setModel: async (model: string) => {
    const state = get()
    const previousModel = state.activeModel
    if (previousModel === model) return
    set({ activeModel: model })
    void window.api.model.setActive(model)

    const activeId = state.activeConversationId
    const realMessageCount = state.messages.filter(
      (m) => m.role === 'user' || m.role === 'assistant'
    ).length

    if (activeId && realMessageCount > 0) {
      const info = useModelStore.getState().models.find((m) => m.id === model)
      const modelName = info?.name ?? model
      const marker = `— Switched to ${modelName} —`
      const result = await window.api.conversation.appendSystem(activeId, marker)
      if (result.success && result.data) {
        const msg = result.data as Message
        set((s) => ({ messages: [...s.messages, msg] }))
      }
      await window.api.conversation.setModel(activeId, model)
      await get().loadConversations()
    }
  },

  appendStreamChunk: (content: string, conversationId?: string) => {
    const now = Date.now()
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) return {}
      const updated: StreamingState = {
        ...prev,
        streamingContent: prev.streamingContent + content,
        lastActivityAt: now
      }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? {
          streamingContent: updated.streamingContent,
          lastActivityAt: now
        } : {})
      }
    })
  },

  resetStreamBuffer: (conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) return {}
      const updated: StreamingState = { ...prev, streamingContent: '' }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? { streamingContent: '' } : {})
      }
    })
  },

  appendReasoningChunk: (content: string, conversationId?: string) => {
    const now = Date.now()
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) return {}
      const updated: StreamingState = {
        ...prev,
        streamingReasoning: prev.streamingReasoning + content,
        lastActivityAt: now
      }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? {
          streamingReasoning: updated.streamingReasoning,
          lastActivityAt: now
        } : {})
      }
    })
  },

  appendStreamingDocument: (doc: DocumentAttachment, conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) return {}
      const updated: StreamingState = {
        ...prev,
        streamingDocuments: [...prev.streamingDocuments, doc]
      }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? { streamingDocuments: updated.streamingDocuments } : {})
      }
    })
  },

  setStreamingVitals: (v, conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    if (!cid) {
      set({ streamingVitals: v })
      return
    }
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) return { streamingVitals: v }
      const updated: StreamingState = { ...prev, streamingVitals: v }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? { streamingVitals: v } : {})
      }
    })
  },


  enqueueMessage: (content, skillIds) =>
    set((s) => ({
      messageQueue: [
        ...s.messageQueue,
        { content, skillIds, conversationId: s.activeConversationId }
      ]
    })),
  removeQueued: (index) =>
    set((s) => ({ messageQueue: s.messageQueue.filter((_, i) => i !== index) })),
  clearQueue: () => set({ messageQueue: [] }),

  editQueued: (index, content) =>
    set((s) => ({
      messageQueue: s.messageQueue.map((q, i) => (i === index ? { ...q, content } : q))
    })),

  reorderQueue: (from, to) =>
    set((s) => {
      const q = [...s.messageQueue]
      if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) return {}
      const [moved] = q.splice(from, 1)
      q.splice(to, 0, moved)
      return { messageQueue: q }
    }),

  sendQueuedNow: (index) => {
    const item = get().messageQueue[index]
    if (!item) return
    const activeId = get().activeConversationId
    const streaming = !!(activeId && get().streams[activeId]?.isStreaming)
    // Pull it out of its current slot first.
    set((s) => ({ messageQueue: s.messageQueue.filter((_, i) => i !== index) }))
    if (streaming) {
      // Can't run a second concurrent turn on this conversation — float it to the FRONT so it
      // drains first the moment the live turn finishes.
      set((s) => ({ messageQueue: [item, ...s.messageQueue] }))
    } else {
      void get().sendMessage(item.content, item.skillIds)
    }
  },

  steerActiveTurn: async (content, skillIds = []) => {
    const text = content.trim()
    if (!text) return
    // The turn to steer is the STREAMING conversation (the user may have navigated away), falling
    // back to the active one.
    const cid = get().streamingConversationId ?? get().activeConversationId
    if (!cid) {
      // Nothing live to steer — treat as a durable new turn.
      get().enqueueMessage(text, skillIds)
      setTimeout(() => get().drainQueue(), 50)
      return
    }
    const steerId = crypto.randomUUID()
    // No initializer: both branches below assign, so seeding `false` here is dead
    // (no-useless-assignment, part of trunk's 0-error lint baseline).
    let accepted: boolean
    try {
      const res = await window.api.chat.steer({ conversationId: cid, text, steerId })
      accepted = !!(res?.success && (res.data as { accepted?: boolean } | undefined)?.accepted)
    } catch (err) {
      console.error('[chat-store] chat:steer threw:', err)
      accepted = false
    }
    if (accepted) {
      // Optimistically show what was injected so the transcript reflects the mid-turn nudge. The
      // brain does not persist the steer to the conversation store, so this bubble is UI-only (it
      // clears on the next conversation reload) — acceptable for an ephemeral in-turn injection.
      const bubble: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        conversationId: cid,
        model: get().activeModel
      }
      set((s) => ({ messages: cid === s.activeConversationId ? [...s.messages, bubble] : s.messages }))
      toast.info('Steering the current turn…')
    } else {
      // Race: the turn ended before the steer landed (or the brain has resume off). Fall back to a
      // durable new turn — a VISIBLE outcome, never a silently-dropped message.
      get().enqueueMessage(text, skillIds)
      setTimeout(() => get().drainQueue(), 50)
    }
  },

  drainQueue: () => {
    const { messageQueue, activeConversationId } = get()
    // Per-conversation: only block if the ACTIVE conversation is streaming.
    // Other conversations' streams don't block this one's queue.
    if (activeConversationId && get().streams[activeConversationId]?.isStreaming) return
    if (messageQueue.length === 0) return
    // Only launch a prompt that belongs to the conversation now on screen.
    // sendMessage always targets activeConversationId, so draining another
    // conversation's entry here would post it into the wrong chat. Entries for
    // other conversations stay queued until the user returns to them
    // (selectConversation drains again).
    const index = messageQueue.findIndex(
      (q) => q.conversationId == null || q.conversationId === activeConversationId
    )
    if (index === -1) return
    const next = messageQueue[index]
    set({ messageQueue: messageQueue.filter((_, i) => i !== index) })
    void get().sendMessage(next.content, next.skillIds)
  },

  finishStream: (message: Message, conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    set((state) => {
      // No resolvable conversation to scope the slot to (no id passed and no
      // active conversation): still record the finished message + its tool
      // calls best-effort and clear the top-level streaming lock, mirroring
      // streamError's !cid escape hatch so the composer never stays locked.
      if (!cid) {
        return {
          messages: [...state.messages, message],
          toolCallsByMessageId: state.toolCalls.length
            ? { ...state.toolCallsByMessageId, [message.id]: state.toolCalls }
            : state.toolCallsByMessageId,
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        }
      }
      const prev = state.streams[cid]
      const prevToolCalls = prev?.toolCalls ?? state.toolCalls
      // Append the finished message only to the VISIBLE conversation...
      const isActive = cid === state.activeConversationId
      // ...but release the top-level streaming lock whenever we finalize the
      // conversation the lock currently tracks, even if the user navigated away
      // (otherwise isStreaming sticks true and the composer stays locked).
      const clearsLock = isActive || cid === state.streamingConversationId
      const { [cid]: _removed, ...restStreams } = state.streams
      return {
        messages: isActive ? [...state.messages, message] : state.messages,
        toolCallsByMessageId: prevToolCalls.length
          ? { ...state.toolCallsByMessageId, [message.id]: prevToolCalls }
          : state.toolCallsByMessageId,
        streams: restStreams,
        ...(clearsLock ? {
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        } : {})
      }
    })
    get().loadConversations()
    // Auto-send the next queued prompt once this turn has fully settled.
    setTimeout(() => get().drainQueue(), 80)
  },

  streamError: (_error: string, conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    set((state) => {
      if (!cid) {
        return {
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        }
      }
      const { [cid]: _removed, ...restStreams } = state.streams
      // Release the top-level lock when erroring the tracked (or active) stream,
      // even after the user navigated away — otherwise the composer stays locked.
      const clearsLock = cid === state.activeConversationId || cid === state.streamingConversationId
      return {
        streams: restStreams,
        ...(clearsLock ? {
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        } : {})
      }
    })
    setTimeout(() => get().drainQueue(), 80)
  },

  resetStreaming: (conversationId?: string) => {
    const cid = conversationId ?? get().streamingConversationId
    set((state) => {
      if (!cid) {
        return {
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        }
      }
      const { [cid]: _removed, ...restStreams } = state.streams
      // Release the top-level lock when resetting the tracked (or active) stream,
      // even after the user navigated away — otherwise isStreaming sticks true.
      const clearsLock = cid === state.activeConversationId || cid === state.streamingConversationId
      return {
        streams: restStreams,
        ...(clearsLock ? {
          isStreaming: false,
          streamingConversationId: null,
          streamingContent: '',
          streamingReasoning: '',
          streamingDocuments: [],
          streamingVitals: null,
          streamStartedAt: null,
          lastActivityAt: null,
          runPhase: null,
          toolCalls: []
        } : {})
      }
    })
  },

  addToolCall: (event: ToolCallEvent, conversationId?: string) => {
    // Route by the EVENT's conversation, not the visible one: a background
    // turn's tool calls belong in its own slot so they survive the switch back
    // and get frozen onto its finished message.
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    const toolEntry = {
      callId: event.callId,
      serverId: event.serverId,
      toolName: event.toolName,
      args: event.args,
      status: 'running' as const,
      title: event.title,
      risks: event.risks,
      providerKind: event.providerKind,
      startedAt: event.startedAt,
      transcriptHidden: event.transcriptHidden
    }
    set((state) => {
      const isActive = cid === state.activeConversationId
      const prev = state.streams[cid]
      if (!prev) {
        return isActive ? { toolCalls: [...state.toolCalls, toolEntry] } : {}
      }
      const updated: StreamingState = { ...prev, toolCalls: [...prev.toolCalls, toolEntry] }
      return {
        streams: { ...state.streams, [cid]: updated },
        // Mirror to the flat chip only for the conversation in view.
        ...(isActive ? { toolCalls: updated.toolCalls } : {})
      }
    })
  },

  updateToolCall: (event: ToolCallResultEvent, conversationId?: string) => {
    const finalStatus: ToolCallState['status'] = event.status ?? 'success'
    const cid = conversationId ?? get().activeConversationId
    if (!cid) return
    set((state) => {
      const isActive = cid === state.activeConversationId
      const prev = state.streams[cid]
      if (!prev) {
        return isActive
          ? {
              toolCalls: state.toolCalls.map((tc) =>
                tc.callId === event.callId
                  ? { ...tc, status: finalStatus, result: event.result, duration: event.duration }
                  : tc
              )
            }
          : {}
      }
      const updated: StreamingState = {
        ...prev,
        toolCalls: prev.toolCalls.map((tc) =>
          tc.callId === event.callId
            ? { ...tc, status: finalStatus, result: event.result, duration: event.duration }
            : tc
        )
      }
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? { toolCalls: updated.toolCalls } : {})
      }
    })
  },

  clearToolCalls: () => {
    set({ toolCalls: [] })
  },

  setRunPhase: (phase: AgentRunPhase | null, conversationId?: string) => {
    const cid = conversationId ?? get().activeConversationId
    if (!cid) {
      set({ runPhase: phase })
      return
    }
    set((state) => {
      const prev = state.streams[cid]
      if (!prev) {
        return { runPhase: phase }
      }
      const updated: StreamingState = { ...prev, runPhase: phase }
      const isActive = cid === state.activeConversationId
      return {
        streams: { ...state.streams, [cid]: updated },
        ...(isActive ? { runPhase: phase } : {})
      }
    })
  },

  addAttachments: (files: ProcessedFile[]) => {
    if (!files.length) return
    // Seed rag-pending files with a queued phase so the chip can render an
    // "Indexing…" state immediately, before the auto-attach IPC returns.
    const seeded = files.map((f) =>
      f.kind === 'rag-pending' && !f.ragPhase
        ? { ...f, ragPhase: 'queued' as const, ragProgress: 0 }
        : f
    )
    set((state) => ({ pendingAttachments: [...state.pendingAttachments, ...seeded] }))
    for (const f of files) {
      if (f.error) toast.warning(`${f.name}: ${f.error}`)
    }

    // Route oversized files through the RAG ingest pipeline. Fired async —
    // each call ensures a per-conversation auto-collection, submits the
    // ingest job, and stamps the returned jobId onto the matching chip so
    // progress events can update it. The auto-attach IPC requires a
    // conversationId; if none exists yet we create one first.
    // ONE conversation for the whole drop. Each file used to run its own
    // `if (!activeConversationId) await createConversation()`, so dropping N files
    // with nothing open had all N closures observe null before any of them finished
    // and create N conversations. singleFlight shares the check-then-create pair.
    const ensureConversation = singleFlight(async () => {
      const existing = get().activeConversationId
      if (existing) return existing
      return await get().createConversation()
    })
    for (const f of seeded) {
      if (f.kind !== 'rag-pending') continue
      if (!f.sourcePath) {
        console.warn('[chat-store] rag-pending file missing sourcePath:', f.name)
        continue
      }
      void (async () => {
        const convId = await ensureConversation()
        if (!convId) return
        try {
          const res = await window.api.rag.autoAttach({
            conversationId: convId,
            filePath: f.sourcePath!,
            displayName: f.name
          })
          if (!res?.success) {
            const errMsg = res?.error ?? 'auto-attach failed'
            toast.error(`${f.name}: ${errMsg}`)
            set((state) => ({
              pendingAttachments: state.pendingAttachments.map((a) =>
                a.name === f.name && a.size === f.size && a.kind === 'rag-pending'
                  ? { ...a, ragPhase: 'error' as const, error: errMsg }
                  : a
              )
            }))
            return
          }
          const { jobId, collectionId } = res.data as {
            jobId: string
            collectionId: string
          }
          set((state) => ({
            pendingAttachments: state.pendingAttachments.map((a) =>
              a.name === f.name && a.size === f.size && a.kind === 'rag-pending'
                ? { ...a, ingestJobId: jobId, collectionId }
                : a
            )
          }))
        } catch (err) {
          const msg = (err as Error)?.message ?? 'auto-attach threw'
          toast.error(`${f.name}: ${msg}`)
        }
      })()
    }
  },

  removeAttachment: (index: number) => {
    const removed = get().pendingAttachments[index]
    const remaining = get().pendingAttachments.filter((_, i) => i !== index)
    set(() => ({ pendingAttachments: remaining }))
    // If a rag-pending chip is removed mid-ingest, drop the conversation→
    // collection link so augmentForChat stops querying it. We deliberately
    // do NOT delete the ingested document — it stays in the auto-collection
    // (cheap to keep, expensive to redo); the user can re-add the file later
    // by drag-drop and the dedupe-by-hash path in ingest will reuse it.
    //
    // ...but ONLY when no other chip still needs that collection. Every oversized
    // file in one conversation shares a single auto-collection, so unlinking on any
    // removal meant removing one chip of three silently stripped RAG grounding from
    // the other two.
    if (
      removed?.kind === 'rag-pending' &&
      shouldUnlinkCollection(remaining, removed.collectionId) &&
      window.api?.rag?.attachments
    ) {
      const convId = get().activeConversationId
      if (convId) {
        void window.api.rag.attachments.remove({
          conversationId: convId,
          collectionId: removed.collectionId
        })
      }
    }
  },

  /** Internal: progress dispatcher for RAG ingest events. Wired from App.tsx
   *  to `window.api.rag.document.onProgress`. Matches by jobId; no-ops if
   *  the chip was already removed from pendingAttachments. */
  _updateRagAttachmentProgress: (event: {
    jobId: string
    documentId: string
    phase: string
    progress: number
    chunkCount?: number
    error?: string
  }) => {
    set((state) => ({
      pendingAttachments: state.pendingAttachments.map((a) => {
        if (a.kind !== 'rag-pending' || a.ingestJobId !== event.jobId) return a
        return {
          ...a,
          documentId: event.documentId || a.documentId,
          ragPhase: event.phase as ProcessedFile['ragPhase'],
          ragProgress: event.progress,
          ragChunkCount: event.chunkCount ?? a.ragChunkCount,
          error: event.error ?? a.error
        }
      })
    }))
  },

  clearAttachments: () => {
    set({ pendingAttachments: [] })
  },

  setAttachmentsProcessing: (v: boolean) => {
    set({ attachmentsProcessing: v })
  },

  getRecentUserPrompts: (limit = 50) => {
    return getRecentUserPromptsFrom(get().messages, limit)
  }
    }),
    {
      // CHEAP-WIN durability: persist ONLY the editable prompt queue, never streaming / lock state
      // (those are live-session concerns; persisting them would resurrect a stale streaming lock on
      // reload). partialize is the guard — the queue survives a reload/crash, nothing else does.
      name: 'duin-chat-store',
      partialize: (s) => ({ messageQueue: s.messageQueue }),
      // Guard the storage getter: the store is imported under a node-only test env (no localStorage).
      // Returning undefined there makes persist a safe no-op instead of throwing at import time.
      storage: createJSONStorage(() =>
        typeof window !== 'undefined' && window.localStorage ? window.localStorage : memoryStorage
      )
    }
  )
)

// Hydrate reasoningEffort from persisted settings once they load.
//
// WHY a subscription and not just the init read above: `reasoningEffort` is set
// during create() (module evaluation), which runs synchronously at import —
// BEFORE App's init effect awaits settings-store.loadSettings(). At that instant
// settings-store still holds defaultSettings, which carries no reasoningEffort
// key, so the init read always collapses to 'low'. loadSettings merges the saved
// value into settings-store only; nothing pushed it back here, so a user's saved
// 'high' was silently reset to 'low' every restart — and because 'low' is truthy
// the composer kept sending an explicit 'low' on every turn, defeating the
// backend's documented "fall back to the settings default" path too. chat-store
// already depends on settings-store (no new import cycle), so subscribing is the
// safe direction: when loadSettings (or any settings write) updates
// settings.reasoningEffort, mirror it into the composer's live value.
useSettingsStore.subscribe((state) => {
  const persisted = (state.settings as { reasoningEffort?: 'low' | 'medium' | 'high' }).reasoningEffort
  if (persisted && persisted !== useChatStore.getState().reasoningEffort) {
    useChatStore.setState({ reasoningEffort: persisted })
  }
})
