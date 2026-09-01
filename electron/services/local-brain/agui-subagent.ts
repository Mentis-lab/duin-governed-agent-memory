// Bounded recursive subagents (spawn_agent) — relocated verbatim from server.ts.
// The nested subagent tool-loop and its dispatch policy. Routes every tool call
// through the SAME unified dispatcher (agui-dispatch) the main /agui loop uses.
import { randomUUID } from 'crypto'
import {
  WRITE_NOTE_TOOL,
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
  SPAWN_AGENT_TOOL
} from './agui-executors'
import { resolveSubagentConfig, subagentToolAllowed, type ResolvedSubagentConfig } from './subagent-config'
import { dispatchAguiTool, type AguiDispatchPolicy } from './agui-dispatch'
import { resolveAguiGate } from './agui-gate'
import type { AguiPosture } from './agui-approval'
import { chatStream } from '../providers/registry'

// ──────────────────── subagent (spawn_agent) ────────────────────

// Reuse the existing executors to run one file/shell/web tool call and return
// the model-facing string. Used only by the nested subagent loop.
// The tools a subagent may run. Gated ones still require the parent's exec token. All dispatch
// through the SAME registry as the main loop (agui-tools.ts). spawn_agent is added dynamically for
// BOUNDED recursion (see runSubagent) — a subagent may delegate deeper, but children are read-only.
// SUBAGENT_TOOLS + the allow predicate live in the PURE subagent-config module so the
// least-privilege boundary is testable without dragging in the electron main-process graph.


// ── Bounded recursive subagents (Capabilities S4) ──
// A subagent tree is contained by FOUR guards, so recursion can't blow up: (1) a depth cap
// (DUIN_SUBAGENT_MAX_DEPTH, default 2 — spawn is only OFFERED while depth < cap); (2) a tree-wide
// concurrency ceiling (DUIN_SUBAGENT_TREE_LIMIT, default 8 live agents); (3) execOk=false at every
// recursion level ≥1 so a nested agent can NEVER run shell / write / delete (the top blast-radius
// risk — recursion is read-only below the first level); (4) the shared 180s turnAbort deadline that
// cancels the whole tree. Serial dispatch within a subagent keeps sibling width bounded too.
const SUBAGENT_MAX_DEPTH = (() => {
  const raw = Number(process.env.DUIN_SUBAGENT_MAX_DEPTH)
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 2
})()
const SUBAGENT_TREE_LIMIT = (() => {
  const raw = Number(process.env.DUIN_SUBAGENT_TREE_LIMIT)
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8
})()
let LIVE_SUBAGENTS = 0

// Agent-engine unification (Stage 3) — the ONE tool-dispatch path lives in
// ./agui-dispatch (dispatchAguiTool + AguiDispatchPolicy). Both the main /agui
// loop and the nested subagent loop route every call through it; their
// behavioural differences are policy fields, not a second copied code path
// (this replaced the divergent second subagent dispatch path). The main loop
// builds its policy inline in handleAgui; the subagent's is built below.

/** Build the subagent dispatch policy for a given nesting depth — the narrow
 *  half of the unified dispatcher (no frames, SUBAGENT_TOOLS allow-set,
 *  depth-capped read-only spawn). Safety ①: the gate now routes through the
 *  SAME posture-aware `resolveAguiGate` the main loop uses (was an exec-token-
 *  only check), so subagent gated calls get the full deny-first pipeline —
 *  catastrophic floor, persisted-DENY precedence, and elevated-risk escalation —
 *  instead of the coarser main/subagent asymmetry. Children still run read-only
 *  (execOk=false → the exec-token step denies gated tools), preserving behaviour
 *  under the default trusted-afk posture. */
