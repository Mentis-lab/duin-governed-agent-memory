// duin-bridge.ts — drive the chat UI from an external agent/DUIN brain
// (an AG-UI server; the in-process local brain runs at http://127.0.0.1:8799/agui
// and is the default — see resolveBrainUrl/DEFAULT_BRAIN) instead of the built-in
// provider loop.
//
// "Adopt shell, keep brain": this is the whole adapter. It POSTs a turn to the brain,
// consumes its AG-UI SSE, and translates each event into the app's chat:* events via the
// SAME emit signature the rest of the app uses (emitChatEvent). `emit` is injected so the
// core mapping is unit-testable without an Electron BrowserWindow.
//
// The brain endpoint is configurable: pass `brainUrl`, or set the DUIN_BRAIN_URL
// environment variable, otherwise the localhost default below is used. When the brain
// is unreachable, streamFromDuin emits a friendly demo reply instead of crashing so a
// fresh install still produces a coherent assistant turn (see Settings / README for how
// to connect a real brain).

import type { ChatEventMap } from './chat-events'
import { messageOf } from './guarded'
import { stripAnsi } from '../shared/strip-ansi'
import type { ForwardedKey, LanguageChoice, PermissionsMode, ResolvedSkill, VisionContentPart } from '../shared/chat-send-contract'
import { classifyToolResult } from './tool-result-status'
// NOTE: getBrainExecToken is imported LAZILY inside streamFromDuin (see below), NOT at the
// top level. That keeps this module's PURE helpers (mapAndEmit / resolveBrainUrl) importable
// without dragging in the Electron-main server graph (local-brain/server → artifact-sandbox →
// electron `app`, plugin-loader → @electron-toolkit/utils), so they stay unit-testable off
// Electron. The only cost is a cached dynamic import on the first streamed turn.

export type ChatEmit = <K extends keyof ChatEventMap>(
  channel: K,
  payload: ChatEventMap[K],
) => void

export interface DuinStreamResult {
  text: string
  chunks: number
  reasoningChunks: number
  /** The full streamed chain-of-thought, so the caller can persist it on the
   *  assistant message (else it vanishes when the streaming card finalizes). */
  reasoning: string
  ok: boolean
  eventTypes: Record<string, number>
}

export interface DuinStreamOptions {
  emit: ChatEmit
  brainUrl?: string
  threadId?: string
  signal?: AbortSignal
  /**
   * Prior conversation turns (oldest→newest) so the brain has MULTI-TURN context —
   * without this each turn is stateless (the brain only ever saw the latest message +
   * retrieval grounding, so a follow-up like "yes, save it" had no memory of the note
   * it just made). Should already include the current user turn as its last element;
   * when absent, falls back to sending just `prompt` (the old single-turn behavior).
   */
  /**
   * Bounded prior turns. `parts` carries the vision attachments a turn was PERSISTED with, so an
   * image the user shared earlier is still present later in the thread. Absent on every text turn.
   */
  history?: { role: string; content: string; parts?: VisionContentPart[] }[]
  /**
   * Optional GENERATION model for the brain to answer with. The brain still owns
   * grounding/retrieval; this only chooses which LLM powers the final answer.
   * When present it's added to the POST body as `model`; when absent the brain
   * auto-picks (today's behavior), so omitting it is byte-for-byte the old path.
   */
  model?: string
  /**
   * The graph node the chat is scoped to (pinned per conversation). Added to the
   * POST body as `context` so a context-aware brain can ground on the exact note
   * (stable id → content) instead of re-parsing the "About the …" prose label.
   * Absent → body is byte-for-byte the old shape.
   */
  context?: { id: string; label: string; kind: string }
  /**
   * Reasoning effort for the brain's generation model. Added to the POST body as
   * `reasoningEffort`; the brain applies it to its provider call. Absent → the
   * brain/registry applies its own 'low' default (byte-for-byte the old shape).
   */
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max'
  /**
   * User-authored Skills the operator enabled for this turn, RESOLVED from ids to bodies by the
   * caller (ipc/chat.ts) because the skill store is a main-process concern. Added to the POST body
   * as `skills`; the brain injects them as a floor-tier ACTIVE SKILLS block. Absent → body is
   * byte-for-byte the old shape.
   */
  skills?: ResolvedSkill[]
  /**
   * The composer's permissions pill for this turn. Added to the POST body as `permissionsMode`;
   * the brain meets it against the env posture (env is a FLOOR — the pill may only TIGHTEN). Absent
   * → body is byte-for-byte the old shape and the brain uses today's env-only posture.
   */
  permissionsMode?: PermissionsMode
  /**
   * Response language for this turn ('en' | 'zh' | 'ja'). Added to the POST body as `language`; the
   * brain injects a floor-tier directive so the reply is written in it regardless of the notes'
   * language. Absent → body is byte-for-byte the old shape and the brain emits no directive.
   */
  language?: LanguageChoice
  /**
   * The operator's voice/tone preset for this turn, already RESOLVED from its settings id to the
   * directive text (agent-tones.resolveToneDirective) by the caller, because the settings store is a
   * main-process concern and the brain may be an external /agui endpoint. Added to the POST body as
   * `voice`; the brain injects it as a floor-tier <voice> block — the same block the raw:/headless
   * path composes in buildSystemPrompt. Absent/'' → body is byte-for-byte the old shape and the
   * brain emits no block.
   */
  voice?: string
  /**
   * Exec-token OVERRIDE for de-privileged turns. Absent (undefined) → byte-for-byte
   * the old behavior: lazily resolve the per-launch token via getBrainExecToken(),
   * so a trusted renderer turn can authorize gated tools. A CHANNEL / remote turn
   * (Slack/Telegram/etc. — no renderer to mint a token) passes `execToken: null`
   * (or '') so NO valid token is attached → the brain's deny-first gate refuses
   * host-exec / destructive / vault-mutating tools. This is the connectivity
   * SECURITY KEYSTONE: an inbound external message can never carry exec authority.
   */
  execToken?: string | null
  /**
   * Vision image data URLs forwarded to a vision-capable brain/model. Absent
   * (undefined) -> byte-for-byte the old request body (text-only). When present,
   * the bridge attaches them to the last user message in the AG-UI POST body as
   * an OpenAI-style multimodal content array; the brain's buildGroundedMessages
   * reconstructs the image_url parts at the model-call boundary.
   */
  images?: { mimeType: string; dataUrl: string }[]
  /**
   * Composer STEERING hook. Called ONCE, as soon as this turn's runId is minted, with the runId and
   * the resolved brain endpoint — so the caller (ipc/chat.ts) can record them on its ActiveRun entry
   * and later fire a steer beacon (steerBrain) at the FOREGROUND streaming run. Absent → no steering
   * wiring, byte-for-byte the old path. The beacon only lands if the brain has resume on (it creates
   * the named run); otherwise the beacon is rejected and the client enqueues a durable new turn.
   */
  onRunId?: (info: { runId: string; brainUrl: string }) => void
}

