// In-process local "brain" — an AG-UI HTTP+SSE server bound to 127.0.0.1:8799.
//
// It speaks the SAME wire contract the external DUIN brain does
// (duin-bridge.ts consumes it unchanged): POST /agui with
// {threadId, messages:[{role,content}]} → SSE `data: {json}\n\n` frames. By
// making the connector's DEFAULT endpoint point here, the app is useful with
// NO external server: notes-RAG → tool card → grounded provider streaming.
//
// Turn sequence on /agui:
//   RUN_STARTED
//   TEXT_MESSAGE_START
//   TOOL_CALL_START { toolCallId, toolName:'search_notes', args:{query} }
//   TOOL_CALL_END   { toolCallId, result:'<k notes, snippets>' }
//   TEXT_MESSAGE_CONTENT { delta } *           (streamed provider tokens)
//   TEXT_MESSAGE_END
//   RUN_FINISHED
// Errors → RUN_ERROR.
//
// Provider reuse: the grounded answer is produced by the user's chosen
// provider via the registry's `chatStream` (NO reimplemented HTTP). The engine
// is the CHAT ROLE (resolveAnswerEngine → registry resolveRole): the request's
// per-conversation pin when callable, else the operator's providerPolicy
// filtered by live provider health — there is no stored default model (P0
// model plane, roles.ts). With nothing callable, the keyless composed answer
// ends with a plain call to connect a model in Settings.

import { handleExecutiveRequest } from '../executive-api/exec-endpoint'
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'http'
import { validateArtifact } from '../artifact-sandbox'
import type { ResolvedSkill } from '../../shared/chat-send-contract'
import { looksLikeIncompleteIntent } from './incomplete-intent'
import { finalizeAnswer } from './answer-completeness'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, renameSync, statSync } from 'fs'
import { join, normalize, sep, dirname, extname } from 'path'
import { execFile, spawn } from 'child_process'
import {
  reindex,
  isReindexing,
  search,
  coverInWindow,
  indexedCount,
  snippetForFile,
  mergeGraphNeighbors,
  rerankHits,
  embedForRecall,
  warmEmbedder
} from './index-store'
import { readRetrievalTunables } from './retrieval-tunables'
import { resolveRerankMode } from '../rag/rerank'
import { deriveGraph } from './graph-derive'
import { restartNotesWatcher, scheduleReindex } from './notes-watcher'
import { getConstruction, applyConstruction } from '../brain/construct'
import { selfImproveEngageTick } from '../brain/self-improve-tick'
import { notePresence } from '../background-work-gate'
import { buildBrainGraph } from '../brain/brain-graph-native'
import { listFutures } from '../brain/futures-native'
import { listSchedules, listIntel, listDocuments, readDocumentBytes, scheduleAction } from '../brain/loop-artifacts-native'
import { runLoopAgentic } from '../loop-agent'
import { listTasks } from '../brain/list-tasks-native'
import { worldGraph } from '../brain/world-graph-native'
import { runGenerateStrategy, runGenerateModel } from '../brain/generate-strategy-native'
import { saveStrategy, saveMentalModel } from '../brain/strategy-save-native'
import { draftReply } from '../brain/draft-reply-native'
import { saveToRaw, autoTrackRisks, inferDrivers, saveUpload, learnLoopStatus } from '../brain/misc-routes-native'
import { app, dialog, BrowserWindow } from 'electron'
import { meetingScan } from '../brain/meeting-scan-native'
import { pullFeishuMessages, sendFeishuMessage } from '../brain/feishu-comms-native'
import { larkExec } from '../lark-exec'
import { recordVerdict } from '../brain/decision-verdict-native'
import { saveProjectLogo, clearProjectLogo } from '../brain/project-logo-native'
import { retrieveContext, toGraphView, graphNeighbors, liveWholeNotes, liveGraph, type Citation, renderComputed } from '../brain/retrieve-agent'
import { buildWholeNoteContext } from '../brain/wholenote-ground'
import { buildCurrencyBlock, supersessionsIn, superseders } from '../brain/grounding-currency'
import { buildGraphExpandContext, graphExpandGroundEnabled } from '../brain/graph-expand-adapt'
import { compileContext } from '../brain/context-compiler'
import { detectCommunities } from '../brain/graph-insight'
import { runEmbedderEval } from './embedder-eval'
import type { LabeledQuery } from '../rag/embeddings/_eval/scoring'
import { detectGapsLive } from '../brain/capability-gap-live'
import { computeThroughput } from '../brain/throughput'
import { causalGraph } from '../brain/causal-substrate'
import { predictedRisks } from '../brain/predicted-risks-native'
import { worldState, revealedRisks } from '../brain/world-state-native'
import { forecastRecord } from '../brain/forecast-record-native'
import { scenarioForks } from '../brain/scenario-forks-native'
import { calibration } from '../brain/calibration-native'
import { scoreResolvedLedger } from '../brain/calibration-scoring'
import { syntheticReplayScore } from '../brain/calibration-replay'
import { buildAutonomyState } from '../ans/autonomy-report'
import { listActions, revertAction } from '../ans/action-ledger'
import { runCalibration } from '../brain/calibration-store'
import { getMoatHealth } from '../brain/moat-health'
import { runShadowMetabolism, runLiveMetabolism, applyClaimResolution, loadPersistedLedger, claimMetabolismLive, type ResolveAction } from '../brain/claim-extract'
import { loadLedger, parseDateMs } from '../brain/claim-ledger'
import { claimsAsOf } from '../brain/claim-metabolism'
import { applyClaimFreshness, claimRecallEnabled, activeClaimsForHits } from '../brain/claim-recall'
import { stageReinforcementCandidates, reinforceTick, claimReinforceEnabled } from '../brain/claim-reinforce'
import { resolveSubagentConfig, type ResolvedSubagentConfig } from './subagent-config'
import { runLearningShadow, runLearningDeep } from '../brain/learning-metabolism'
import { runCalibrationMetabolism, loadKindRatesWithCurrency } from '../brain/calibration-metabolism'
import { runMeasurePass } from '../brain/judgment-measure-live'
import { getSkillGrounding, getSkillGroundingAsync } from '../brain/skill-library'
import { getImprovementProposals } from '../brain/improvement-proposer'
import { appendCorrection, runReflect } from '../brain/learn-store'
import { getTaste, toks, type Correction } from '../brain/learn-native'
import { loadKindRates } from '../brain/calibration-weight'
import { listFailures } from '../failure-ledger'
import {
  renderTasteBlock,
  renderFailureBlock,
  renderCalibrationBlock
} from './personalization-blocks'
import { listSpacesWrapped } from '../brain/spaces-native'
import { setForecastVerdict, logForecast } from '../brain/forecast-write-native'
import { taskAction, moveTask } from '../brain/task-write-native'
import { setDecisionMeta, resolveNode, makeDecision } from '../brain/decision-write-native'
import { cascadeDecision, cascadeTrack, cascadeProject } from '../brain/cascade-engine-native'
import { resolveCascade } from '../brain/cascade-apply-native'
import { generateOnce } from '../brain/generate-once-native'
import { runProjectFutures } from '../brain/project-futures-native'
// Last Python write-verbs, now native (brain-unification: served in-process TS).
import { captureWork } from '../brain/capture-work-write-native'
import { runScout } from '../brain/scout-active-work-native'
import { runStreamNudge } from '../brain/stream-nudge-write-native'
import { actWorldUpdate } from '../brain/world-update-act-write-native'
import { actRevealedRisk } from '../brain/revealed-risk-write-native'
import { seedFromVault } from '../brain/cold-start-seed'
import { bindCandidate, correctionFailsBindings } from '../brain/binding-ledger'
import { loadBindings, appendBinding, writeBindings } from '../brain/binding-store'
import { setTrackProject, addTrack } from '../brain/track-write-native'
import { updateStream, bindTask, unbindTask, actFuture, extractStream } from '../brain/stream-write-native'
import { recordPredictionFeedback, dismissAnchorCandidate, createProject } from '../brain/tier2-writes-native'
import { extractWorldUpdate } from '../brain/world-update-native'
import { meetingAction } from '../brain/meeting-write-native'
import { anchors } from '../brain/anchors-native'
import { eventPrep } from '../brain/event-prep-native'
import { decisionLoop } from '../brain/decision-loop-native'
import { listProfile } from '../brain/profile-native'
import { listDetectors } from '../brain/detectors-native'
import { streamVerdicts, forecastOwed, cascadePending, listMeetings } from '../brain/simple-reads-native'
import { listTracks } from '../brain/tracks-native'
import { listProblems } from '../brain/problems-native'
import { listStrategies, listMentalModels } from '../brain/strategies-native'
import { buildGraph } from '../brain/build-graph-native'
import { futuresGraph } from '../brain/futures-graph-native'
import { listEntities } from '../brain/entities-native'
import { listConversations } from '../brain/conversations-native'
import { listWorkflows } from '../brain/workflows-native'
import { listProjectsWrapped } from '../brain/projects-native'
import { projectDetail } from '../brain/project-detail-native'
import { listDecisions } from '../brain/decisions-native'
import { buildStyleFingerprint } from '../brain/style-fingerprint-service'
import { looksLikeGenerativeWrite, generativeProseFirstEnabled } from '../brain/generative-intent'
import { resolvePeriodWindow } from '../brain/period-window'
import { isGatedTool, execAuthorized, deniedResult } from './agui-guard'
import { screenCommand, classifyCommandRisk } from './command-screen'
import { decideAguiGate, aguiTier, tierRisks, resolveTurnPosture, isMcpToolName, type AguiPosture } from './agui-approval'
import { partitionAguiWindows, mapLimit, AGUI_PARALLEL_LIMIT } from './agui-windows'
import { buildMcpToolSchemas, splitMcpToolName } from './agui-mcp'
import { mcpManager } from '../mcp-manager'
import { applyProfile, hasKernelSandbox, type SandboxTier } from '../sandbox'
import { permissionsService } from '../permissions-store'
import { resolveDecision as resolvePersistedDecision } from '../permission-policies-store'
import { recordEvent, listEvents } from '../event-log'
import { docResponse, resolveResponse } from '../brain/doc-native'
import { listOutputs } from '../brain/outputs-native'
import { listValue } from '../brain/value-native'
import { conversationThreads } from '../brain/conversation-threads-native'
import { listExperts } from '../brain/experts-native'
import { decisionConnections } from '../brain/decision-connections-native'
import { generateForecasts } from '../brain/forecast-generator'
import { logForecastsToLedger } from '../brain/forecast-ledger'
import type { CausalGraph, DecisionOutcome } from '../brain/types'
import {
  getCausalGraph,
  runPropagate,
  getPredictedRisks,
  getWorldState,
  getInsights,
  getKeylessInsightInputs,
  getDecisionLoop,
  recordDecision,
  recordInsightVerdict,
  refreshNotesExtraction,
  buildBrain
} from '../brain'
import { automaticCloudWorkAllowed } from '../brain/cloud-consent'
import { chatStream, chatOnce, routeModel, resolveRole, envRoutePin, routeWithinProvider, getProviderForModel, resolveModel, detectOllama, wholeNoteEgressAllowed, emitRoleFailure, isCallableModel, PROVIDERS } from '../providers/registry'
import type { ProviderId } from '../providers/registry'
import {
  classifyProviderError,
  isProviderFailoverError
} from '../providers/quota-error'
import { AUTO_ENGINE, isBenchRequest, type RoleResolution, type ProviderHealthReason } from '../providers/roles'
import { nextFailoverHop, exhaustionMessage } from '../providers/router'
import { scheduleBootProbes, getProviderHealth, coolingDownClass } from '../providers/provider-health'
import { CONTINUE_PROMPT, continuationVerdict, maxContinuations } from './continuation'
import type { ContinuationVerdict } from './continuation'
import { composeKeylessAnswer } from './keyless-answer'
import { buildMemoryIndexBlock } from '../memory-store'
import { buildOperatorBlock, getOperatorFacts, learnFromTurn, noteSession, pruneCandidatesFromStore, buildGovernAudit, efficacySummary } from '../brain/operator-model'
import { runGovernPass, defaultGovernJury, DEFAULT_GOVERN_POLICY, loadResolvedForecasts } from '../brain/operator-govern'
import { runTransferAB, makeTransferDeps, DEFAULT_TRANSFER_QUERIES } from '../brain/transfer-ab'
import { ConsolidationTracker, runConsolidation } from './consolidation-trigger'
import { runForecastLoop } from '../brain/forecast-loop'
import { isEndorsement, recordSuccess, getSuccesses } from '../brain/success-miner'
import { distillToSkill } from '../brain/named-skill'
import { loadNamedSkills, appendNamedSkill } from '../brain/named-skill-store'
import { recordFeedback } from '../ans/capability-ledger'
import { runGovernorPass } from '../ans/governor'
import {
  operatorCandidates,
  tasteCandidates,
  failureCandidates,
  rankRecall,
  renderRecallBlock,
  confirmedJudgmentTexts,
  tasteRerank
} from './personalization-recall'
import { loadRecallEfficacy, stageRecalledKinds, recallEfficacyTick, classifyOutcome } from './recall-efficacy'
import { turnBeatTick, gradeStagedTurnBeat, turnBeatsEnabled, turnBeatReport, type BeatGrounding } from './turn-beats'
import { loadOntology } from '../brain/ontology'
import { loadBrain, buildBrainGroundingBlock } from '../brain/brain-root'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'

// Port is env-overridable (DUIN_BRAIN_PORT) so a benchmark/isolated instance can bind a distinct
// port. NOTE: a few internal self-calls still hardcode :8799 (e.g. decision-simulator), so full
// CONCURRENT isolation isn't complete yet — for a clean isolated run prefer an EXCLUSIVE instance
// launched with Electron's --user-data-dir (separate settings/index/vault) on the default port.
import { LOCAL_BRAIN_PORT as SHARED_LOCAL_BRAIN_PORT } from '../../shared/brain-port'
export const LOCAL_BRAIN_PORT = SHARED_LOCAL_BRAIN_PORT
export const HOST = '127.0.0.1'

// Per-launch execution token for the deny-first /agui gate (see agui-guard.ts). Generated at
// startLocalBrain(), held here, and handed to the trusted renderer over IPC (never over the wire
// unauthenticated). Null until the server starts → gated tools deny (fail-safe).
let brainExecToken: string | null = null
let brainControlToken: string | null = null
export function getBrainExecToken(): string | null {
  return brainExecToken
}
export function getBrainControlToken(): string | null {
  return brainControlToken
}

// Recall-confidence "currency" (WS1 Item 3a): fold each recall-kind's earned empirical efficacy
// into β_conf so retrieval is metered by CALIBRATED confidence, not raw cosine — the design's
// core "confidence is the currency" claim. Now ON by default (was opt-in `=== '1'`, which left the
// currency inert): the nudge is already bounded to ±0.15 and gated to genuinely-observed kinds,
// and the semantic floor still governs survival, so activating it can only RE-RANK earned kinds,
// never inject junk. Disable with DUIN_RECALL_CAL=0.
export function recallCalEnabled(): boolean {
  const v = (process.env.DUIN_RECALL_CAL ?? '').trim().toLowerCase()
  return v !== '0' && v !== 'false' && v !== 'off'
}

let server: Server | null = null

type SettingsReader = () => Record<string, unknown>
export let readSettings: SettingsReader = () => ({})

/** Inject the settings reader (settings-helper.readSettings) at boot so this
 *  module needs no electron import in tests. */
export function setLocalBrainSettingsReader(fn: SettingsReader): void {
  readSettings = fn
}

// /state/brain-graph memo (_brainGraphCache + BRAIN_GRAPH_TTL_MS) relocated to
// ./brain-native-routes with the /state/brain-graph route that owns it.

type SettingsWriter = (patch: Record<string, unknown>) => void
export let writeSettings: SettingsWriter = () => {}
/** Inject the settings writer (settings-helper.patchSettings) at boot — used by
 *  /state/config to persist vault dir / model / auto-track. */
export function setLocalBrainSettingsWriter(fn: SettingsWriter): void {
  writeSettings = fn
}

const DOC_EXTS = ['.md', '.markdown', '.txt', '.canvas', '.json', '.jsonl', '.csv', '.yaml', '.yml']

/** Resolve a vault-relative note path to an absolute path inside the connected
 *  notes folder. Mirrors the Python engine's _doc_abspath: strips a `vault:`
 *  prefix, blocks traversal, allows only note-ish extensions. Null = invalid. */
export function docAbspath(rel: string): string | null {
  const base = (readSettings().localBrainNotesDir as string) || ''
  if (!base) return null
  let r = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (r.startsWith('vault:')) r = r.slice('vault:'.length).replace(/^\/+/, '')
  if (!r) return null
  const root = normalize(base)
  const full = normalize(join(root, r))
  if (full !== root && !full.startsWith(root + sep)) return null // traversal guard
  if (!DOC_EXTS.some((e) => full.toLowerCase().endsWith(e))) return null
  return full
}

/** Read a request body to a string (small JSON payloads only). */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let buf = ''
    let settled = false
    const done = (v: string): void => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    req.on('data', (c) => {
      buf += c
      if (buf.length > 5_000_000) {
        // 5MB cap. Resolve (reject the oversized body) BEFORE destroying — a bare
        // req.destroy() fires neither 'end' nor 'error', so without this the
        // awaiting handler would hang forever and leak the socket.
        done('')
        req.destroy()
      }
    })
    req.on('end', () => done(buf))
    req.on('error', () => done(''))
    req.on('close', () => done(buf))
  })
}

export interface AguiMessage {
  role: 'user' | 'assistant' | 'system'
  // Plain string for normal turns; an OpenAI-style multimodal content array
  // (text + image_url parts) for the LAST user turn when the renderer attached
  // vision images. buildGroundedMessages passes this through to the provider.
  content: string | Array<
    | { type: 'text'; text: string }
    | { type: 'image_url'; image_url: { url: string } }
  >
}

/** True when a turn carries at least one image part. */
export function hasImagePart(m: AguiMessage): boolean {
  return Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
}

/**
 * Drop image parts, collapsing the message back to its text projection.
 *
 * The renderer decides whether to attach images from ITS view of the answer model, but the brain is
 * the only place that knows the engine `resolveAnswerModel` actually chose — its tier-policy →
 * Ollama → keyless fallbacks are invisible client-side. When the two disagree, an image_url part
 * would reach a text-only provider as an unsupported content block, i.e. a hard API error. Stripping
 * here makes that disagreement cost the user the IMAGE rather than the whole TURN.
 */
export function stripImageParts(m: AguiMessage): AguiMessage {
  if (!Array.isArray(m.content)) return m
  const text = m.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
  return { role: m.role, content: text }
}