function makeSubagentPolicy(
  notesDir: string,
  execOk: boolean,
  modelId: string,
  signal: AbortSignal | undefined,
  depth: number,
  posture: AguiPosture,
  conversationId: string,
  onProgress?: () => void,
  // LEAST-PRIVILEGE (enforcement fix): the per-run derived allow-list. Previously this
  // list only chose which tool SCHEMAS were offered to the model, while `allowsTool` was
  // bound to the broad SUBAGENT_TOOLS set — so an off-list call that the model made anyway
  // (hallucinated name, prompt injection, or a stale tool id echoed from context) was NOT
  // blocked at dispatch. Offering a narrow toolset is a hint; this makes it a boundary.
  // Empty list = "no per-run restriction" (a bare {task} spawn threads no config), which
  // keeps that path byte-identical to today.
  allowedToolNames: readonly string[] = []
): AguiDispatchPolicy {
  const allowSet = new Set(allowedToolNames)
  return {
    emit: () => {}, // subagents never stream frames to the parent response
    notesDir,
    threadId: conversationId,
    // R3/Phase-2 — carry the turn signal into the unified dispatcher so a subagent's tool calls
    // short-circuit the instant the parent turn's deadline/cancel fires (was: only checked between
    // rounds, so an in-flight fan-out kept draining past the 180s deadline).
    signal,
    allowsTool: (name) => subagentToolAllowed(name, allowSet),
    notAvailable: (name) => `Error: tool "${name}" is not available to a subagent`,
    gate: (tc) => resolveAguiGate(tc, { execOk, posture, conversationId, workspacePath: notesDir }),
    enableRenderArtifact: false,
    enableMcp: false,
    allowSpawn: depth < SUBAGENT_MAX_DEPTH,
    spawnDenied: `Error: tool "spawn_agent" is not available at this nesting depth`,
    // A subagent's child is ALWAYS read-only (execOk=false) and one level deeper.
    runSpawn: async (task, args) => {
      const childCfg = resolveSubagentConfig(args, { defaultModelId: modelId })
      const sub = await runSubagent(task, notesDir, modelId, signal, 6, false, childCfg, depth + 1, posture, conversationId, onProgress)
      return `Subagent result:\n${sub}`
    }
  }
}

/** PURE. The handoff a cut-off subagent returns when no model is available to write one. Names the
 *  cap explicitly so the parent cannot mistake a truncated attempt for a finished one, and carries
 *  whatever prose the child did produce rather than discarding it. */
export function deterministicCapCheckpoint(finalText: string, toolWork: number): string {
  const tail = finalText.trim()
  return (
    `[subagent stopped at its round cap after ${toolWork} tool call(s) — the task is INCOMPLETE, not failed]` +
    (tail ? `\n\nLast output before the cap:\n${tail}` : '\n\nIt produced no prose before the cap.') +
    `\n\nTreat this as partial: re-dispatch the remaining work as a new, narrower subagent task rather than assuming it finished.`
  )
}

/**
 * One tools-DISABLED call asking the cut-off child what it accomplished and what remains.
 *
 * Why a whole extra call: the alternative is what shipped before — return `finalText`, which on a
 * cap exit is usually the last TOOL-CALL round and therefore empty, so the parent received
 * "(subagent produced no final text)" for a child that had done real work. One bounded call buys
 * a usable handoff. Only ever reached on the cap path.
 *
 * Fails soft in both directions: no model, an error, or an empty answer all fall through to the
 * deterministic checkpoint, so the parent ALWAYS learns the child was cut off.
 */
async function summarizeAtCap(
  msgs: unknown[],
  model: string,
  signal: AbortSignal | undefined,
  finalText: string,
  toolWork: number
): Promise<string> {
  const fallback = deterministicCapCheckpoint(finalText, toolWork)
  try {
    const ask = [
      ...(msgs as Array<Record<string, unknown>>),
      {
        role: 'user',
        content:
          'You have run out of tool rounds and must stop now. Do NOT call any tool. In under 150 words, state plainly: (1) what you actually accomplished, with concrete results; (2) what remains undone. Be specific — this hands off to another agent.'
      }
    ]
    const text = await new Promise<string>((resolve) => {
      let settled = false
      const done = (s: string): void => {
        if (settled) return
        settled = true
        resolve(s)
      }
      chatStream(
        ask as never,
        model,
        // No tools: the child is out of rounds, and offering tools here would invite another call
        // that cannot be honoured.
        undefined as never,
        { onChunk: () => {}, onDone: (c: string) => done(c ?? ''), onError: () => done('') },
        signal,
        { reasoningEffort: 'low' }
      ).catch(() => done(''))
    })
    const summary = text.trim()
    return summary
      ? `[subagent stopped at its round cap after ${toolWork} tool call(s) — INCOMPLETE]\n\n${summary}`
      : fallback
  } catch {
    return fallback
  }
}