/**
 * Composer STEERING: fire a steer beacon at a RUNNING brain turn — a lightweight `{steer, runId,
 * steerId?}` POST mirroring fireStopBeacon. The brain injects the text into the named run's inbox
 * (drained at its next round seam) and answers `{ok, accepted}`: accepted:false when the run is
 * absent/terminal (or resume is off), so the caller can fall back to a durable new turn. Best-effort
 * on transport failure → treated as not-accepted. `brainUrl` should be the resolved endpoint.
 */
export async function steerBrain(
  brainUrl: string,
  runId: string,
  text: string,
  steerId?: string
): Promise<{ ok: boolean; accepted: boolean }> {
  try {
    const res = await fetch(resolveBrainUrl(brainUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, steer: text, ...(steerId ? { steerId } : {}) })
    })
    if (!res.ok) return { ok: false, accepted: false }
    const j = (await res.json().catch(() => null)) as { ok?: boolean; accepted?: boolean } | null
    return { ok: !!j?.ok, accepted: !!j?.accepted }
  } catch {
    return { ok: false, accepted: false }
  }
}

/**
 * PURE: build the /agui POST body. Extracted from the fetch so the transport contract is
 * TESTABLE — chat-send-contract.test.ts asserts that every field the contract calls 'forwarded'
 * actually lands on this body, which is what makes "forwarded" a checked claim rather than a
 * comment. Behaviour is byte-identical to the inline literal it replaced.
 */
export function buildAguiBody(
  opts: Pick<
    DuinStreamOptions,
    'history' | 'model' | 'context' | 'reasoningEffort' | 'skills' | 'images' | 'permissionsMode' | 'language' | 'voice'
  >,
  wire: { threadId: string; runId: string; prompt: string; isReconnect?: boolean }
): Record<string, unknown> {
  // Build the messages array. When vision images are present, attach them
  // to the LAST user message as a multimodal content array (OpenAI format:
  // [{type:'text',text}, {type:'image_url',image_url:{url:'data:...'}}]).
  // Absent images → messages are plain {role, content:string}, byte-for-byte
  // the old shape.
  const messages: { role: string; content: unknown }[] =
    opts.history && opts.history.length ? opts.history.map((m) => ({ role: m.role, content: m.content })) : [{ role: 'user', content: wire.prompt }]

  const toMultimodal = (text: unknown, urls: string[]): unknown[] => [
    { type: 'text', text: typeof text === 'string' ? text : String(text ?? '') },
    ...urls.map((url) => ({ type: 'image_url', image_url: { url } }))
  ]

  // PERSISTED images first: a history turn carries the attachments it was saved
  // with, so an image stays visible on later turns instead of existing only for
  // the turn it arrived on.
  //
  // Track whether THE LAST USER MESSAGE specifically got images, not whether any
  // message did — that is the only message the live-image branch below would
  // rewrite. A global flag conflates them: an older turn carrying an image would
  // suppress a NEW image on this turn (e.g. when the current row's parts failed to
  // load and were dropped as corrupt), showing the model the stale picture instead
  // of the one the user just attached.
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      lastUserIdx = i
      break
    }
  }
  let lastUserGotImages = false
  if (opts.history && opts.history.length) {
    for (let i = 0; i < messages.length; i++) {
      const parts = opts.history[i]?.parts
      if (parts?.length) {
        messages[i].content = toMultimodal(messages[i].content, parts.map((p) => p.image_url.url))
        if (i === lastUserIdx) lastUserGotImages = true
      }
    }
  }

  // LIVE images for this turn. Skipped when history already supplied them —
  // ipc/chat.ts persists the user row (with its parts) BEFORE building history,
  // so on the default path this turn's images arrive via history and adding
  // `opts.images` too would send every attachment twice. This branch remains for
  // callers that stream without persisting first.
  const imgs = !lastUserGotImages && opts.images && opts.images.length ? opts.images : null
  if (imgs && lastUserIdx >= 0) {
    messages[lastUserIdx].content = toMultimodal(
      messages[lastUserIdx].content,
      imgs.map((im) => im.dataUrl)
    )
  }
  return {
    threadId: wire.threadId,
    messages,
    runId: wire.runId,
    ...(wire.isReconnect ? { resume: true } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.context ? { context: opts.context } : {}),
    ...(opts.reasoningEffort ? { reasoningEffort: opts.reasoningEffort } : {}),
    ...(opts.skills && opts.skills.length ? { skills: opts.skills } : {}),
    ...(opts.permissionsMode ? { permissionsMode: opts.permissionsMode } : {}),
    ...(opts.language ? { language: opts.language } : {}),
    ...(opts.voice ? { voice: opts.voice } : {})
  }
}