interface AguiRequest {
  threadId?: string
  messages?: AguiMessage[]
  /**
   * Optional GENERATION model the caller (duin-bridge) wants this turn answered
   * with — the user's picked model used as the brain's engine. The brain still
   * grounds/retrieves; only the final-answer LLM changes. Absent → auto-pick
   * (today's behavior). 'duin-brain' / unusable ids fall back to the auto-pick.
   */
  model?: string
  /**
   * The graph node the chat is pinned to ("asking in context"). When its `id`
   * resolves to a real vault note, that note is read and prepended as an
   * AUTHORITATIVE pinned-context block — so the answer grounds on the exact note
   * the user is looking at, not just whatever the keyword/semantic search
   * happened to surface. Absent / non-note kinds → behaves exactly as before.
   */
  context?: { id: string; label: string; kind: string }
  /**
   * User-authored Skills the operator explicitly enabled for this turn (Customize → Skills),
   * already RESOLVED from ids to bodies by the main process. Injected as a floor-tier ACTIVE
   * SKILLS grounding block. Absent → byte-for-byte the old prompt.
   *
   * Before 2026-07-20 the composer sent `activeSkillIds` and this field did not exist, so the ids
   * were validated, sent, and dropped — the Skills toggle had no effect on the default chat path.
   */
  skills?: ResolvedSkill[]
  /**
   * Reasoning effort for the generation model, forwarded from the composer /
   * settings. Applied to the PRIMARY reasoning round; tool-continuation rounds
   * are capped at 'low' so a long agentic chain doesn't multiply latency.
   * Absent → the registry applies its own 'low' default.
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  /**
   * Resumable-stream keys (DUIN_TURN_RESUME). `runId` names this turn's frame ring; a reconnecting
   * client re-POSTs with `resume: true` + the same `runId` (+ a Last-Event-ID header) to replay
   * missed frames and take over live output. Absent → a fresh, non-resumed turn (today's behavior).
   */
  runId?: string
  resume?: boolean
  /**
   * The composer's permissions pill for this turn ('default' | 'auto-review' | 'full'). Resolved
   * against the env posture (env is a FLOOR — the pill may only TIGHTEN, never loosen). Absent /
   * garbled → the env-only posture (today's behaviour), so channel/bridge/headless turns that carry
   * no pill are byte-for-byte unchanged. See agui-approval.resolveTurnPosture.
   */
  permissionsMode?: 'default' | 'auto-review' | 'full'
  /**
   * Response language for this turn ('en' | 'zh' | 'ja'), forwarded from the composer / settings.
   * Rendered as a floor-tier directive so the reply is written in it regardless of the notes'
   * language. Absent → no directive (today's behaviour), so channel/bridge/headless turns that
   * carry no language are byte-for-byte unchanged.
   */
  language?: 'en' | 'zh' | 'ja'
  /**
   * The operator's voice/tone preset for this turn, already resolved to its directive text by the
   * caller (ipc/chat.ts, via agent-tones.resolveToneDirective). Rendered as a floor-tier <voice>
   * block so the preset colours the reply on the DEFAULT chat path too — before this it was only
   * composed in buildSystemPrompt, which the brain path never reaches. Absent → no block, so
   * channel/bridge/headless turns that carry no voice are byte-for-byte unchanged.
   */
  voice?: string
  /** Stop beacon: a lightweight `{abort:true, runId}` POST (no stream) aborts the named run's turn
   *  immediately — how a client tells the brain a disconnect is a deliberate Stop, not a transient
   *  drop, so it aborts now instead of waiting out the reconnect grace window. */
  abort?: boolean
  /** Steer beacon: a lightweight `{steer:text, runId, steerId?}` POST (no stream) INJECTS the text
   *  into the named RUNNING turn as a role:user message at the next round boundary — how a client
   *  nudges a turn already in flight instead of only queuing a whole new turn. Accepted only when
   *  the run exists and is live; a missing/terminal run is rejected (the client then enqueues it as
   *  a durable new turn — a visible race, never a silent mis-fire). Idempotent on `steerId`. */
  steer?: string
  steerId?: string
}

// Turn-resume grace: on a client disconnect the turn keeps running and its frames keep buffering for
// this long, so a reconnect within the window replays + resumes instead of losing the turn.
const TURN_RESUME_GRACE_MS = 30_000
const graceTimers = new Map<string, ReturnType<typeof setTimeout>>()
function clearGrace(runId: string): void {
  const t = graceTimers.get(runId)
  if (t) {
    clearTimeout(t)
    graceTimers.delete(runId)
  }
}

// ──────────────────── model resolution ────────────────────

/**
 * Resolve the CHAT role for this turn (P0 model plane, roles.ts). The request's `model` is the
 * per-conversation pin unless it is the AUTO_ENGINE sentinel ('duin-brain' — "no pin, resolve from
 * policy"); a DUIN_ROUTE_CHAT env pin applies when no request pin does. There is no stored default
 * model any more: the answer comes from the operator's provider policy filtered by live health,
 * and `chain` is the ordered failover list the round loop walks. Null = nothing callable at all
 * (no keyed provider, no local runtime) → the keyless composed answer.
 */
function resolveAnswerEngine(requested?: string): RoleResolution | null {
  const pin = requested && requested !== AUTO_ENGINE ? requested : (envRoutePin('chat') ?? undefined)
  return resolveRole('chat', { pin })
}

/** Why a requested model is not the engine: computed from the key/health record, never typed. */
function describeUnavailable(modelId: string): string {
  if (!isCallableModel(modelId)) return 'no key or unknown id'
  const provider = resolveModel(modelId).provider
  const parked = coolingDownClass(provider)
  const h = getProviderHealth(provider)
  const reason: ProviderHealthReason = parked ?? (h && h.healthy === false ? h.reason : 'unknown')
  return h?.detail ? `${reason} — ${h.detail}` : reason
}

/**
 * Whether the agentic, graph-aware retriever is enabled. Gated behind
 * `settings.agenticRetriever`: when explicitly false → off (today's one-shot
 * search()). When unset → ENABLED (the caller only invokes the retriever when a
 * model is available anyway, and it degrades gracefully to search() on any
 * failure, so the default is safe). Any read error → off.
 */
function agenticRetrieverEnabled(): boolean {
  try {
    const v = readSettings().agenticRetriever
    return v === undefined || v === null ? true : v === true
  } catch {
    return false
  }
}

/**
 * Whether the agentic pass's citations are RANKED by the four shared downstream stages (1-hop
 * graph-neighbour merge → cross-encoder rerank → taste-rerank → claim-freshness demotion) before
 * being rendered, instead of bypassing them by setting `contextOverride` at the dispatch site.
 *
 * DEFAULT ON — measured, 2026-07-25. The bypass shipped on an UNMEASURED code comment ("the agentic
 * pass already ranks its own citations"). Measured live on the operator vault (25 probes × 6
 * replicates over the real index, real graph, real bge cross-encoder, real 342-retired-claim ledger,
 * real glm-4.5-airx driving the real retrieveContext loop), on the 65 probe-runs where the pass
 * actually returned citations (n=65 of 150; on the rest it returns none and server.ts already falls
 * through), routing the citations through the stages beat the bypass on EVERY metric, paired:
 *     recall@5  0.316 → 0.431 (+11.6pp)  MRR 0.797 → 0.870 (+7.2pp)  any-hit@5 0.815 → 0.938 (+12.3pp)
 *     26 probe-runs improved, 7 regressed, 32 tied; the win holds in all 6 replicates separately.
 * Almost all of the recall comes from stage 1 (the graph-neighbour merge the bypass was deleting):
 * reordering the citations with stages 2-4 alone is ~neutral, because the pass emits a MEAN OF 1.8
 * notes and you cannot reorder your way to recall@5 out of 1.8 notes.
 *
 * `DUIN_AGENTIC_RANK_STAGES=0` restores the pre-measurement bypass (opt-OUT polarity, matching the
 * other default-on retrieval flags). See brain/agentic-bypass.eval.ts for the harness and arms.
 */
function agenticRankStagesEnabled(): boolean {
  return process.env.DUIN_AGENTIC_RANK_STAGES !== '0'
}

/** Whole-note grounding: feed the answer model top-K WHOLE notes (BM25) instead of the narrow
 *  cheap-driver citation snippets — the naive-RAG-parity lever. Validated on LongMemEval_S (DUIN
 *  74%→87%, ties the naive-RAG baseline and beats it on knowledge-update +6 / temporal +4) AND on
 *  the operator vault (1072 notes, ~0.8s BM25/query, relevant CN hits).
 *
 *  DEFAULT OFF (opt-IN) — validated-better (+14) BUT it ships up to ~120K chars of full vault-note
 *  bodies to the answer provider (incl. cloud/CN-hosted keys), a real data-egress cost on a sensitive
 *  vault. Held opt-in as a deliberate PRIVACY decision (operator's call): set DUIN_WHOLENOTE_GROUND=1
 *  to enable it as the fallback ahead of the agentic snippet retriever. Contrast the DUIN-native
 *  graph-expand path (local, model-free, no body egress), which IS default-on.
 *
 *  P8 (private-grounding guard): even with DUIN_WHOLENOTE_GROUND=1, full note bodies are only sent
 *  when THIS turn's answer model is LOCAL (see `wholeNoteEgressAllowed` in the registry). If the answer
 *  model is CLOUD the branch is SKIPPED (fail closed → minimal-egress agentic snippets) unless the
 *  operator sets DUIN_WHOLENOTE_ALLOW_CLOUD=1 to explicitly accept cloud egress for non-sensitive work. */
function wholeNoteGroundEnabled(): boolean {
  return process.env.DUIN_WHOLENOTE_GROUND === '1'
}

/** Force the pre-2026-08-17 behaviour: whole-note on EVERY turn, no breadth decision.
 *  Kept because that is the configuration the July whole-note A/B (+14pp) was measured
 *  under, so the number stays reproducible; adaptive breadth is the default because the
 *  same benchmark showed always-on would regress the single-session categories DUIN
 *  currently wins. See grounding-breadth.ts for the evidence table. */
function wholeNoteAlwaysEnabled(): boolean {
  return process.env.DUIN_WHOLENOTE_ALWAYS === '1'
}

// P8 — warn ONCE per process when whole-note grounding is enabled but blocked because the resolved
// answer model is cloud (no explicit cloud opt-in). A per-turn log would spam every message; the
// single line tells the operator why full-note grounding isn't running and how to allow it.
let wholeNoteEgressBlockWarned = false
function warnWholeNoteEgressBlockedOnce(modelId: string): void {
  if (wholeNoteEgressBlockWarned) return
  wholeNoteEgressBlockWarned = true
  console.warn(
    `[grounding] whole-note skipped: answer model ${modelId} is cloud; full-note egress blocked ` +
      `(set DUIN_WHOLENOTE_ALLOW_CLOUD=1 to allow)`
  )
}

// ──────────────────── SSE helpers ────────────────────

// Returns res.write()'s backpressure signal (false = the kernel/socket buffer is full)
// instead of silently discarding it, so a caller can observe backpressure rather than
// growing the write buffer blindly.
// Per-response monotonic frame counter → the SSE `id:` field. Lets a client
// track the last frame it saw and reconnect with a Last-Event-ID header (seeded
// back into this counter at turn start so ids stay monotonic across a reconnect).
// WeakMap-keyed so it GCs with the response. Comment/id lines (no `data:` prefix)
// are ignored by the bridge parser + any spec SSE client, so this is non-breaking.
const frameSeq = new WeakMap<ServerResponse, number>()

/** Seed the frame counter (e.g. from a reconnect's Last-Event-ID) so subsequent
 *  frame ids continue monotonically rather than restarting at 1. */
function seedFrameSeq(res: ServerResponse, startId: number): void {
  if (Number.isFinite(startId) && startId >= 0) frameSeq.set(res, Math.floor(startId))
}

// Resume wiring (DUIN_TURN_RESUME, default OFF). When a turn is resumable, its response is mapped to
// a RunState whose ring buffers every frame and whose writer is the CURRENT subscriber — so a
// reconnect can replay missed frames and take over live output. When no run is mapped (the default),
// sseFrame is byte-identical to before.
const runForRes = new WeakMap<ServerResponse, RunState>()
/** Durable per-turn journal, keyed by the same response the RunState ring is. Separate map (rather
 *  than a RunState field) because agui-run.ts is deliberately I/O-free and must stay that way. */
const journalForRes = new WeakMap<ServerResponse, TurnJournal>()
// Keep this many most-recent frames un-evicted for replay while letting the ring bound memory on a
// long turn (a reconnecting client that was keeping up needs only recent frames after its last id).
const RING_LIVE_MARGIN = 512

function sseFrame(res: ServerResponse, event: Record<string, unknown>): boolean {
  const json = JSON.stringify(event)
  const run = runForRes.get(res)
  if (run) {
    // The ring assigns the authoritative id (so replayAfter aligns across a reconnect) and owns the
    // output target (a reconnected subscriber receives via run.write). Buffered even if nobody is
    // currently attached, so a dropped client loses nothing.
    const frame = run.emit(json)
    // Tee to the durable journal. Buffered in memory and flushed asynchronously — this is the hot
    // path for every content delta, so the cost here is one filtered array push and nothing more.
    journalForRes.get(res)?.note({ ...event, frameId: frame.id })
    const written = run.write(`id: ${frame.id}\ndata: ${json}\n\n`)
    // Mark all-but-the-last-N frames delivered so the bounded ring can actually evict on a long turn
    // (memory), while keeping a recent window replayable for a reconnect (a keeping-up client's
    // Last-Event-ID sits near the head). Not marked when nobody is attached (a dropped client keeps
    // its whole tail buffered for replay).
    if (written) run.markDelivered(frame.id - RING_LIVE_MARGIN)
    return written
  }
  const n = (frameSeq.get(res) ?? 0) + 1
  frameSeq.set(res, n)
  return res.write(`id: ${n}\ndata: ${json}\n\n`)
}

/**
 * Backpressure-respecting SSE write for the high-volume streaming path (content
 * and reasoning deltas). When the kernel/socket buffer is full `res.write`
 * returns false; rather than forward the next delta and let our write buffer
 * grow unbounded against a slow client, we AWAIT the socket's 'drain' before
 * resolving. The provider stream loop awaits onChunk/onReasoning, so this pauses
 * upstream forwarding until the client catches up.
 *
 * Fail-safe: resolves immediately on a clean write, and short-circuits if the
 * turn aborts or the socket closes (so a stalled/gone client can never wedge the
 * turn open waiting for a drain that will never fire).
 */
function sseFrameDrained(
  res: ServerResponse,
  event: Record<string, unknown>,
  signal?: AbortSignal
): Promise<void> {
  const ok = sseFrame(res, event)
  if (ok || signal?.aborted || res.writableEnded || res.destroyed) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      res.removeListener('drain', finish)
      res.removeListener('close', finish)
      signal?.removeEventListener?.('abort', finish)
      resolve()
    }
    res.once('drain', finish)
    res.once('close', finish)
    signal?.addEventListener?.('abort', finish, { once: true })
  })
}

/** Render the one-shot search() hits into a CONTEXT block (today's behavior). */
// ──────────────────── grounding assembly ────────────────────
// Relocated to ./agui-grounding (pure move). handleAgui imports these back.
import {
  readPinnedNote,
  buildBeatGrounding,
  buildGroundedMessages
} from './agui-grounding'

/**
 * The agentic pass's citations expressed as retrieval HITS, so the shared downstream ranking stages
 * (1-hop graph-neighbour merge → cross-encoder rerank → taste-rerank → claim-freshness demotion) can
 * rank them instead of being skipped. Deduped by note, first mention wins; `score` is a strictly
 * descending rank proxy that preserves the model's own emitted order as the stages' input order.
 * PURE. See `orderCitationsByHits` for the return trip. */
export function citationsToHits(citations: Citation[]): { file: string; snippet: string; score: number }[] {
  const seen = new Set<string>()
  const out: { file: string; snippet: string; score: number }[] = []
  for (const c of citations) {
    const note = (c.note ?? '').trim()
    if (!note || seen.has(note)) continue
    seen.add(note)
    out.push({ file: note, snippet: c.snippet ?? '', score: 1 / seen.size })
  }
  return out
}

/**
 * Re-order `citations` into the order the ranking stages left `hits` in, so the rendered CONTEXT
 * block follows the stages' ranking while KEEPING each citation's precise `note:line` locus, snippet
 * and `why` — the things a plain `hitsToContext(hits)` would throw away.
 *
 * A hit with no citation behind it is one the 1-hop graph-neighbour merge ADDED (stage 1); it is
 * carried through as a synthesized citation with the neighbour's snippet, so graph-reachable evidence
 * survives into the block instead of being dropped for lack of a model citation. Any citation the
 * stages somehow dropped is appended rather than lost (the stages re-rank, never drop). PURE.
 */
export function orderCitationsByHits(
  citations: Citation[],
  hits: { file: string; snippet: string }[]
): Citation[] {
  const byNote = new Map(citations.map((c) => [c.note, c]))
  const used = new Set<string>()
  const out: Citation[] = []
  for (const h of hits) {
    if (!h.file || used.has(h.file)) continue
    used.add(h.file)
    const cited = byNote.get(h.file)
    out.push(
      cited ?? {
        note: h.file,
        snippet: h.snippet ?? '',
        why: 'linked via the knowledge graph to a cited note'
      }
    )
  }
  for (const c of citations) {
    if (!c.note || used.has(c.note)) continue
    used.add(c.note)
    out.push(c)
  }
  return out
}

/** Render the agentic retriever's compact citations into a CONTEXT block. Each
 *  citation carries a precise `note:line` locus, a snippet, and the agent's
 *  one-line rationale — focused, multi-hop evidence the main model can answer
 *  from directly. Falls back to a friendly empty marker when none. PURE. */
/** Graph-neighbour slots the 1-hop merge may add on top of the ranked pool. Relative to the
 *  pool so the stage cannot silently no-op when `searchK` rises; 2 keeps the shipped default
 *  (searchK=6 ⇒ cap 8) byte-identical to the constant it replaced. */
const NEIGHBOUR_SLOTS = 2

export function citationsToContext(citations: Citation[]): string {
  if (citations.length === 0) return '(no relevant notes found in the local index)'
  return citations
    .map((c, i) => {
      const loc = c.lines ? `${c.note}:${c.lines[0]}-${c.lines[1]}` : c.note
      const snip = c.snippet ? c.snippet.replace(/^\s*---[\s\S]*?---\s*/, '').trim() : ''
      const why = c.why ? `\nwhy: ${c.why}` : ''
      return `[${i + 1}] (${loc})\n${snip}${why}`
    })
    .join('\n\n')
}


// Govern-loop tick (operator-govern): debounced dual-verifier pass to confirm /
// auto-revert provisional facts. Survival counting lives on the topic-close boundary
// (consolidationTick), a better "distinct session" signal than per-conversation.
// Best-effort, fire-and-forget; a failure never touches the turn.
let lastGovernAt = 0
const GOVERN_DEBOUNCE_MS = 30 * 60_000
function governTick(): void {
  const now = Date.now()
  if (now - lastGovernAt < GOVERN_DEBOUNCE_MS) return
  lastGovernAt = now
  // Schema-graft ① (backtest verifier, GATED): when DUIN_GOVERN_BACKTEST=1, feed the govern gate
  // the RESOLVED forecast rows so it can epicycle-reject a provisional fact that only coincidentally
  // fit a prediction reality refuted. Default off ⇒ [] ⇒ every fact abstains ⇒ byte-identical gate.
  let resolvedForecasts: { predicted: string; resolution: string }[] = []
  if (process.env.DUIN_GOVERN_BACKTEST === '1') {
    try {
      const d = readSettings().localBrainNotesDir
      if (typeof d === 'string' && d) resolvedForecasts = loadResolvedForecasts(d)
    } catch { /* best-effort — backtest abstains on load failure */ }
  }
  void runGovernPass(defaultGovernJury, DEFAULT_GOVERN_POLICY, { resolvedForecasts })
    .then((r) => {
      if (r.confirmed || r.reverted) {
        console.log(
          `[operator-govern] ${r.confirmed} confirmed, ${r.reverted} auto-reverted, ${r.held} held`
        )
      }
      // Feed the ANS earned-autonomy governor: a confirmed fact is a 'ratify' for the
      // promotion capability, an auto-revert is a 'revert' (the demote signal). Then run
      // one governor pass — auto-demotes on a miss, PROPOSES graduation when earned.
      try {
        for (let i = 0; i < r.confirmed; i++) recordFeedback('operator-fact-promotion', 'ratify')
        for (let i = 0; i < r.reverted; i++) recordFeedback('operator-fact-promotion', 'revert')
        const vaultDir = (() => {
          try {
            const d = readSettings().localBrainNotesDir
            return typeof d === 'string' && d ? d : null
          } catch {
            return null
          }
        })()
        const g = runGovernorPass()
        if (g.tripped.length) {
          console.log(`[ans-governor] breaker tripped on ${g.tripped.length} capability(ies)`)
        }
      } catch (e) { console.debug('[server] governor is advisory upkeep:', messageOf(e)) }
    })
    .catch(() => {
      /* govern is advisory upkeep — never affects the turn */
    })
}

