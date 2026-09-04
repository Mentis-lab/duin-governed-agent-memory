import { ipcMain, app } from 'electron'
import { randomUUID } from 'crypto'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import {
  chatOnce,
  chatStream,
  getProviderForModel,
  resolveModel,
  routeModel,
  type ModelRequestAudit,
  type ProviderId
} from '../services/providers/registry'
import { AUTO_ENGINE } from '../services/providers/roles'
import { boundedJsonPreview, recordEvent } from '../services/event-log'
import { validateChatSendRequest } from './chat-validation'
import * as convStore from '../services/conversation-store'
import { streamFromDuin, steerBrain, resolveBrainUrl } from '../services/duin-bridge'
import type { ChatSteerRequest } from '../shared/chat-send-contract'
import { imagesToParts } from '../shared/chat-send-contract'
import { setActExecContext, clearActExecContext } from '../services/act/external-action'
import { buildBrainHistory, HISTORY_EVICT_CHUNK } from '../services/brain-history'
import {
  isPlanModeActive,
  setPlanModeActive,
  type StoredDocument
} from '../services/conversation-store'
import * as memStore from '../services/memory-store'
import { getProject } from '../services/projects-store'
import { buildChaptersBlock, createChapter } from '../services/chapters-store'
import {
  compressOldestMessages,
  getEffectiveMessages
} from '../services/context-compressor'
import {
  modelCompactionEnabled,
  runModelCompaction,
  productionModelCompactionDeps,
  DETERMINISTIC_BACKSTOP_THRESHOLD_PCT
} from '../services/model-compaction'
import { providerHasPrefixCache, sortToolsStable } from '../services/providers/usage-accounting'
import {
  buildTaskNotificationsBlock,
  markAsyncEventsDelivered,
  takeAsyncEventsForPrompt
} from '../services/async-event-bridge'
import { buildSystemPrompt } from '../services/system-prompt-builder'
import { resolveToneDirective } from '../services/agent-tones'
import { loadBrain, buildBrainGroundingBlock } from '../services/brain/brain-root'
import { readAgentsMd, agentsMdDuplicates } from '../services/agents-md-loader'
import { fireHooks } from '../services/hooks-runner'
import { mcpManager } from '../services/mcp-manager'
import { listSkills, getSkillContent } from '../services/skill-loader'
import type { ResolvedSkill } from '../shared/chat-send-contract'
import { runCaptureHook } from '../services/capture-hook'
import { buildApiMessagesFromStoredMessages } from '../services/chat-history'
import { applyRuntimeSnapshotToApiMessages } from '../services/runtime-context-snapshot'
import { augmentForChat } from '../services/rag/chat-augmentation'
import { makeChatPlanner } from '../services/rag/chat-planner'
/**
 * Resolve enabled Skill IDs to their bodies. ONE implementation shared by the brain-default path
 * (forwarded to the brain as the /agui `skills` field) and the raw-bypass headless path (injected
 * as <skill> blocks by the system-prompt builder) — previously only the headless path resolved
 * them, which is why the Skills toggle did nothing on the path every normal model selection takes.
 * Unknown ids and bodyless skills are dropped rather than surfacing as a "skill not found" later.
 */
function resolveActiveSkills(ids: readonly string[]): ResolvedSkill[] {
  if (!ids.length) return []
  const known = listSkills()
  return ids
    .map((id) => {
      const skill = known.find((s) => s.id === id)
      if (!skill) return null
      const body = getSkillContent(id)
      if (!body) return null
      return {
        name: skill.name,
        content: body,
        ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
        ...(skill.description ? { description: skill.description } : {})
      } as ResolvedSkill
    })
    .filter((s): s is ResolvedSkill => s !== null)
}
import { toolRegistry, isMutatingDescriptor } from '../services/tool-registry'
import { TOOL_SEARCH_TOOL_NAME } from '../services/model-tool-surface'
import {
  activateLazySurface,
  isLazyActive,
  isSurfaceDowngraded,
  unlockTools,
  getUnlockedTools,
  recordMalformedSearch
} from '../services/tool-unlock-state'
import {
  maybeSpillToolResult,
  capToolResultChars,
  DEFAULT_SPILL_THRESHOLD
} from '../services/tool-result-spill'
import {
  partitionToolCallWindows,
  type ProviderToolCall
} from '../services/tool-call-windowing'
// SP-4 — ghost-reply guard (D5): persist a system notice when a turn fails
// before any visible reply row landed.
import {
  turnEndedGhosted,
  isUserAbortError,
  buildGhostReplyNotice
} from '../services/ghost-reply-guard'
import { permissionsService, descriptorNeedsApproval } from '../services/permissions-store'
import { inferPhaseFromDescriptor, type AgentRunPhase } from '../services/agent-run-phase'
import { getActiveWorkspace } from '../services/workspace-state'
import { classifyToolResult } from '../services/tool-result-status'
import { validateToolArguments } from '../services/tool-schema-validator'
import { detectEmptyParams } from '../services/empty-params-guard'
import { parseFallbackToolCalls } from '../services/fallback-tool-parser'
import { recordCapabilityCheck, isDowngraded } from '../services/providers/capability-tracker'
import { dispatchNativeTool } from '../services/native-dispatch'
import { toolWallClockBudgetMs } from '../services/tool-timeout'
import {
  DEFAULT_TIMEOUT_MS as SHELL_DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS as SHELL_MAX_TIMEOUT_MS
} from '../services/shell-tool'
import { emitChatEvent } from '../services/chat-events'
import { readDeepResearchSettings } from '../services/research/adapter-cascade'
import { trace } from '../services/debug-trace'
import { routeChatTurn } from '../services/research/intent'
import {
  runDeepResearch,
  FabricatedCitationError,
  DeepResearchCancelledError,
  NoSourcesError
} from '../services/research'
// UB-5 (Unburdening Phase, 2026-06-10) — the final-response composer is
// excised: the reply the user reads is the model's own reply, always. The
// R6 reasoning trail (kept, user-directed) moved to reasoning-trail.ts and
// the agentic-coding config (mode + skills, no composer) to its own module.
import { concatReasoningTrail } from '../services/reasoning-trail'
import { loadAgenticCodingConfig } from '../services/agentic-coding-config'
import { getAskUserRuntime } from '../services/ask-user-runtime'
// LP-1 (Loop Phase) — wire the headless turn runner into the loop runner.
import { setLoopTurnRunner } from '../services/loop-runner'
// Unattended action-class FLOOR (the irreversibility taxonomy). The loop path
// (loop-controller → runHeadlessTurn → runChatRound → resolveSingleToolCall)
// has its own dispatch that never consulted classifyAction, so a CAP-class act
// (send / delete / exec / financial / credential) could run with no human. This
// mirrors the floor tool-exec.ts enforces for its own headless path.
import { capFloorForDescriptor } from '../services/governance/action-class'
import {
  taintFloorForDescriptor,
  isUntrustedSource,
  getConversationTaintStore
} from '../services/governance/taint-guard'
import { ruleOfTwoCheck, noteExecutedTool, ruleOfTwoProfile } from '../services/governance/rule-of-two'
import { reviewAction } from '../services/governance/action-reviewer'
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions'
import { friendly, messageOf } from '../services/guarded'

interface ModelParams {
  temperature?: number
  topP?: number
  maxTokens?: number | null
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
}

/** Narrow an unknown to a valid reasoning-effort level (or undefined). Shared by
 *  the settings global-default read and the per-request override. */
export function readReasoningEffort(v: unknown): 'low' | 'medium' | 'high' | 'max' | undefined {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'max' ? v : undefined
}

/** Narrow a persisted `language` setting to an explicit wire choice, or undefined. The
 *  settings-level 'auto' (and anything malformed) maps to undefined → no language is
 *  forwarded and the brain emits no directive (byte-for-byte the old request). */
export function readLanguage(v: unknown): 'en' | 'zh' | 'ja' | undefined {
  return v === 'en' || v === 'zh' || v === 'ja' ? v : undefined
}