// Compile-time bridge between the request contract and this transport: every key the contract
// marks 'forwarded' must exist as a field on DuinStreamOptions. Delete a field here without
// updating the contract and this fails typecheck instead of silently dropping the value.
type _AssertForwardedReachTransport = ForwardedKey extends keyof DuinStreamOptions ? true : never
const _forwardedKeysReachTransport: _AssertForwardedReachTransport = true
void _forwardedKeysReachTransport

// The DEFAULT brain is now the in-process LOCAL brain (electron/services/
// local-brain/server.ts) on :8799, so a fresh install is useful with NO
// external server. An explicit brainUrl (Settings → Brain) or DUIN_BRAIN_URL
// still wins — see resolveBrainUrl.
import { LOCAL_BRAIN_ORIGIN } from '../shared/brain-port'
const DEFAULT_BRAIN = `${LOCAL_BRAIN_ORIGIN}/agui`

// Hang guard: cap how much text we'll accumulate from a single stream. A
// runaway / misbehaving brain that never emits RUN_FINISHED would otherwise
// stream forever and pin memory. 5M chars is far beyond any real assistant turn.
const MAX_STREAM_CHARS = 5_000_000

/** R8/Phase-2 — the absolute no-progress ceiling (ms) that bounds reconnect churn on a parked run.
 *  Env DUIN_BRIDGE_TURN_CEILING_MS; default 240000; 0/negative disables it (unbounded reconnects,
 *  the pre-fix behaviour). Pure + exported so the budget logic is unit-testable off the network path.
 *
 *  The 240000 was originally derived as "server 180s deadline + a reconnect/replay grace window".
 *  That derivation is DEAD: the server's absolute deadline was removed (turn-watchdog `maxMs`
 *  defaults to 0, deliberately — long multi-agent turns are legitimate). Corrected 2026-08-02 so
 *  nobody re-derives from a ceiling that no longer exists. The number still holds on its own terms,
 *  and the two sides do not conflict, because BOTH are no-progress budgets rather than wall-clock
 *  caps and the server's stall cut (90s) is the tighter of the two — it fires first, so this stays
 *  the reconnect backstop it says it is. A genuinely productive long turn is cut by neither. */
export function bridgeTurnCeilingMs(): number {
  const raw = Number(process.env.DUIN_BRIDGE_TURN_CEILING_MS)
  return Number.isFinite(raw) && process.env.DUIN_BRIDGE_TURN_CEILING_MS != null && process.env.DUIN_BRIDGE_TURN_CEILING_MS !== ''
    ? raw
    : 240_000
}

/** R8/Phase-2 — has a parked (non-advancing) run exhausted the single absolute ceiling? `true` once
 *  the time since the last committed frame (`msSinceProgress`) exceeds `ceilingMs`. A ceiling <= 0
 *  disables the budget (never exhausts). A reconnect that DID advance frames resets msSinceProgress
 *  upstream, so a genuinely productive long turn is never cut here — only a stalled one. */
export function bridgeReconnectExhausted(msSinceProgress: number, ceilingMs: number): boolean {
  if (ceilingMs <= 0) return false
  return msSinceProgress > ceilingMs
}

// Legacy stub-engine port (:8765) — a retired external engine only ever served a
// stub echo ("You said: …") on /agui, never a real model stream. Chat must never
// resolve there, so any stale :8765 target is coerced back to the in-process brain.
const STUB_SIDECAR_PORT = '8765'

/** Resolve the brain endpoint: explicit option > DUIN_BRAIN_URL env var > localhost default. */
export function resolveBrainUrl(explicit?: string): string {
  const fromEnv =
    typeof process !== 'undefined' ? process.env?.DUIN_BRAIN_URL?.trim() : undefined
  let url = explicit?.trim() || (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BRAIN)
  // Hard guard against the stub footgun: a stale DUIN_BRAIN_URL / old deploy env /
  // mis-set Brain setting pointing chat at the legacy :8765 stub engine would
  // silently route every turn to the stub echo. It never served real chat, so
  // coerce any :8765 target back to the in-process TS brain (:8799).
  try {
    if (new URL(url).port === STUB_SIDECAR_PORT) url = DEFAULT_BRAIN
  } catch (e) { console.debug('[duin-bridge] non-URL string  leave as-is for the caller to handle:', messageOf(e)) }
  return url
}

/** Is this brain endpoint the local machine?
 *
 *  `x-duin-exec` is the per-launch host-exec token — the single thing separating
 *  "chat can read notes" from "chat can run shell commands, delete files, send
 *  email". Its send site is annotated "local brain only", but nothing enforced
 *  that: Settings > Brain is an onboarding-guided, named feature, and pointing it
 *  at any non-default endpoint put the real exec authority on the wire, in
 *  plaintext, on every turn, with no indication anywhere.
 *
 *  Loopback-only, matching the brain server's own ingress check
 *  (executive-api/exec-endpoint.ts hostAllowed/originAllowed). Unparseable ⇒ false:
 *  a URL we cannot reason about does not get the token. PURE. */
export function isLoopbackBrainUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const h = parsed.hostname.toLowerCase()
    if (h === 'localhost' || h === '::1' || h === '[::1]') return true
    // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
    return /^127[.][0-9]{1,3}[.][0-9]{1,3}[.][0-9]{1,3}$/.test(h)
  } catch {
    return false
  }
}