// Consolidation tick (consolidation-trigger): the WRITE-side. Feed the turn embedding
// to the topic tracker; when a topic CLOSES (semantic shift / overflow), count it as a
// distinct session toward provisional-fact survival, and — if the closed batch is
// coherent + right-sized — fire a consolidation pass (dedup + prune). Fire-and-forget.
const consolidationTracker = new ConsolidationTracker()
async function consolidationTick(query: string): Promise<void> {
  const q = (query ?? '').trim()
  if (!q) return
  try {
    const [vec] = await embedForRecall([q])
    if (!vec) return
    const ev = consolidationTracker.push(vec)
    if (!ev.closed) return
    try {
      noteSession(ev.topicId) // topic boundary = a distinct session survived
    } catch (e) { console.debug('[server] best-effort:', messageOf(e)) }
    if (ev.consolidate) {
      const r = await runConsolidation()
      if (r.merged || r.pruned) {
        console.log(
          `[consolidation] ${ev.topicId} closed (${ev.batchSize} turns): merged ${r.merged}, pruned ${r.pruned}`
        )
      }
    }
  } catch (e) { console.debug('[server] consolidation is upkeep  never affects the turn:', messageOf(e)) }
}

// Forecast/calibration close (forecast-loop): generate → log → resolve on a background
// cadence, so the calibration ledger fills WITHOUT the operator opening a panel. Without
// this the resolver only ran on-view, so β_conf + taste-weighting (which read the tier
// calibration) stayed permanently neutral. Debounced 6h; also fired by an idle interval
// below so it closes even when the app sits unused and forecasts age past eval_after.
let lastForecastAt = 0
const FORECAST_DEBOUNCE_MS = 6 * 60 * 60_000
function forecastTick(): void {
  const now = Date.now()
  if (now - lastForecastAt < FORECAST_DEBOUNCE_MS) return
  lastForecastAt = now
  try {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    if (!notesDir) return
    const r = runForecastLoop(notesDir)
    if (r.logged || r.resolved) {
      console.log(`[forecast-loop] logged ${r.logged} new, resolved ${r.resolved}, ${r.patterns} kinds tracked`)
    }
  } catch (e) { console.debug('[server] calibration upkeep  never affects the turn:', messageOf(e)) }
}
// Idle close: fire even when no one is chatting (forecasts age past eval_after unattended).
// unref so this timer never keeps the process alive on shutdown.
const forecastIdleTimer = setInterval(() => forecastTick(), FORECAST_DEBOUNCE_MS)
if (typeof forecastIdleTimer.unref === 'function') forecastIdleTimer.unref()

// Schema-graft (dead-projection): keep the forward projection (future-nodes) fresh, restoring
// the on-engage refresh the 2026-07-15 decouple broke (POST /state/project was 404; future-meta
// went stale). GATED OFF by default (DUIN_PROJECT_TICK=1). Self-gating: runProjectFutures makes
// no LLM call unless the projection is >1h stale, so an enabled timer costs at most one generate
// per hour. Best-effort — never affects the turn.
let lastProjectAt = 0
function projectTick(): void {
  if (process.env.DUIN_PROJECT_TICK !== '1') return
  const now = Date.now()
  if (now - lastProjectAt < FORECAST_DEBOUNCE_MS) return
  lastProjectAt = now
  try {
    const notesDir = (readSettings().localBrainNotesDir as string) || null
    if (!notesDir) return
    void runProjectFutures(notesDir, { generate: generateOnce }).catch(() => {})
  } catch (e) { console.debug('[server] projection upkeep  never affects the turn:', messageOf(e)) }
}
const projectIdleTimer = setInterval(() => projectTick(), FORECAST_DEBOUNCE_MS)
if (typeof projectIdleTimer.unref === 'function') projectIdleTimer.unref()

// Success capture (success-miner): the live chat path sends only the LATEST user turn
// (threadId carries continuity), so the prior answer isn't in the request. The brain
// therefore remembers its OWN last (query, answer) per thread; when the next turn is an
// endorsement of it, that prior pair is captured as a success exemplar. Bounded map,
// best-effort — never affects the turn.
const lastTurnByThread = new Map<string, { query: string; answer: string }>()
function successTick(threadId: string, query: string, answer: string): void {
  try {
    const key = threadId || 'default'
    const prior = lastTurnByThread.get(key)
    if (prior && isEndorsement(query)) recordSuccess(prior.query, prior.answer)
    if (answer && answer.trim()) {
      lastTurnByThread.set(key, { query, answer })
      if (lastTurnByThread.size > 200) {
        const oldest = lastTurnByThread.keys().next().value
        if (oldest) lastTurnByThread.delete(oldest)
      }
    }
  } catch (e) { console.debug('[server] success capture is upkeep  never affects the turn:', messageOf(e)) }
}


import {
  WRITE_NOTE_TOOL,
  RENDER_ARTIFACT_TOOL,
  READ_FILE_TOOL,
  LIST_DIR_TOOL,
  EDIT_FILE_TOOL,
  DELETE_FILE_TOOL,
  MOVE_FILE_TOOL,
  CREATE_DIR_TOOL,
  SEARCH_FILES_TOOL,
  GLOB_FILES_TOOL,
  RUN_COMMAND_TOOL,
  WEB_FETCH_TOOL,
  WEB_SEARCH_TOOL,
  WRITE_TODOS_TOOL,
  START_COMMAND_TOOL,
  READ_COMMAND_TOOL,
  STOP_COMMAND_TOOL,
  SPAWN_AGENT_TOOL,
  executeWriteNote,
  executeReadFile,
  executeListDir,
  executeEditFile,
  executeDeleteFile,
  executeMoveFile,
  executeCreateDir,
  executeSearchFiles,
  executeGlobFiles,
  executeRunCommand,
  executeWebFetch,
  executeWebSearch,
  executeWriteTodos,
  executeStartCommand,
  executeReadCommand,
  executeStopCommand,
  ARTIFACT_TYPES,
  VAULT_MUTATING_TOOLS
} from './agui-executors'
import { executeAguiWebSearch } from './agui-search'
import { AGUI_TOOLS, isSimpleAguiTool, runAguiTool } from './agui-tools'
import { RunState, createRun, getRun, dropRun, turnResumeEnabled } from './agui-run'
import { openTurnJournal, pruneTurnJournals, type TurnJournal } from './agui-journal'
import { decideBreadth } from './grounding-breadth'
// Agent-engine unification: the /agui brain loop's tool surface + dispatch now
// run through a dedicated instance of lamprey's ToolRegistry (brain-tool-registry),
// provider-normalized via the SAME machinery the coder loop uses, instead of a
// hand-built aguiTools array + a second bespoke dispatch path.
import {
  normalizeToolsForProvider,
  dedupeToolsByName,
  type ProviderTool
} from '../providers/schema-normalizer'
import { brainToolRegistry, VAULT_TOOL_NAMES } from './brain-tool-registry'
import { dispatchAguiTool, parseBrainFallbackCalls, fallbackParseMiss, parseToolArgs, type AguiDispatchPolicy } from './agui-dispatch'
import {
  emptyRepeatState,
  noteCallOutcome,
  shouldHaltOnRepeat,
  repeatFailureK,
  repeatRootCause,
  nextRoundBudget,
  roundGrant,
  roundHardCap,
  roundProgressWindowMs
} from './agui-no-progress'
import { emptyTurnCost, accrueTurnCost, shouldRefuseForBudget, budgetRefusalMessage, readTurnBudgetUsd } from './agui-cost'
import type { NormalizedUsage } from '../providers/usage-accounting'
import { deadlineTerminalFrames } from './agui-terminal'
import {
  watchdogConfig,
  watchdogVerdict,
  WATCHDOG_TICK_MS,
  noticeConfig,
  noticeDue,
  noticeLabel,
  noticeWorthSending,
  type WatchdogReason
} from './turn-watchdog'

// ──────────────────── subagent (spawn_agent) ────────────────────
// Relocated to ./agui-subagent (pure move). handleAgui still calls runSubagent.
import { runSubagent } from './agui-subagent'


// Hard ceiling on an /agui request body. A turn payload (messages + context) is a few
// KB even for a long thread; 8 MB is orders of magnitude beyond that. Without a cap a
// malformed/hostile client could stream an unbounded body and pin the main process's
// memory before JSON.parse ever runs. Enforced incrementally as chunks arrive.
const MAX_AGUI_BODY_BYTES = 8 * 1024 * 1024

// ──────────────────── per-action tool gate ────────────────────
// Relocated to ./agui-gate (pure move). handleAgui's mainPolicy.gate calls it.
import { resolveAguiGate } from './agui-gate'

/**
 * Names the brain round loop will dispatch. A tool call whose name is neither
 * in here nor an MCP name is DROPPED — no tool_result, no TOOL_CALL frame —
 * and the turn burns its completeness retry on a call the model legitimately
 * made against an offered tool.
 *
 * DERIVED from the registry, never hand-listed (gate finding F4). This was an
 * 18-name literal inside the round loop; `create_skill` is registered, offered
 * to the model, and dispatchable, but was never added to the literal, so every
 * create_skill call the model made was silently discarded. A hand-maintained
 * mirror of a registry is a drift bug waiting for the next tool — so it is now
 * the registry itself, and brain-tool-registry.test.ts pins the parity.
 */
export const HANDLED_TOOLS: ReadonlySet<string> = new Set(
  brainToolRegistry.getDescriptors().map((d) => d.name)
)