// Run a nested, bounded tool loop with a FRESH context. Gets only the
// file/shell/web tools (never spawn_agent — no recursion) and never streams to
// the parent response; returns its final text as the tool result.
export async function runSubagent(
  task: string,
  notesDir: string,
  modelId: string,
  signal?: AbortSignal,
  maxRounds = 6,
  execOk = false,
  cfg?: ResolvedSubagentConfig,
  depth = 0,
  // Safety ① — the turn's posture + thread id, threaded down so the subagent's
  // gate uses the SAME resolveAguiGate pipeline as the main loop. Defaults keep
  // the pre-Safety-① behaviour for any caller that doesn't thread them.
  posture: AguiPosture = 'trusted-afk',
  conversationId = '',
  // Sub-agents are opaque to the parent stream (they emit no frames), so the
  // parent's stall-watchdog would falsely kill a deep/long agent. Threading the
  // parent's markProgress here — called on the subagent's own token streaming +
  // each of its tool calls — keeps a legitimately long multi-agent turn alive.
  onProgress?: () => void
): Promise<string> {
  // Tree-wide concurrency ceiling — refuse honestly rather than launch an unbounded fan-out/tree.
  if (LIVE_SUBAGENTS >= SUBAGENT_TREE_LIMIT) {
    return `(subagent concurrency limit reached — ${SUBAGENT_TREE_LIMIT} agents already running; try again with fewer parallel/nested subagents)`
  }
  LIVE_SUBAGENTS++
  try {
  // Typed/parameterized config (Capabilities S3). All optional → today's exact defaults when a
  // bare {task} spawn is used: parent model, 'low' effort, 6 rounds, full toolset, no system prompt.
  const effModel = cfg?.modelId ?? modelId
  const effRounds = cfg?.maxRounds ?? maxRounds
  const effEffort = cfg?.effort ?? 'low'
  const allowed = cfg?.allowedToolNames ?? []
  // Offer spawn_agent for BOUNDED recursion only while under the depth cap (children run read-only).
  const canSpawn = depth < SUBAGENT_MAX_DEPTH
  const baseTools = notesDir
    ? [
        WRITE_NOTE_TOOL,
        READ_FILE_TOOL,
        LIST_DIR_TOOL,
        EDIT_FILE_TOOL,
        DELETE_FILE_TOOL,
        MOVE_FILE_TOOL,
        CREATE_DIR_TOOL,
        SEARCH_FILES_TOOL,
        GLOB_FILES_TOOL,
        RUN_COMMAND_TOOL,
        WEB_FETCH_TOOL
      ]
    : [RUN_COMMAND_TOOL, WEB_FETCH_TOOL]
  const fullTools = canSpawn ? [...baseTools, SPAWN_AGENT_TOOL] : baseTools
  // Restrict to the type's allow-list when set; an empty allow-list (or a filter that removes
  // everything) falls back to the full toolset so a subagent is never left with zero tools.
  // spawn_agent is EXEMPT from this per-run filter. Why: the allow-list is drawn from AguiToolName,
  // which has no 'spawn_agent' member, and every resolveSubagentConfig branch returns a NON-empty
  // list (deriveToolset seeds the read-only floor), so `allowed.length` is truthy on every real
  // spawn and the filter silently stripped SPAWN_AGENT_TOOL from the offered schemas — making the
  // whole bounded-recursion feature (SUBAGENT_MAX_DEPTH / allowSpawn / runSpawn) unreachable in
  // production while every comment and the model-facing description still promised it. This was
  // invisible because the code READ as least-privilege working correctly: the filter is right for
  // the eleven file/shell/web tools and wrong only for the one tool whose name can never appear in
  // the list it filters against. spawn_agent does not need the allow-list's protection — it carries
  // its own bounds (the depth cap via `canSpawn` above, the tree-concurrency ceiling, execOk=false
  // for every child, and the deny-first gate, which is why a child at depth ≥ 1 is still refused).
  const filtered = allowed.length
    ? fullTools.filter((t) => t.function.name === 'spawn_agent' || allowed.includes(t.function.name as never))
    : fullTools
  const subTools = filtered.length ? filtered : fullTools
  const SUB_HANDLED = new Set([
    'write_file',
    'read_file',
    'list_dir',
    'edit_file',
    'delete_file',
    'move_file',
    'create_dir',
    'search_files',
    'glob_files',
    'run_command',
    'web_fetch',
    ...(canSpawn ? ['spawn_agent'] : [])
  ])
  const msgs: any[] = cfg?.systemPrompt
    ? [{ role: 'system', content: cfg.systemPrompt }, { role: 'user', content: task }]
    : [{ role: 'user', content: task }]
  let finalText = ''
  // Did the subagent run out of rounds while still working? Distinct from finishing: a child that
  // was CUT OFF returns whatever its last round happened to hold — often a tool-call round with no
  // prose at all, which surfaces to the parent as "(subagent produced no final text)". The parent
  // then reads a truncated attempt as a completed one. Tracked so the cap gets its own honest exit.
  let roundsUsed = 0
  let toolWork = 0
  for (let round = 0; round < effRounds; round++) {
    roundsUsed = round + 1
    if (signal?.aborted) break // parent turn cancelled → stop the subagent
    const result = await new Promise<{ content: string; toolCalls: any[] }>((resolve) => {
      let settled = false
      chatStream(
        msgs as never,
        effModel,
        subTools as never,
        {
          onChunk: () => onProgress?.(), // subagent token streaming = parent progress
          onDone: (c: string, tcs?: any[]) => {
            if (settled) return
            settled = true
            resolve({ content: c, toolCalls: tcs ?? [] })
          },
          onError: () => {
            if (settled) return
            settled = true
            resolve({ content: '', toolCalls: [] })
          }
        },
        signal,
        { reasoningEffort: effEffort }
      ).catch(() => {
        if (settled) return
        settled = true
        resolve({ content: '', toolCalls: [] })
      })
    })
    if (result.content) finalText = result.content
    const handled = result.toolCalls.filter((tc) => SUB_HANDLED.has(tc?.function?.name))
    if (handled.length === 0) break
    for (const tc of result.toolCalls) if (tc && !tc.id) tc.id = randomUUID()
    msgs.push({ role: 'assistant', content: result.content || null, tool_calls: result.toolCalls })
    const subPolicy = makeSubagentPolicy(notesDir, execOk, effModel, signal, depth, posture, conversationId, onProgress, allowed)
    for (const tc of result.toolCalls) {
      // R3/Phase-2 — check the turn signal BEFORE each queued tool call so the subagent's
      // tool-execution loop stops draining the instant the deadline/cancel fires (dispatchAguiTool
      // also guards, but breaking here avoids even queueing the remaining calls).
      if (signal?.aborted) break
      onProgress?.() // a subagent tool call keeps the parent stall-watchdog alive
      const out = await dispatchAguiTool(tc, subPolicy)
      onProgress?.()
      toolWork++
      msgs.push({ role: 'tool', tool_call_id: tc.id, content: out })
    }
  }
  // CAP CHECKPOINT. Reaching the last round with tools still in flight means the child was cut
  // off mid-task. Spend ONE tools-disabled call to say what got done and what is left, so the
  // parent inherits a usable handoff instead of a stale fragment. Bounded: only on the cap path,
  // never on a clean finish, and skipped entirely when the parent already cancelled.
  if (roundsUsed >= effRounds && toolWork > 0 && !signal?.aborted) {
    return await summarizeAtCap(msgs, effModel, signal, finalText, toolWork)
  }
  return finalText || '(subagent produced no final text)'
  } finally {
    LIVE_SUBAGENTS-- // release the tree-concurrency slot on every exit path
  }
}