/** One AG-UI SSE frame, decoded. Fields are camelCase per the brain's wire format. */
interface AguiEvent {
  type?: string
  delta?: string
  label?: string
  text?: string
  message?: string
  error?: string
  // Tool-call frames (emitted by the local brain for notes retrieval so the
  // chat UI renders a tool card). See mapAndEmit below.
  toolCallId?: string
  toolName?: string
  args?: Record<string, unknown>
  result?: string
  // ARTIFACT frame — the brain validated + wants the app to render an artifact.
  artifactType?: string
  source?: string
  title?: string
}

/** U6 — the marker a turn the user stopped carries. The raw provider path has always
 *  persisted a cancelled turn (registry.ts writes a `[cancelled]` marker); the brain path
 *  discarded it. Both paths now keep the partial answer and say why it is partial. */
export const STOPPED_BY_USER_NOTE = '\n\n_(stopped by you)_'

/** The single place a KEPT-but-incomplete turn becomes a terminal chat:done. Used by both
 *  the RUN_ERROR/interrupted branch and the Stop/abort path so the two agree on shape:
 *  one message, carrying the annotated text and the streamed reasoning. */
function emitKeptPartial(
  conversationId: string,
  content: string,
  reasoning: string,
  emit: ChatEmit
): void {
  emit('chat:done', {
    conversationId,
    message: {
      id: `duin-${Date.now()}`,
      conversationId,
      role: 'assistant' as const,
      content,
      reasoning: reasoning || undefined,
      createdAt: Date.now()
    }
  })
}

/**
 * Outcomes:
 *   'done'         a terminal arrived; the CALLER still has to emit chat:done.
 *   'done-emitted' a terminal arrived AND this function already emitted the chat:done
 *                  (the kept-partial branch). U7: this used to also return 'done', so the
 *                  caller emitted a SECOND chat:done — un-annotated, and carrying the same
 *                  `duin-${Date.now()}` id minted in the same synchronous call. The visible
 *                  bubble was the duplicate WITHOUT the interruption note.
 *   'error'        terminal error already emitted.
 *   null           not a terminal frame.
 */
export function mapAndEmit(
  ev: AguiEvent,
  conversationId: string,
  emit: ChatEmit,
  acc: {
    text: string
    chunks: number
    reasoning: number
    reasoningText: string
    toolStarts: Map<string, number>
  },
): 'done' | 'done-emitted' | 'error' | null {
  switch (ev.type) {
    case 'TOOL_CALL_START': {
      // The brain ran a tool (e.g. notes retrieval). Render a tool card.
      // Match ChatToolCallPayload exactly (electron/services/chat-events.ts).
      const callId = ev.toolCallId ?? `local-${Date.now()}`
      const toolName = ev.toolName ?? 'tool'
      const startedAt = Date.now()
      acc.toolStarts.set(callId, startedAt)
      emit('chat:tool-call', {
        callId,
        conversationId,
        serverId: 'local-brain',
        toolName,
        title: toolName,
        // The AG-UI frame carries no risk metadata (see AguiFrame above), so there is
        // nothing to populate this from on the brain path without a wire-format change.
        // Empty is honest here; the misleading half of this card was the RESULT status
        // below, which claimed success for refusals.
        risks: [],
        providerKind: 'native',
        startedAt,
        args: ev.args ?? {},
      })
      return null
    }
    case 'TOOL_CALL_END': {
      // Match ChatToolCallResultPayload exactly.
      const callId = ev.toolCallId ?? `local-${Date.now()}`
      const startedAt = acc.toolStarts.get(callId)
      const duration = startedAt ? Date.now() - startedAt : 0
      acc.toolStarts.delete(callId)
      // Classify the result instead of asserting success. This branch hardcoded
      // 'success', so every refusal from the deny-first execution gate — run_command,
      // delete_file, send_email — rendered as a green checkmark, collapsed. An operator
      // scanning the transcript would reasonably read that as DUIN having done the thing
      // it actually refused. Uses the SAME classifier as the native path
      // (ipc/chat.ts resolveToolCall) so the two surfaces cannot disagree about what a
      // given result string means.
      const resultText = ev.result ?? ''
      const audit = classifyToolResult(resultText)
      emit('chat:tool-call-result', {
        callId,
        conversationId,
        result: resultText,
        duration,
        status: audit === 'done' ? 'success' : audit,
      })
      return null
    }
    case 'TEXT_MESSAGE_CONTENT': {
      const content = ev.delta ?? ''
      acc.text += content
      acc.chunks += 1
      emit('chat:chunk', { conversationId, content })
      return null
    }
    case 'TEXT_MESSAGE_RESET': {
      // The brain discarded the answer body it streamed so far (tool-call preamble)
      // and is about to re-stream clean prose. Zero our accumulator so emitDone
      // persists ONLY the post-reset prose, and tell the renderer to clear its
      // visible streaming buffer. Reasoning + tool cards are intentionally kept.
      acc.text = ''
      acc.chunks = 0
      emit('chat:reset', { conversationId })
      return null
    }
    case 'STEP': {
      // A STEP is an OPERATOR-FACING STATUS LINE — the long-turn heartbeat, the
      // retrieval trace, the engine-fallback notice — not model thinking. It streams
      // to the reasoning panel so a long turn stays legible, but it must NOT be
      // accumulated into acc.reasoningText, because that string is persisted to
      // `messages.reasoning` and then replayed into the NEXT turn's context as
      // <think>…</think> (see chat-history.ts, setting `includePastReasoningInContext`,
      // default on).
      //
      // Concatenating the two was actively harmful, not merely untidy. The watchdog
      // polls on a 5s interval, so a heartbeat lands whenever it happens to fire —
      // including BETWEEN two REASONING token frames, which splices it mid-token:
      //
      //   …docs live (I saw DUstill working — round 2/32 · 105s elapsedIN_SHIP_BACKLOG.md…
      //
      // The model read that back as its own chain-of-thought, found it interleaved
      // with garbage and ending on a heartbeat, and concluded it had been cut off
      // mid-write — opening the next turn apologising for a truncation that never
      // happened (real session, 2026-08-05). Status is ephemeral; thinking is the
      // record. Keeping them in one string corrupts the record and lies to the model.
      //
      // ANSI is still stripped at ingest, for the reason it always was: STEP labels
      // are assembled from tool / retrieval / subprocess output, and the reasoning
      // card renders markdown rather than a terminal, so an unstripped `ESC[1m`
      // surfaced in the DOM as a literal "1m".
      //
      // The newlines keep a status line on its own row in the live panel, so it can
      // never appear to interrupt a word even while the model is mid-sentence.
      const content = stripAnsi(ev.delta ?? ev.label ?? ev.text ?? '')
      if (content) emit('chat:reasoning', { conversationId, content: `\n${content}\n` })
      return null
    }
    case 'THINKING':
    case 'REASONING':
    case 'TEXT_MESSAGE_THINKING': {
      // Model chain-of-thought. This is the only thing that reaches
      // `messages.reasoning`, and through it the next turn's <think> context.
      const content = stripAnsi(ev.delta ?? ev.label ?? ev.text ?? '')
      if (content) {
        acc.reasoning += 1
        acc.reasoningText += content
        emit('chat:reasoning', { conversationId, content })
      }
      return null
    }
    case 'ARTIFACT': {
      // The brain rendered + validated an artifact; open it in the artifact panel.
      const artifactType = ev.artifactType ?? 'html'
      const source = ev.source ?? ''
      if (source) {
        emit('chat:artifact', { conversationId, artifactType, source, title: ev.title })
      }
      return null
    }
    case 'RUN_FINISHED':
      return 'done'
    case 'RUN_ERROR':
    case 'ERROR': {
      // A terminated turn — the 180s deadline emits RUN_ERROR, a stalled
      // reconnect, etc. — must NOT discard what the model already streamed.
      // Discarding it is why a long turn's rendered response "disappears" the
      // instant it hits the deadline. If any answer text accumulated, finalize
      // it as a KEPT + persisted done message (with an interrupted note + the
      // reasoning), so the user keeps their work; only surface a hard error
      // when the turn produced nothing at all.
      if (acc.text.trim().length > 0) {
        const why = ev.message ?? ev.error ?? 'the turn was cut short'
        // Annotate the ACCUMULATOR, not just the emitted copy: streamFromDuin returns
        // acc.text and ipc/chat.ts persists exactly that, so annotating only the emitted
        // message left the stored row un-annotated — the reloaded transcript disagreed
        // with the bubble and showed a truncated answer as if it were complete.
        acc.text = `${acc.text}\n\n_(interrupted — ${why})_`
        emitKeptPartial(conversationId, acc.text, acc.reasoningText, emit)
        return 'done-emitted'
      }
      emit('chat:error', { conversationId, error: ev.message ?? ev.error ?? 'DUIN run error' })
      return 'error'
    }
    default:
      // RUN_STARTED / TEXT_MESSAGE_START / TEXT_MESSAGE_END — lifecycle, no chat:* peer.
      return null
  }
}