function readSettingsJson(): Record<string, unknown> | null {
  try {
    const path = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function loadModelConfig(
  raw: Record<string, unknown> | null,
  model: string
): { params: ModelParams; systemPromptOverride?: string } {
  if (!raw) return { params: {} }
  // Global reasoning-effort default (applies to every model unless a per-model
  // cfg or a per-request override supersedes it).
  const globalEffort = readReasoningEffort(raw.reasoningEffort)
  const cfg = (raw.modelConfig as Record<string, Record<string, unknown>> | undefined)?.[model]
  if (!cfg) return { params: globalEffort ? { reasoningEffort: globalEffort } : {} }
  return {
    params: {
      temperature: typeof cfg.temperature === 'number' ? cfg.temperature : undefined,
      topP: typeof cfg.topP === 'number' ? cfg.topP : undefined,
      maxTokens:
        typeof cfg.maxTokens === 'number'
          ? cfg.maxTokens
          : cfg.maxTokens === null
          ? null
          : undefined,
      reasoningEffort: readReasoningEffort(cfg.reasoningEffort) ?? globalEffort
    },
    systemPromptOverride:
      typeof cfg.systemPromptOverride === 'string' ? cfg.systemPromptOverride : undefined
  }
}

// UB-5 — the final-response composer is excised entirely; agentic-coding
// config (mode + skills) lives in `../services/agentic-coding-config`.

// Idempotent union: preserves order of `base`, then appends ids from `extra`
// that aren't already present. Used to merge auto-activated agentic skills
// into the request's activeSkillIds without duplicating user-picked entries.
export function mergeAgenticSkillIds(base: string[], extra: string[]): string[] {
  const seen = new Set(base)
  const out = [...base]
  for (const id of extra) {
    if (id && !seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

// A chat turn's runtime context. `chat:send` opens the entry, `chat:cancel`
// reads it to find the correlationId for the chat.cancelled event, and the
// catch in chat:send tears it down. The correlationId is generated here and
// threaded through every downstream producer.
interface ActiveRun {
  controller: AbortController
  correlationId: string
  conversationId: string
  startedAt: number
  // Composer STEERING. Set ONLY for the FOREGROUND brain streaming run (streamFromDuin reports its
  // runId + resolved endpoint via onRunId). Background loop / raw-path runs never set these, so
  // chat:steer — which filters by a defined runId — targets only the foreground turn, never a loop.
  runId?: string
  brainUrl?: string
}
// Keyed by correlationId (unique per turn), NOT conversationId — a single
// conversation can have more than one turn in flight (a background loop iteration
// + a manual send), and a conversationId key made the second registrant clobber
// the first's entry, leaking an un-cancellable turn and mis-deleting the wrong run.
const activeAbortControllers = new Map<string, ActiveRun>()

// Documents the model emits via `create_document` during a single chat:send
// turn. Keyed by correlationId so the buffer is stable across the recursive
// runChatRound calls and isolated between concurrent turns (parallel agent
// pipeline). The final-message branch in runChatRound drains the buffer when
// it persists the assistant row; the catch block in chat:send clears it on
// failure so a partial run does not leak into the next turn.
const pendingDocuments = new Map<string, StoredDocument[]>()

const CREATE_DOCUMENT_MAX_BYTES = 256 * 1024

function pushPendingDocument(correlationId: string | undefined, doc: StoredDocument): void {
  if (!correlationId) return
  const list = pendingDocuments.get(correlationId)
  if (list) {
    list.push(doc)
  } else {
    pendingDocuments.set(correlationId, [doc])
  }
}

function drainPendingDocuments(correlationId: string | undefined): StoredDocument[] | undefined {
  if (!correlationId) return undefined
  const list = pendingDocuments.get(correlationId)
  if (!list || list.length === 0) {
    pendingDocuments.delete(correlationId)
    return undefined
  }
  pendingDocuments.delete(correlationId)
  return list
}

// Tool definitions (memory_add + MCP tools) come from toolRegistry.
// Approval gating is owned by permissionsService — both live in services/.

// Per-stage tool-call iteration ceiling. Each runChatRound recursive call
// increments `round`; we hard-stop when the counter exceeds this. The cap
// is PER-STAGE (multi-agent pipelines reset the counter at each Planner
// / Coder / Reviewer hand-off), not per-turn — so the effective ceiling
// across a pipeline run is ~3× this number.
//
// Was 10 in 0.2.x — that tripped on routine codebase exploration where
// the planner needed 12-20 sequential reads to map a new repo. Codex
// and Claude Code allow 100+ rounds per agent loop; 50 is a generous
// midpoint that lets real work finish without going unbounded.
const MAX_TOOL_ROUNDS = 50

/**
 * R2/R3 (Phase-3) — hard wall-clock ceiling for a single raw-path turn, checked
 * at the top of every runChatRound recursion against `turnStartedAt`. Env
 * `DUIN_TURN_DEADLINE_MS`; default 180000 (mirrors the brain server's 180s
 * deadline); 0/negative disables it (unbounded — the pre-fix behaviour). Pure +
 * exported so the budget logic is unit-testable off the chat IPC path.
 */
export function turnDeadlineMs(): number {
  const rawEnv = process.env.DUIN_TURN_DEADLINE_MS
  const raw = Number(rawEnv)
  return Number.isFinite(raw) && rawEnv != null && rawEnv !== '' ? raw : 180_000
}

function emitPhase(conversationId: string, phase: AgentRunPhase): void {
  emitChatEvent('chat:phase', { conversationId, phase })
}

export function registerChatHandlers(): void {
  ipcMain.handle('chat:send', async (_event, request) => {
    // Defensive: the renderer is trusted but a malformed payload (hot
    // reload race, programmatic caller, future SDK consumer) must not
    // crash the handler. Validate the shape before doing anything.
    const validation = validateChatSendRequest(request)
    if (!validation.ok) {
      return { success: false, error: validation.error }
    }
    const { content: rawContent, model: rawModel, activeSkillIds, context: chatContext } = validation.value
    // P1 — RAW-BYPASS convention. The DUIN brain is now the always-on default
    // chat path: ANY normal model selection routes THROUGH the brain, with the
    // selected model used as the brain's generation engine. An explicit
    // `raw:`-prefixed model id (e.g. `raw:deepseek-v4-flash`) is the escape
    // hatch — "talk to the model directly, bypass the brain" — and runs the
    // built-in provider loop exactly as before. We strip the prefix here so the
    // saved `model` column, catalog lookups, and resolveModel never see it.
    //
    // 2026-08-21 — NO UI EMITS `raw:` ANY MORE. The renderer's Advanced rows
    // are deleted and chat-store strips stale persisted prefixes on read, so
    // rawBypass is reachable only by a programmatic chat:send caller. That
    // makes everything from the brain branch's `return` down to the end of
    // this handler — research routing included — dead from the UI. Its fate
    // (adopt or delete) is Lane E's one decision; do not grow it meanwhile.
    const rawBypass = rawModel.startsWith('raw:')
    const model = rawBypass ? rawModel.slice('raw:'.length) : rawModel
    // D3 — the prompt body the rest of the handler sees may have a
    // /research or --no-research prefix stripped off it. The actual
    // routing decision is made below before any model dispatch.
    let content = rawContent
    let conversationId = validation.value.conversationId

    // Hoisted so the catch block can reference it when an exception fires
    // before the regular `activeAbortControllers.set` runs. Generated here
    // (rather than after that .set) so the chat.error event always carries a
    // correlationId, even when the user typed into a conversation that
    // failed to materialise.
    const correlationId = randomUUID()

    try {
      if (conversationId === 'new' || !conversationId) {
        const conv = convStore.createConversation(model)
        conversationId = conv.id
      }

      // Deterministic learning-capture arrow. Independent of whether the chat
      // model chooses to invoke the `capture` skill (unreliable — live testing
      // showed the model may narrate "Persisted" while making no tool call), we
      // detect a correction/validation-shaped user turn reacting to the prior
      // assistant output and record it — WITH its why — into the same learn loop
      // (POST /learn/correction). Fire-and-forget: best-effort, never blocks or
      // breaks the turn. Runs before the new user message is persisted so it reads
      // the prior assistant turn, not this one.
      try {
        const prior = convStore.getMessages(conversationId)
        const lastAssistant =
          [...prior].reverse().find((m) => m.role === 'assistant')?.content ?? null
        if (lastAssistant) void runCaptureHook(lastAssistant, content, { session: conversationId })
      } catch (e) { console.debug('[chat] capture is best-effort; a failure here must never affect the chat turn:', messageOf(e)) }

      // Brain-default path. The DUIN brain is the always-on default chat path:
      // the explicit `duin-brain` connector AND every normal model selection
      // route here, bypassing the built-in provider loop + research routing and
      // streaming from the configured agent/DUIN brain (an AG-UI server, default
      // @ :8799/agui local, or an external AG-UI endpoint) via the duin-bridge
      // adapter. The
      // brain owns grounding/tools/governance; this app is the shell.
      //
      // ENGINE selection: an explicit per-conversation pin is passed to the
      // brain as its GENERATION engine; the AUTO_ENGINE sentinel (no pin) passes
      // NO model so the brain resolves the chat role from the provider policy.
      // There is no default model anywhere in this path (roles.ts).
      // Only an explicit `raw:`-prefixed selection (rawBypass) skips this and
      // falls through to the raw provider loop below.
      if (!rawBypass) {
        // The engine model handed to the brain. AUTO_ENGINE is the connector,
        // not a callable LLM — omit it so the brain routes the chat role.
        const engineModel = model === AUTO_ENGINE ? undefined : model
        // A retry of a turn that died before answering re-runs the persisted row instead of
        // appending a duplicate user message (L5 F9): when the newest stored row is a user
        // row with this exact content and nothing has answered it, it IS this turn.
        const persisted = convStore.getMessages(conversationId)
        // System markers ("— Switched to X —") sit between the failed row and the retry.
        const newest = [...persisted].reverse().find((m) => m.role !== 'system')
        const unansweredRetry = !!newest && newest.role === 'user' && newest.content === content
        // Persist the images with the turn, not just forward them in-flight.
        // Without this the model can see an attachment on the turn it arrives
        // and never again: reopening the conversation replayed a text-only
        // history, so "what did I show you?" had no answer.
        if (!unansweredRetry) {
          convStore.saveMessage({
            id: randomUUID(),
            conversationId,
            role: 'user',
            content,
            model,
            ...(validation.value.images?.length
              ? { contentParts: imagesToParts(validation.value.images) }
              : {})
          })
        }
        const duinAbort = new AbortController()
        activeAbortControllers.set(correlationId, {
          controller: duinAbort,
          correlationId,
          conversationId,
          startedAt: Date.now()
        })
        try {
          // Prefer the persisted Brain endpoint (Settings → Brain). Passing it
          // as the explicit arg keeps duin-bridge's resolveBrainUrl precedence:
          // explicit (= persisted setting) > DUIN_BRAIN_URL env > localhost
          // default. An empty/missing setting leaves brainUrl undefined so the
          // env/default path is used.
          const s = readSettingsJson()
          let persistedBrainUrl =
            typeof s?.brainUrl === 'string' ? (s.brainUrl as string).trim() || undefined : undefined
          // Durable alignment: if no explicit chat endpoint but a live GRAPH
          // endpoint is configured (an external AG-UI brain), route chat to
          // that SAME brain's /agui. Stops the chat silently falling back to the
          // local brain while the graph shows the external one (the rename /
          // profile-orphan footgun that made node-context answers come back empty).
          if (!persistedBrainUrl && typeof s?.brainGraphUrl === 'string' && (s.brainGraphUrl as string).trim()) {
            try {
              const o = new URL((s.brainGraphUrl as string).trim())
              persistedBrainUrl = `${o.protocol}//${o.host}/agui`
            } catch (e) { console.debug('[chat] malformed brainGraphUrl  leave undefined (local default):', messageOf(e)) }
          }
          // Multi-turn context: send the bounded thread (the user message was just saved
          // above, so getMessages includes it as the latest turn). Without this the brain
          // is stateless per turn — the note-follow-up context-loss bug.
          // Under the byte-stable-prefix layout the history is the CACHED prefix, so evicting one
          // message per turn would shift its front every turn and defeat the cache in exactly the
          // long threads it exists for. Evict in chunks instead, keeping the front stable between
          // steps. Flag OFF ⇒ evictChunk 0 ⇒ the original one-at-a-time window, unchanged.
          const brainHistory = buildBrainHistory(
            // Carry persisted vision parts onto the history shape so an image the
            // user attached earlier is still THERE on a later turn — that is the
            // whole point of storing them. buildBrainHistory bounds them by count
            // (HISTORY_MAX_IMAGE_MSGS), not by the char budget.
            convStore.getMessages(conversationId).map((m) => ({
              role: m.role,
              content: m.content,
              ...(m.contentParts?.length ? { parts: m.contentParts } : {})
            })),
            { evictChunk: process.env.DUIN_STABLE_PREFIX === '1' ? HISTORY_EVICT_CHUNK : 0 }
          )
          // Effective reasoning effort: per-conversation override (from the
          // composer) wins, else the global default in settings; undefined lets
          // the brain/registry apply its own 'low' default.
          const effectiveEffort = validation.value.reasoningEffort ?? readReasoningEffort(s?.reasoningEffort)
          // Effective response language: the composer's per-turn choice wins, else the
          // persisted `language` setting (so headless/loop turns that send none still get
          // one). Undefined ('auto'/unset) → no directive (byte-for-byte the old body).
          const effectiveLanguage = validation.value.language ?? readLanguage(s?.language)
          // Voice/tone preset (Settings → Voice & tone), RESOLVED here from the persisted id to its
          // directive text — same reason `skills` is resolved main-side: the settings store is a
          // main-process concern and the brain may be an EXTERNAL /agui endpoint that cannot read it.
          //
          // WHY THIS WAS INVISIBLE: the preset was only ever composed inside buildSystemPrompt, and
          // buildSystemPrompt is reached only from the raw:-bypass / headless paths — this brain
          // branch returns ~500 lines above it. So the picker persisted, the tile showed selected,
          // and every default-path reply came back in the default voice with no error at all.
          // 'balanced' (and an empty custom directive) resolve to '' → field omitted → the request
          // body is byte-for-byte what it was before.
          const voice = resolveToneDirective(
            s?.agentTone as string | undefined,
            s?.agentToneCustom as string | undefined
          )
          const activeSkills = resolveActiveSkills(validation.value.activeSkillIds ?? [])
          const r = await streamFromDuin(content, conversationId, {
            emit: emitChatEvent,
            brainUrl: persistedBrainUrl,
            history: brainHistory,
            // P1 — the user's picked model as the brain's generation engine.
            // Undefined for the bare `duin-brain` sentinel → brain auto-picks.
            ...(engineModel ? { model: engineModel } : {}),
            // The pinned node context — lets the brain ground on the exact note
            // by stable id rather than re-parsing the "About the …" prose label.
            ...(chatContext ? { context: chatContext } : {}),
            ...(effectiveEffort ? { reasoningEffort: effectiveEffort } : {}),
            // Skills the operator explicitly enabled, resolved id -> body here (the skill store is
            // a main-process concern) and injected by the brain as a floor-tier ACTIVE SKILLS
            // block. Empty list -> field omitted -> byte-for-byte the previous request body.
            ...(activeSkills.length ? { skills: activeSkills } : {}),
            // Vision images validated by validateChatSendRequest; forwarded so
            // a vision-capable brain model actually receives the image_url parts.
            ...(validation.value.images ? { images: validation.value.images } : {}),
            // Composer permissions pill — forwarded so the brain can TIGHTEN the
            // per-turn posture below the env floor (never loosen). Absent → the
            // brain uses today's env-only posture (byte-for-byte the old body).
            ...(validation.value.permissionsMode ? { permissionsMode: validation.value.permissionsMode } : {}),
            // Response language — forwarded so the brain writes the reply in it regardless
            // of the notes' language. Absent → no directive (byte-for-byte the old body).
            ...(effectiveLanguage ? { language: effectiveLanguage } : {}),
            // Voice/tone directive — forwarded so the brain injects the same <voice> block the
            // raw:/headless path already gets. Absent → no block (byte-for-byte the old body).
            ...(voice ? { voice } : {}),
            // Composer STEERING — record this foreground turn's runId + endpoint on the ActiveRun so
            // a later chat:steer can fire a beacon at it. Only the foreground brain path sets this.
            onRunId: ({ runId, brainUrl }) => {
              const entry = activeAbortControllers.get(correlationId)
              if (entry) {
                entry.runId = runId
                entry.brainUrl = brainUrl
              }
            },
            signal: duinAbort.signal
          })
          // Persist when there's a visible answer OR streamed reasoning — a turn
          // that only reasoned/used tools (empty final text) would otherwise save
          // nothing, so its reasoning vanishes on reload.
          if (r.ok && (r.text.trim() || (r.reasoning && r.reasoning.trim()))) {
            convStore.saveMessage({
              id: randomUUID(),
              conversationId,
              role: 'assistant',
              content: r.text,
              model,
              // Persist the brain's streamed chain-of-thought so the Reasoning
              // block survives as an inspectable, collapsible card after the
              // turn finalizes (instead of vanishing when the streaming view is
              // replaced by the saved message). Capped like the built-in path
              // (MAX_REASONING_BYTES, honest truncation marker) so a huge trail
              // can't bloat the row.
              ...(r.reasoning && r.reasoning.trim()
                ? { reasoning: concatReasoningTrail([r.reasoning], undefined) }
                : {})
            })
          }
        } finally {
          activeAbortControllers.delete(correlationId)
        }
        return { success: true, data: { conversationId } }
      }

      // D3 — Deep research routing decision. Strips any /research or
      // --no-research prefix from the prompt and, when auto-trigger is
      // enabled in settings (defaults to off until D10 ships the real
      // orchestrator), runs the intent classifier. The /research prefix
      // forces the pipeline regardless of the auto-trigger setting.
      const deepResearchSettings = readDeepResearchSettings()
      let researchRoute: Awaited<ReturnType<typeof routeChatTurn>> | null = null
      try {
        researchRoute = await routeChatTurn(rawContent, {
          autoTrigger: deepResearchSettings.autoTrigger,
          planMode: isPlanModeActive(conversationId),
          modelOverride: deepResearchSettings.classifierModel
        })
      } catch (err) {
        console.warn('[chat] research routing decision threw; falling back to normal flow:', err)
      }
      if (researchRoute) {
        // Use the cleaned body (prefix stripped) for the saved message and
        // every downstream model call.
        content = researchRoute.kind === 'research' ? researchRoute.body : researchRoute.content
      }

      convStore.saveMessage({
        id: randomUUID(),
        conversationId,
        role: 'user',
        content,
        model,
        // The `raw:` / research path rebuilds its request from stored rows via
        // buildApiMessagesFromStoredMessages, so persisting the parts here is what
        // lets an image reach a raw provider call at all — this path forwarded no
        // images previously and dropped them without a word.
        ...(validation.value.images?.length
          ? { contentParts: imagesToParts(validation.value.images) }
          : {})
      })

      // If routing chose the research pipeline, hand off to runDeepResearch
      // and emit its outcome as the assistant message. Most errors fall
      // through to the outer catch which emits a chat:error event so the
      // user sees the problem. EXCEPTION: a NoSourcesError (R1+R2) is
      // recoverable — we persist a system note about the failed search and
      // fall through to a normal chat turn so the model can answer from
      // training knowledge instead of ghosting the conversation.
      if (researchRoute && researchRoute.kind === 'research') {
        // Set up an abort controller early so chat:cancel can interrupt
        // the in-flight research run. The normal-dispatch path below
        // creates its own a few lines later; only one of the two ever
        // runs per turn.
        const researchAbort = new AbortController()
        activeAbortControllers.set(correlationId, {
          controller: researchAbort,
          correlationId,
          conversationId,
          startedAt: Date.now()
        })
        try {
          const outcome = await runDeepResearch({
            question: researchRoute.body,
            depth: researchRoute.depth,
            conversationId,
            correlationId,
            abortSignal: researchAbort.signal
          })
          // D11 will register the artifact with the renderer; D10's job
          // is to drop the assistant message containing the executive
          // summary and a clickable link to the on-disk markdown.
          convStore.saveMessage({
            id: randomUUID(),
            conversationId,
            role: 'assistant',
            content: `${outcome.summary}\n\n**Sources:** ${outcome.sourceCount} (${outcome.acceptedCount} accepted, ${outcome.singleSourceCount} single-source, ${outcome.disputedCount} disputed) · Providers: ${outcome.providersUsed.join(', ') || 'none'}\n\n[Open full report](artifact://research/${outcome.filename})`,
            model
          })
          activeAbortControllers.delete(correlationId)
          return { success: true, data: { conversationId, correlationId } }
        } catch (researchErr: unknown) {
          activeAbortControllers.delete(correlationId)
          if (researchErr instanceof NoSourcesError) {
            // R1+R2 — recoverable. Persist a SYSTEM-role message that
            // tells the model (and the user, in the transcript) that the
            // search cascade returned nothing. The fall-through runs the
            // normal chat dispatch which picks this system note up via
            // promptHistory below.
            const trail = researchErr.summary()
            convStore.saveMessage({
              id: randomUUID(),
              conversationId,
              role: 'system',
              content:
                'Deep research fallback: the web-search cascade returned no usable sources for this prompt. ' +
                'Answer from training knowledge ONLY. Be explicit that web search returned nothing, name any ' +
                'limitations (no recent events, no citations), and offer to retry with a narrower query or ' +
                'after the user configures a Brave Search / SerpAPI key in Settings → API Keys.\n\n' +
                `Search provider trail:\n${trail}`,
              model
            })
            // Tell the renderer the research stage failed cleanly so the
            // banner closes; the next phase emit (`understanding`) then
            // re-opens the normal-chat lifecycle.
            emitChatEvent('chat:error', {
              conversationId,
              error: `Research cascade returned no sources — falling back to model knowledge.`
            })
            // Fall through to the normal-chat dispatch below. Do NOT return.
          } else {
            // Anything else from runDeepResearch (FabricatedCitationError,
            // DeepResearchCancelledError, hard exceptions) keeps the
            // existing behaviour: surface to the outer catch as chat:error.
            throw researchErr
          }
        }
        void FabricatedCitationError
        void DeepResearchCancelledError
      }

      // LP-1 (Loop Phase) — the normal-dispatch body (prompt assembly + tools
      // + abort registration + runChatRound + cleanup) is now `runHeadlessTurn`
      // so a loop iteration or a fired `schedule_wakeup` wake-up can run the
      // identical turn in the main process. The user message was already
      // persisted above; runHeadlessTurn owns abort registration + cleanup.
      await runHeadlessTurn({
        conversationId,
        model,
        activeSkillIds,
        correlationId,
        promptBody: content,
        ...(validation.value.reasoningEffort ? { reasoningEffort: validation.value.reasoningEffort } : {})
      })

      activeAbortControllers.delete(correlationId)
      drainPendingDocuments(correlationId)
      return { success: true, data: { conversationId } }
    } catch (err) {
      activeAbortControllers.delete(correlationId)
      drainPendingDocuments(correlationId)
      emitPhase(conversationId, 'error')
      emitChatEvent('chat:error', { conversationId, error: messageOf(err) })
      // Mirror into the event spine so the timeline reader sees the failure
      // alongside any model/tool/agent events that completed before the throw.
      try {
        recordEvent({
          type: 'chat.error',
          actorKind: 'system',
          severity: 'error',
          conversationId,
          correlationId,
          payload: {
            errorPreview: boundedJsonPreview(messageOf(err)),
            errorClass: (err as { name?: string })?.name
          }
        })
      } catch (e) {
        console.error('[chat] chat.error event failed:', e)
      }
      // SP-4 — ghost-reply guard (D5). If the failure landed BEFORE any
      // visible reply row (pre-stream throw, instant stream failure with no
      // partial, multi-agent bail with zero mutations), persist a
      // `role:'system'` notice so the transcript never ends on an unanswered
      // user message. User-initiated cancels are not ghosts — skip those.
      try {
        if (!isUserAbortError(err as { name?: string; message?: string })) {
          const rows = convStore.getMessages(conversationId)
          if (turnEndedGhosted(rows)) {
            const notice = convStore.saveMessage({
              id: randomUUID(),
              conversationId,
              role: 'system',
              // Renamed from 'lamprey-safety-net' 2026-08-21 (brand residue in a
              // user-visible row). Old saved rows keep the old string; nothing
              // branches on the value, so no migration is needed.
              content: buildGhostReplyNotice(messageOf(err)),
              model: 'duin-safety-net',
              stage: 'system'
            })
            emitChatEvent('chat:done', { conversationId, message: notice })
          }
        }
      } catch (guardErr) {
        console.error('[chat] SP-4 ghost-reply guard failed:', guardErr)
      }
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('chat:cancel', async (_event, conversationId) => {
    // Abort EVERY run bound to this conversation — a background loop turn and a
    // manual send can both be in flight, each with its own correlationId key.
    const runs = [...activeAbortControllers.values()].filter(
      (r) => r.conversationId === conversationId
    )
    for (const run of runs) {
      run.controller.abort()
      activeAbortControllers.delete(run.correlationId)
      drainPendingDocuments(run.correlationId)
      try {
        recordEvent({
          type: 'chat.cancelled',
          actorKind: 'user',
          severity: 'warning',
          conversationId,
          correlationId: run.correlationId,
          payload: {
            cancelledAt: Date.now(),
            elapsedMs: Date.now() - run.startedAt
          }
        })
      } catch (err) {
        console.error('[chat] chat.cancelled event failed:', err)
      }
    }
    // R7 (Phase-4) — aborting the controller unblocks the streaming/tool
    // awaits, but two awaits don't observe it on their own: a pending
    // tool-approval modal and an ask_user prompt. Resolve both so an AFK
    // approval can't leave the cancelled turn deadlocked forever.
    try {
      permissionsService.cancelPendingForConversation(conversationId)
    } catch (err) {
      console.error('[chat] cancel pending approvals failed:', err)
    }
    try {
      // Scoped, not cancelAll(): another conversation can be streaming with its
      // own ask_user prompt open, and resolving it with `cancelled` would send
      // that turn down a branch the user never chose.
      getAskUserRuntime()?.cancelForConversation(conversationId)
    } catch (err) {
      console.error('[chat] cancel pending ask_user prompts failed:', err)
    }
    return { success: true, data: null }
  })

  // Composer STEERING — inject text into a RUNNING foreground turn instead of queuing a new turn.
  // Resolves the conversation to its FOREGROUND streaming run (the brain streamFromDuin run, which
  // set `runId` via onRunId) — NEVER a background loop run (those go through the raw path and never
  // set a runId). Fires a steer beacon at that run; returns { accepted }. accepted:false (no live
  // run caught it, or the brain has resume off) tells the renderer to enqueue a durable new turn.
  ipcMain.handle('chat:steer', async (_event, request: ChatSteerRequest) => {
    const conversationId = typeof request?.conversationId === 'string' ? request.conversationId : ''
    const text = typeof request?.text === 'string' ? request.text : ''
    const steerId = typeof request?.steerId === 'string' && request.steerId ? request.steerId : undefined
    if (!conversationId || !text.trim()) {
      return { success: false, error: 'chat:steer requires conversationId and non-empty text' }
    }
    // Foreground streaming run = the most recent ActiveRun for this conversation that carries a
    // runId. A conversation can also have a background loop turn in flight (no runId), which we must
    // never steer — filtering by a defined runId excludes it structurally.
    const foreground = [...activeAbortControllers.values()]
      .filter((r) => r.conversationId === conversationId && !!r.runId)
      .sort((a, b) => b.startedAt - a.startedAt)[0]
    if (!foreground?.runId) {
      return { success: true, data: { accepted: false, reason: 'no-active-run' } }
    }
    try {
      const result = await steerBrain(
        foreground.brainUrl ?? resolveBrainUrl(),
        foreground.runId,
        text.trim(),
        steerId
      )
      return { success: true, data: { accepted: result.accepted } }
    } catch (err) {
      return { success: false, error: messageOf(err) }
    }
  })

  ipcMain.handle('chat:generateTitle', async (_event, content: string, model?: string) => {
    try {
      // The 'title' role (cheapest healthy model), honoring the conversation's
      // explicit pin as `preferred` — so an Ollama/local-only conversation keeps
      // title generation on-device. AUTO_ENGINE is not a pin. No fallback id:
      // when no provider can answer, the title honestly stays the raw prompt.
      const selected = typeof model === 'string' && model && model !== AUTO_ENGINE ? model : undefined
      const titleModel = routeModel('title', selected)
      if (!titleModel) return { success: false, error: 'No usable model for the title role' }
      const rawResult = await chatOnce(
        [
          {
            role: 'system',
            content:
              'Generate a concise 3–5 word title for a conversation that begins with the user message below. Reply with ONLY the title — no quotes, no punctuation, no trailing period.'
          },
          { role: 'user', content }
        ],
        titleModel
      )
      const cleaned = rawResult.content.replace(/^["'\s]+|["'\s]+$/g, '').replace(/[.!?]+$/g, '').slice(0, 60)
      return { success: true, data: cleaned || content.slice(0, 40) }
    } catch (err) {
      return { success: false, error: friendly(err, 'Title generation failed') }
    }
  })

  // mcp:approveToolCall used to live here because chat.ts owned the pending
  // confirmation promises. It now lives in electron/ipc/permissions.ts and
  // routes through permissionsService.

  // LP-1 (Loop Phase) — wire the headless turn runner into the loop runner so a
  // fired schedule_wakeup wake-up (and, from LP-3, a loop iteration) runs a
  // real turn instead of leaving the injected user message unanswered (G1).
  setLoopTurnRunner((runnerInput) =>
    runHeadlessTurn({
      conversationId: runnerInput.conversationId,
      model: runnerInput.model,
      promptBody: runnerInput.promptBody,
      // Bug 2 — forward the loop's per-iteration watchdog signal so an
      // iteration-timeout abort actually interrupts the turn, AND disable the
      // interactive 180s turn deadline (deadlineMs: 0) so the loop turn is
      // capped ONLY by its own iteration watchdog (DEFAULT_ITERATION_TIMEOUT_MS,
      // ~10min) — not by DUIN_TURN_DEADLINE_MS meant for interactive chat.
      signal: runnerInput.signal,
      deadlineMs: 0,
      // Loop iterations run with no human at the console — apply the
      // action-class CAP floor (fail-closed) so an autonomous turn can't
      // send / delete / exec without approval. Interactive chat:send omits
      // this (defaults false) and keeps its modal/policy path.
      unattended: true
    })
  )
}

// Prompt 11: agent-pipeline mode needs to capture the Coder's final
// assistant message AND defer the chat:done emit until after the Reviewer
// stage has been queued (so the renderer doesn't clear the pipeline-banner
// in the gap between Coder-done and Reviewer-running). When
// `suppressDoneEvent` is true:
//   * runChatRound persists the assistant message as usual,
//   * BUT it does NOT emit `chat:phase = done` or `chat:done`,
//   * AND it resolves with the persisted message so the caller can emit
//     those events itself at the right moment.
// Single-mode callers pass `false` (the default) and ignore the return
// value; the byte-for-byte behaviour of the pre-Prompt-11 path is
// preserved.
export type RunChatRoundResult = { message: unknown } | null

/**
 * runHeadlessTurn's result widens RunChatRoundResult with a context-aware token
 * estimate (Loop Phase gap-closure): the chars of the FULL message stack sent
 * to the model (system prompt + history + the iteration prompt) plus the reply,
 * over ~4 chars/token. This replaces the prior promptBody-only estimate, which
 * ignored the system prompt + history that dominate a turn's real token cost.
 * Multi-round tool turns still undercount the re-sent context, so iteration +
 * wall-clock remain the hard caps; the token budget is the soft guard.
 */
export type HeadlessTurnResult = { message: unknown; tokensEstimate: number } | null

/**
 * LP-1 (Loop Phase) — the headless turn runner. Factored out of `chat:send`
 * so a loop iteration or a fired `schedule_wakeup` wake-up can run a real chat
 * turn in the main process, with the window closed or another conversation
 * focused. The CALLER persists the triggering user message first (chat:send
 * does; fireDueWakeups does). This function assembles the prompt + tools,
 * registers an abort controller (so chat:cancel AND a loop's cancel both
 * interrupt it), runs runChatRound, and owns its own cleanup in a `finally` —
 * a throwing turn never leaks the activeAbortControllers entry.
 */
export async function runHeadlessTurn(input: {
  conversationId: string
  model: string
  activeSkillIds?: string[]
  correlationId?: string
  /** Body for the promptSubmit hook (the user/wake-up text). */
  promptBody?: string
  /** External cancel signal (e.g. a loop's controller) — aborts the turn. */
  signal?: AbortSignal
  /** Override the internal per-turn wall-clock deadline (ms). When provided it
   *  WINS over turnDeadlineMs(); 0 disables the internal deadline entirely so
   *  the caller's own budget (e.g. the loop's iteration watchdog via `signal`)
   *  becomes the sole wall-clock cap (Bug 2). Undefined ⇒ the env default. */
  deadlineMs?: number
  suppressDoneEvent?: boolean
  /** Per-request reasoning-effort override (composer). Wins over the settings
   *  global default that loadModelConfig resolves. */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  /** Unattended (loop / autonomy) run — enforce the action-class CAP floor on
   *  tool dispatch. Defaults false so the interactive chat:send path is
   *  unchanged. */
  unattended?: boolean
}): Promise<HeadlessTurnResult> {
  const { conversationId } = input
  // This is the RAW provider loop, so it needs a concrete engine: an explicit pin
  // is honoured when usable; AUTO_ENGINE (or an unusable pin) resolves the chat role
  // from the provider policy. No default model — nothing routable is a hard stop.
  const model = routeModel('chat', input.model && input.model !== AUTO_ENGINE ? input.model : undefined)
  if (!model) throw new Error('No usable model for the chat role — add a provider key or fix the provider order')
  const correlationId = input.correlationId ?? randomUUID()
  const activeSkillIds = input.activeSkillIds ?? []

  emitPhase(conversationId, 'understanding')

  void fireHooks('promptSubmit', { conversationId, promptBody: input.promptBody ?? '' })

  // Track 2 / E5 — auto context compression. Run BEFORE pulling
  // history so the next turn's prompt sees the compressed view.
  // A3 (DUIN_MODEL_COMPACTION=1): the model-driven post-turn compaction
  // owns the normal 0.75 threshold; this deterministic pre-turn pass is
  // demoted to the 0.9 emergency backstop so a dead provider can never
  // let a conversation overflow — see model-compaction.ts.
  const modelCompactionOn = modelCompactionEnabled()
  let ctxWindow = 128_000
  try {
    const modelInfo = resolveModel(model)
    ctxWindow = modelInfo.contextWindow ?? 128_000
    const r = compressOldestMessages(
      conversationId,
      ctxWindow,
      modelCompactionOn ? { thresholdPct: DETERMINISTIC_BACKSTOP_THRESHOLD_PCT } : undefined
    )
    if (r) {
      emitChatEvent('chat:compressed', {
        conversationId,
        summaryMessageId: r.summaryMessageId,
        compressedCount: r.compressedCount,
        reductionPct: r.reductionPct
      })
    }
  } catch (err) {
    console.error('[chat] context compression failed:', err)
  }

  // The dispatcher uses the effective view (compressed messages hidden,
  // summary inserted in their place) for the OpenAI API.
  const promptHistory = getEffectiveMessages(conversationId)
  let memoryBlock = memStore.buildMemoryBlock()
  const memoryIndexBlock = memStore.buildMemoryIndexBlock()
  // Read now, commit delivery only once this turn has actually produced a message
  // (see the successful return below). Stamping here would lose the notification
  // outright if the turn then failed or was cancelled.
  const pendingAsyncEvents = takeAsyncEventsForPrompt(conversationId)
  const taskNotificationsBlock = buildTaskNotificationsBlock(pendingAsyncEvents)

  const settingsRaw = readSettingsJson()
  const agentic = loadAgenticCodingConfig(settingsRaw)

  // Unify grounding across chat paths (OKF memory design — breakage ①). The main
  // agent path historically injected ONLY the userData memory-store block, so the
  // vault brain (BRAIN.md / ME.md + .brain/memory OKF concepts) was invisible
  // here — the same question grounded differently than in the RAG path. Prepend
  // the brain grounding so identity + portable memory are path-independent.
  const notesDirForBrain =
    typeof (settingsRaw as { localBrainNotesDir?: unknown })?.localBrainNotesDir === 'string'
      ? (settingsRaw as { localBrainNotesDir: string }).localBrainNotesDir
      : null
  const loadedBrain = loadBrain(notesDirForBrain)
  const brainGroundingBlock = buildBrainGroundingBlock(loadedBrain)
  if (brainGroundingBlock) {
    memoryBlock = brainGroundingBlock + (memoryBlock ? `\n\n${memoryBlock}` : '')
  }

  const effectiveSkillIds = agentic.mode
    ? mergeAgenticSkillIds(activeSkillIds, agentic.skills)
    : activeSkillIds

  let skillContents: {
    name: string
    content: string
    allowedTools?: string[]
    description?: string
  }[] = []
  if (effectiveSkillIds.length > 0) {
    const skills = listSkills()
    skillContents = effectiveSkillIds
      .map((id: string) => {
        const skill = skills.find((s) => s.id === id)
        if (!skill) return null
        const skillBody = getSkillContent(id)
        if (!skillBody) return null
        return {
          name: skill.name,
          content: skillBody,
          ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
          ...(skill.description ? { description: skill.description } : {})
        }
      })
      .filter(Boolean) as {
      name: string
      content: string
      allowedTools?: string[]
      description?: string
    }[]
  }

  // HY4 — lazy skill bodies follow the tool-surface mode.
  const lazySkillBodies =
    ((settingsRaw as { toolSurface?: string } | null)?.toolSurface ?? 'full') !== 'full'

  const { params: modelParams, systemPromptOverride } = loadModelConfig(settingsRaw, model)
  // Per-request effort override (composer) wins over the settings global default.
  if (input.reasoningEffort) modelParams.reasoningEffort = input.reasoningEffort
  const activeWorkspace = getActiveWorkspace()
  // BRAIN.md reaches the prompt from two independent readers: once inside the
  // brain identity block built above, and once verbatim as <agents_md>. Both is
  // strictly worse than either — it spends the file's whole length twice, and
  // since the two readers resolve DIFFERENT roots (localBrainNotesDir vs the
  // active workspace) through different caches, the copies can disagree and the
  // model has no way to know which contract governs. Keep the identity-block
  // copy: it is the deliberate, framed, ordered one.
  const agentsMd = agentsMdDuplicates(activeWorkspace, loadedBrain?.identityFiles ?? [])
    ? ''
    : readAgentsMd(activeWorkspace)
  const chaptersBlock = buildChaptersBlock(conversationId)
  const supportsTools = resolveModel(model).supportsTools

  // RAG augmentation. This is the ONLY path by which an attached document's
  // content reaches the model on a chat turn — and until now it was never
  // called: `augmentForChat` had zero importers repo-wide. Everything around it
  // was already live (ipc/rag.ts auto-attaches the conversation collection,
  // ingest succeeds, ContextAttachBar renders the chip), which is exactly what
  // made the gap invisible: three separate comments — file-handler.ts:86,
  // ipc/rag.ts:535/543, chat-store.ts:206 — describe this call as if it existed.
  // The user-visible consequence was worst above file-handler's 5 MB
  // INLINE_THRESHOLD_BYTES: those files are routed to `kind: 'rag-pending'`
  // INSTEAD of being inlined, on the stated premise that retrieval would pick
  // them up here. With no caller, a >5 MB attachment was strictly invisible to
  // the model while every UI affordance claimed it was attached.
  let retrievedContextBlock: string | undefined
  const ragQuery = input.promptBody?.trim()
  if (ragQuery) {
    try {
      const ragSettings = (settingsRaw as { rag?: Parameters<typeof augmentForChat>[0]['settings'] } | null)
        ?.rag
      const augmented = await augmentForChat({
        conversationId,
        query: ragQuery,
        correlationId,
        // Without a planner the multi-query rewrite cannot fire, so switching
        // Settings → RAG → "Multi-query rewrite" ON changed nothing: the branch
        // in augmentForChat needs BOTH the setting and a runner. Supplying it
        // here costs one extra model call per turn ONLY when the operator has
        // opted in — the setting defaults off.
        planner: makeChatPlanner(model),
        ...(ragSettings ? { settings: ragSettings } : {})
      })
      // `.block` is '' when retrieval returned zero chunks — normalize to
      // undefined so buildSystemPrompt emits no empty tag.
      retrievedContextBlock = augmented?.context.block || undefined
    } catch (err) {
      // Best-effort: retrieval is an enrichment, never a precondition. A broken
      // embedder or a locked DB must not sink the user's turn.
      console.error('[chat] rag augmentation failed:', err)
    }
  }

  // A2b (DUIN_STABLE_PREFIX, chat-loop half): the four per-turn-volatile
  // blocks bust the provider prefix cache for the WHOLE conversation when
  // they ride in the system prompt. Under the stable layout they are
  // PREPENDED INTO the final user message instead (matching the /agui
  // half's prompt-layout.mjs) — system + retained history stay
  // byte-stable, alternation holds, and the Anthropic breakpoint-2 slot
  // (message before the last user message) stays on stable bytes.
  const stablePrefixLayout = process.env.DUIN_STABLE_PREFIX === '1'
  const systemPrompt = buildSystemPrompt(
    skillContents,
    memoryBlock,
    systemPromptOverride,
    agentsMd,
    model,
    agentic.mode ? 'coding' : undefined,
    stablePrefixLayout ? undefined : memoryIndexBlock,
    stablePrefixLayout ? undefined : taskNotificationsBlock,
    stablePrefixLayout ? undefined : chaptersBlock,
    supportsTools,
    lazySkillBodies,
    stablePrefixLayout ? undefined : retrievedContextBlock
  )

  const activeProvider = getProviderForModel(model)
  const tools: ChatCompletionTool[] = buildDispatchTools(
    conversationId,
    activeProvider,
    settingsRaw
  )

  // DEFINITIVE main-chat diagnostic: exactly what the user's chat turn sends to
  // the model — the tool count, the tool NAMES (so we can see whether apply_patch
  // / shell_command actually reach it), and whether the model is flagged
  // tool-capable / has been downgraded. This is the main-chat path only, so it
  // is not polluted by sub-agent/loop runs.
  trace('mainchat.tools-built', {
    model,
    provider: activeProvider,
    toolCount: tools.length,
    toolNames: tools
      .map((t) => (t as { function?: { name?: string } }).function?.name)
      .filter(Boolean)
      .slice(0, 50),
    supportsTools: resolveModel(model).supportsTools,
    downgraded: isDowngraded(conversationId, model),
    nativeCatalog: toolRegistry.getDescriptors().length
  })

  const apiMessages = buildApiMessagesFromStoredMessages(systemPrompt, promptHistory, model)

  if (stablePrefixLayout) {
    applyRuntimeSnapshotToApiMessages(apiMessages, {
      retrievedContextBlock,
      taskNotificationsBlock,
      memoryIndexBlock,
      chaptersBlock
    })
  }

  // Context-aware token estimate (gap-closure): the full message stack sent to
  // the model, not just the iteration prompt. Computed here because this is the
  // only place that holds the assembled apiMessages.
  const promptChars = apiMessages.reduce((n, m) => {
    const c = (m as { content?: unknown }).content
    return n + (typeof c === 'string' ? c.length : c == null ? 0 : JSON.stringify(c).length)
  }, 0)

  const abortController = new AbortController()
  // Bridge an external cancel signal (a loop's controller) into the turn's
  // own controller so chat:cancel + loop-cancel both interrupt this run.
  if (input.signal) {
    if (input.signal.aborted) abortController.abort()
    else input.signal.addEventListener('abort', () => abortController.abort(), { once: true })
  }
  activeAbortControllers.set(correlationId, {
    controller: abortController,
    correlationId,
    conversationId,
    startedAt: Date.now()
  })

  const workspacePath = activeWorkspace
  try {
    const result = await runChatRound(
      conversationId,
      model,
      apiMessages,
      tools.length > 0 ? tools : undefined,
      workspacePath,
      abortController.signal,
      0,
      modelParams,
      input.suppressDoneEvent ?? false,
      correlationId,
      [],
      Date.now(),
      input.unattended ?? false,
      abortController,
      input.deadlineMs
    )
    if (!result) return null

    // A3 — model compaction as prefix-extension: fire on the request this
    // turn JUST sent so the summarization rides the provider's warm prefix
    // cache instead of re-billing the context cold. Fire-and-forget — it
    // never blocks the reply; any failure defers to the pre-turn
    // deterministic backstop above. Guarded to prefix-cache-capable
    // providers: elsewhere the "extension" would re-bill ~75% of the
    // context at cold price (or minutes of local re-prefill on ollama),
    // and the deterministic backstop is free.
    if (modelCompactionOn && providerHasPrefixCache(activeProvider)) {
      void runModelCompaction(
        {
          conversationId,
          contextWindow: ctxWindow,
          modelId: model,
          apiMessages: apiMessages.slice(),
          // The turn's own request sent these tools (sorted at the
          // chatStream chokepoint); the extension must carry the SAME
          // list or the rendered prompt diverges at position ~0 and the
          // whole cache-hit premise dies.
          tools:
            resolveModel(model).supportsTools && tools.length > 0
              ? sortToolsStable(tools)
              : undefined
        },
        productionModelCompactionDeps()
      )
        .then((c) => {
          if (c) {
            emitChatEvent('chat:compressed', {
              conversationId,
              summaryMessageId: c.summaryMessageId,
              compressedCount: c.compressedCount,
              reductionPct: c.reductionPct
            })
          }
        })
        .catch((err) => console.error('[chat] model compaction failed:', err))
    }

    const replyContent = (result as { message?: { content?: unknown } }).message?.content
    const replyChars = typeof replyContent === 'string' ? replyContent.length : 0
    // The turn produced a message, so the notifications it carried have now been
    // delivered. Every earlier exit (including `if (!result) return null` above and
    // any throw) leaves them pending for the next turn on purpose.
    markAsyncEventsDelivered(pendingAsyncEvents.map((e) => e.id))
    return { message: (result as { message: unknown }).message, tokensEstimate: Math.ceil((promptChars + replyChars) / 4) }
  } finally {
    activeAbortControllers.delete(correlationId)
    drainPendingDocuments(correlationId)
  }
}

/**
 * HY2 — Build the tool array handed to the model for a turn. `'full'` (the
 * SP-1 era default, also used when unset or downgraded) returns the entire
 * normalized catalog, identical to the pre-Hygiene dispatch. `'lazy'` (opt-in)
 * returns the core set + `tool_search` + any tools already unlocked for this
 * conversation.
 */
function buildDispatchTools(
  conversationId: string,
  provider: ProviderId,
  settingsRaw: unknown
): ChatCompletionTool[] {
  const mode = (settingsRaw as { toolSurface?: string } | undefined)?.toolSurface ?? 'full'
  let built: ChatCompletionTool[]
  try {
    if (mode === 'lazy' && !isSurfaceDowngraded(conversationId)) {
      activateLazySurface(conversationId)
      built = toolRegistry.getModelToolSurface(provider, {
        unlockedNames: getUnlockedTools(conversationId)
      })
    } else {
      built = toolRegistry.getNormalizedToolsForRole('coder', provider)
    }
  } catch (err) {
    // A tool-build error must NEVER silently hand the model an empty toolbox —
    // that manifests as "the model can't do anything" (the FC diagnosis). Log
    // loudly and continue with no tools rather than crashing the turn.
    console.error(
      `[chat] buildDispatchTools FAILED (provider="${provider}", mode="${mode}") — model gets NO tools this turn:`,
      err
    )
    trace('buildDispatchTools.threw', { provider, mode, error: String(err).slice(0, 200) })
    built = []
  }
  if (built.length === 0) {
    console.error(
      `[chat] buildDispatchTools returned 0 tools (provider="${provider}", mode="${mode}", conversation=${conversationId}). ` +
        'The model cannot call any tool. Check native tool registration — see the [tool-packs] startup log.'
    )
    trace('buildDispatchTools.zero-tools', { provider, mode, conversationId })
  }
  return built
}

/**
 * HY2 — Recompute the tool array between tool-call rounds so tools unlocked by
 * a `tool_search` call this round are callable next round. In `'full'` mode
 * (and for non-lazy conversations) the array passes through unchanged; a
 * mid-loop downgrade rebuilds the full catalog.
 */
function rebuildToolsForNextRound(
  conversationId: string,
  model: string,
  currentTools: ChatCompletionTool[] | undefined
): ChatCompletionTool[] | undefined {
  if (isLazyActive(conversationId)) {
    return toolRegistry.getModelToolSurface(getProviderForModel(model), {
      unlockedNames: getUnlockedTools(conversationId)
    })
  }
  if (isSurfaceDowngraded(conversationId)) {
    return toolRegistry.getNormalizedToolsForRole('coder', getProviderForModel(model))
  }
  return currentTools
}

export async function runChatRound(
  conversationId: string,
  model: string,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[] | undefined,
  workspacePath: string,
  signal: AbortSignal,
  round: number,
  params?: ModelParams,
  suppressDoneEvent: boolean = false,
  correlationId?: string,
  /** Reasoning Audit Phase R6 — cumulative reasoning trail. Pre-existing
   *  rounds' chain-of-thought; this round appends its own onDone.
   *  Threaded through recursion so the FINAL round folds the whole trail
   *  into the saved row's `reasoning` column via concatReasoningTrail().
   *  Defaults to [] at the top-level call so callers don't need to pass it. */
  roundReasonings: string[] = [],
  turnStartedAt: number = Date.now(),
  /** Unattended (loop / autonomy) run — enforce the action-class CAP floor on
   *  tool dispatch (fail-closed). Defaults false: the interactive path is
   *  byte-for-byte unchanged. Threaded through the self-recursion so every
   *  round of an unattended turn stays gated. */
  unattended: boolean = false,
  /** R3 (Phase-3) — the turn's own AbortController. When the wall-clock
   *  deadline trips we abort this so any signal-aware in-flight/pending work
   *  (the shared stream, signal-checking tool executors) stops instead of the
   *  turn merely returning. Optional: the abort signal is already threaded via
   *  `signal`; this is the handle needed to raise it. Threaded through the
   *  self-recursion. */
  turnAbort?: AbortController,
  /** Bug 2 — per-turn wall-clock deadline OVERRIDE (ms). When provided it WINS
   *  over the env-derived turnDeadlineMs(): a positive value caps this turn, and
   *  0 DISABLES the internal deadline (so a caller-owned budget — e.g. the loop's
   *  iteration watchdog via `signal` — becomes the sole cap). Undefined ⇒ the env
   *  default. Threaded through the self-recursion so every round honours it. */
  deadlineMsOverride?: number
): Promise<RunChatRoundResult> {
  trace('runChatRound.enter', {
    conversationId,
    correlationId,
    model,
    round,
    messagesCount: messages.length,
    toolsCount: tools?.length ?? 0,
    parentSignalAborted: signal.aborted
  })
  if (round >= MAX_TOOL_ROUNDS) {
    emitPhase(conversationId, 'error')
    emitChatEvent('chat:error', {
      conversationId,
      // Tool calls completed in rounds 0..MAX_TOOL_ROUNDS-1 ARE persisted —
      // re-prompting with "continue" picks up where the model left off
      // because the history reflects the partial work.
      error: `Tool-call cap reached (${MAX_TOOL_ROUNDS} rounds this stage). Re-prompt with "continue" to keep going — the partial work is saved.`
    })
    return null
  }

  // R3 (Phase-3) — hard wall-clock deadline. `turnStartedAt` was threaded
  // through the recursion but never compared (dead code); enforce it now so a
  // long tool fan-out can't keep the raw-path turn alive past the ceiling. We
  // check BEFORE starting this round's stream, abort the shared controller so
  // any signal-aware pending work stops, emit a terminal chat:error, and settle
  // the turn with null instead of recursing. A deadline <= 0 disables the check.
  const deadlineMs = deadlineMsOverride ?? turnDeadlineMs()
  if (deadlineMs > 0 && Date.now() - turnStartedAt > deadlineMs) {
    try {
      turnAbort?.abort()
    } catch (e) {
      console.error('[chat] turn-deadline abort failed:', messageOf(e))
    }
    emitPhase(conversationId, 'error')
    emitChatEvent('chat:error', {
      conversationId,
      error: `Turn deadline exceeded (${deadlineMs}ms this turn). Re-prompt with "continue" to keep going — the partial work is saved.`
    })
    return null
  }

  const descriptor = resolveModel(model)
  // FC-10 — when the capability tracker has downgraded this model for this
  // conversation, treat it as supportsTools: false going forward. The
  // fallback parser (FC-6/FC-8) handles tool invocation from text.
  const actuallySupportsTools = descriptor.supportsTools && !isDowngraded(conversationId, model)
  const effectiveTools = actuallySupportsTools ? tools : undefined

  const audit: ModelRequestAudit | undefined = correlationId
    ? { correlationId, conversationId, purpose: 'main' }
    : undefined

  return new Promise<RunChatRoundResult>((resolve, reject) => {
    chatStream(
      messages,
      model,
      effectiveTools,
      {
        onChunk: (chunk) => {
          emitChatEvent('chat:chunk', { conversationId, content: chunk })
        },
        onReasoning: (chunk) => {
          emitChatEvent('chat:reasoning', { conversationId, content: chunk })
        },
        onVitals: (v) => {
          emitChatEvent('chat:streaming-vitals', {
            conversationId,
            lastChunkAt: v.lastChunkAt,
            msSinceLastChunk: v.msSinceLastChunk,
            chunkCount: v.chunkCount,
            tokenEstimate: v.tokenEstimate,
            attemptElapsedMs: v.attemptElapsedMs
          })
        },
        onDone: async (fullContent, toolCalls, fullReasoning) => {
          // R2 (Phase-3) — the ENTIRE onDone body is guarded. onDone does heavy
          // work (persist assistant + tool rows to SQLite, spill, recurse); a
          // throw ANYWHERE here (e.g. an oversized tool result exceeding SQLite
          // limits during saveMessage/spill) used to become an unhandled
          // rejection that left the caller's turn promise unsettled — the chat
          // hung dead. Catch it, emit a terminal chat:error, and reject so the
          // turn always settles exactly once. (The shared registry settle-once
          // also routes an onDone throw to onError, but this local guard keeps
          // the terminal emission + reject on the raw path even if that changes.)
          try {
          trace('runChatRound.onDone', {
            conversationId,
            round,
            contentLen: fullContent.length,
            reasoningLen: fullReasoning?.length ?? 0,
            toolCallsCount: toolCalls?.length ?? 0
          })

          // FC-10 — capability mismatch detection. When the model is flagged
          // supportsTools but returns tool-like text without tool_calls,
          // track consecutive mismatches. Downgraded models bypass future
          // native-tool attempts and go straight to fallback parsing.
          if (descriptor.supportsTools) {
            const gotToolCalls = !!(toolCalls && toolCalls.length > 0)
            const toolsWereSent = effectiveTools !== undefined
            const warning = recordCapabilityCheck(
              conversationId,
              model,
              toolsWereSent,
              gotToolCalls,
              fullContent
            )
            if (warning) {
              trace('runChatRound.capability-mismatch', {
                conversationId,
                model,
                warning
              })
              // Log but don't block — the user's current turn proceeds normally
            }
          }

          // FC-8 — when the model does not support native tool calling
          // (toolCalls is empty/null), attempt fallback parsing from the
          // text content. Fallback models are instructed to output JSON
          // following the fallback contract. If a valid fallback call is
          // found, convert it to the native toolCalls format and dispatch
          // through the same pathway.
          //
          // FC-10 — also run capability mismatch detection. When a native
          // model returns tool-like syntax but no tool_calls, track
          // consecutive mismatches. After 3, temporarily downgrade to
          // fallback mode so the user's turn isn't wasted.
          let effectiveToolCalls = toolCalls
          // Fallback parsing triggers when: (a) model doesn't support tools
          // natively, OR (b) model has been downgraded due to capability mismatch.
          const needsFallbackParsing = !descriptor.supportsTools || isDowngraded(conversationId, model)
          if ((!effectiveToolCalls || effectiveToolCalls.length === 0) && needsFallbackParsing) {
            const descriptors = toolRegistry.getDescriptors()
            const fallbackResult = parseFallbackToolCalls(fullContent, descriptors)
            if (fallbackResult && !fallbackResult.isFinalAnswer && fallbackResult.calls.length > 0) {
              // Convert fallback ToolCallRequest[] to ProviderToolCall[]
              effectiveToolCalls = fallbackResult.calls.map((fc) => ({
                id: fc.id,
                type: 'function' as const,
                function: { name: fc.name, arguments: JSON.stringify(fc.arguments) }
              }))
              trace('runChatRound.fallback-parsed', {
                conversationId,
                round,
                callCount: effectiveToolCalls.length,
                provenance: 'fallback'
              })
            }
          }

          if (!effectiveToolCalls || effectiveToolCalls.length === 0) {
            // The "PIC Completion Gate" (2026-07-22, commit f924971a) that appended a
            // "[auto: no completion signal ...]" marker to every multi-round turn whose
            // final text lacked a literal completion emoji was reverted: untested WIP
            // that over-fired on normal completions (any tool-using turn answered without
            // an emoji) and broke R4/R5. The content the model streamed IS the reply,
            // byte-for-byte (see UB-5 below).
            const finalContent = fullContent
            // UB-5 (Unburdening Phase, 2026-06-10) — the final-response
            // composer that used to rewrite the reply here is EXCISED. The
            // content the model streamed IS the reply, byte-for-byte. The
            // UB-4 note still applies: no proof gate, no trust notice, no
            // proof_status write.
            const documents = drainPendingDocuments(correlationId)
            // R6 (kept) — fold every round's chain-of-thought into the saved
            // row. Single-shot turns (no prior tool rounds) persist the raw
            // reasoning unchanged; multi-round turns get the numbered trail,
            // capped at MAX_REASONING_BYTES with the honest truncation marker.
            const finalReasoning =
              roundReasonings.length > 0
                ? concatReasoningTrail([...roundReasonings, fullReasoning ?? ''], undefined)
                : fullReasoning
            const assistantMsg = convStore.saveMessage({
              id: randomUUID(),
              conversationId,
              role: 'assistant',
              content: finalContent,
              model,
              reasoning: finalReasoning,
              documents
            })
            if (!suppressDoneEvent) {
              emitPhase(conversationId, 'done')
              emitChatEvent('chat:done', { conversationId, message: assistantMsg })
              void fireHooks('agentStop', { conversationId })
            }
            resolve({ message: assistantMsg })
            return
          }

          const persistedToolCalls = effectiveToolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: tc.function.arguments }
          }))

          convStore.saveMessage({
            id: randomUUID(),
            conversationId,
            role: 'assistant',
            content: fullContent || '',
            model,
            toolCalls: persistedToolCalls,
            reasoning: fullReasoning
          })

          messages.push({
            role: 'assistant',
            content: fullContent || null,
            tool_calls: persistedToolCalls,
            ...(fullReasoning && { reasoning_content: fullReasoning })
          } as any)

          // Group the model's tool_calls into execution windows: contiguous
          // spans of parallelizable calls run via Promise.all; non-parallel
          // calls run one at a time. The final tool-role messages are pushed
          // in tool_call array order regardless of completion order so the
          // next API round sees a consistent sequence.
          const resolved: ResolvedToolCall[] = new Array(effectiveToolCalls.length)
          const windows = partitionToolCallWindows(effectiveToolCalls, (id) =>
            toolRegistry.getById(id)
          )
          for (const win of windows) {
            if (win.kind === 'parallel') {
              // R4 (Phase-3) — allSettled, not all: one tool's rejection must
              // not void the whole parallel batch (and thereby orphan the turn
              // by throwing out of onDone). `safeResolveToolCall` already never
              // throws, so every entry is 'fulfilled'; the rejected branch is a
              // belt-and-suspenders fallback that still yields a tool row.
              const settled = await Promise.allSettled(
                win.indices.map((idx) =>
                  safeResolveToolCall(
                    effectiveToolCalls[idx],
                    conversationId,
                    model,
                    workspacePath,
                    signal,
                    correlationId,
                    unattended
                  )
                )
              )
              for (let i = 0; i < win.indices.length; i++) {
                const s = settled[i]
                resolved[win.indices[i]] =
                  s.status === 'fulfilled'
                    ? s.value
                    : {
                        callId: effectiveToolCalls[win.indices[i]].id,
                        result: `Error: ${messageOf(s.reason)}`
                      }
              }
            } else {
              resolved[win.index] = await safeResolveToolCall(
                effectiveToolCalls[win.index],
                conversationId,
                model,
                workspacePath,
                signal,
                correlationId,
                unattended
              )
            }
          }

          // HY3 — spill threshold (chars). Default DEFAULT_SPILL_THRESHOLD;
          // `toolResultSpill: false` or `toolResultSpillBytes: 0` disables it.
          const spillSettings = readSettingsJson() ?? {}
          const spillThreshold =
            spillSettings.toolResultSpill === false
              ? 0
              : typeof spillSettings.toolResultSpillBytes === 'number'
                ? spillSettings.toolResultSpillBytes
                : DEFAULT_SPILL_THRESHOLD
          for (const r of resolved) {
            // R5 (Phase-4) — cap the result to MAX_TOOL_RESULT_CHARS BEFORE it
            // reaches the store. An oversized MCP/subagent result that exceeds
            // the SQLite limit would otherwise throw out of saveMessage and
            // orphan the turn (no terminal frame). Uniform for native + MCP +
            // subagent since every resolved row flows through here.
            const storedResult = capToolResultChars(r.result)
            // Guard the persist itself: even a capped write can fail (locked
            // db, disk). A failing tool-row save must NOT reject the round —
            // the model still gets the (spilled) result below regardless.
            try {
              convStore.saveMessage({
                id: randomUUID(),
                conversationId,
                role: 'tool',
                content: storedResult,
                toolCallId: r.callId
              })
            } catch (persistErr) {
              console.error('[chat] tool-result persist failed (continuing):', persistErr)
            }
            // Feed the MODEL a head+tail preview when the result is large; the
            // full (capped) text stays on disk, reachable via read_tool_result.
            const spill = maybeSpillToolResult(storedResult, { threshold: spillThreshold })
            messages.push({
              role: 'tool',
              content: spill.result,
              tool_call_id: r.callId
            } as any)
          }

          try {
            // R6 — fold THIS round's reasoning into the cumulative trail
            // before recursing. The final round (no tool calls + composer
            // ran) reads the trail off the `roundReasonings` parameter
            // and folds it into the saved composer-row's reasoning column.
            const nextRoundReasonings = fullReasoning && fullReasoning.length > 0
              ? [...roundReasonings, fullReasoning]
              : roundReasonings
            const next = await runChatRound(
              conversationId,
              model,
              messages,
              // HY2 — fold in any tools unlocked by a tool_search this round.
              rebuildToolsForNextRound(conversationId, model, tools),
              workspacePath,
              signal,
              round + 1,
              params,
              suppressDoneEvent,
              correlationId,
              nextRoundReasonings,
              turnStartedAt,
              unattended,
              turnAbort,
              deadlineMsOverride
            )
            resolve(next)
          } catch (err) {
            reject(err)
          }
          } catch (onDoneErr) {
            // A throw anywhere in the onDone body (tool-result persistence,
            // spill, a saveMessage that exceeded a column limit). Settle the
            // turn with a terminal instead of orphaning it. Guard the emits so a
            // failing emit still lets reject run.
            try {
              emitPhase(conversationId, 'error')
              emitChatEvent('chat:error', { conversationId, error: messageOf(onDoneErr) })
            } catch (emitErr) {
              console.error('[chat] onDone-catch terminal emit failed:', emitErr)
            }
            reject(onDoneErr instanceof Error ? onDoneErr : new Error(messageOf(onDoneErr)))
          }
        },
        onError: (error, partial) => {
          trace('runChatRound.onError', {
            conversationId,
            round,
            errorPreview: String(error).slice(0, 200),
            partialContentLen: partial?.content?.length ?? 0,
            partialReasoningLen: partial?.reasoning?.length ?? 0
          })
          // Permanently fix data loss on stream errors: if the provider
          // streamed body or reasoning before failing, persist it as an
          // assistant message instead of letting it evaporate. Without
          // this, every stream error silently discarded everything the
          // user already saw on screen — including thousands of tokens
          // of chain-of-thought from reasoning models.
          //
          // We emit `chat:done` FIRST with the persisted partial so the
          // renderer transitions the on-screen streaming buffers into a
          // durable message via finishStream (which adds it to the
          // messages array and clears the streaming state). Then we emit
          // `chat:error` so the failure still surfaces as a toast.
          const hasPartial = !!(
            partial && (partial.content || partial.reasoning)
          )
          if (hasPartial) {
            try {
              const documents = drainPendingDocuments(correlationId)
              const errorMarker = `\n\n_[stream interrupted: ${error}]_`
              const assistantMsg = convStore.saveMessage({
                id: randomUUID(),
                conversationId,
                role: 'assistant',
                content: (partial!.content || '') + errorMarker,
                model,
                reasoning: partial!.reasoning,
                documents
              })
              if (!suppressDoneEvent) {
                emitChatEvent('chat:done', {
                  conversationId,
                  message: assistantMsg
                })
              }
            } catch (e) {
              console.error('[chat] failed to persist partial on stream error:', e)
            }
          }

          // R2 (Phase-3) — guard the terminal emits so reject ALWAYS runs. A
          // throwing emit (serialization, disposed webContents, a bug in a
          // renderer listener) must not escape onError and leave the turn
          // promise unsettled (the exact orphan this contract prevents).
          try {
            emitPhase(conversationId, 'error')
            emitChatEvent('chat:error', { conversationId, error })
            // Mirror provider-side stream errors into the spine. `model.request.failed`
            // is already emitted from inside chatStream for the underlying API
            // failure; this `chat.error` row pins the orchestration-layer
            // outcome so the chat-turn timeline reads cleanly even when the
            // provider stream short-circuits before any tool round runs.
            if (correlationId) {
              try {
                recordEvent({
                  type: 'chat.error',
                  actorKind: 'system',
                  severity: 'error',
                  conversationId,
                  correlationId,
                  payload: {
                    errorPreview: boundedJsonPreview(error),
                    source: 'stream'
                  }
                })
              } catch (e) {
                console.error('[chat] chat.error event failed:', e)
              }
            }
          } catch (emitErr) {
            console.error('[chat] onError terminal emit failed:', emitErr)
          } finally {
            reject(new Error(error))
          }
        }
      },
      signal,
      params,
      audit
    ).catch((streamErr) => {
      // R2 (Phase-3) — bind chatStream's OWN failure to the turn. onDone/onError
      // are the normal terminal sites, but a pre-loop setup throw (or any
      // rejection of the chatStream promise itself) that never reached a
      // callback would otherwise orphan this executor. reject is idempotent
      // once a terminal callback already settled, so this is a no-op on the
      // happy path and the safety net when a callback was never invoked.
      reject(streamErr instanceof Error ? streamErr : new Error(messageOf(streamErr)))
    })
  })
}

interface ResolvedToolCall {
  callId: string
  result: string
}

/**
 * R4 (Phase-3) — never-throw wrapper around resolveSingleToolCall, adopting the
 * same contract executeToolCall/dispatchNativeTool hold: ALWAYS return a
 * `{ callId, result }` row, NEVER throw. resolveSingleToolCall already routes
 * every KNOWN failure into a result string, but an UNEXPECTED throw (an approval
 * runtime bug, a windowing edge, a hook that rejects unexpectedly) would
 * otherwise propagate out of the onDone tool loop and orphan the turn. This
 * converts any such throw into a tool-role error row so the batch stays intact
 * and the model still sees a result for the call.
 */
async function safeResolveToolCall(
  tc: ProviderToolCall,
  conversationId: string,
  model: string,
  workspacePath: string,
  signal: AbortSignal,
  correlationId?: string,
  unattended: boolean = false
): Promise<ResolvedToolCall> {
  try {
    return await resolveSingleToolCall(
      tc,
      conversationId,
      model,
      workspacePath,
      signal,
      correlationId,
      unattended
    )
  } catch (err) {
    return { callId: tc.id, result: `Error: ${messageOf(err)}` }
  }
}

async function resolveSingleToolCall(
  tc: ProviderToolCall,
  conversationId: string,
  model: string,
  workspacePath: string,
  signal: AbortSignal,
  correlationId?: string,
  /** Unattended (loop / autonomy) run — apply the action-class CAP floor
   *  (fail-closed) between the deny branch and dispatch. Defaults false so the
   *  interactive path is unchanged. */
  unattended: boolean = false
): Promise<ResolvedToolCall> {
  const toolName = tc.function.name
  let args: Record<string, unknown> = {}
  const rawArgs = tc.function.arguments
  try {
    args = JSON.parse(rawArgs)
  } catch {
    args = {}
  }

  // Fix C — detect empty-parameter tool calls caused by reasoning token
  // exhaustion. Pure detection in empty-params-guard.ts; see that module
  // for the full rationale.
  {
    const schemaReq = (toolRegistry.getById(toolName)?.inputSchema as
      | { required?: string[] }
      | undefined)?.required
    const detection = detectEmptyParams(toolName, rawArgs, schemaReq)
    if (detection.isEmpty) {
      trace('resolveToolCall.empty-params-detected', {
        callId: tc.id,
        conversationId,
        toolName,
        rawArgs: (rawArgs || '').trim(),
        requiredFields: detection.requiredFields
      })
      return {
        callId: tc.id,
        result: JSON.stringify({
          error: 'empty_tool_parameters',
          tool: detection.toolName,
          required_fields: detection.requiredFields,
          diagnosis: detection.diagnostic,
          hint: 'Do not re-plan. Emit the tool call immediately with minimal reasoning.'
        })
      }
    }
  }

  // HY2 — `tool_search` meta-tool. Synthetic surface-only tool (no registry
  // descriptor), handled before the dispatch path: resolve matches, unlock
  // them for this conversation so the next round can call them natively, and
  // return the match list. A malformed (empty-query) call counts toward the
  // surface downgrade so a model that can't drive the round-trip falls back
  // to the full catalog.
  if (toolName === TOOL_SEARCH_TOOL_NAME) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    if (!query) {
      const n = recordMalformedSearch(conversationId)
      return {
        callId: tc.id,
        result: JSON.stringify({
          error: 'tool_search requires a non-empty "query" string.',
          malformedCount: n
        })
      }
    }
    const matches = toolRegistry.resolveToolSearch(query)
    unlockTools(
      conversationId,
      matches.map((m) => m.name)
    )
    return {
      callId: tc.id,
      result: JSON.stringify({
        query,
        unlocked: matches.map((m) => m.name),
        tools: matches,
        note: matches.length
          ? 'These tools are now available — call them directly on your next turn.'
          : 'No matching tools found. Try a different capability description.'
      })
    }
  }

  // FC-5 — Validate arguments against the tool's inputSchema before
  // dispatching. If the model produced invalid arguments (wrong types,
  // missing required fields, extra properties), return a corrective
  // tool-result message instead of executing. This lets the model
  // correct its call on the next turn rather than getting a cryptic
  // handler error or worse, silent wrong behavior.
  const descriptor = toolRegistry.getById(toolName)
  if (descriptor?.inputSchema) {
    const validation = validateToolArguments(toolName, args, descriptor.inputSchema)
    if (!validation.valid) {
      const errorDetail = validation.errors.join('; ')
      trace('resolveToolCall.validation-failed', {
        callId: tc.id,
        conversationId,
        toolName,
        errors: validation.errors
      })
      return {
        callId: tc.id,
        result: JSON.stringify({
          error: 'argument_validation_failed',
          details: validation.errors,
          hint: 'Check the tool schema and retry with corrected arguments.'
        })
      }
    }
    // Use the parsed (and potentially normalized) args from the validator
    args = validation.parsed
  }

  const startTime = Date.now()
  trace('resolveToolCall.enter', {
    callId: tc.id,
    conversationId,
    toolName,
    parentSignalAborted: signal.aborted
  })

  const earlyDescriptor = toolRegistry.getById(toolName)
  emitChatEvent('chat:tool-call', {
    callId: tc.id,
    conversationId,
    serverId: toolName.includes('__') ? toolName.split('__')[0] : 'internal',
    toolName: toolName.includes('__') ? toolName.split('__').slice(1).join('__') : toolName,
    title: earlyDescriptor?.title ?? toolName,
    risks: earlyDescriptor?.risks ?? [],
    providerKind: earlyDescriptor?.providerKind ?? 'native',
    startedAt: startTime,
    args,
    transcriptHidden: earlyDescriptor?.transcriptHidden
  })

  toolRegistry.recordCallStart(
    {
      id: tc.id,
      toolId: toolName,
      name: toolName,
      conversationId,
      args,
      startedAt: startTime,
      status: 'running'
    },
    correlationId
  )

  let result: string
  let explicitStatus: 'done' | 'error' | 'denied' | undefined

  if (descriptor) {
    emitPhase(conversationId, inferPhaseFromDescriptor(descriptor))
  }

  // UB-4 (Unburdening Phase, 2026-06-10) — the WC-3 implicit change-contract
  // synthesis + CR-5 mutation-attempt tracking that ran here fed the M5
  // proof gate; all excised with it. Mutating calls go straight to the
  // plan-mode gate + approval flow below, exactly like the era product.

  // Track 2 / C3 — plan-mode gate. Block mutating tools without asking
  // for approval first: there is no point routing through the modal when
  // the mode already says no, and a global 'deny destructive' policy
  // shouldn't get to silently allow what plan-mode forbids. The
  // enter/exit tools opt out of the gate via `mutates: false` on the
  // descriptor, so the model can always flip the mode back off.
  const planModeActive = isPlanModeActive(conversationId)
  const blockedByPlanMode = planModeActive && isMutatingDescriptor(descriptor)

  const needsApproval = !blockedByPlanMode && descriptorNeedsApproval(descriptor)
  // S7 / S12 — shell_command + `dangerously_disable_sandbox: true` escalates
  // the approval flow: per-call risks gain `'sandboxBypass'`, any persisted
  // "always allow" is skipped, and the modal re-pops for every call. Other
  // tools do not honour the flag.
  const isDangerousShellBypass =
    toolName === 'shell_command' && args?.dangerously_disable_sandbox === true
  // FC-9 — fallback-provenance calls (from text parsing, not native
  // tool_calls) carry degraded trust. Mutating fallback calls skip any
  // persisted "always allow" policy and always re-prompt the user.
  const isFallbackProvenance = tc.id.startsWith('fb_')
  const isFallbackMutating = isFallbackProvenance && isMutatingDescriptor(descriptor)
  // W1 — Rule-of-Two escalation (governance/rule-of-two.ts): a session that has already
  // ingested untrusted content AND touched secret-class material must not take a
  // state-changing/external action on a stale "always allow". Interactively this rides
  // the SAME mechanism as the shell-bypass/fallback escalations above (`dangerous` skips
  // persisted allow and re-pops the modal — the human IS the Rule-of-Two gate). An
  // unattended run has no human; the hard floor branch below refuses instead.
  const rotEscalation = descriptor && !blockedByPlanMode ? ruleOfTwoCheck(conversationId, descriptor) : null
  const callRisks = isDangerousShellBypass && descriptor
    ? [...descriptor.risks, 'sandboxBypass' as const]
    : descriptor?.risks
  const approvalOutcome =
    needsApproval && descriptor
      ? await permissionsService.requestApprovalDetailed({
          callId: tc.id,
          toolId: descriptor.id,
          name: descriptor.name,
          serverId: descriptor.providerId,
          providerKind: descriptor.providerKind,
          risks: callRisks ?? descriptor.risks,
          args,
          conversationId,
          correlationId,
          // R7 (Phase-4) — thread the turn's abort signal so a chat:cancel /
          // deadline resolves an AFK modal as a deny instead of deadlocking.
          signal,
          dangerous: (isDangerousShellBypass || isFallbackMutating || !!rotEscalation) ? true : undefined
        })
      : { decision: 'allow' as const, source: 'none' }
  const approvalDecision = approvalOutcome.decision
  const approvalSource = blockedByPlanMode ? 'plan-mode' : approvalOutcome.source

  // irreversibility taxonomy, keyed off the descriptor's STRUCTURED signals
  // (mutates / requiresApproval / risks), not free text. A loop turn has no
  // human to approve a CAP-class act, so refuse it even though the approval gate
  // above resolved 'allow' (an always-allow policy or a capability list).
  // `capFloorForDescriptor` never floors a read (a danger word in an arg no
  // longer over-blocks), floors a mutating tool that is CAP by risk or by its
  // normalized name (so snake_case `shell_command` is caught), allows a
  // reversible-write tool (`apply_patch`), and FAILS SAFE — an unclassifiable
  // mutating tool is refused. Interactive runs (unattended=false) skip this
  // entirely and keep the modal/policy path.
  const capFloor =
    unattended && approvalDecision === 'allow' && descriptor
      ? capFloorForDescriptor(descriptor, args)
      : null

  // Taint floor — injection containment (CaMeL invariant), enforced in BOTH interactive
  // and unattended runs: an irreversible/outward tool whose argument was lifted from
  // untrusted content read earlier this conversation is refused, so a scraped or on-screen
  // instruction cannot drive a shell / send / delete / navigate.
  const taintStore = conversationId ? getConversationTaintStore(conversationId) : undefined
  const taintFloor =
    descriptor && approvalDecision === 'allow' && !blockedByPlanMode
      ? taintFloorForDescriptor(descriptor, args, taintStore)
      : null

  // W3.1 — per-action reviewer on the UNATTENDED chat branch. This is the path a loop
  // lands on when the L6 provider-failover chain switches it off 'duin-brain' onto a raw
  // provider (loop-controller.ts:808) — without this, failover silently exits reviewer
  // coverage. Runs only when no deterministic floor above already refused, and only for
  // MUTATING calls (reads never cost a model call). actorModel enables the reviewer's
  // distinct-family preference.
  const rotProfile = conversationId ? ruleOfTwoProfile(conversationId) : null
  const reviewVerdict =
    unattended &&
    descriptor &&
    !blockedByPlanMode &&
    approvalDecision === 'allow' &&
    !capFloor &&
    !taintFloor &&
    !rotEscalation &&
    isMutatingDescriptor(descriptor)
      ? await reviewAction({
          toolName: descriptor.name,
          args,
          surface: 'chat-unattended',
          actorModel: model,
          context: {
            taintPresent: (taintStore?.size() ?? 0) > 0,
            untrustedIngested: rotProfile?.untrustedIngested,
            secretTouched: rotProfile?.secretTouched
          }
        })
      : null

  if (blockedByPlanMode) {
    result =
      'Blocked: plan mode is active for this conversation. Read-only tools are still available; call `exit_plan_mode` (or have the user click "Exit plan mode" in the banner) to allow mutating tools.'
    explicitStatus = 'denied'
  } else if (approvalDecision === 'deny') {
    result = 'Action denied by user.'
    explicitStatus = 'denied'
  } else if (capFloor) {
    result = `Action refused: '${descriptor?.name ?? toolName}' is a ${capFloor.title} (CAP-class — needs human approval) in an unattended loop run.`
    explicitStatus = 'denied'
  } else if (taintFloor) {
    result = `Action refused: ${taintFloor.reason}`
    explicitStatus = 'denied'
  } else if (unattended && rotEscalation) {
    // W1 hard floor — an unattended turn cannot answer the Rule-of-Two re-prompt, so a
    // completed triple is a refusal (the interactive path resolves it via the forced
    // modal above; approval 'deny' there lands in the approvalDecision branch).
    result = `Action refused: ${rotEscalation.reason}`
    explicitStatus = 'denied'
  } else if (
    reviewVerdict &&
    reviewVerdict.source !== 'skipped' &&
    (reviewVerdict.tier === 'critical' || reviewVerdict.tier === 'high')
  ) {
    // W3.1 — no human anywhere on this branch, so BOTH critical and high refuse
    // (same vocabulary as the tool-exec headless face).
    result = `Action refused: the independent action reviewer rated '${descriptor?.name ?? toolName}' ${reviewVerdict.tier} (${reviewVerdict.reason}) and this is an unattended run.`
    explicitStatus = 'denied'
    try {
      recordEvent({
        type: 'tool.call.denied',
        actorKind: 'system',
        severity: 'warning',
        conversationId,
        workspacePath,
        entityKind: 'tool',
        entityId: toolName,
        payload: { toolId: toolName, source: `action-reviewer:${reviewVerdict.tier}`, reason: reviewVerdict.reason, surface: 'chat-unattended' }
      })
    } catch (e) { console.debug('[chat] reviewer denial audit is best-effort:', messageOf(e)) }
  } else {
    // Track 2 / C2 — preToolUse hooks run after approval but before dispatch.
    // A throwing preToolUse hook BLOCKS the call: its message reaches the
    // model as the synthetic tool result and the audit row records 'denied'
    // with approvalSource left at the approval gate's value (the hook is
    // its own provenance). Hook errors are also surfaced as logs for the
    // UI's recent-runs view.
    const preHook = await fireHooks('preToolUse', {
      conversationId,
      toolName,
      args,
      cwd: workspacePath
    })
    if (preHook.blocked) {
      result = `Blocked by hook: ${preHook.blockReason ?? 'preToolUse refused'}`
      explicitStatus = 'denied'
    } else if (toolName === 'memory_add' && typeof args.content === 'string') {
      // Attribute the memory to the conversation's project (if any) so per-project
      // memory views show it; falls back to the global lane when unattributed.
      const projectId = conversationId ? convStore.getConversation(conversationId)?.projectId ?? null : null
      const projectSlug = projectId ? getProject(projectId)?.slug : undefined
      const entry = memStore.addMemory(args.content, conversationId, projectSlug ?? undefined)
      emitChatEvent('memory:added', entry)
      result = 'Saved to memory.'
    } else if (toolName === 'create_document') {
      const nameRaw = typeof args.name === 'string' ? args.name.trim() : ''
      const mimeRaw = typeof args.mimeType === 'string' ? args.mimeType.trim() : ''
      const contentRaw = typeof args.content === 'string' ? args.content : ''
      if (!nameRaw || !mimeRaw || !contentRaw) {
        result =
          'Error: create_document requires non-empty `name`, `mimeType`, and `content`.'
        explicitStatus = 'error'
      } else {
        const sizeBytes = Buffer.byteLength(contentRaw, 'utf8')
        if (sizeBytes > CREATE_DOCUMENT_MAX_BYTES) {
          result = `Error: create_document body exceeds ${CREATE_DOCUMENT_MAX_BYTES} bytes (got ${sizeBytes}). Split into multiple documents or shorten.`
          explicitStatus = 'error'
        } else {
          const doc: StoredDocument = {
            id: randomUUID(),
            name: nameRaw.slice(0, 200),
            mimeType: mimeRaw.slice(0, 120),
            content: contentRaw,
            sizeBytes,
            createdAt: Date.now()
          }
          pushPendingDocument(correlationId, doc)
          emitChatEvent('chat:document-created', { conversationId, document: doc })
          result = `Document "${doc.name}" (${doc.sizeBytes} bytes, ${doc.mimeType}) attached to this turn. Do NOT paste the body into your visible reply — the user already sees the card.`
        }
      }
    } else if (toolName === 'enter_plan_mode') {
      // Track 2 / C3 — inline because the handler emits a renderer event.
      // Persisted on the conversation row so it survives a restart.
      setPlanModeActive(conversationId, true)
      emitChatEvent('plan:mode-changed', { conversationId, active: true })
      result =
        'Plan mode is on. Mutating tools (apply_patch, shell_command, destructive MCP) are blocked until exit_plan_mode is called.'
    } else if (toolName === 'exit_plan_mode') {
      setPlanModeActive(conversationId, false)
      emitChatEvent('plan:mode-changed', { conversationId, active: false })
      result = 'Plan mode is off. Mutating tools are allowed again.'
    } else if (toolName === 'mark_chapter') {
      // Track 2 / E1 — anchor the chapter at the assistant turn that
      // produced the call. The anchor message id is not yet persisted at
      // this point in the dispatch loop (the post-tool assistant message
      // gets persisted after this returns), so we anchor on the existing
      // tool-call id — chat-history can map it back to its parent
      // assistant turn. The renderer treats the anchor as the boundary
      // marker; UI cosmetic, no behavioural dependency on exact mapping.
      const titleRaw =
        typeof args.title === 'string' ? args.title.trim() : ''
      const summaryRaw =
        typeof args.summary === 'string' ? args.summary.trim() : ''
      if (!titleRaw) {
        result = 'Error: mark_chapter requires a non-empty `title`.'
        explicitStatus = 'error'
      } else {
        const chapter = createChapter({
          conversationId,
          title: titleRaw.slice(0, 80),
          summary: summaryRaw ? summaryRaw.slice(0, 280) : null,
          anchorMessageId: tc.id
        })
        emitChatEvent('chat:chapter-marked', { conversationId, chapter })
        // Plan §2 invariant 10 — chapters also land on the event spine
        // for the audit timeline.
        try {
          recordEvent({
            type: 'chat.chapter.marked',
            actorKind: 'model',
            conversationId,
            correlationId,
            entityKind: 'chapter',
            entityId: chapter.id,
            payload: {
              title: chapter.title,
              summary: chapter.summary,
              anchorMessageId: chapter.anchorMessageId
            }
          })
        } catch (err) {
          console.error('[chat] chat.chapter.marked spine event failed:', err)
        }
        result = `Chapter marked: "${chapter.title}"`
      }
    } else if (toolName === 'ask_user_question') {
      // Integration / H6 — route through the singleton ask-user-runtime.
      // The handler returns the chosen option label (multi-select returns a
      // comma-separated list); a timeout returns the literal "(timed out)"
      // so the model can detect non-interactive contexts and proceed.
      const question = typeof args.question === 'string' ? args.question.trim() : ''
      const header = typeof args.header === 'string' ? args.header.trim() : ''
      const optionsRaw = Array.isArray(args.options) ? args.options : []
      const options: Array<{ label: string; description?: string; preview?: string }> = []
      for (const o of optionsRaw) {
        if (!o || typeof o !== 'object') continue
        const opt = o as Record<string, unknown>
        const label = typeof opt.label === 'string' ? opt.label.trim() : ''
        if (!label) continue
        const entry: { label: string; description?: string; preview?: string } = { label }
        if (typeof opt.description === 'string') entry.description = opt.description
        if (typeof opt.preview === 'string') entry.preview = opt.preview
        options.push(entry)
      }
      if (!question || !header || options.length < 2 || options.length > 4) {
        result =
          'Error: ask_user_question requires `question`, `header`, and 2-4 `options` with non-empty `label`s.'
        explicitStatus = 'error'
      } else {
        try {
          const runtime = getAskUserRuntime()
          if (!runtime) {
            throw new Error('ask-user runtime not initialised')
          }
          const answer = await runtime.ask({
            question,
            header,
            options,
            // Binds the prompt to this turn so `chat:cancel` on ANOTHER
            // conversation cannot resolve it.
            conversationId,
            multiSelect: !!args.multiSelect,
            timeoutMs:
              typeof args.timeoutMs === 'number' && Number.isFinite(args.timeoutMs)
                ? args.timeoutMs
                : undefined
          })
          if (answer.kind === 'timeout') {
            result = '(timed out — user did not respond)'
          } else if (answer.kind === 'cancelled') {
            result = '(cancelled by user)'
          } else if (answer.kind === 'single') {
            result = answer.notes ? `${answer.label} — ${answer.notes}` : answer.label
          } else {
            const joined = answer.labels.join(', ')
            result = answer.notes ? `${joined} — ${answer.notes}` : joined
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          result = `Error: ${msg}`
          explicitStatus = 'error'
        }
      }
    } else if (toolRegistry.hasHandler(toolName)) {
      // Make the ACT gate load-bearing on THIS path. runChatRound is the trusted local
      // operator path — channels reach the brain via /agui and never reach here — so publish
      // full privilege for the external-action handler's re-check (external-action.ts), and
      // clear it in the finally so no value leaks to a later reader (kills the module-global
      // stale-state the /agui set-site would otherwise leave behind).
      setActExecContext(true)
      const dispatched = await (async () => {
        try {
          return await dispatchNativeTool(
            () =>
              toolRegistry.executeNative(toolName, args, {
                conversationId,
                workspacePath,
                model,
                signal,
                callId: tc.id,
                correlationId
              }),
            // R4 (Phase-4) — per-tool wall-clock timeout + abort at the native
            // seam so a hung handler can't park the round. shell_command carries
            // its own 120s/600s budget the model was promised; thread it in so
            // the flat 60s backstop can't clip a long command before its own
            // timeout fires.
            {
              signal,
              toolName,
              timeoutMs: toolWallClockBudgetMs(toolName, args, {
                defaultMs: SHELL_DEFAULT_TIMEOUT_MS,
                maxMs: SHELL_MAX_TIMEOUT_MS
              })
            }
          )
        } finally {
          clearActExecContext()
        }
      })()
      result = dispatched.result
      explicitStatus = dispatched.status
      if (toolName === 'update_plan' && dispatched.status === 'done') {
        try {
          const snapshot = JSON.parse(result)
          emitChatEvent('plan:updated', { conversationId, snapshot })
        } catch {
          // Snapshot shape drifted — renderer refetches on the next
          // conversation switch.
        }
      }
    } else if (toolName.includes('__')) {
      const [serverId, ...nameParts] = toolName.split('__')
      const mcpToolName = nameParts.join('__')
      try {
        const mcpResult = await mcpManager.callTool(serverId, mcpToolName, args)
        result = typeof mcpResult === 'string' ? mcpResult : JSON.stringify(mcpResult)
      } catch (err) {
        result = `Error: ${messageOf(err)}`
      }
    } else {
      result = `Unknown tool: ${toolName}`
    }
  }

  // Track 2 / C2 — postToolUse fires after the handler completes (whether
  // it succeeded, failed, or was denied by approval/hook). Hooks here can
  // log every invocation but never block — we are past the dispatch point.
  // Awaited so the synchronous JS sandbox completes before the next call
  // in the same window starts.
  if (result === undefined) result = ''
  // Record untrusted-source results (screen / web / MCP) so a later tool call whose arg is
  // lifted from this content trips the taint floor above.
  if (
    taintStore &&
    descriptor &&
    isUntrustedSource(descriptor) &&
    explicitStatus !== 'denied' &&
    explicitStatus !== 'error'
  ) {
    taintStore.markUntrusted(result)
  }
  // W1 — accrue this executed call's Rule-of-Two legs (untrusted/secret/state-change)
  // onto the session profile, beside the taint mark it composes with.
  if (descriptor && explicitStatus !== 'denied' && explicitStatus !== 'error') {
    noteExecutedTool(conversationId, descriptor)
  }
  await fireHooks('postToolUse', {
    conversationId,
    toolName,
    args,
    result,
    cwd: workspacePath
  })

  const duration = Date.now() - startTime
  const finishedAt = startTime + duration
  const auditStatus = explicitStatus ?? classifyToolResult(result)
  toolRegistry.recordCallEnd(tc.id, {
    status: auditStatus,
    result: auditStatus === 'error' ? undefined : result,
    error: auditStatus === 'error' ? result : undefined,
    finishedAt,
    approvalSource,
    correlationId
  })
  emitChatEvent('chat:tool-call-result', {
    callId: tc.id,
    conversationId,
    result,
    duration,
    status: auditStatus === 'done' ? 'success' : auditStatus
  })
  trace('resolveToolCall.return', {
    callId: tc.id,
    toolName,
    duration,
    status: auditStatus,
    resultLen: result.length
  })

  return { callId: tc.id, result }
}