export async function handleAgui(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body = ''
  let bodyBytes = 0
  for await (const chunk of req) {
    bodyBytes += (chunk as Buffer).length
    if (bodyBytes > MAX_AGUI_BODY_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'request body too large' }))
      req.destroy() // stop reading; don't keep buffering a runaway upload
      return
    }
    body += chunk
  }
  let parsed: AguiRequest
  try {
    parsed = JSON.parse(body || '{}') as AguiRequest
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'invalid JSON body' }))
    return
  }

  // Stop beacon (not a stream): a deliberate Stop aborts the named run NOW instead of leaving it to
  // grace-wait a reconnect. Plain 200; no SSE. Gated with resume (the only mode that has runs).
  if (parsed.abort === true && typeof parsed.runId === 'string' && parsed.runId) {
    if (turnResumeEnabled()) {
      clearGrace(parsed.runId)
      getRun(parsed.runId)?.abort()
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  // Steer beacon (not a stream): inject `steer` text into the named RUNNING turn's inbox so the
  // round loop splices it in at the next clean boundary. Accepted ONLY when the run exists and is
  // live; a missing/terminal run (or resume off, where no run exists) returns accepted:false so the
  // client falls back to enqueuing it as a durable new turn — a VISIBLE race, never a silent
  // mis-fire. Idempotent on steerId: a re-delivered steer injects at most once, and a duplicate on
  // a still-live run is still reported accepted (it landed the first time). Plain 200; no SSE.
  if (typeof parsed.steer === 'string' && typeof parsed.runId === 'string' && parsed.runId) {
    let accepted = false
    if (turnResumeEnabled()) {
      const rs = getRun(parsed.runId)
      if (rs && !rs.isTerminal) {
        // pushSteer's own idempotency drops a duplicate injection; the run being live is what makes
        // the steer 'accepted' from the client's view (so an idempotent repeat still reads accepted).
        rs.pushSteer(parsed.steer, parsed.steerId)
        accepted = true
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, accepted }))
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  })

  // SSE resumability. `retry:` tells a reconnecting client how long to wait; a Last-Event-ID header
  // marks the last frame it saw. With DUIN_TURN_RESUME on, a dropped connection no longer aborts the
  // turn — it detaches, keeps running, and buffers frames in a RunState ring (agui-run.ts), so a
  // reconnect (resume:true + runId + Last-Event-ID) replays the missed frames and takes over live
  // output (see the resume wiring below). With resume OFF (default) only the id-seeding applies and
  // a dropped connection still aborts, exactly as before.
  const lastEventId = Number(req.headers['last-event-id'])
  if (Number.isFinite(lastEventId) && lastEventId > 0) seedFrameSeq(res, lastEventId)
  try {
    res.write('retry: 3000\n\n')
  } catch (e) { console.debug('[server] socket already gone:', messageOf(e)) }

  // ── Resume wiring (DUIN_TURN_RESUME, default OFF → all of this is inert) ──
  const resumeOn = turnResumeEnabled()
  let run: RunState | null = null
  /** Sealed into the journal's TURN_END record from the `finally`, which is the only block that
   *  runs on every exit path — the in-try `acc` / `turnCost` are not in scope there. */
  // Deny-first execution gate: is THIS turn authorized to run host-exec / irreversible tools?
  // The trusted renderer (and the main-process bridge) send the per-launch token; an
  // unauthenticated local caller does not → gated tools are refused (agui-guard.ts). Reads,
  // reasoning, search, and vault note writes proceed regardless. Decided here, before the journal
  // opens, because the bench marker below is only honoured for an authorized caller.
  const execOk = execAuthorized(req.headers['x-duin-exec'], brainExecToken)
  // Bench / evaluation marker (roles.ts BENCH_HEADER, decision D3): accepted ONLY with the exec
  // token. A bench turn answers exactly like any other turn but teaches nothing — both learn sites,
  // taste capture, the turn-beat prediction and the govern trigger are skipped — and is tagged
  // `bench: true` in its journal (TURN_START + TURN_END, so /debug/turns shows it). Without the
  // token the header is ignored and this is an ordinary turn (S7, 2026-09-02).
  const bench = isBenchRequest(req.headers, execOk)
  const turnOutcome = {
    answerChars: 0,
    costUsd: 0,
    meteredCalls: 0,
    /** How privileged this turn was. DUIN already ENFORCES this boundary with execOk at the gate;
     *  recording it does not add a control, it NAMES the one that exists — so a journalled turn
     *  says whether a human was behind it without re-deriving that from headers after the fact. */
    origin: 'unknown' as 'authorized' | 'deprivileged' | 'unknown',
    /** Evaluation traffic (never learned from). Always stated, so a reader can tell "not bench"
     *  from "written before the field existed". */
    bench,
    /** WHICH grounding branch produced this turn's context — see the `groundingPath` declaration in
     *  handleAgui. The branches are first-wins and silently skip each other; without this the turn
     *  record cannot say whether the hybrid retriever ran at all. */
    groundingPath: 'none' as 'graph-expand' | 'whole-note' | 'agentic' | 'ranking-stages' | 'none',
    /** The engine that produced the answer, the ordered engines tried, and whether the answer came
     *  from a failover hop — the vitals footer's `engine X after Y (reason)`. */
    engine: null as string | null,
    engineChain: [] as string[],
    recovered: false
  }
  let subToken: symbol | null = null
  if (resumeOn && parsed.resume === true && typeof parsed.runId === 'string' && parsed.runId) {
    // RECONNECT: attach to the existing run, replay the frames this client missed, then PARK. The
    // ORIGINAL turn keeps running and its sseFrame writes now target THIS response via run.write —
    // no new turn is started here.
    const existing = getRun(parsed.runId)
    if (existing) {
      clearGrace(parsed.runId)
      const tok = existing.attach((b) => res.write(b))
      runForRes.set(res, existing)
      const from = Number.isFinite(lastEventId) && lastEventId > 0 ? lastEventId : 0
      for (const f of existing.replayAfter(from)) {
        try {
          res.write(`id: ${f.id}\ndata: ${f.data}\n\n`)
        } catch {
          break
        }
      }
      if (!existing.isTerminal) {
        // Park until the turn finishes OR this reconnected socket also drops.
        let reconnectDropped = false
        await new Promise<void>((resolve) => {
          const onClose = (): void => {
            reconnectDropped = true
            resolve()
          }
          res.on('close', onClose)
          void existing.whenDone().then(() => {
            res.removeListener('close', onClose)
            resolve()
          })
        })
        existing.detach(tok)
        // If THIS socket dropped again while the turn is still running, RE-ARM the grace→abort — the
        // original close's grace timer was cleared on this reconnect, so without this the orphaned
        // turn would run to the deadline against no client (still executing tools / writing files).
        if (reconnectDropped && !existing.isTerminal) {
          clearGrace(existing.runId)
          graceTimers.set(
            existing.runId,
            setTimeout(() => {
              graceTimers.delete(existing.runId)
              existing.abort()
            }, TURN_RESUME_GRACE_MS)
          )
        }
      } else {
        existing.detach(tok)
      }
      try {
        if (!res.writableEnded) res.end()
      } catch (e) { console.debug('[server] already gone:', messageOf(e)) }
      return
    }
    // Unknown / expired runId on an explicit resume → the turn is gone. Do NOT start a duplicate
    // fresh turn (it would re-run tools + re-emit from id 1); tell the client the session expired.
    try {
      sseFrame(res, { type: 'RUN_ERROR', message: 'resume failed: run not found (expired)' })
    } catch (e) { console.debug('[server] socket gone:', messageOf(e)) }
    try {
      if (!res.writableEnded) res.end()
    } catch (e) { console.debug('[server] already gone:', messageOf(e)) }
    return
  }
  if (resumeOn) {
    const rid = typeof parsed.runId === 'string' && parsed.runId ? parsed.runId : randomUUID()
    run = createRun(rid)
    subToken = run.attach((b) => res.write(b))
    runForRes.set(res, run)
    journalForRes.set(
      res,
      openTurnJournal(rid, { threadId: parsed.threadId ?? null, model: parsed.model ?? null, bench })
    )
  }

  // Stop the server-side work if the client disconnects (Stop button /
  // navigation / duin-bridge aborting the fetch). Without this the tool loop
  // keeps calling the model AND executing tools (writing files!) against a dead
  // connection. Wired into the loop condition + passed to chatStream so the
  // in-flight generation aborts too. With resume ON, a disconnect instead DETACHES
  // and keeps the turn alive for a grace window (aborting only if no reconnect).
  const turnAbort = new AbortController()
  // Let a Stop beacon (a separate request) abort THIS turn immediately, bypassing the disconnect grace.
  if (run) run.setAbort(() => turnAbort.abort())
  res.on('close', () => {
    if (run && resumeOn && !run.isTerminal) {
      if (subToken) run.detach(subToken)
      const rid = run.runId
      clearGrace(rid)
      graceTimers.set(
        rid,
        setTimeout(() => {
          graceTimers.delete(rid)
          turnAbort.abort()
        }, TURN_RESUME_GRACE_MS)
      )
    } else {
      turnAbort.abort()
    }
  })

  // Phase 0 — per-turn wall-clock deadline. The tool loop's total time is bounded by
  // MAX_TOOL_ROUNDS (32 — see below; it was 8 when this comment was written) times the
  // per-round provider and per-tool timeouts, NOT by wall clock: the absolute ceiling is off
  // by default (maxMs 0, turn-watchdog.ts — a deliberate choice, since real multi-agent turns
  // run for an hour), and the stall cut only fires after 90s of NO activity. So a turn that
  // keeps making progress is long, not infinite. Measured on the deployed build 2026-08-02: a
  // Chinese "写一份完整的双周报" ran 20 tool calls / 31.7k reasoning chars past 240s without a
  // terminal frame — correctly uncut by both limits, and indistinguishable from wedged from
  // outside. That gap is closed by the long-turn NOTICES below, not by a cut.
  // On the deadline we abort the turn; unlike a client-close abort, the client is still
  // connected and waiting, so `deadlineHit` drives its OWN clean terminal frame below (the
  // finalize + normal RUN_FINISHED paths are skipped once aborted). Degrades gracefully into
  // "stop churning + close cleanly". Override via DUIN_TURN_DEADLINE_MS (0/negative disables).
  let deadlineHit = false
  // R2/R3 single-settle guard — hoisted above the deadline timer so the timer callback and the
  // downstream round-loop paths share ONE flag (exactly-once terminal). The round loop assigns it
  // via `terminalSent = true` further down; it is declared here, not re-declared there.
  let terminalSent = false
  // Progress-aware turn budget (turn-watchdog): cut on STALL (no streamed tokens
  // or tool results for stallMs) OR at an ABSOLUTE ceiling (maxMs) — replacing the
  // old flat wall-clock cap that guillotined long-but-productive "dispatch agents"
  // turns at 3 min. A healthy long turn keeps producing tool results inside the
  // stall window and runs to completion; only a real hang or a slow-runaway is cut.
  const wdCfg = watchdogConfig()
  const wdStartedAt = Date.now()
  let lastProgressAt = wdStartedAt
  // Forward progress = streamed tokens or tool results. NOT the SSE heartbeat — a
  // stalled turn still heartbeats, so counting it would defeat the stall cut.
  const markProgress = (): void => {
    lastProgressAt = Date.now()
  }
  // R3/Phase-2 — emit the terminal frame FROM THE WATCHDOG, independent of the round
  // loop unwinding. Before this, the terminal was only emitted downstream (after the
  // loop exits); a wedged "dispatch agents" fan-out never reached it, so the bridge
  // reconnect-churned for minutes. This runs the moment the watchdog fires, guarded by
  // the shared terminalSent flag so it stays exactly-once (the downstream path no-ops).
  // The reason customizes the RUN_ERROR message (stalled vs over-budget).
  const emitDeadlineTerminal = (reason: WatchdogReason = 'max-wallclock'): void => {
    if (terminalSent || res.writableEnded) return
    terminalSent = true
    try {
      for (const frame of deadlineTerminalFrames(reason)) sseFrame(res, frame as never)
    } catch (e) { console.debug('[server] socket gone at deadline terminal:', messageOf(e)) }
    try {
      if (!res.writableEnded) res.end()
    } catch (e) { console.debug('[server] res.end after deadline terminal:', messageOf(e)) }
  }
  // Long-turn notices (turn-watchdog `noticeDue`/`noticeLabel`). Advisory STEP frames that make
  // "still working" an explicit state instead of one inferred from a scrolling reasoning panel.
  // They never abort and never touch lastProgressAt. `roundCap` stays 0 until the round loop
  // computes MAX_TOOL_ROUNDS, so an early notice honestly says "preparing" rather than naming a
  // round that has not started.
  const noticeCfg = noticeConfig()
  let noticesSent = 0
  let currentRound = 0
  let roundCap = 0
  const watchdogTimer =
    wdCfg.stallMs > 0 || wdCfg.maxMs > 0 || (noticeCfg.firstMs > 0 && noticeCfg.everyMs > 0)
      ? setInterval(() => {
          const v = watchdogVerdict(Date.now(), wdStartedAt, lastProgressAt, wdCfg)
          if (v.cut && !turnAbort.signal.aborted) {
            deadlineHit = true
            turnAbort.abort()
            emitDeadlineTerminal(v.reason)
            if (watchdogTimer) clearInterval(watchdogTimer)
            return
          }
          const elapsed = Date.now() - wdStartedAt
          if (!v.cut && !turnAbort.signal.aborted && !terminalSent && !res.writableEnded &&
              noticeDue(elapsed, noticesSent, noticeCfg) &&
              // Say nothing while output is visibly flowing — the reasoning panel is
              // already answering the question this line exists to answer.
              noticeWorthSending(Date.now(), lastProgressAt)) {
            noticesSent++
            try {
              sseFrame(res, { type: 'STEP', label: noticeLabel(elapsed, currentRound, roundCap) })
            } catch (e) { console.debug('[server] socket gone at long-turn notice:', messageOf(e)) }
          }
        }, WATCHDOG_TICK_MS)
      : null

  // SSE keep-alive heartbeat. A comment frame (': hb', no 'data:' prefix → ignored
  // by the bridge parser and by any spec SSE client) every ~15s keeps proxies /
  // intermediaries from idling the connection out during a long reasoning or
  // tool round, and lets the client observe liveness. Cleared with the deadline
  // timer at turn end; guards on abort/ended/destroyed so it never writes to a
  // dead socket. Disable via DUIN_SSE_HEARTBEAT_MS=0.
  const heartbeatMs = (() => {
    const raw = Number(process.env.DUIN_SSE_HEARTBEAT_MS)
    return Number.isFinite(raw) && process.env.DUIN_SSE_HEARTBEAT_MS != null && process.env.DUIN_SSE_HEARTBEAT_MS !== ''
      ? raw
      : 15_000
  })()
  const heartbeatTimer =
    heartbeatMs > 0
      ? setInterval(() => {
          if (!turnAbort.signal.aborted && !res.writableEnded && !res.destroyed) {
            try {
              res.write(': hb\n\n')
            } catch (e) { console.debug('[server] socket gone between the guard and the write:', messageOf(e)) }
          }
        }, heartbeatMs)
      : null
  // Stop the heartbeat the moment the client disconnects (covers the abnormal
  // path); the normal-completion path clears it alongside the deadline timer.
  if (heartbeatTimer) res.on('close', () => clearInterval(heartbeatTimer))
  // Stop the progress watchdog if the client disconnects mid-turn (belt-and-
  // suspenders; it's also cleared on cut and at turn end).
  if (watchdogTimer) res.on('close', () => clearInterval(watchdogTimer))

  // `execOk` was decided above the journal open (it gates the bench marker too).
  turnOutcome.origin = execOk ? 'authorized' : 'deprivileged'
  // Per-action approval posture for THIS turn. The composer's permissions pill can
  // only TIGHTEN below the env floor, never loosen it (meet of env + pill). Absent /
  // garbled pill → readAguiPosture(process.env) exactly, so channel/bridge/headless
  // turns (no pill) keep today's behaviour. `full`→trusted-afk, `default`→interactive,
  // `auto-review`→review. See agui-approval.resolveTurnPosture.
  const aguiPosture = resolveTurnPosture(parsed.permissionsMode, process.env)

  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  const lastUser = [...messages].reverse().find((m) => m.role === 'user')
  // When the last user turn carries vision images, its content is a multimodal
  // array (not a plain string). Extract the text part(s) for the query; the
  // image_url parts are preserved on the message and flow through to the model.
  const lastContent = lastUser?.content
  const query = typeof lastContent === 'string'
    ? lastContent.trim()
    : Array.isArray(lastContent)
      ? lastContent.filter((p): p is { type: 'text'; text: string } => typeof p === 'object' && p?.type === 'text').map((p) => p.text).join(' ').trim()
      : ''
  // The note the chat is pinned to (if it resolves to a readable vault note).
  // Null for unscoped chats or non-note nodes → retrieval-only, as before.
  const pinnedNote = readPinnedNote(parsed.context)

  // WS2′ Phase A (turn-beats) — GRADE side, at turn-open: if the PRIOR turn staged a
  // next-beat prediction for this thread, grade it now against THIS turn's actual track
  // (predicted vs the "stay on current track" baseline) and persist the graded row.
  // Gated OFF by default → never called → no file, byte-identical to today. LOG-ONLY:
  // this reads nothing into the reply.
  // A bench turn is not the operator's next beat: grading the prior staged prediction against an
  // evaluation query would score calibration on traffic the operator never sent (D3).
  if (turnBeatsEnabled() && !bench) {
    try {
      const vd = (readSettings().localBrainNotesDir as string) || null
      const actualTrack = loadOntology(vd).trackOf(query)
      const graded = gradeStagedTurnBeat(vd, parsed.threadId ?? '', actualTrack)
      // Schema-graft ("surprise" instrument): a graded track MISS is a first-class
      // prediction.mispredicted row — the queryable audit of reality contradicting a
      // staged prediction. AUDIT ONLY (not `*.failed`): forecast miss-rates are already
      // owned by the calibration gap-axis; the symmetric forecast-resolver emit is left
      // as a documented extension point to avoid double-counting that axis.
      if (graded && graded.hit === false) {
        try {
          recordEvent({
            type: 'prediction.mispredicted',
            actorKind: 'model',
            entityKind: 'turn-beat',
            entityId: parsed.threadId || undefined,
            severity: 'info',
            payload: {
              kind: 'turn-beat',
              predicted: graded.predicted_track,
              actual: graded.actual_track ?? null,
              baseline: graded.baseline_track ?? null
            }
          })
        } catch (e) { console.debug('[server] mispredict emit  never break the turn:', messageOf(e)) }
      }
    } catch (e) { console.debug('[server] measurement grade  never break the turn:', messageOf(e)) }
  }

  try {
    sseFrame(res, { type: 'RUN_STARTED', ...(run ? { runId: run.runId } : {}) })
    sseFrame(res, { type: 'TEXT_MESSAGE_START' })

    // ── Retrieval tool call (renders as a tool card in the chat UI) ──
    const toolCallId = randomUUID()
    sseFrame(res, {
      type: 'TOOL_CALL_START',
      toolCallId,
      toolName: 'search_notes',
      args: { query }
    })
    let hits: { file: string; snippet: string; score: number }[] = []
    /** Set only when a cover pass could not fit the whole window into its char budget. */
    let coverTruncated: { emitted: number; eligible: number } | null = null
    try {
      // Retrieval breadth + fusion weights come from the vault's bounded, clamped retrieval config.
      // Absent file ⇒ defaults ⇒ identical to the previous hardcoded `search(query, 6)`.
      const rtun = readRetrievalTunables((readSettings().localBrainNotesDir as string) || null)
      // A periodic report is an AGGREGATION over a window, and a top-k ranking cannot express
      // "these notes are eligible and those are not". Measured before this existed: 138 notes
      // inside a fortnight, 6 returned — and searchK is clamped to 30, so breadth was never going
      // to close it (aggregation-arms.eval: stock 0/18, searchK=30 also 0/18). Resolves to null for
      // every non-periodic query, in which case this is byte-identical to the previous call.
      const window = resolvePeriodWindow(query) ?? undefined
      if (window) {
        console.log(`[local-brain] period-scoped retrieval (${window.label}): ${new Date(window.from).toISOString().slice(0, 10)} .. ${new Date(window.to - 1).toISOString().slice(0, 10)}`)
      }
      if (query && window) {
        // COVER, not top-k. The window made the notes ELIGIBLE; ranking them and keeping 6 threw
        // the eligibility away again, which is why both stock and searchK=30 scored 0/18 on
        // aggregation. Emit the ranked matches AND every other in-window note at reduced fidelity.
        const cover = await coverInWindow(query, window, { rankedK: rtun.searchK, tuning: rtun })
        if (cover.eligible === 0) {
          // No note in the index carries a date inside this window, so the population cannot be
          // determined. Fall back to ranked retrieval rather than inventing one — this is the
          // common case on a vault whose notes are undated, where cover has nothing to cover.
          console.log('[local-brain] cover: no dated notes in window — falling back to ranked search')
          hits = await search(query, rtun.searchK, { ...rtun, window })
        } else {
          hits = cover.hits
          console.log(
            `[local-brain] cover: ${cover.covered}/${cover.eligible} in-window notes at ${cover.snippetChars} chars (${cover.emitted} hits total)`
          )
          // Say so when the budget cut the population. A report built on a truncated window is
          // still useful, but the model must not present it as complete — and neither should the
          // log. Compared on `covered`, not `emitted`: the ranked head can carry a relevant note
          // from outside the dated set, and counting it would report >100% coverage.
          if (cover.covered < cover.eligible) {
            coverTruncated = { emitted: cover.covered, eligible: cover.eligible }
            console.warn(`[local-brain] cover TRUNCATED — ${cover.eligible - cover.covered} in-window notes omitted for budget`)
          }
        }
      } else {
        hits = query ? await search(query, rtun.searchK, { ...rtun, window }) : []
      }
    } catch (err) {
      console.warn('[local-brain] search failed:', (err as Error).message)
    }
    const resultText =
      hits.length > 0
        ? hits
            .map(
              (h, i) =>
                // Strip leading YAML frontmatter so the tool card stays clean
                // (file notes + synthetic ingest frontmatter alike).
                `${i + 1}. ${h.file} (score ${h.score.toFixed(2)}): ${h.snippet.replace(/^\s*---[\s\S]*?---\s*/, '').trim()}`
            )
            .join('\n')
        : 'No matching notes found in the local index.'
    // The model must know when it is looking at a SAMPLE of the window rather than the window.
    // Without this it writes "here is what happened this fortnight" over two thirds of the notes
    // and sounds equally confident — the exact failure mode arm D30 exhibited in the eval, where
    // more context made confabulation MORE likely, not less.
    const coverNote = coverTruncated
      ? `\n\n[COVERAGE: showing ${coverTruncated.emitted} of ${coverTruncated.eligible} notes in this period — ${coverTruncated.eligible - coverTruncated.emitted} were omitted to fit the context. Say so if you summarize; do not imply the period is fully covered.]`
      : ''
    sseFrame(res, {
      type: 'TOOL_CALL_END',
      toolCallId,
      result: `${hits.length} notes\n${resultText}${coverNote}`
    })
    // Mirror the retrieval into the reasoning trace so it's visible inline
    // (not only inside the tool-activity chip): what was searched + what came back.
    try {
      const found = hits.length > 0 ? hits.map((h) => h.file).slice(0, 5).join(', ') : 'nothing relevant'
      sseFrame(res, {
        type: 'STEP',
        label: query
          ? `Searched your notes for "${query.slice(0, 80)}" → ${hits.length} hit(s): ${found}`
          : 'No query to search'
      })
    } catch (e) { console.debug('[server] best-effort trace line:', messageOf(e)) }

    // ── Grounded answer via the user's chosen provider ──
    // The caller (duin-bridge) may pass a per-turn generation model — the user's
    // picker choice used as the brain's engine. resolveAnswerModel honours it
    // when usable, else falls back to today's settings/auto pick.
    const requestedModel = typeof parsed.model === 'string' ? parsed.model : undefined
    const engine = resolveAnswerEngine(requestedModel)
    const modelId = engine?.modelId ?? null
    turnOutcome.engine = modelId
    if (!modelId) {
      // No LLM (no provider key, no Ollama) — still give a USEFUL grounded answer
      // composed deterministically from the keyless engines + retrieved notes,
      // ending with a plain call to connect a model (guided flow in onboarding +
      // Settings). Engine reads are best-effort; a failure falls back to a short
      // notes-only reply rather than the old dead-end.
      let answer: string
      try {
        const nd = (readSettings().localBrainNotesDir as string) || null
        const ki = getKeylessInsightInputs(nd)
        answer = composeKeylessAnswer(query, hits, {
          insights: getInsights(nd).insights,
          risks: getPredictedRisks(nd).risks,
          world: getWorldState(nd),
          graph: ki.graph,
          openLoops: ki.openLoops
        })
      } catch (err) {
        console.warn('[local-brain] keyless answer failed:', (err as Error).message)
        answer =
          `I found ${hits.length} relevant note${hits.length === 1 ? '' : 's'} in your brain.\n\n` +
          '_Want a conversational answer? **Connect an AI model** in Settings → API Keys._'
      }
      for (const line of answer.split('\n')) {
        sseFrame(res, { type: 'TEXT_MESSAGE_CONTENT', delta: line + '\n' })
      }
      sseFrame(res, { type: 'TEXT_MESSAGE_END' })
      sseFrame(res, { type: 'RUN_FINISHED' })
      // F1 — learn from this turn (keyless heuristics capture explicit teaching). Ingestion-trust
      // tiering: pass execOk so a de-privileged inbound/channel turn's facts are tagged 'external'
      // (quarantined from grounding) rather than trusted as operator/machine teaching.
      // Bench-gateway turns (hidden catalog models, e.g. the LongMemEval harness driving
      // gpt-5.5-oneai) are NOT the operator: their synthetic personas were compiling into live
      // taste ("Prefers single-sentence responses", fictional due-diligence projects) — QA
      // 2026-08-24, F4.
      if (bench || (modelId && resolveModel(modelId)?.hidden === true)) {
        console.log(`[local-brain] ${bench ? 'bench-header' : 'hidden bench model'} turn — learning ticks skipped`)
      } else {
        void learnFromTurn(query, answer, execOk)
        successTick(parsed.threadId ?? '', query, answer)
        // WS1 Item 3b: grade the prior turn's recalled kinds by this turn's reaction
        // (endorse/correct) into the recall-efficacy ledger. ON by default (DUIN_RECALL_CAL=0
        // disables). Inside the bench guard: harness reactions must not grade live calibration.
        if (recallCalEnabled()) {
          recallEfficacyTick((readSettings().localBrainNotesDir as string) || null, parsed.threadId ?? '', query, answer, execOk)
        }
      }
      // store.reinforce-arm: grade the PRIOR turn's staged claims against THIS reaction; endorse → enqueue for markUseful.
      // INDEPENDENTLY flagged — this is NOT nested under recallCalEnabled(). It reads its own
      // DUIN_CLAIM_REINFORCE gate, same as the standalone call sites at :1737 and claim-extract.ts.
      // (Until 2026-08-03 this line was indented as if inside the guard above, which had no braces —
      // the indentation implied a nesting the parser never saw. Behaviour unchanged; the lie is gone.)
      if (claimReinforceEnabled()) reinforceTick(parsed.threadId ?? '', query, answer, classifyOutcome)
      // WS2′ Phase A (turn-beats) — STORE side: run the cheap LOG-ONLY prediction pass and
      // stage the next-beat for turn N+1 to grade. Gated OFF by default. Fire-and-forget
      // (measurement); keyless/null model → no beat. Never touches the reply/grounding.
      if (turnBeatsEnabled() && !bench) {
        const beatVd = (readSettings().localBrainNotesDir as string) || null
        void turnBeatTick({
          vaultDir: beatVd,
          threadId: parsed.threadId ?? '',
          turnIndex: messages.filter((m) => m.role === 'user').length,
          grounding: buildBeatGrounding(beatVd, messages, query)
        })
      }
      if (!bench) governTick() // an evaluation turn never trips the govern debounce (D3)
      void consolidationTick(query)
      forecastTick()
      projectTick()
      // W2 (posture 2026-08-21): the self-improve loop advances HERE, at engage time — the
      // operator just finished a turn — never on the wall clock. Below the earned tier it only
      // STAGES (Needs-you card); at 'auto' it applies and says so. Debounced internally (30min).
      selfImproveEngageTick(() => (readSettings().localBrainNotesDir as string) || null)
      // PRESENCE: a completed turn is the app being USED. Every automatic token-spending pass
      // is gated on this (background-work-gate) so nothing expensive runs while the operator is
      // away. Recorded at the interaction, never by a timer — a loop must not be able to assert
      // its own permission to run.
      notePresence()
      res.end()
      return
    }

    // ── Truthful engine indicator ──
    // Surface WHICH model actually answered this turn as a STEP event before
    // generation. duin-bridge maps STEP -> chat:reasoning, so it shows in the
    // reasoning trace. Additive + guarded (only when a model resolved); a
    // failure here must never block the answer.
    try {
      // A requested pin that lost to health is said out loud: the operator asked for X and gets
      // Y, and the reason is the one the classifier recorded (never "the model changed").
      const pinLost =
        requestedModel && requestedModel !== AUTO_ENGINE && engine?.source !== 'pin'
          ? ` (requested ${requestedModel} unavailable: ${describeUnavailable(requestedModel)})`
          : ''
      sseFrame(res, { type: 'STEP', label: `engine: ${modelId}${pinLost}` })
    } catch {
      // best-effort indicator — ignore
    }

    // ── Vision safety net ──
    // Only the brain knows which engine actually answered (see stripImageParts).
    // If it can't see, drop image parts and SAY SO — an ignored image must be
    // visible in the trace, not silent. Best-effort: never block the answer.
    let visionSafeMessages = messages
    try {
      if (messages.some(hasImagePart) && resolveModel(modelId)?.supportsVision === false) {
        visionSafeMessages = messages.map(stripImageParts)
        sseFrame(res, {
          type: 'STEP',
          label: `images skipped: ${modelId} has no vision support`
        })
      }
    } catch {
      // best-effort — a capability lookup failure must not lose the turn
    }

    // ── Agentic, graph-aware retrieval (ADDITIVE upgrade to one-shot search) ──
    // A cheap model runs a read-only tool loop over the vault + constructed
    // graph, returning compact note:line citations that become the CONTEXT block
    // — so the main (expensive) model spends zero tokens on retrieval and gets
    // focused, multi-hop evidence. Gated behind settings.agenticRetriever
    // (default on when a model exists); ANY null/throw → fall back to today's
    // `hits` EXACTLY. Zero regression.
    let contextOverride: string | undefined
    /** WHICH grounding branch actually produced this turn's context.
     *
     *  The branches below are FIRST-WINS: setting `contextOverride` in an earlier one silently skips
     *  every later one, including the agentic retriever and the four ranking stages. That is by
     *  design, but it was INVISIBLE — nothing in the turn record said which path ran. It cost a whole
     *  benchmark on 2026-09-04: `DUIN_WHOLENOTE_GROUND=1` (the operator's own launcher setting) put
     *  all 120 probes through plain BM25 whole-note grounding, with the hybrid retriever, reranker,
     *  graph expansion and agentic loop bypassed on every single one — and the run was written up as
     *  "DUIN vs naive BM25" when it was BM25 vs BM25. Recording the path is not a behaviour change;
     *  it is the one thing that would have caught it. Surfaced on TURN_END and in GET /debug/turns. */
    let groundingPath: 'graph-expand' | 'whole-note' | 'agentic' | 'ranking-stages' | 'none' = 'none'
    /** Whole-corpus values the retrieval agent computed. Threaded separately from contextOverride
     *  because it must reach the prompt on BOTH paths and with zero citations. */
    let computedBlock: string | undefined

    // ── Graph-expansion grounding (model-free multi-hop) — OPT-IN, DEFAULT OFF ──
    // Ranks WHOLE notes with the depth-adaptive graph-expansion retriever (BM25 seeds + bounded
    // multi-hop over the live brain graph, re-ranked alpha·bm25 + beta·activation; frontier/density
    // cap ON). Enable with DUIN_GRAPH_EXPAND_GROUND=1.
    //
    // DEFAULT FLIPPED BACK TO OFF (2026-07-25, measured): on a real vault index (25 probes, 12,793
    // chunks, exact KNN) this path scores recall@5 0.318 / MRR 0.533 against RRF 2:1 fusion's 0.408 /
    // 0.636 — −9.0pp recall@5, −10.3pp MRR — and the "+8pp multi-hop" claim it shipped on does not
    // reproduce (exact tie at k=5; −28.4pp at the production DUIN_WHOLENOTE_TOPK=12). See
    // graphExpandGroundEnabled() in brain/graph-expand-adapt.ts for the full measurement.
    //
    // The flag is load-bearing for MORE than this branch: setting `contextOverride` here SKIPS the
    // four `!contextOverride`-gated downstream stages below (1-hop graph-neighbour merge, cross-
    // encoder rerank, taste-rerank, claim-freshness demotion) AND makes agui-grounding use this
    // context instead of the RRF-fused `hits`. Default-OFF is what restores all of them.
    //
    // When ON it takes PRECEDENCE over the BM25 whole-note branch. The retriever sees only
    // (query, notes, graph) — never gold ids/answers. Any throw → fall through unchanged.
    if (query && graphExpandGroundEnabled()) {
      try {
        const notes = liveWholeNotes().map((n) => ({ id: n.id, text: n.text }))
        const topK = envNum('DUIN_WHOLENOTE_TOPK', 12, { min: 0 }) // 0 = disable whole-note fusion
        const rawCap = process.env.DUIN_WHOLENOTE_NOTECAP
        const perNoteBudget = rawCap != null && rawCap !== '' ? Number(rawCap) : 20000
        // liveGraph() = deriveGraph() ⨝ getConstruction() — the SAME canonical runtime graph the
        // agentic retriever traverses. The adapter maps it to the entity co-mention index in-process.
        const { context, used, hopsUsed } = buildGraphExpandContext(query, notes, liveGraph(), {
          topK,
          perNoteBudget
        })
        if (context) {
          contextOverride = context
          groundingPath = 'graph-expand'
          console.log(
            `[local-brain] graph-expand-ground: corpus=${notes.length} note(s), used=${used.length}, hops=${hopsUsed}, ${context.length} chars`
          )
        }
      } catch (err) {
        console.warn('[local-brain] graph-expand-ground failed, falling through:', (err as Error).message)
      }
    }

    // ── Whole-note grounding (naive-RAG-parity lever) ──
    // Feed the answer model top-K WHOLE notes ranked by BM25 + semantic fusion — reproducing the
    // naive-RAG baseline's broad, lexically-exact context (which beats DUIN's narrow cheap-driver
    // citation snippets by +14 on LongMemEval_S), keyless/on-device. Takes precedence over the
    // agentic path when it yields context. OPT-IN (default OFF, DUIN_WHOLENOTE_GROUND=1) — held off by
    // default as a privacy decision (full note-body egress to the answer provider on a sensitive vault).
    // The `!contextOverride` guard defers to the graph-expand branch ABOVE: when graph-expand yields
    // context this branch is skipped (graph-expand wins); when it yields nothing (contextOverride
    // still undefined) this whole-note branch runs as the FALLBACK, ahead of the agentic retriever.
    //
    // P8 (private-grounding guard): whole-note ships FULL note bodies (~120K chars) to the answer model,
    // so it only runs when THIS turn's answer model may receive them — LOCAL (Ollama, no egress) or an
    // explicit DUIN_WHOLENOTE_ALLOW_CLOUD=1 opt-in. `modelId` is the answer model already resolved for
    // this turn (above), so `wholeNoteEgressAllowed(modelId)` is a PURE read — no re-resolution, no
    // reorder, no double-charge. Fails CLOSED: a dropped Ollama that falls back to a cloud key DISABLES
    // whole-note (skip-logged once) and falls through to the minimal-egress agentic snippet path below —
    // it never silently egresses the vault. Kept as two mutually-exclusive checks (not one folded
    // condition) so the flag-on-but-blocked case can log exactly once without re-indenting the body.
    // BREADTH (2026-08-17): whole-note is no longer all-or-nothing. `decideBreadth` reads
    // this turn's retrieval spread — how many DISTINCT sources the top hits landed in — and
    // widens only when the evidence is genuinely scattered. Narrow turns keep snippets,
    // which is not a concession but the measured better answer: the LongMemEval re-run has
    // DUIN WINNING both single-session categories (100% vs 90.9%/92.9%) and losing
    // multi-session by 25.9pp, i.e. it is already best when the answer sits in one place.
    // Set DUIN_WHOLENOTE_ALWAYS=1 to force the old unconditional behaviour (that is the
    // configuration the July A/B measured, kept reproducible on purpose).
    const breadth = wholeNoteGroundEnabled() && !wholeNoteAlwaysEnabled()
      ? decideBreadth({ hits })
      : null
    const wholeNoteWanted = wholeNoteGroundEnabled() && (wholeNoteAlwaysEnabled() || breadth?.breadth === 'whole-note')
    if (breadth) {
      console.debug(`[whole-note] breadth=${breadth.breadth} distinctSources=${breadth.distinctFiles} (${breadth.reason})`)
    }
    if (!contextOverride && query && wholeNoteWanted && !wholeNoteEgressAllowed(modelId)) {
      warnWholeNoteEgressBlockedOnce(modelId)
    }
    if (!contextOverride && query && wholeNoteWanted && wholeNoteEgressAllowed(modelId)) {
      try {
        const notes = liveWholeNotes()
        // Default 'bm25' (pure lexical) — the A/B WINNER: on the clean vault corpus, mixing the weak
        // on-device embedder in via RRF ('fuse') measurably HURT (60% vs bm25 80% on n=20). Override
        // with DUIN_WHOLENOTE_MODE=fuse. topK overridable via DUIN_WHOLENOTE_TOPK (default 12).
        const mode = process.env.DUIN_WHOLENOTE_MODE || 'bm25'
        const topK = envNum('DUIN_WHOLENOTE_TOPK', 12, { min: 0 }) // 0 = disable whole-note fusion
        // Per-note cap: a note LARGER than this is windowed to its matched region — a latency guard
        // for PATHOLOGICAL giant notes (e.g. a 900KB DEVLOG) that otherwise dominate the context. Set
        // HIGH by design (20k): windowing normal-sized notes measurably hurt accuracy (bench 87→83,
        // temporal 96→81 — temporal questions need broad within-note date context), so only genuinely
        // huge outliers are trimmed; everything else stays whole. DUIN_WHOLENOTE_NOTECAP=0 disables.
        const rawCap = process.env.DUIN_WHOLENOTE_NOTECAP
        const perNoteBudget = rawCap != null && rawCap !== '' ? Number(rawCap) : 20000
        const sem = mode === 'bm25' ? [] : await search(query, 24)
        // CURRENCY (2026-09-03): co-retrieve the note that SUPERSEDES anything the ranking picked, then
        // label the superseded statements after the notes. Measured on bench/stale: in 2 of 4 read
        // failures the superseding note ranked #1 and the answer still came from the older one; in the
        // other 2 the superseder never entered the top-8 while an older note on the same topic did.
        // Ranking scores topical similarity, so a long stale note beats a brief update. Both halves are
        // fixed here WITHOUT reordering general search and WITHOUT dropping any text.
        // Kill switch: DUIN_GROUNDING_CURRENCY=0.
        const currencyOn = process.env.DUIN_GROUNDING_CURRENCY !== '0'
        const ledger = currencyOn
          ? (() => {
              try {
                const d = readSettings().localBrainNotesDir
                return typeof d === 'string' && d ? loadPersistedLedger(d) : []
              } catch {
                return []
              }
            })()
          : []
        let { context, used } = buildWholeNoteContext(
          query,
          notes.map((n) => ({ id: n.id, text: n.text })),
          sem.map((h) => ({ note: h.file, score: h.score })),
          { topK, perNoteBudget }
        )
        if (ledger.length > 0 && used.length > 0) {
          // (b) pull in the updates for whatever was retrieved, then re-assemble so they are IN context.
          const extra = superseders(used, ledger).filter((id) => notes.some((n) => n.id === id))
          if (extra.length > 0) {
            const re = buildWholeNoteContext(
              query,
              notes.map((n) => ({ id: n.id, text: n.text })),
              sem.map((h) => ({ note: h.file, score: h.score })),
              { topK: topK + extra.length, perNoteBudget, pin: extra }
            )
            if (re.context) {
              context = re.context
              used = re.used
              console.log(`[local-brain] currency: co-retrieved ${extra.length} superseding note(s)`)
            }
          }
          // (a) label what is no longer current. Appends only — the stale text stays in context.
          const block = buildCurrencyBlock(supersessionsIn(used, ledger))
          if (block) {
            context = context + block
            console.log(`[local-brain] currency: labelled ${supersessionsIn(used, ledger).length} superseded statement(s)`)
          }
        }
        if (context) {
          // NOTE (measured 2026-07-13): a prepended "answer strictly / don't infer absent values"
          // directive was tried here and REGRESSED the benchmark (temporal-reasoning 96%→85% — it made
          // the model over-cautious on temporal computations like "how many days ago"), for a noisy
          // preference gain (n=6). Reverted. Plain BM25 whole-note context (this line) is the winner:
          // 87% vs naive-RAG 88% (tie, within judge noise) and BEATS it on knowledge-update (+6) and
          // temporal (+4). Keep the context clean; don't reintroduce answer-behavior directives here.
          contextOverride = context
          groundingPath = 'whole-note'
          console.log(
            `[local-brain] wholenote-ground[${mode}]: corpus=${notes.length} note(s), used=${used.length}, ${context.length} chars`
          )
        }
      } catch (err) {
        console.warn('[local-brain] wholenote-ground failed, falling through:', (err as Error).message)
      }
    }

    // The citations this turn's agentic pass produced, held for rendering AFTER the four ranking
    // stages below. Non-null ⇒ the agentic pass owns this turn's CONTEXT block.
    //
    // WHY THIS IS NOT WRITTEN TO `contextOverride` HERE (measured 2026-07-25). It used to be, and
    // that single assignment is what SKIPPED all four `!contextOverride`-gated stages below on every
    // default install — the pass is default-ON whenever a model is configured. The justification was
    // a comment, never a measurement. Measured, the bypass LOSES: routing the same citations through
    // the stages scores recall@5 0.431 vs 0.316, MRR 0.870 vs 0.797 and any-hit@5 0.938 vs 0.815
    // (paired, 65 probe-runs where the pass returned citations; 26 better / 7 worse / 32 tied). The
    // dominant term is stage 1: the pass emits a mean of 1.8 notes, and the graph-neighbour merge the
    // bypass was deleting is what turns that into an answerable set. Full arms, slices and the
    // fidelity notes: brain/agentic-bypass.eval.ts. Kill-switch: DUIN_AGENTIC_RANK_STAGES=0.
    let agenticCitations: Citation[] | null = null
    if (!contextOverride && query && agenticRetrieverEnabled()) {
      try {
        // Drive the retrieval loop with a cheap extraction model when one exists,
        // else the answer model — so the agentic pass ALWAYS runs when a model is
        // configured instead of silently no-opping to the passive top-6.
        const retrieved = await retrieveContext(query, { model: routeModel('extraction') ?? modelId })
        // Captured BEFORE the citations gate below. A whole-corpus computation is a legitimate
        // result with nothing to cite ("how many notes mention X"), so gating it on citations would
        // silently discard exactly the answers this tool exists to produce.
        computedBlock = renderComputed(retrieved?.computed)
        if (computedBlock) {
          const c = retrieved?.computed ?? []
          console.log(
            `[local-brain] agentic retrieve: ${c.filter((x) => !x.failed).length} computed value(s)` +
              `${c.some((x) => x.failed) ? `, ${c.filter((x) => x.failed).length} failed` : ''}`
          )
        }
        if (retrieved && retrieved.citations.length > 0) {
          if (agenticRankStagesEnabled()) {
            // Hand the citations to the SHARED pipeline as this turn's hits. They replace the RRF
            // hits rather than merging with them: the union arm was measured too (recall@5 0.428,
            // but MRR collapses to 0.670 vs 0.870 — it dilutes the pass's precision-at-1 with eight
            // fusion hits, and on multi-hop its MRR falls to 0.221 vs 0.833), so replace-not-merge is
            // the measured choice, not an oversight.
            //
            // ONE KNOWN SIDE-EFFECT, deliberately left as-is: citation hits carry no `rawScore`
            // (a model citation has no absolute relevance scale — inventing one would be a lie), so
            // agui-grounding's uncertainty gate sees no absolute signal and FAILS OPEN, i.e. it may
            // inject the memory-recall block on a short query where the RRF rawScore would have
            // suppressed it. That is the direction uncertainty-gate.ts itself argues for ("losing
            // grounding is the expensive error; spending context is the cheap one"), and it only
            // reaches queries short enough to be non-substantive — which are also the queries the
            // agentic pass almost never returns citations for.
            agenticCitations = retrieved.citations
        if (groundingPath === 'none') groundingPath = 'agentic'
            hits = citationsToHits(retrieved.citations)
            console.log(
              `[local-brain] agentic retrieve: ${retrieved.citations.length} citation(s), ` +
                `${retrieved.turns} turn(s), ${retrieved.toolCalls} tool call(s) → ranking stages`
            )
          } else {
            // Kill-switch path — the pre-measurement behaviour, byte-identical: compile the citations
            // into a topic-organized, rescue-augmented block (SkillRAE graft) and suppress the four
            // stages. Degrades byte-identical to citationsToContext when there's no graph.
            const g = deriveGraph()
            const compiled = compileContext(retrieved.citations, query, toGraphView(g), detectCommunities(g), {
              flatFallback: citationsToContext
            })
            contextOverride = compiled.context
        groundingPath = 'ranking-stages'
            console.log(
              `[local-brain] agentic retrieve: ${retrieved.citations.length} citation(s), ` +
                `${retrieved.turns} turn(s), ${retrieved.toolCalls} tool call(s); ` +
                `compiled ${compiled.clusters} cluster(s), ${compiled.rescued.length} rescued`
            )
          }
        }
      } catch (err) {
        console.warn('[local-brain] agentic retrieve failed, using one-shot search:', (err as Error).message)
      }
    }

    // ── Graph-augment the ONE-SHOT retrieval (item 2) ──
    // The agentic pass already walks the graph; the passive top-k search does NOT.
    // When we're on the one-shot path, expand the hits with 1-hop graph neighbours
    // of the top hits — linked notes that may share none of the query's vocabulary
    // but are structurally relevant (the recall pure-RAG can't reach). Best-effort:
    // any failure leaves `hits` exactly as the search returned them.
    if (!contextOverride && hits.length > 0) {
      try {
        const gview = toGraphView(deriveGraph())
        if (gview.nodes.length > 0) {
          const seenFiles = new Set(hits.map((h) => h.file))
          const neighborFiles: string[] = []
          for (const h of hits.slice(0, 3)) {
            for (const nb of graphNeighbors(gview, h.file)) {
              if (!seenFiles.has(nb.id) && !neighborFiles.includes(nb.id)) neighborFiles.push(nb.id)
            }
          }
          const neighborHits = neighborFiles
            .slice(0, 4)
            .map((f) => {
              const snip = snippetForFile(f)
              // Score below any real hit; tag "(linked)" so the answer model knows
              // this note was pulled by a RELATIONSHIP, not a keyword/semantic match.
              return snip ? { file: f, snippet: `(linked) ${snip}`, score: 0.25 } : null
            })
            .filter((h): h is { file: string; snippet: string; score: number } => h !== null)
          if (neighborHits.length > 0) {
            const before = hits.length
            // The cap is RELATIVE to the pool, not absolute. `mergeGraphNeighbors` keeps all of
            // `base` and breaks the moment `out.length >= k`, so a hardcoded 8 made this stage — the
            // one this file calls the dominant term — a SILENT no-op for every `searchK >= 8`, i.e.
            // two-thirds of the tunable's own [3,30] range, while `retrieval-tunables.ts` urges
            // raising it to 20-30. Nothing logged, because the "merged N" line below is gated on
            // the count having changed.
            //
            // NEIGHBOUR_SLOTS = 2 is chosen to be BYTE-IDENTICAL at the shipped default: searchK=6
            // ⇒ 6+2 = 8 = the old constant, so today's measured behaviour (recall@5 0.431) is
            // unchanged and this is a trap fix, not a retuning. Widening the slots is a separate,
            // measurable decision — `neighborFiles.slice(0, 4)` above already prepares 4 candidates,
            // so half are still discarded at the default.
            hits = mergeGraphNeighbors(hits, neighborHits, hits.length + NEIGHBOUR_SLOTS)
            if (hits.length > before) {
              console.log(`[local-brain] graph-expand: +${hits.length - before} linked note(s)`)
            }
          }
        }
      } catch (err) {
        console.warn('[local-brain] graph-expand failed, using base hits:', (err as Error).message)
      }
    }

    // ── Shared cross-encoder rerank (item 3) ──
    // Reuse the attachment-RAG reranker on the notes-brain path so ONE setting
    // (rag.rerankMode) reorders BOTH pipelines. ON by default (DEFAULT_RERANK_MODE =
    // 'local-cross-encoder'); an operator opts OUT in Settings → RAG. The comment here said
    // 'off by default' until 2026-09-04 -- true before item 6 flipped the default, and stale
    // after it. This used to be qualified "one-shot path only — the agentic pass already ranks its
    // own citations"; that claim was never measured and is now REFUTED (see agenticRankStagesEnabled),
    // so the agentic citations arrive here as `hits` too and get cross-encoded like any other
    // candidate set. Best-effort inside rerankHits.
    if (!contextOverride && hits.length > 1) {
      const ragCfg = (() => {
        try {
          return (readSettings() as { rag?: { rerankMode?: string; rerankerId?: string } }).rag ?? {}
        } catch {
          return {} as { rerankMode?: string; rerankerId?: string }
        }
      })()
      if (resolveRerankMode(ragCfg) !== 'off') {
        hits = await rerankHits(query, hits, ragCfg.rerankerId)
      }
    }

    // ── taste_rerank (read-side moat) ──
    // Reshape the final ranking toward the operator's CONFIRMED judgment, so retrieval
    // bends to what they've decided matters. Cold-start safe (no confirmed judgment →
    // no-op) and best-effort (null → original order kept). Off-switch:
    // settings.tasteRerank === 'off'. Runs on the agentic path too since 2026-07-25 — the "agentic
    // ranks its own" carve-out was an unmeasured assumption; measured, it lost (agenticRankStagesEnabled).
    if (!contextOverride && hits.length > 1) {
      const tasteRerankOn = (() => {
        try {
          return (readSettings() as { tasteRerank?: string }).tasteRerank !== 'off'
        } catch {
          return true
        }
      })()
      if (tasteRerankOn) {
        try {
          const tvDir = (() => {
            try {
              const d = readSettings().localBrainNotesDir
              return typeof d === 'string' && d ? d : null
            } catch {
              return null
            }
          })()
          let tv
          try {
            tv = getTaste(tvDir)
          } catch {
            tv = null
          }
          const judgmentTexts = confirmedJudgmentTexts(getOperatorFacts(), tv)
          if (judgmentTexts.length > 0) {
            const reranked = await tasteRerank(query, hits, judgmentTexts, embedForRecall)
            if (reranked) hits = reranked
          }
        } catch (e) { console.debug('[server] keep the existing order:', messageOf(e)) }
      }
    }

    // ── claim-recall demotion (read-side moat) ──
    // Demote a one-shot hit whose note is backed by a RETIRED claim (superseded/stale/orphaned) so
    // the answer grounds on fresh evidence, not a note the embedder still found "similar". Re-ranks,
    // never drops (clamped at FRESH_FLOOR). Gated OFF by default (byte-identical) and ledger-driven
    // — a no-op until the live metabolism (DUIN_CLAIM_METABOLISM_LIVE) has persisted retired claims.
    if (!contextOverride && hits.length > 1 && claimRecallEnabled()) {
      try {
        const crDir = (() => {
          try {
            const d = readSettings().localBrainNotesDir
            return typeof d === 'string' && d ? d : null
          } catch {
            return null
          }
        })()
        if (crDir) {
          const ledger = loadLedger(crDir)
          hits = applyClaimFreshness(hits, ledger, Date.now())
          // store.reinforce-arm: stage the ACTIVE claims whose notes survived in the grounding hits
          // (usefully recalled). If the next turn endorses this answer, they'll be markUseful'd. Opt-in.
          if (claimReinforceEnabled()) stageReinforcementCandidates(parsed.threadId ?? '', activeClaimsForHits(hits, ledger))
        }
      } catch (e) { console.debug('[server] keep the existing order:', messageOf(e)) }
    }

    // ── Render the agentic citations in the order the four stages settled on ──
    // This is the agentic pass's contextOverride write, deliberately placed AFTER every stage above
    // instead of at the dispatch site, so the stages actually run on its citations. Rendering is FLAT
    // (citationsToContext, stage order) rather than through compileContext's community regrouping:
    // measured, regrouping AFTER the stages gives back the ranking they just produced — MRR 0.704 vs
    // 0.870 flat, for recall@5 0.350 vs 0.431 — so it loses on both. (compileContext's own rescue pass
    // is what the flat path gives up; stage 1's graph-neighbour merge more than replaces it, admitting
    // up to 4 linked notes against the compiler's 2, which is why arm B beats arm A on recall too.)
    // compileContext stays wired on the DUIN_AGENTIC_RANK_STAGES=0 kill-switch path above.
    if (agenticCitations) {
      contextOverride = citationsToContext(orderCitationsByHits(agenticCitations, hits))
    }

    // Whole-prompt budget for the context-compiler (DUIN_CONTEXT_COMPILER=1; inert when off). Thread the
    // answer model's context window, reserving half for the chat history + the completion so the system
    // prompt gets at most ~half the window. resolveModel always returns a descriptor (safe, pure read).
    const groundingBudgetTokens = Math.floor(resolveModel(modelId).contextWindow / 2)
    // The `undefined` is contextDescribedByHits — left derived-by-verification here, exactly as
    // before; `voice` is appended after it so no existing caller's positions shift.
    // Inside phase:agui-turn, so a stall here reports the narrower name. This
    // stage reads the retrieved note files off disk synchronously and assembles
    // the prompt, which makes it the first place to look for a turn-time freeze.
    const groundedMessages = await withPhase('turn:grounding', () =>
      buildGroundedMessages(visionSafeMessages, query, hits, contextOverride, pinnedNote, parsed.threadId ?? '', groundingBudgetTokens, parsed.skills, parsed.language, computedBlock, undefined, parsed.voice)
    )

    // Schema-graft ③ (forward-note resurface, HOT PATH — GATED DUIN_FORWARD_NOTES). At turn-open,
    // surface the brain's recent self-authored "recheck" notes so a promoted belief's follow-up
    // survives context compaction. Default off ⇒ groundedMessages untouched (byte-identical today).
    if (process.env.DUIN_FORWARD_NOTES === '1') {
      try {
        const fwd = listEvents({ type: 'note.forward.recorded', limit: 5, order: 'desc' })
        const lines = fwd
          .map((e) => {
            const p = (e.payload ?? {}) as Record<string, unknown>
            const note = String(p.note ?? '').trim()
            const belief = p.belief ? ` — ${String(p.belief).trim()}` : ''
            return note ? `- ${note}${belief}` : null
          })
          .filter((x): x is string => Boolean(x))
        if (lines.length) {
          const block = 'Forward notes (self-authored — recheck these):\n' + lines.join('\n')
          // CACHE INTERACTION (DUIN_STABLE_PREFIX): this block is per-turn VOLATILE and unshifting
          // it puts it AHEAD of the byte-stable core, so with both flags on the prefill cache is
          // defeated from byte 0 — prefix caching is anchored at the start of the request. The
          // marker side is already hardened (prefill-cache.ts marks the END of the leading system
          // run, not index 0), so the breakpoint still lands on the core; but the prefix itself is
          // only stable while this stays off. If forward-notes ever ships default-on, move this
          // into buildGroundedMessages' volatileTail instead of prepending it here.
          groundedMessages.unshift({ role: 'system', content: block } as (typeof groundedMessages)[number])
        }
      } catch (e) { console.debug('[server] forward-notes resurface  never break the turn:', messageOf(e)) }
    }

    // Offer the model a real file-write tool (jailed to the vault) so "create a
    // note" actually writes a file instead of hallucinating success. Bounded
    // tool-execution loop: stream any text, execute write_note calls, feed the
    // results back, and let the model confirm. No vault configured → no tools
    // (identical to the old text-only behaviour).
    const writeNotesDir = (readSettings().localBrainNotesDir as string) || ''
    // Tool surface — ONE catalog (brainToolRegistry), provider-normalized through the
    // shared normalizeToolsForProvider (the same path the coder loop uses), replacing
    // the old hand-built aguiTools array. The 9 vault-jailed tools are offered only when
    // a vault is configured (run_command / web_fetch / render_artifact / spawn_agent do
    // not need one) — the VAULT_TOOL_NAMES filter reproduces the pre-registry
    // `vaultTools` conditional exactly. For the brain's simple schemas the normalizer is a
    // byte-identical deep-clone (they use no unsupported keywords), so the model-facing
    // surface is unchanged; locked by brain-tool-surface.test.ts.
    const brainDescriptors = brainToolRegistry
      .getDescriptors()
      .filter((d) => (writeNotesDir ? true : !VAULT_TOOL_NAMES.has(d.name)))
    const { tools: normalizedBrainTools, warnings: brainToolWarnings } = normalizeToolsForProvider(
      brainDescriptors.map((d) => ({
        name: d.name,
        description: d.description,
        inputSchema: d.inputSchema,
        providerKind: d.providerKind
      })),
      getProviderForModel(modelId)
    )
    for (const w of brainToolWarnings) console.warn(`[local-brain] ${w}`)
    const aguiTools: ProviderTool[] = [...normalizedBrainTools]
    // Offer every mounted MCP tool (browser control, external APIs, a JS REPL,
    // Feishu, …) to the brain loop, namespaced serverId__tool. Each is gated as
    // tier mcp-external (deny-first, same as host-exec) at dispatch. Default ON;
    // DUIN_AGUI_MCP=0 disables (e.g. to trim the tool list for a small model).
    // MCP stays on the raw buildMcpToolSchemas path (not registry-normalized) to
    // preserve byte-parity with structural-keyword MCP schemas ($ref/oneOf, common
    // in real servers) that the normalizer would drop.
    if (process.env.DUIN_AGUI_MCP !== '0') {
      try {
        aguiTools.push(...(buildMcpToolSchemas(mcpManager.getAllTools()) as never[]))
      } catch (err) {
        console.warn('[local-brain] MCP tool enumeration failed:', (err as Error)?.message)
      }
    }
    // Providers (OpenAI/DeepSeek/…) return 400 "Tool names must be unique" and hard-fail
    // the whole turn if any tool name repeats. The brain-native ++ MCP concat above has no
    // uniqueness guard, so a collision — an MCP tool shadowing a brain native, a
    // double-mounted server, or a future tool addition — kills every turn on strict
    // providers (GLM silently tolerates it, which is why it wasn't caught earlier). Dedupe
    // by function.name keeping brain natives (first) over later MCP/dynamic duplicates.
    {
      const { tools: dedupedTools, dropped } = dedupeToolsByName(aguiTools)
      if (dropped.length) {
        console.warn(
          `[local-brain] dropped ${dropped.length} duplicate model tool(s): ${dropped.join(', ')} (brain-native takes precedence)`
        )
        aguiTools.length = 0
        aguiTools.push(...dedupedTools)
      }
    }
    let acc = ''
    // Phase 1 — prose-first routing for generative-write intent. A "write me a complete
    // structured document" request wants PROSE in the chat, but the write_file-biased model
    // treats it as a file-authoring task and churns on search tools + a preamble without ever
    // composing (02 Cards C260709). Retrieval above already injected vault context, so on such
    // a request we run round 0 TOOLS-OFF at full effort — the model composes from grounding in
    // one pass. Later rounds restore tools as an escape hatch. File/persistence phrasing keeps
    // the tools (see generative-intent.ts). Disable via DUIN_GENERATIVE_PROSE_FIRST=0.
    const proseFirst = generativeProseFirstEnabled() && looksLikeGenerativeWrite(query)
    // The native tool calls the model returned on the LAST completed round —
    // fed to the bare-preamble MITIGATION guard below (a turn that ends still
    // wanting to call a tool, with no substantive prose, is the quirk we catch).
    let lastToolCalls: any[] = []
    // Enough headroom for a real agentic chain (list_dir → read_file → read_file
    // → write_file / render_artifact → confirm) without unbounded looping.
    // Round budget for the agentic chain. Raised from 8 → 16 so deep multi-hop
    // work (long list→read→edit→verify chains, fan-out + follow-up) isn't cut
    // short; the per-turn wall-clock deadline (DUIN_TURN_DEADLINE_MS) remains the
    // real safety bound. Override via DUIN_MAX_TOOL_ROUNDS.
    const MAX_TOOL_ROUNDS = (() => {
      const raw = Number(process.env.DUIN_MAX_TOOL_ROUNDS)
      // Default 32 (Capabilities ②, raised from 16) so deep multi-hop agentic chains
      // (long list→read→edit→verify + fan-out + follow-up) aren't cut short; the coder
      // loop runs 50, the per-turn wall-clock deadline (DUIN_TURN_DEADLINE_MS) is the
      // real safety bound, and DUIN_MAX_TOOL_ROUNDS overrides.
      return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 32
    })()
    let errored = false
    // Latched when the PROVIDER reports finishReason 'length' — the model stopped because it ran
    // out of output budget, not because it was done. chatStream already latches and forwards this
    // (registry.ts settleDone's `completion` arg); both onDone handlers below used to declare only
    // (fullContent, toolCalls) and silently drop it, so a document that stopped mid-sentence
    // terminated with a plain RUN_FINISHED and was indistinguishable from a complete answer.
    // Property 8: two different situations must not produce the identical terminal.
    let truncated = false
    let nudgedOnce = false
    // Transparent continuation. `max_tokens` is a PER-RESPONSE protocol limit, not a limit on
    // how much the operator is allowed to ask for — every provider ends a capped response with
    // finishReason 'length'. Treating that as the end of the turn made the product's answer to
    // "write me the whole thing" a half-document plus an apology. Instead, feed the partial back
    // and ask for the rest, streaming into the SAME message: from outside it is one continuous
    // answer of arbitrary length. Bounded only so a model that loops forever cannot run unbounded
    // (the stall watchdog and Cancel still apply); 64 slices is ~1M tokens of output.
    let continuations = 0
    let continuationStop: ContinuationVerdict | null = null
    const MAX_CONTINUATIONS = maxContinuations()
    // Did the loop end because the model was DONE, or because it ran out of rounds? The two
    // exits shared a fall-through, so a 32-round agent that never finished its task emitted a
    // plain RUN_FINISHED — indistinguishable from success, and worse than merely silent: it
    // reached the learn hooks below, so an unfinished turn was mined for facts and staged for
    // promotion. Every other cut mode already suppresses those; round exhaustion was the one
    // that bypassed the guard. Set at the completion break, read after the loop.
    let answerComplete = false
    const requestedEffort =
      parsed.reasoningEffort === 'low' || parsed.reasoningEffort === 'medium' ||
      parsed.reasoningEffort === 'high' || parsed.reasoningEffort === 'max'
        ? parsed.reasoningEffort
        : undefined
    // A successful quota/billing fallback (below) carries forward across tool-rounds so we don't
    // re-hit the dead provider every round — it holds the working model for the rest of the turn.
    let activeModel = modelId
    // Every engine this turn actually called, in order — the journal's `engineChain`. Turn-scoped
    // (the per-round `triedModels` below is not), so TURN_END can say what the answer cost in hops.
    const engineTried: string[] = [modelId]
    // Repeat-failure ladder state: the streak of consecutive identical failing calls, and the root
    // cause once it trips. Turn-scoped by construction — a fresh turn starts with a clean streak.
    let repeatState = emptyRepeatState()
    let repeatHalted: string | null = null
    // Per-turn cost meter. The meter always runs (knowing the spend is useful on its own); the
    // ceiling only exists for an operator who set one — readTurnBudgetUsd returns 0 otherwise.
    let turnCost = emptyTurnCost()
    let budgetRefused: string | null = null
    const turnBudgetUsd = readTurnBudgetUsd()
    // Publish the loop bounds to the long-turn notices (advisory only; see the watchdog above).
    roundCap = MAX_TOOL_ROUNDS
    // The round budget is EARNED, not fixed. It starts at MAX_TOOL_ROUNDS and is extended
    // — on the last round of the current budget, and only then — when the turn has made
    // real progress recently (markProgress: streamed tokens, reasoning, or a SUCCEEDING
    // tool). A turn that is getting somewhere keeps going up to `roundHard`; a turn that
    // is spinning stops exactly where it used to. See nextRoundBudget for why a fixed
    // count was the wrong primitive and what replaced it. The wall-clock deadline and the
    // cost ceiling remain the real bounds.
    const roundHard = roundHardCap(MAX_TOOL_ROUNDS)
    const grant = roundGrant()
    const progressWindow = roundProgressWindowMs()
    let roundBudget = MAX_TOOL_ROUNDS
    // A continuation is not a tool round — it is the same answer still being written — so it
    // must not spend the tool budget. Extending the bound by the continuations taken keeps the
    // agentic budget intact for actual work.
    for (let round = 0; round < roundBudget + continuations && !errored && !turnAbort.signal.aborted; round++) {
      const grown = nextRoundBudget({
        round,
        budget: roundBudget,
        hardCap: roundHard,
        lastProgressAt,
        now: Date.now(),
        progressWindowMs: progressWindow,
        grant
      })
      if (grown !== roundBudget) {
        roundBudget = grown
        roundCap = grown
        console.log(`[agui] round budget extended to ${grown} (progress within ${progressWindow}ms)`)
      }
      currentRound = round + 1
      // ── STEER DRAIN (composer steering) ──────────────────────────────────────────────────────
      // Splice any pending steer text (injected via the steer beacon while this turn ran) into the
      // conversation as role:user messages BEFORE this round's chatStream. We drain STRICTLY at the
      // round top: the PRIOR round's tail already pushed its assistant tool_calls + ALL matching
      // tool_result messages (see the loop bottom), so groundedMessages ends on a COMPLETE pair
      // here — a user message spliced in now can never split an assistant tool_calls/tool_result
      // pair. Subagent steers ride the same inbox: a steer that arrives while a spawn_agent child is
      // running is buffered on THIS parent run and delivered here, at the parent seam AFTER the
      // child's tool_result landed, so the child keeps its own identity (it never sees the steer).
      if (run && run.hasPendingSteer) {
        for (const steerText of run.drainSteers()) {
          groundedMessages.push({ role: 'user', content: steerText } as never)
          markProgress() // an injected steer is forward progress (resets the stall cut)
          sseFrame(res, { type: 'STEP', label: 'steering — injected your message into this turn' })
        }
      }
      // Full effort only on the primary reasoning round; tool-continuation rounds
      // are capped at 'low' so a high setting on a long agentic chain doesn't
      // multiply latency. (undefined on round 0 → registry's own 'low' default.)
      // Continuation rounds previously FLOORED to 'low', so hard multi-hop chains reasoned at the
      // floor after round 0 (a real capability tax). Keep the operator's requested effort on
      // continuations, only shading 'high' → 'medium' so a long agentic chain doesn't multiply
      // full-effort latency while still reasoning properly. (undefined → registry default, as before.)
      const roundEffort = round === 0 ? requestedEffort : requestedEffort === 'high' ? 'medium' : requestedEffort
      // Round 0 tools-off when generative-write intent is detected (prose-first); every other
      // round keeps the full agentic tool set.
      const roundTools = round === 0 && proseFirst ? [] : aguiTools
      // Provider-agnostic quota/billing fallback: if the routed model fails with a quota/billing/
      // rate-limit error BEFORE any token streamed (e.g. a keyed provider whose account ran dry —
      // "402 Insufficient Balance"), re-route to the next keyed model from a DIFFERENT provider and
      // retry, instead of hard-failing the turn. Only fires pre-stream (a mid-stream failure can't be
      // cleanly retried); each provider is tried at most once; no hardcoded provider preference.
      let attemptModel = activeModel
      let result: { content: string; toolCalls: any[] } = { content: '', toolCalls: [] }
      // Dedup by MODEL id (not just provider): a stale-id failover re-uses the SAME provider with a
      // different catalog id, so a provider-only guard would wrongly reject the within-provider hop.
      const triedModels = new Set<string>()
      // What each attempt died of, in order. The exhaustion message used to report only
      // the LAST error, so an operator who started on Claude, fell through an empty
      // balance to OpenAI and hit a bad key there was told "invalid OpenAI key" — a
      // model they never chose, a provider they may not have known was in play, and no
      // sign that the first one failed for a completely different reason.
      const attemptLog: string[] = []
      const attemptReasons: ProviderHealthReason[] = []
      for (;;) {
        triedModels.add(attemptModel)
        // Cost ceiling, checked before EVERY attempt (a failover hop is another paid call, so it
        // must be checked too, not just the first try of the round). A continuation round is
        // waived — see shouldRefuseForBudget: cutting there truncates an answer mid-stream.
        // DEFAULT OFF; only an operator who set DUIN_TURN_COST_BUDGET_USD can be refused here.
        const budgetVerdict = shouldRefuseForBudget(turnCost, turnBudgetUsd, truncated)
        if (budgetVerdict.stop) {
          errored = true
          budgetRefused = budgetRefusalMessage(turnCost, turnBudgetUsd)
          console.warn(`[agui] ${budgetRefused}`)
          if (!turnAbort.signal.aborted) sseFrame(res, { type: 'RUN_ERROR', message: budgetRefused })
          break
        }
        let streamedThisAttempt = false
        let failoverErr = ''
        result = await new Promise<{ content: string; toolCalls: any[] }>((resolve) => {
          let settled = false
          const fail = (msg: string): void => {
            if (settled) return
            settled = true
            // Recoverable-on-another-provider ONLY when nothing has streamed yet.
            if (isProviderFailoverError(msg) && !streamedThisAttempt && !turnAbort.signal.aborted) {
              failoverErr = msg
              resolve({ content: '', toolCalls: [] })
              return
            }
            errored = true
            if (!turnAbort.signal.aborted) sseFrame(res, { type: 'RUN_ERROR', message: msg })
            resolve({ content: '', toolCalls: [] })
          }
          chatStream(
            groundedMessages as never,
            attemptModel,
            roundTools as never,
            {
              onChunk: async (content: string) => {
                streamedThisAttempt = true
                markProgress() // streamed tokens = forward progress (resets the stall cut)
                acc += content
                // Await socket drain when the client is slow — bounds our write
                // buffer instead of forwarding deltas faster than it can read.
                await sseFrameDrained(res, { type: 'TEXT_MESSAGE_CONTENT', delta: content }, turnAbort.signal)
              },
              // Forward the provider's reasoning channel so the chat's Reasoning
              // panel shows the model's ACTUAL thinking. duin-bridge maps REASONING.
              onReasoning: async (chunk: string) => {
                if (chunk) {
                  markProgress() // reasoning tokens are progress too
                  await sseFrameDrained(res, { type: 'REASONING', delta: chunk }, turnAbort.signal)
                }
              },
              onDone: (
                fullContent: string,
                toolCalls?: any[],
                _reasoning?: string,
                completion?: { finishReason?: string | null; usage?: NormalizedUsage }
              ) => {
                if (settled) return
                settled = true
                if (completion?.finishReason === 'length') truncated = true
                // Meter this call against the turn. Best-effort by construction: a provider that
                // reports no usage simply leaves the total where it was — metering must never gate
                // answering. `attemptModel` (not activeModel) so a quota failover hop is billed to
                // the model that actually ran.
                turnCost = accrueTurnCost(turnCost, attemptModel, completion?.usage)
                resolve({ content: fullContent, toolCalls: toolCalls ?? [] })
              },
              onError: (error: string) => fail(error)
            },
            turnAbort.signal,
            { reasoningEffort: roundEffort },
            // Audit context so the brain path emits model.request.started/completed (usage +
            // costUsd) like chatOnce callers do — lane C's cost ledger missed every chat turn
            // while this was undefined. The thread is the conversation; the role names the face.
            { conversationId: parsed.threadId ?? undefined, role: 'brain-turn', purpose: 'main' }
          ).catch((err) => fail((err as Error)?.message ?? 'provider error'))
        })
        if (!failoverErr || turnAbort.signal.aborted) break
        const failedProvider = getProviderForModel(attemptModel)
        // One verdict per hop (roles.ts ClassifiedProviderError): the STEP line, the event and the
        // exhaustion message all read the same reason. chatStream already formatted the message
        // as `provider: reason (status) — detail`, so this parses exactly rather than re-guessing.
        const classified = classifyProviderError({ message: failoverErr }, failedProvider, PROVIDERS[failedProvider].label)
        attemptLog.push(`${attemptModel} (${classified.reason})`)
        attemptReasons.push(classified.reason)
        // Stale/unknown id (not-found): exhaust the SAME provider's other catalog ids first — a
        // single-key operator has no other provider to fail over to (e.g. a retired default 404s →
        // try the provider's next id). Any ACCOUNT-level reason (no credit, bad key, no access,
        // rate limit, unreachable, 5xx) walks the role's CHAIN instead — resolveRole ordered it by
        // policy then health — never re-entering a provider that already failed this turn.
        const fallback = nextFailoverHop({
          chain: engine?.chain ?? [],
          triedModels,
          providerOf: getProviderForModel,
          reason: classified.reason,
          failedModelId: attemptModel,
          withinProvider: () => routeWithinProvider(failedProvider, 'chat', triedModels)
        })
        if (!fallback) {
          // Chain exhausted (router.exhaustionMessage: every engine with the reason IT failed
          // for, the fix hint for the operator's first preference, the raw text last).
          errored = true
          const headProvider = getProviderForModel(engineTried[0])
          const msg = exhaustionMessage(
            attemptLog.map((_, i) => ({ modelId: engineTried[i] ?? attemptModel, reason: attemptReasons[i] ?? classified.reason })),
            PROVIDERS[headProvider].label,
            failoverErr
          )
          emitRoleFailure(
            { role: 'chat', provider: failedProvider, modelId: attemptModel, reason: classified.reason, detail: classified.detail, recovered: false },
            { conversationId: parsed.threadId ?? undefined, role: 'brain-turn' }
          )
          if (!turnAbort.signal.aborted) sseFrame(res, { type: 'RUN_ERROR', message: msg })
          break
        }
        emitRoleFailure(
          { role: 'chat', provider: failedProvider, modelId: attemptModel, reason: classified.reason, detail: classified.detail, recovered: true, nextModelId: fallback },
          { conversationId: parsed.threadId ?? undefined, role: 'brain-turn' }
        )
        console.warn(`[local-brain] engine ${attemptModel} failed: ${classified.reason} (${failoverErr.slice(0, 80)}) → trying ${fallback}`)
        sseFrame(res, { type: 'STEP', label: `engine ${attemptModel} failed: ${classified.reason} → trying ${fallback}` })
        engineTried.push(fallback)
        attemptModel = fallback
      }
      // Remember a working fallback for the rest of the turn (skip the dead provider next round).
      if (!errored && attemptModel !== activeModel) activeModel = attemptModel
      if (errored || turnAbort.signal.aborted) break
      // Capabilities ① — non-native-model fallback. A model that does NOT support
      // native tool_calls (e.g. a local Ollama model, supportsTools:false) can
      // still drive tools by emitting the fallback-JSON contract in its text;
      // parse it into the native shape so the existing dispatch runs it. Native
      // models (supportsTools !== false) NEVER enter this branch, so their
      // behaviour is byte-identical. Mirrors ipc/chat.ts's parse-only fallback.
      if (
        (!result.toolCalls || result.toolCalls.length === 0) &&
        resolveModel(attemptModel)?.supportsTools === false
      ) {
        const fbCalls = parseBrainFallbackCalls(
          result.content,
          brainToolRegistry.getDescriptors().map((d) => ({
            name: d.name,
            inputSchema: d.inputSchema,
            description: d.description
          }))
        )
        if (fbCalls) result.toolCalls = fbCalls
        else {
          // A local model that ATTEMPTED a tool call and produced unreadable JSON must not have
          // that JSON served back as its answer in silence. This is the only place the attempt is
          // still visible; downstream it is indistinguishable from prose.
          const miss = fallbackParseMiss(
            result.content,
            brainToolRegistry.getDescriptors().map((d) => ({
              name: d.name,
              inputSchema: d.inputSchema,
              description: d.description
            }))
          )
          if (miss === 'unparseable') {
            console.warn(
              `[agui] ${attemptModel} emitted an unreadable fallback tool call — the call was DROPPED ` +
                'and its raw text will be shown as the answer. (supportsTools=false path.)'
            )
          }
        }
      }
      lastToolCalls = result.toolCalls
      // HANDLED_TOOLS is module-scope and derived from brainToolRegistry (F4).
      const handledCalls = result.toolCalls.filter(
        (tc) => HANDLED_TOOLS.has(tc?.function?.name) || isMcpToolName(tc?.function?.name)
      )
      if (handledCalls.length === 0) {
        // ── CONTINUE A CAPPED ANSWER ────────────────────────────────────────────────────────
        // The model stopped because it ran out of per-response output budget, NOT because it
        // was finished. Hand its own partial back and ask for the remainder; the next slice
        // streams into the same `acc` and the same TEXT_MESSAGE, so the operator sees one
        // continuous document rather than a truncation notice.
        //
        // Ordered before the incomplete-intent nudge deliberately: a capped answer often ends
        // mid-sentence or on a colon, which that gate reads as an unfulfilled intention. Nudging
        // there would tell the model to "write your full final answer" — restarting the document
        // that just overflowed, guaranteeing it overflows again. Continuation is the correct
        // response to 'length'; the nudge is the correct response to a model that chose to stop.
        const contVerdict = continuationVerdict({
          truncated,
          continuations,
          maxContinuations: MAX_CONTINUATIONS,
          sliceChars: (result.content || '').length,
          answerText: acc,
          contextWindow: resolveModel(attemptModel).contextWindow || 0
        })
        if (contVerdict === 'continue') {
          truncated = false // consumed; re-latches if this slice also caps out
          continuations++
          groundedMessages.push({ role: 'assistant', content: result.content } as never)
          groundedMessages.push({ role: 'user', content: CONTINUE_PROMPT } as never)
          sseFrame(res, {
            type: 'STEP',
            label: `continuing past the output limit — part ${continuations + 1}`
          })
          markProgress()
          continue
        }
        if (truncated) {
          // Truncated but NOT continuing. Carry WHICH stopping condition applied through to the
          // terminal: once the per-response cap is no longer one, the remaining three have
          // genuinely different remedies, and "ask me to continue" is actively wrong for
          // context-full — that request is the one that would overflow.
          continuationStop = contVerdict
          console.warn(
            `[local-brain] output capped and not continuing (${contVerdict}) after ${continuations} continuation(s), ${acc.length} chars`
          )
        }
        // No tool call this round. If the model merely ANNOUNCED an action
        // ("Let me search for it:") without acting, nudge it ONCE to actually do
        // it or give a complete answer — otherwise the turn dead-ends with no
        // follow-up message (the reported bug). Bounded to a single nudge.
        if (!nudgedOnce && looksLikeIncompleteIntent(result.content)) {
          nudgedOnce = true
          groundedMessages.push({ role: 'assistant', content: result.content || '' } as never)
          groundedMessages.push({
            role: 'user',
            content:
              'You indicated you would do something but did not call a tool or give a complete answer. Either call the appropriate tool now (read_file, list_dir, write_file, render_artifact) or write your full final answer. Do not just restate the intention.'
          } as never)
          continue
        }
        answerComplete = true
        break // the answer is complete
      }
      // Ensure every tool call has a stable id — some providers stream tool_calls
      // without one, which would break the assistant↔tool_result pairing (and get
      // the follow-up round rejected) on the next request.
      for (const tc of result.toolCalls) {
        if (tc && !tc.id) tc.id = randomUUID()
      }
      // Record the assistant's tool-call turn, then execute + feed results back.
      groundedMessages.push({
        role: 'assistant',
        content: result.content || null,
        tool_calls: result.toolCalls
      } as never)
      // Execute ONE tool call → its model-facing result string. Routes through the
      // SAME dispatchAguiTool the subagent loop uses (Agent-engine unification,
      // Stage 3 — this replaced the divergent second subagent dispatch path). The main
      // policy streams TOOL_CALL_START/END (+ARTIFACT) frames, gates every call
      // through the posture-aware resolveAguiGate, and offers the full tool
      // universe (render_artifact / MCP / spawn at parent execOk, depth 0).
      const mainPolicy: AguiDispatchPolicy = {
        emit: (frame) => sseFrame(res, frame as never),
        notesDir: writeNotesDir,
        threadId: parsed.threadId ?? '',
        // F2 (bounded-context): supply the turn query + on-device embedder so an over-budget tool
        // output is relevance-bounded (boundToBudget) rather than blind head-sliced. Fail-open — a
        // cold embedder falls back to today's slice, so no cold-start regression.
        query,
        embed: embedForRecall,
        // R3/Phase-2 — thread the turn signal so queued/in-flight tool work in the parallel windows
        // STOPS after the deadline/cancel instead of draining past it (dispatchAguiTool short-circuits).
        signal: turnAbort.signal,
        allowsTool: () => true,
        notAvailable: (name) => `Error: tool "${name}" is not available`,
        gate: (tc) =>
          resolveAguiGate(tc, {
            execOk,
            posture: aguiPosture,
            conversationId: parsed.threadId ?? '',
            workspacePath: writeNotesDir
          }),
        enableRenderArtifact: true,
        enableMcp: true,
        allowSpawn: true,
        spawnDenied: '', // main is always under the depth cap — never surfaced
        runSpawn: async (task, args) => {
          // Typed/parameterized spawn (Capabilities S2/S3): resolve agent_type/model/effort →
          // config. A bare {task} resolves to today's defaults, so the spawn is byte-identical.
          const subCfg = resolveSubagentConfig(args, { defaultModelId: modelId })
          const sub = await runSubagent(
            task, writeNotesDir, modelId, turnAbort.signal, 6, execOk, subCfg, 0,
            aguiPosture, parsed.threadId ?? '', // Safety ①: subagent uses the same posture-aware gate
            markProgress // opaque subagents mark the parent's stall-watchdog so long agents don't false-cut
          )
          return `Subagent result:\n${sub}`
        },
        // Heavy main-only deps injected so agui-dispatch stays free of the
        // artifact-sandbox / mcp-manager imports.
        renderArtifact: (type, source) => validateArtifact(type, source),
        callMcp: (serverId, toolName, margs) => mcpManager.callTool(serverId, toolName, margs)
      }
      const runOneCall = async (tc: any): Promise<string> => {
        markProgress() // a tool starting is forward progress
        const r = await dispatchAguiTool(tc, mainPolicy)
        // …and its result landing — but ONLY a SUCCESSFUL one. A failing tool is not progress,
        // and counting it defeated the very watchdog that exists to cut a wedged turn: the most
        // common wedge is a tool failing identically every round, and each failure refreshed
        // lastProgressAt, so DUIN_TURN_STALL_MS could never fire. Nothing stopped the loop before
        // the 32-round cap — 32 paid model calls on a turn that was dead after the third.
        // `!/^Error:/` is the same success discriminant the reindex scheduler uses below.
        if (!/^Error:/.test(r)) markProgress()
        return r
      }

      // Run independent read-only calls (read/list/search/glob/web/read_command)
      // CONCURRENTLY; every mutation / host-exec / spawn stays serial and ordered.
      // Results are re-assembled in original tool_call order so the provider's
      // assistant↔tool pairing — and any write-before-read intent — is preserved.
      const windows = partitionAguiWindows(result.toolCalls)
      const outs: (string | undefined)[] = new Array(result.toolCalls.length)
      for (const win of windows) {
        // Stop before starting a new window if the client cancelled (queued
        // delete_file/run_command must not run after Stop). A parallel window
        // already in flight is read-only, so letting it settle is harmless.
        if (turnAbort.signal.aborted) break
        if (win.kind === 'parallel') {
          // Bounded concurrency so a burst of spawn_agent fan-out (or many web
          // reads) can't launch unbounded subagents/host shells at once.
          const settled = await mapLimit(win.indices, AGUI_PARALLEL_LIMIT, (i) => runOneCall(result.toolCalls[i]))
          win.indices.forEach((i, k) => (outs[i] = settled[k]))
        } else {
          outs[win.index] = await runOneCall(result.toolCalls[win.index])
        }
      }
      for (let i = 0; i < result.toolCalls.length; i++) {
        const tc = result.toolCalls[i]
        const out = outs[i]
        if (out === undefined) continue // window not reached (turn cancelled)
        // After a successful vault mutation, schedule a (debounced) reindex so a
        // same-turn search_notes doesn't miss what the model just wrote/edited.
        if (writeNotesDir && VAULT_MUTATING_TOOLS.has(tc?.function?.name) && !/^Error:/.test(out)) {
          scheduleReindex(writeNotesDir)
        }
        groundedMessages.push({ role: 'tool', tool_call_id: tc.id, content: out } as never)
        // Repeat-failure ladder. Folding EVERY call (success or failure) into the streak here —
        // rather than only failures — is what makes a success reset it. The tool_result is already
        // paired above, so a halt below still leaves groundedMessages well-formed.
        repeatState = noteCallOutcome(repeatState, tc?.function?.name ?? '', parseToolArgs(tc), out)
      }
      // The same call failing identically N times is not exploration, it is a wedged loop. Stop
      // instead of spending the remaining round budget (and its paid model calls) on it, and name
      // the offending call so the operator gets a root cause rather than a silent early end.
      if (shouldHaltOnRepeat(repeatState, repeatFailureK())) {
        console.warn(`[agui] repeat-failure halt: ${repeatRootCause(repeatState)}`)
        repeatHalted = repeatRootCause(repeatState)
        break
      }
      // loop again so the model sees the tool results and confirms to the user
    }
    // ── MITIGATION (intermittent provider quirk): bare tool-call preamble ─────
    // DeepSeek V4 Pro (and similar agentic reasoners without thinking mode)
    // occasionally emit a natural-language tool-call preamble ("Let me pull the
    // current state…") — or a bare native tool call — as their ENTIRE turn and
    // stop, leaving no substantive answer. Persisting that as a valid answer is
    // worse than an explicit error. NARROW guard (see answer-completeness.ts):
    // fires ONLY on a strong signal — nothing substantive streamed, OR the turn
    // ended with leftover native tool calls AND only a narration preamble —
    // never a blanket "short = fail" (a legit terse "Yes." passes untouched). It
    // does ONE bounded re-generation with a direct-answer nudge; if that is STILL
    // empty it surfaces RUN_ERROR (bridge → chat:error) instead of the preamble.
    // Zero behaviour change for a normal complete answer (guard is a no-op).
    // NOTE: `terminalSent` is declared up-top (hoisted for the deadline timer) — do not re-declare.
    if (!errored && !turnAbort.signal.aborted) {
      const finalized = await finalizeAnswer(acc, lastToolCalls, {
        log: (m) => console.warn(`[duin-brain] ${m}`),
        // ONE re-generation only — the answer-completeness helper never loops.
        regenerate: () =>
          new Promise<{ content: string; toolCalls: any[] }>((resolve) => {
            groundedMessages.push({ role: 'assistant', content: acc || '' } as never)
            groundedMessages.push({
              role: 'user',
              content: 'Answer the question directly now in prose; do not narrate next steps or call tools.'
            } as never)
            // Tell the client to DISCARD the preamble deltas it already rendered before
            // we re-stream clean prose. Server-side `acc` is reset below, but the client
            // kept its own accumulator — without this reset the retry prose appended to
            // the visible preamble (duplicated/garbled text). Honored by duin-bridge
            // (zeroes its acc + emits chat:reset) and the renderer (clears the buffer).
            sseFrame(res, { type: 'TEXT_MESSAGE_RESET' })
            acc = '' // re-accumulate so the retry's prose is what we persist/re-check
            let settled = false
            chatStream(
              groundedMessages as never,
              modelId,
              // FIX (large-output stall): tools OFF on the completeness retry. With no tools
              // offered, the tool-biased model cannot re-emit another empty tool-call preamble —
              // it MUST answer in prose. This turns the previously-empty retry into the actual
              // document on big generative requests.
              [] as never,
              {
                onChunk: (content: string) => {
                  markProgress()
                  acc += content
                  sseFrame(res, { type: 'TEXT_MESSAGE_CONTENT', delta: content })
                },
                onReasoning: (chunk: string) => {
                  if (chunk) {
                    markProgress()
                    sseFrame(res, { type: 'REASONING', delta: chunk })
                  }
                },
                onDone: (
                  fullContent: string,
                  toolCalls?: any[],
                  _reasoning?: string,
                  completion?: { finishReason?: string | null }
                ) => {
                  if (settled) return
                  settled = true
                  if (completion?.finishReason === 'length') truncated = true
                  resolve({ content: fullContent, toolCalls: toolCalls ?? [] })
                },
                onError: () => {
                  if (settled) return
                  settled = true
                  resolve({ content: '', toolCalls: [] })
                }
              },
              turnAbort.signal,
              // FIX: synthesize at the requested effort, not 'low' — 'low' is too degraded to
              // compose a multi-section document in one shot.
              { reasoningEffort: requestedEffort }
            ).catch(() => {
              if (settled) return
              settled = true
              resolve({ content: '', toolCalls: [] })
            })
          })
      })
      if (finalized.status === 'error') {
        // Even the tools-off retry produced no answer. Emit RUN_ERROR for telemetry, but STILL
        // deliver a short fallback line + a clean RUN_FINISHED so the client never hangs on a
        // missing terminal frame (the large-multi-output stall). `errored` stays true so the
        // learn/successTick hooks below are skipped — we never learn from a non-answer.
        if (!turnAbort.signal.aborted) {
          sseFrame(res, { type: 'RUN_ERROR', message: 'turn produced no answer' })
          sseFrame(res, {
            type: 'TEXT_MESSAGE_CONTENT',
            delta:
              'I ran several actions but could not compose a final written answer here. Ask me to summarize what I did and I will.'
          })
          sseFrame(res, { type: 'TEXT_MESSAGE_END' })
          sseFrame(res, { type: 'RUN_FINISHED' })
          terminalSent = true
        }
        errored = true
      }
    }
    // Phase 0 deadline terminal path: we aborted on the wall-clock budget (NOT a client
    // disconnect), so the client is still connected and waiting — flush whatever streamed plus
    // a clean terminal frame so it never hangs. This is the deadline's own terminal (finalize +
    // the normal RUN_FINISHED below are gated off once aborted).
    if (deadlineHit && !terminalSent && !res.writableEnded) {
      sseFrame(res, { type: 'RUN_ERROR', message: 'turn exceeded the time budget' })
      if (!acc.trim()) {
        sseFrame(res, {
          type: 'TEXT_MESSAGE_CONTENT',
          delta:
            'This turn hit its time budget before finishing. Ask me to continue and I will pick up from here — or narrow the request so I can answer in one pass.'
        })
      }
      sseFrame(res, { type: 'TEXT_MESSAGE_END' })
      sseFrame(res, { type: 'RUN_FINISHED' })
      terminalSent = true
      errored = true // skip the learn/successTick hooks — we never learn from a cut-off turn
    }
    // The model hit its output cap. The turn is NOT a success: the document stops mid-sentence.
    // Reuse the deadline cut-off sequence (RUN_ERROR → note → TEXT_MESSAGE_END → RUN_FINISHED)
    // rather than inventing a frame type — duin-bridge already renders RUN_ERROR-with-accumulated-
    // text as a kept, persisted, annotated message, and the two Python bench harnesses break on a
    // FIXED tuple of terminal types and would hang forever on an unknown one.
    //
    // errored = true also suppresses the learn/successTick hooks below, on the same reasoning the
    // deadline path already applies: a cut-off answer is not evidence of a good answer, and feeding
    // truncated output into the Learn loop teaches it from a failure it cannot see.
    // The agentic loop ran out of rounds with the model still working. Not a success: the task
    // is unfinished, it just stopped being worked on. `errored = true` is doing two jobs, the
    // same two it does on every other cut path — it emits an honest terminal, and it suppresses
    // learnFromTurn/successTick below so an unfinished turn is not mined for facts or staged for
    // promotion into the moat. Checked before `truncated` only because a turn cannot be both.
    // What this turn cost. Logged unconditionally (it is the only record of turn spend that exists,
    // and it is free), surfaced to the operator only when they configured a ceiling — an unasked-for
    // dollar figure on every reply is noise. `metered` can be 0 on a provider that returns no usage
    // chunk; saying so is better than printing a confident $0.00.
    turnOutcome.answerChars = acc.length
    // Which engine answered, every engine tried, and whether the answer came from a hop — so the
    // journal's TURN_END (and /debug/turns) reads `engine X after Y (reason)` rather than the
    // requested id. `recovered` is true only when the answer came from somewhere other than the
    // first engine; an exhausted chain leaves it false with the whole walk in `engineChain`.
    turnOutcome.engine = errored && !acc ? null : activeModel
    turnOutcome.engineChain = [...engineTried]
    turnOutcome.recovered = !errored && activeModel !== modelId
    turnOutcome.costUsd = Number(turnCost.spentUsd.toFixed(6))
    turnOutcome.meteredCalls = turnCost.metered
    turnOutcome.groundingPath = groundingPath
    if (turnCost.metered > 0) {
      console.log(
        `[agui] turn cost $${turnCost.spentUsd.toFixed(4)} over ${turnCost.metered} model call(s) — ${turnCost.inputTokens} in / ${turnCost.outputTokens} out`
      )
      if (turnBudgetUsd > 0 && !turnAbort.signal.aborted && !res.writableEnded) {
        sseFrame(res, {
          type: 'STEP',
          label: `spend $${turnCost.spentUsd.toFixed(2)} of $${turnBudgetUsd.toFixed(2)}`
        } as never)
      }
    }
    // Repeat-failure halt. Checked BEFORE the round-budget arm: the loop broke early on purpose,
    // so the honest terminal names the stuck call rather than blaming an exhausted budget that was
    // never actually spent. Same `errored = true` contract as every other cut — an honest terminal
    // plus suppression of the learn/promotion hooks, since a wedged turn must not teach the moat.
    if (repeatHalted && !answerComplete && !errored && !terminalSent && !turnAbort.signal.aborted && !res.writableEnded) {
      sseFrame(res, { type: 'TEXT_MESSAGE_CONTENT', delta: `\n\nRoot cause: ${repeatHalted}.` } as never)
      for (const frame of deadlineTerminalFrames('repeat-failure')) sseFrame(res, frame as never)
      terminalSent = true
      errored = true
    }
    if (
      !answerComplete && !truncated && !errored && !terminalSent &&
      !turnAbort.signal.aborted && !res.writableEnded
    ) {
      console.warn(`[local-brain] round budget exhausted after ${roundCap} rounds, ${acc.length} chars`)
      for (const frame of deadlineTerminalFrames('max-rounds')) sseFrame(res, frame as never)
      terminalSent = true
      errored = true
    }
    if (truncated && !errored && !terminalSent && !turnAbort.signal.aborted && !res.writableEnded) {
      // Reasoning is billed against the same cap, so it can be exhausted before the model writes a
      // single character of answer — measured live, not hypothesised. That renders as a blank reply
      // unless it gets its own explanation, so the two cases carry different notes.
      const reason = !acc.trim()
        ? 'output-cap-empty'
        : continuationStop === 'context-full'
          ? 'context-full'
          : 'output-cap'
      for (const frame of deadlineTerminalFrames(reason)) sseFrame(res, frame as never)
      terminalSent = true
      errored = true
    }
    if (!errored && !turnAbort.signal.aborted) {
      sseFrame(res, { type: 'TEXT_MESSAGE_END' })
      sseFrame(res, { type: 'RUN_FINISHED' })
      terminalSent = true
      // F1 — learn from this turn (keyless + key-gated extraction). Ingestion-trust tiering: pass
      // execOk so a de-privileged inbound/channel turn's facts are tagged 'external' (quarantined
      // from grounding) rather than trusted as operator/machine teaching.
      // Bench-gateway turns (hidden catalog models — the LongMemEval harness et al.) must not
      // teach the live operator model, session taste, or recall calibration (QA 2026-08-24, F4).
      if (bench || resolveModel(activeModel)?.hidden === true) {
        console.log(`[local-brain] ${bench ? 'bench-header' : 'hidden bench model'} turn — learning ticks skipped`)
      } else {
        void learnFromTurn(query, acc, execOk)
        successTick(parsed.threadId ?? '', query, acc)
        // WS1 Item 3b: grade the prior turn's recalled kinds by this turn's reaction
        // (endorse/correct) into the recall-efficacy ledger. ON by default (DUIN_RECALL_CAL=0 disables).
        if (recallCalEnabled()) {
          recallEfficacyTick((readSettings().localBrainNotesDir as string) || null, parsed.threadId ?? '', query, acc, execOk)
        }
      }
      // store.reinforce-arm: grade the PRIOR turn's staged claims against THIS reaction; endorse → enqueue for markUseful.
      // INDEPENDENTLY flagged — see the twin site above; this is not nested under recallCalEnabled().
      if (claimReinforceEnabled()) reinforceTick(parsed.threadId ?? '', query, acc, classifyOutcome)
      // WS2′ Phase A (turn-beats) — STORE side: run the cheap LOG-ONLY prediction pass and
      // stage the next-beat for turn N+1 to grade. Gated OFF by default. Fire-and-forget
      // (measurement); keyless/null model → no beat. Never touches the reply/grounding.
      if (turnBeatsEnabled() && !bench) {
        const beatVd = (readSettings().localBrainNotesDir as string) || null
        void turnBeatTick({
          vaultDir: beatVd,
          threadId: parsed.threadId ?? '',
          turnIndex: messages.filter((m) => m.role === 'user').length,
          grounding: buildBeatGrounding(beatVd, messages, query)
        })
      }
      if (!bench) governTick() // an evaluation turn never trips the govern debounce (D3)
      void consolidationTick(query)
      forecastTick()
      projectTick()
    }
    // Belt-and-suspenders: any path that set `errored` mid-loop (e.g. a provider RUN_ERROR)
    // never reaches the RUN_FINISHED above — guarantee the client still unblocks with a
    // terminal frame instead of hanging on an unterminated stream.
    if (!terminalSent && !turnAbort.signal.aborted && !res.writableEnded) {
      sseFrame(res, { type: 'RUN_FINISHED' })
    }
    if (!res.writableEnded) res.end()
  } catch (err) {
    try {
      sseFrame(res, { type: 'RUN_ERROR', message: (err as Error)?.message ?? 'local brain error' })
    } catch {
      // response may already be closed
    }
    res.end()
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer) // never let the watchdog fire post-turn
    if (heartbeatTimer) clearInterval(heartbeatTimer) // stop keep-alive at turn end
    // Seal the journal. This `finally` runs on EVERY exit — including the client-abort path, which
    // is precisely the one that used to lose the whole turn — so the last record always lands.
    // Fire-and-forget: the turn is over and must not wait on disk.
    const journal = journalForRes.get(res)
    if (journal) {
      journalForRes.delete(res)
      void journal.close({ aborted: turnAbort.signal.aborted, ...turnOutcome })
    }
    if (run) {
      // Terminal: wake any reconnect parked on whenDone() so it replays the tail + closes. Keep the
      // ring one grace window longer so a client that dropped just before RUN_FINISHED can still
      // reconnect and replay it, then evict.
      run.done()
      const rid = run.runId
      setTimeout(() => {
        clearGrace(rid)
        dropRun(rid)
      }, TURN_RESUME_GRACE_MS)
    }
  }
}