/**
 * Stream one turn from the DUIN brain into lamprey's chat:* event bus.
 * Returns when RUN_FINISHED / RUN_ERROR arrives or the stream ends.
 */
export async function streamFromDuin(
  prompt: string,
  conversationId: string,
  opts: DuinStreamOptions,
): Promise<DuinStreamResult> {
  const brainUrl = resolveBrainUrl(opts.brainUrl)
  const threadId = opts.threadId ?? conversationId
  const acc = { text: '', chunks: 0, reasoning: 0, reasoningText: '', toolStarts: new Map<string, number>() }
  const eventTypes: Record<string, number> = {}
  let ok = false

  // Resolve the per-launch exec token via a LAZY import of the Electron-main server module
  // (see the import note at the top of this file). Fail-safe: if the module can't load (e.g.
  // a non-Electron env), the token is empty → the brain's deny-first gate refuses host-exec /
  // destructive tools, exactly as when no token is minted. Cached after the first call.
  let execToken = ''
  if (opts.execToken !== undefined) {
    // Explicit override wins (de-privileged channel turn passes null/'' → empty
    // header → deny-first gate refuses gated tools). Skips the server import entirely.
    execToken = opts.execToken ?? ''
  } else {
    try {
      execToken = (await import('./local-brain/server')).getBrainExecToken() ?? ''
    } catch (e) { console.debug('[duin-bridge] server graph unavailable  empty token  deny-first gate refuses host-exec:', messageOf(e)) }
  }

  let controlToken = ''
  try {
    controlToken = (await import('./local-brain/server')).getBrainControlToken() ?? ''
  } catch (e) {
    console.debug('[duin-bridge] server control token unavailable:', messageOf(e))
  }

  // The exec token authorizes host-exec and destructive tools. It travels ONLY to a
  // brain on this machine — see isLoopbackBrainUrl. Withholding is announced rather
  // than silent: the operator pointed Settings > Brain somewhere, and the reason
  // their gated tools now refuse should be findable.
  const execTokenTravels = isLoopbackBrainUrl(brainUrl)
  if (execToken && !execTokenTravels) {
    console.warn(
      `[duin-bridge] brain endpoint ${brainUrl} is not loopback  withholding x-duin-exec. ` +
        'Host-exec and destructive tools will be refused by the remote brain.'
    )
  }

  // Resumable-stream state. We name this turn with a runId and, if the brain echoes it back on
  // RUN_STARTED (i.e. DUIN_TURN_RESUME is on), a mid-stream socket drop RECONNECTS with resume:true +
  // Last-Event-ID to replay the missed frames instead of losing the turn. When the brain does NOT
  // echo a runId (resume off), we never reconnect — behavior is identical to before.
  const runId = `duin-${threadId}-${Date.now()}`
  // Report the runId + resolved endpoint to the caller so a foreground steer beacon can target THIS
  // turn. Fired once, up-front (best-effort): even if the brain has resume off, the caller can still
  // attempt a steer — the beacon simply rejects and the client enqueues a durable new turn instead.
  try {
    opts.onRunId?.({ runId, brainUrl })
  } catch (e) { console.debug('[duin-bridge] onRunId hook threw (non-fatal):', messageOf(e)) }
  let lastEventId = 0
  let serverResumable = false
  let emittedTerminal = false // did we emit any terminal event (done/error/abort/cap)?
  let received = 0
  const MAX_RECONNECTS = 4
  // R8/Phase-2 — ONE absolute no-progress ceiling across ALL reconnects. Before this, every
  // reconnect re-armed a fresh `inactivityMs` idle window, so a run that PARKED without advancing
  // (server wedged past its own deadline, only heartbeats keeping the socket warm) could churn
  // MAX_RECONNECTS × inactivityMs (~5 min) before giving up. `lastProgressAt` advances ONLY when a
  // new frame commits (heartbeats and replayed-but-already-seen frames do not), so a reconnect that
  // receives ZERO new frames counts against this single ceiling instead of resetting the clock.
  // Env DUIN_BRIDGE_TURN_CEILING_MS (default 240000 = the 180s server deadline + a reconnect/replay
  // grace window); 0/negative disables (unbounded — the pre-fix behaviour).
  let lastProgressAt = Date.now()
  const turnCeilingMs = bridgeTurnCeilingMs()

  // Inactivity watchdog — the default brain path had NONE (unlike the raw provider path), so an
  // external AG-UI brain that accepts the POST then wedges without sending frames or closing the
  // socket blocks reader.read() forever, leaking the turn. Reuse the SAME knob as the raw path so
  // both share one setting (settings.json streamInactivityMs; 60s default; 0 disables). Lazy import
  // keeps this module's pure helpers importable off the Electron-main graph (see the top note).
  let inactivityMs = 60_000
  try {
    inactivityMs = (await import('./providers/registry')).readStreamInactivityMs()
  } catch (e) { console.debug('[duin-bridge] registry unavailable — default inactivity 60s:', messageOf(e)) }
  let stalled = false // last read loop exit was an inactivity trip (drives the finalize message)

  // Stop beacon: a deliberate Stop must abort the turn NOW, not leave the brain grace-waiting a
  // reconnect. On abort we fire a lightweight {abort, runId} POST (only useful once the brain has
  // shown it's resume-capable). Fire-once + fire-and-forget.
  let beaconSent = false
  const fireStopBeacon = (): void => {
    if (beaconSent || !serverResumable) return
    beaconSent = true
    void fetch(brainUrl, {
      method: 'POST',
      // Never forward local control authority across an HTTP redirect. The
      // initial URL is loopback-checked, but a 30x target may not be.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        ...(execTokenTravels && controlToken ? { 'x-duin-control': controlToken } : {})
      },
      body: JSON.stringify({ runId, abort: true })
    }).catch(() => {})
  }
  opts.signal?.addEventListener?.('abort', fireStopBeacon, { once: true })

  // U6 — what Stop means on the DEFAULT (brain) path. Every abort site used to emit a bare
  // chat:error and set emittedTerminal, which skips the finalize block below; ok stayed false
  // so ipc/chat.ts never saved the row, and the renderer's resetStreaming clears
  // streamingContent the same tick — so the partial answer was gone and unrecoverable. The raw
  // provider path has always persisted a cancelled turn (a `[cancelled]` marker in
  // providers/registry.ts), so the two paths disagreed about what Stop means.
  //
  // Now: keep whatever the model already streamed, mark it, and report ok so it is PERSISTED.
  // With nothing streamed there is nothing to keep, so a plain error is still the honest
  // terminal (the renderer needs one either way to release the composer).
  const finalizeAborted = (): void => {
    if (emittedTerminal) return
    emittedTerminal = true
    if (acc.text.trim().length > 0) {
      acc.text = `${acc.text}${STOPPED_BY_USER_NOTE}`
      ok = acc.chunks > 0
      emitKeptPartial(conversationId, acc.text, acc.reasoningText, opts.emit)
      return
    }
    opts.emit('chat:error', { conversationId, error: 'DUIN run aborted' })
  }

  // Process one SSE line. `id:` is held as PENDING and only committed to lastEventId once its
  // matching `data:` frame is actually dispatched — so a socket split between the id line and its
  // data line can't advance lastEventId past a frame we never processed (which a reconnect's
  // replayAfter would then skip, losing content).
  let pendingId = 0
  const handleLine = (line: string): boolean => {
    if (line.startsWith('id:')) {
      const n = Number(line.slice(3).trim())
      if (Number.isFinite(n)) pendingId = n
      return false
    }
    if (!line.startsWith('data:')) return false
    let ev: AguiEvent
    try {
      ev = JSON.parse(line.slice(5).trim()) as AguiEvent
    } catch {
      return false
    }
    if (pendingId > lastEventId) {
      lastEventId = pendingId // commit the id WITH its data frame
      lastProgressAt = Date.now() // R8: a NEW frame = real progress → resets the no-progress ceiling
    }
    if (ev.type) eventTypes[ev.type] = (eventTypes[ev.type] ?? 0) + 1
    // The brain only sets runId on RUN_STARTED when resume is enabled → our signal it's safe to
    // reconnect (a reconnect to a non-resume brain would start a duplicate fresh turn).
    if (ev.type === 'RUN_STARTED' && typeof (ev as { runId?: unknown }).runId === 'string') serverResumable = true
    const outcome = mapAndEmit(ev, conversationId, opts.emit, acc)
    if (outcome === 'done' || outcome === 'done-emitted') {
      ok = acc.chunks > 0 && acc.text.trim().length > 0
      // 'done-emitted' means mapAndEmit ALREADY emitted the terminal chat:done
      // (the kept-partial branch). Emitting again here is U7: two bubbles with
      // one id, the visible one lacking the interruption note.
      if (outcome === 'done') emitDone(conversationId, acc.text, opts.emit)
      emittedTerminal = true
      return true
    }
    if (outcome === 'error') {
      emittedTerminal = true
      return true
    }
    return false
  }

  for (let attempt = 0; attempt <= MAX_RECONNECTS && !emittedTerminal; attempt++) {
    if (opts.signal?.aborted) {
      finalizeAborted()
      break
    }
    const isReconnect = attempt > 0
    // R8/Phase-2 — before spending another reconnect on a parked run, enforce the single absolute
    // no-progress ceiling. A reconnect that made no progress leaves `lastProgressAt` stale; once the
    // gap exceeds the ceiling we stop reconnecting and fall through to finalize (persist any text,
    // else a clean stalled error) instead of re-arming yet another fresh idle window.
    if (isReconnect && bridgeReconnectExhausted(Date.now() - lastProgressAt, turnCeilingMs)) {
      stalled = true
      break
    }
    let res: Response
    try {
      res = await fetch(brainUrl, {
        method: 'POST',
        // Credentials below are valid only for the checked loopback endpoint.
        // Reject redirects so fetch cannot replay them to another host.
        redirect: 'error',
        // Authorize host-exec / destructive tools through the deny-first gate (local brain only).
        // On a reconnect, Last-Event-ID tells the brain which buffered frames we still need.
        headers: {
          'Content-Type': 'application/json',
          // Loopback only. A remote brain gets NO exec authority — it still serves the
          // turn, the brain simply sees an unauthorized request and refuses host-exec
          // and destructive tools, which is the correct posture for an endpoint that is
          // not this machine.
          ...(execTokenTravels ? { 'x-duin-exec': execToken } : {}),
          ...(execTokenTravels && controlToken ? { 'x-duin-control': controlToken } : {}),
          ...(isReconnect && lastEventId > 0 ? { 'Last-Event-ID': String(lastEventId) } : {})
        },
        body: JSON.stringify(buildAguiBody(opts, { threadId, runId, prompt, isReconnect })),
        signal: opts.signal
      })
    } catch (err) {
      if (opts.signal?.aborted) {
        fireStopBeacon()
        finalizeAborted()
        break
      }
      void err
      if (attempt === 0) {
        // First contact failed → brain unreachable → friendly demo reply (fresh-install path).
        return emitDemoReply(conversationId, brainUrl, opts.emit, eventTypes, opts.signal)
      }
      await new Promise((r) => setTimeout(r, 400)) // reconnect fetch failed → brief backoff, retry
      continue
    }
    if (!res.ok || !res.body) {
      if (attempt === 0) {
        opts.emit('chat:error', { conversationId, error: `DUIN brain HTTP ${res.status}` })
        return { text: '', chunks: 0, reasoningChunks: 0, reasoning: '', ok: false, eventTypes }
      }
      await new Promise((r) => setTimeout(r, 400))
      continue
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    let finished = false
    // Per-read inactivity timer: armed before each read, cleared when it returns. On fire we cancel
    // the reader so the pending read() unblocks (resolves done OR rejects — both handled below), then
    // route through the existing reconnect (resumable brain) / finalize (else) path. User Stop still
    // wins: opts.signal aborts the fetch and is checked at the loop top + in the read catch.
    let inactivityFired = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const clearIdle = (): void => { if (idleTimer) { clearTimeout(idleTimer); idleTimer = null } }
    const armIdle = (): void => {
      clearIdle()
      if (inactivityMs <= 0) return
      idleTimer = setTimeout(() => {
        inactivityFired = true
        void reader.cancel().catch(() => {})
      }, inactivityMs)
    }
    try {
      while (!finished) {
        if (opts.signal?.aborted) {
          finalizeAborted()
          break
        }
        armIdle()
        let readResult: ReadableStreamReadResult<Uint8Array>
        try {
          readResult = await reader.read()
        } catch (readErr) {
          clearIdle()
          void readErr
          if (opts.signal?.aborted) {
            finalizeAborted()
          } else if (inactivityFired) {
            stalled = true
          }
          break
        }
        clearIdle()
        const { done, value } = readResult
        if (done) {
          if (inactivityFired) stalled = true
          break
        }
        const text = decoder.decode(value, { stream: true })
        received += text.length
        buf += text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (handleLine(line)) {
            finished = true
            break
          }
        }
        if (!finished && received > MAX_STREAM_CHARS) {
          // KEEP THE ANSWER. This used to emit a bare chat:error and set emittedTerminal, which
          // skipped the finalize block below — so `ok` stayed false, ipc/chat.ts's `if (r.ok…)`
          // persistence gate never ran, and a multi-megabyte document the model had just spent
          // minutes writing was discarded in full. The guard exists to bound memory on a runaway
          // brain, which is served by stopping the read; destroying the work was never part of it.
          // Now the accumulated text is annotated and kept, exactly as the RUN_ERROR path does.
          // Annotate the ACCUMULATOR, not just the emitted copy — see the note at the RUN_ERROR
          // branch: this function returns acc.text and that is what gets persisted/returned. The
          // hole was invisible because the emitted bubble looked right; only the stored row and
          // the channel reply (which never see the emitted copy) carried the un-marked text.
          acc.text = `${acc.text}\n\n_(interrupted — the reply exceeded this session's ${MAX_STREAM_CHARS}-character stream limit)_`
          emitKeptPartial(conversationId, acc.text, acc.reasoningText, opts.emit)
          ok = acc.chunks > 0
          emittedTerminal = true
          break
        }
      }
      // Final-frame drain: process a trailing frame with no closing newline (often RUN_FINISHED).
      if (!finished && !emittedTerminal) {
        buf += decoder.decode()
        const tail = buf.trim()
        if (tail) for (const l of tail.split('\n')) handleLine(l.trim())
      }
    } finally {
      clearIdle()
      void reader.cancel().catch(() => {})
    }

    // Turn done, aborted, or the brain doesn't support resume → stop. Otherwise the socket dropped
    // mid-turn on a resumable brain → loop to reconnect (a short backoff; the turn is held server-
    // side for a 30s grace window and its frames keep buffering).
    if (emittedTerminal || opts.signal?.aborted || !serverResumable) break
    await new Promise((r) => setTimeout(r, 300))
  }

  // No terminal frame after exhausting reconnects (brain crash / persistent drop): finalize so the
  // turn isn't left hanging — persist accumulated text, else error out.
  if (!emittedTerminal) {
    if (acc.text.trim().length > 0) {
      ok = acc.chunks > 0
      // Say that it stopped early. This is the reconnect-ceiling / inactivity / brain-crash exit,
      // and it was the ONE incompleteness path that forgot to annotate — its two siblings mark
      // theirs (`_(interrupted — …)_` on RUN_ERROR, `_(stopped by you)_` on Stop). Unannotated,
      // an answer that simply ends mid-sentence reaches the operator — on the phone, via a
      // channel — reading as a finished reply. `stalled` was already in scope, used only to pick
      // an error string in the no-text branch four lines down.
      //
      // The annotation goes on the ACCUMULATOR, not just the emitted copy (same reason as the
      // RUN_ERROR branch above): `return { text: acc.text }` is what ipc/chat.ts persists and what
      // channel-runtime.ts sends to Slack/Telegram. Annotating only emitKeptPartial's argument
      // fixed the bubble and left both of those un-marked — which is exactly the phone-reads-as-
      // finished case this annotation exists to prevent, and it was invisible because the one
      // surface a developer looks at (the live bubble) was the one surface that was correct.
      acc.text = `${acc.text}\n\n_(interrupted — ${
        stalled
          ? `no response from the DUIN brain for ${Math.round(inactivityMs / 1000)}s`
          : 'the connection to the DUIN brain ended before the turn finished'
      })_`
      emitKeptPartial(conversationId, acc.text, acc.reasoningText, opts.emit)
    } else {
      opts.emit('chat:error', {
        conversationId,
        error: stalled
          ? `DUIN brain stalled — no frames for ${Math.round(inactivityMs / 1000)}s`
          : 'DUIN stream ended unexpectedly'
      })
    }
  }
  return {
    text: acc.text,
    chunks: acc.chunks,
    reasoningChunks: acc.reasoning,
    reasoning: acc.reasoningText,
    ok,
    eventTypes
  }
}