// POST /state/decision {nodeId, choice, note?} — HTTP parity for the
// brain:recordDecision IPC (curl-debuggable, external-brain symmetry).
// ──────────────────── state-mutation routes ────────────────────
// Relocated to ./brain-state-routes (pure move). The dispatch table below imports them.
import {
  handleDecision,
  handleInsightVerdict,
  handleProjectCreate,
  handleTrackAdd,
  handleTrackAssign,
  handleStreamUpdate,
  handleStreamSync,
  handleWorldUpdate,
  handleFutureAct,
  handlePredictionFeedback,
  handleAnchorDismiss,
  handleTaskBind,
  handleMeetingAction,
  handleMakeDecision,
  handleDecisionMeta,
  handleResolveNode,
  handleTaskAction,
  handleTaskMove,
  handleForecastVerdict,
  handleLogForecast,
  handleLearnCorrection
} from './brain-state-routes'

// ──────────────────── brain-graph adapter + native routes ────────────────────
// Relocated to ./brain-native-routes (+ ./brain-native-routes-2, pure move/split).
// handleRequestNative (below) still calls handleRequestNativeImpl.
import { handleRequestNativeImpl } from './brain-native-routes'
import { messageOf } from '../guarded'
import { envNum } from '../../shared/env-number'
import { withScope, withPhase } from '../main-stall-monitor'
import { admitControlPlaneRequest } from './control-plane-guard'