/**
 * Demo fallback used when no brain is reachable. Streams a short, friendly assistant
 * turn (as real chat:chunk frames) explaining that no brain is connected and how to
 * connect one, then emits chat:done. This keeps the first-run experience coherent —
 * the user sees an assistant reply, not a crash. The Brain graph view already ships
 * demo data, so the visual console works offline regardless of this path.
 */
function emitDemoReply(
  conversationId: string,
  brainUrl: string,
  emit: ChatEmit,
  eventTypes: Record<string, number>,
  signal?: AbortSignal,
): DuinStreamResult {
  const lines = [
    "👋 Hi! This is the built-in demo assistant. No brain is connected yet, so I can't actually think for you — but everything else works.",
    '',
    `I just tried to reach a brain at ${brainUrl} and nothing was listening there.`,
    '',
    "Want to connect one? It takes three steps:",
    '',
    '1. **Start your agent.** Run an agent server that speaks the AG-UI protocol (it accepts a turn and streams the reply back). DUIN’s own built-in brain runs locally at http://127.0.0.1:8799/agui; an external brain can serve /agui on any host:port you point the Brain setting at.',
    '2. **Point DUIN at it.** Open Settings → Brain and paste the endpoint, then hit “Test connection.”',
    '3. **Chat away.** New conversations use the brain automatically — just start typing.',
    '',
    'Until then, feel free to explore the Brain graph on the left — it runs on sample data so you can see how everything fits together.',
  ]
  const acc = { text: '', chunks: 0, reasoning: 0 }
  for (const line of lines) {
    if (signal?.aborted) break
    const content = line + '\n'
    acc.text += content
    acc.chunks += 1
    emit('chat:chunk', { conversationId, content })
  }
  emitDone(conversationId, acc.text, emit)
  return {
    text: acc.text,
    chunks: acc.chunks,
    reasoningChunks: 0,
    reasoning: '',
    ok: true,
    eventTypes,
  }
}

/** Construct the minimal persisted-assistant-message shape chat:done carries.
 *  (Phase 2 hazard #2 — real persistence in lamprey's SQLite row shape — is out of
 *  spike scope; the renderer only needs id/role/content/conversationId to render the bubble.) */
function emitDone(conversationId: string, text: string, emit: ChatEmit): void {
  const message = {
    id: `duin-${Date.now()}`,
    conversationId,
    role: 'assistant' as const,
    content: text,
    createdAt: Date.now(),
  }
  emit('chat:done', { conversationId, message })
}