// M1 — single renderer front. The renderer talks only to this in-process brain
// (:8799). /health + /agui (chat) stay local; the entire vault-state surface
// (/state, /graph) is served natively in-process by handleRequestNative — every
// route is computed here in TS, with no external process behind the front.
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  // Control-plane admission (control-plane-guard.ts). :8799 is localhost-bound; the guard rejects
  // a mutating verb carrying an external http(s) Origin (cross-site write), any request whose Host
  // header is a non-loopback name (DNS rebinding), and — since 2026-08-25 — any mutation or
  // controlled effectful GET that presents neither the per-launch control token (renderer,
  // in-process bridge) nor the stronger exec token (external bridge, bench, via the opt-in
  // exec-token file). /exec/ is exempt from the token+origin rules — it carries its own
  // per-principal bearer auth — but keeps the Host rule (downgraded to a read for admission).
  const admit = admitControlPlaneRequest(
    { method: url.startsWith('/exec/') ? 'GET' : method, url, headers: req.headers },
    { control: brainControlToken, exec: brainExecToken }
  )
  if (!admit.ok) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `blocked: ${admit.reason}` }))
    return
  }
  if (method === 'GET' && url.startsWith('/health')) {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', brain: 'local-front', indexed: indexedCount() }))
    return
  }
  // Executive API family (/exec/*): bearer-authenticated per-principal MCP
  // mount for FOREIGN agents. Self-contained module (dispatch, auth, its own
  // Host/Origin hardening) — the same relocation pattern as brain-state-routes,
  // kept out of the native route chain so route-level auth exists at this seam
  // and the fall-through 404 never swallows it. Async by nature (MCP transport);
  // errors are contained inside handleExecutiveRequest.
  if (url.startsWith('/exec/')) {
    void handleExecutiveRequest(req, res)
    return
  }
  // Every /state + /graph route is served natively in-process — there is no
  // external process to fall back to.
  handleRequestNative(req, res)
}

function handleRequestNative(req: IncomingMessage, res: ServerResponse): void {
  try {
    handleRequestNativeImpl(req, res)
  } catch (err) {
    // STABILITY: a synchronous handler that throws AFTER res.writeHead(200) would
    // otherwise surface as an uncaughtException in the request listener and can
    // crash the main process (the writeHead-before-compute class across the
    // /state/* GET handlers). Contain it here — one failed request, never a crash.
    console.error('[local-brain] native handler threw:', (err as Error)?.message ?? err)
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'internal error' }))
      } else {
        res.end()
      }
    } catch {
      try {
        res.destroy()
      } catch (e) { console.debug('[server] socket already gone:', messageOf(e)) }
    }
  }
}


/**
 * Start the local brain HTTP server and index the configured notes folder.
 * Idempotent: a second call while running is a no-op. The notes dir is read
 * from settings.localBrainNotesDir (absent is fine — empty index).
 */
export async function startLocalBrain(): Promise<void> {
  if (server) return
  // Mint the per-launch execution token before we accept a single request, so the deny-first
  // /agui gate is armed from the first byte (see agui-guard.ts). Two UUIDs = 72 hex chars.
  brainExecToken = `${randomUUID()}-${randomUUID()}`
  brainControlToken = `${randomUUID()}-${randomUUID()}`
  // Publish the per-launch exec token to a locked-down file so an AUTHORIZED local channel bridge
  // (the Feishu agent-bridge, scoped to the operator's own DMs) can send x-duin-exec and act on the
  // operator's behalf. Per-process token → rotates each launch, so the bridge re-reads it per call.
  // The file lives in userData (operator-profile ACLs); on Windows only the operator/admins can read.
  // D1 (2026-08-17) — the legacy full-privilege exec-token file is OPT-IN. The decision and
  // its reasoning live in executive-api/exec-token-file.ts, where they can be TESTED by
  // running them; keeping it inline here meant the only available check was asserting on this
  // file's source text, which is not a check.
  // Turn journals are diagnostics, not an archive — drop anything past the retention window so the
  // directory cannot grow without bound. Fire-and-forget: boot must never wait on it.
  void pruneTurnJournals()
    .then((n) => {
      if (n > 0) console.debug(`[brain] pruned ${n} expired turn journal(s)`)
    })
    .catch(() => {
      /* best-effort */
    })
  {
    const { syncExecTokenFile } = await import('../executive-api/exec-token-file')
    const outcome = syncExecTokenFile(app.getPath('userData'), brainExecToken)
    if (outcome === 'written') {
      console.debug('[brain] exec-token file written (DUIN_EXEC_TOKEN_FILE=1) — legacy full-privilege path is ACTIVE')
    } else if (outcome === 'removed') {
      console.debug('[brain] removed stale exec-token file (DUIN_EXEC_TOKEN_FILE not set)')
    } else if (outcome === 'failed') {
      console.debug('[brain] exec-token file sync failed (channel bridge may not be able to act)')
    }
  }
  // Scope every request for the stall monitor: this HTTP server shares the main
  // thread with window input, so a slow synchronous route IS a UI freeze — the
  // wrap makes each one attributable at /debug/stalls by route path.
  const s = createServer((req, res) =>
    withScope(`http:${(req.url ?? '/').split('?')[0]}`, () => handleRequest(req, res))
  )
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject)
    s.listen(LOCAL_BRAIN_PORT, HOST, () => {
      s.removeListener('error', reject)
      resolve()
    })
  })
  server = s
  console.log(`[local-brain] listening on http://${HOST}:${LOCAL_BRAIN_PORT}`)

  // Index in the background so startup isn't blocked by embedding.
  const notesDir =
    typeof readSettings().localBrainNotesDir === 'string'
      ? (readSettings().localBrainNotesDir as string)
      : null
  // Detect a local Ollama (keyless) so chat + notes-extraction can use it with
  // no API key. Fire-and-forget; resolves in <1s, before the reindex→extract
  // chain below needs it.
  void detectOllama()
    .then((o) => {
      if (o.available) console.log(`[local-brain] Ollama detected: ${o.models.join(', ')}`)
    })
    .catch(() => {})
  void reindex(notesDir)
    .then(async (n) => {
      console.log(`[local-brain] indexed ${n} note file(s)`)
      // Release M11 — the extraction→construction tail below sends vault content to the routed
      // provider (1 extraction + ⌈N/40⌉ construction calls per LAUNCH, R1 C4). Unattended, it
      // runs only with the operator's consent (a key saved after the disclosure, or
      // backgroundAutonomy on) or on a local model; otherwise the vault stays indexed
      // (structural-only) until the operator saves a key or presses Rebuild — both of which
      // call the tail directly and never consult this gate.
      const consent = automaticCloudWorkAllowed()
      if (!consent.ok) {
        console.log(`[local-brain] skipping boot-time extraction/construction — ${consent.reason} (${consent.detail})`)
        return null
      }
      // Key-gated temporal extraction so a notes folder lights up the foresight
      // engines on boot too (no key → no-op → structural-only).
      const enriched = await refreshNotesExtraction()
      if (enriched) console.log('[local-brain] temporal extraction applied')
      // "Build my brain" — auto-construct the knowledge graph from raw prose on
      // boot too (key-gated; no model → no-op → structural-only, as before).
      return buildBrain()
    })
    .then((result) => {
      if (result && result.status === 'built') {
        console.log(`[local-brain] brain constructed: ${result.entities} entities, ${result.edges} edges`)
      }
    })
    .catch((err) => console.warn('[local-brain] initial reindex failed:', (err as Error).message))

  // Live-watch the folder so edits re-index + refresh the Brain graph with no
  // manual "Reindex" (no-op when no folder is set).
  restartNotesWatcher(notesDir)

  // P0 model plane: learn which provider ACCOUNTS answer (health = a completion, not a key check).
  // One 1-token completion per keyed provider, staggered off the boot path, never blocking; the
  // results reach the picker/Status through model:health-changed. Ollama detection above runs
  // first (<1s) so the local runtime is probed as keyed when it is up.
  setTimeout(() => {
    try {
      const n = scheduleBootProbes()
      // Logged for every count, 0 included: "no keyed provider — nothing to probe" is itself the
      // boot fact a keyless install's log has to state (unkeyed providers read `no-key` without a
      // call, so health is still populated).
      console.log(
        `[local-brain] provider health probes scheduled: ${n} keyed provider(s)${n === 0 ? ' — none keyed, nothing to probe' : ''}`
      )
    } catch (err) {
      console.warn('[local-brain] provider health probes not scheduled:', (err as Error)?.message)
    }
  }, 1_500).unref?.()

  // Background-warm the embedder in parallel with the reindex above, so the first real query doesn't pay
  // worker-spawn + model-load as first-turn latency (efficiency: cold.background-warm / grounding.embedder-warm).
  void warmEmbedder().catch(() => {})
}

/** Stop the server. Safe to call when not running. */
export async function stopLocalBrain(): Promise<void> {
  if (!server) return
  const s = server
  server = null
  await new Promise<void>((resolve) => {
    s.close(() => resolve())
  })
  brainExecToken = null
  brainControlToken = null
}

/** Test-only: whether the server is currently listening. */
export function __isLocalBrainRunning(): boolean {
  return server !== null
}
