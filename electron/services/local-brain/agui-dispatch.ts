// agui-dispatch — the ONE tool-dispatch path for the /agui brain loop (Agent-
// engine unification, Stage 3). Before this, server.ts had TWO dispatch code
// paths: the main loop's `runOneCall` if/else and a divergent subagent switch.
// They re-implemented the same routing (gate → simple tool → render → spawn →
// MCP) with slightly different behaviour. This collapses them into one
// policy-parameterized function: the main loop passes an SSE `emit` + the
// posture-aware gate + the full tool universe; a subagent passes a noop `emit`,
// the narrow allow-set, and a depth-capped, read-only spawn.
//
// Heavy, main-only dependencies (artifact validation, MCP transport) are
// INJECTED through the policy, so this module imports only the light dispatch
// helpers — it is unit-testable without the HTTP server, electron, or the MCP
// manager (see agui-dispatch.test.ts).

import { randomUUID } from 'crypto'
import { deniedResult } from './agui-guard'
import { withToolTimeout, toolTimeoutMs, toolTimeoutMessage } from './agui-timeout'
import { isMcpToolName, aguiTier, tierRisks } from './agui-approval'
import { noteExecutedTool } from '../governance/rule-of-two'
import { splitMcpToolName } from './agui-mcp'
import { AGUI_TOOLS, isSimpleAguiTool } from './agui-tools'
import { ARTIFACT_TYPES } from './agui-executors'
import { parseFallbackToolCalls } from '../fallback-tool-parser'
import type { EmbedFn } from '../brain/claim-entities' // type-only — no runtime dep (keeps this module electron-free)

/** A native-shaped tool call (OpenAI Chat Completions), the form the /agui round
 *  loop dispatches. */
export interface NativeToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

/**
 * Capabilities ① — non-native-model fallback. Mirrors `ipc/chat.ts`'s parse-only
 * fallback: a model that does NOT emit native `tool_calls` (e.g. a local Ollama
 * model, `supportsTools:false`) can still drive tools by outputting the
 * fallback-JSON contract in its text. Parse it into the native tool_calls shape
 * so the existing /agui dispatch runs it. Returns `null` for a final answer,
 * unparseable text, or no call — the caller then treats the text as the answer.
 * The caller MUST gate this behind `supportsTools === false` so native models are
 * never touched.
 */
/** Why no tool calls came back. `unparseable` is the one that matters: the model clearly ATTEMPTED
 *  structured output (a balanced JSON object was extracted from its text) and we could not read it,
 *  which is a dropped tool call — not an answer. It used to share `null` with a genuine final
 *  answer, so a local model emitting slightly malformed JSON had its call silently discarded and
 *  the raw JSON served to the user as the reply, with no frame, no log and no telemetry. */
export type FallbackParseMiss = 'final-answer' | 'unparseable' | 'no-calls'

/** The reason a fallback parse produced no calls. Null when it DID produce calls. */
export function fallbackParseMiss(
  content: string,
  descriptors: Array<{ name: string; inputSchema: unknown; description?: string }>
): FallbackParseMiss | null {
  const fb = parseFallbackToolCalls(content, descriptors)
  // parseFallbackToolCalls returns null for "no balanced JSON", "JSON.parse threw", and "not an
  // object". Only the first is genuinely prose; re-testing for extractable JSON separates them.
  if (!fb) return /\{[\s\S]*\}/.test(content) ? 'unparseable' : 'final-answer'
  if (fb.isFinalAnswer) return 'final-answer'
  if (fb.calls.length === 0) return 'no-calls'
  return null
}

export function parseBrainFallbackCalls(
  content: string,
  descriptors: Array<{ name: string; inputSchema: unknown; description?: string }>
): NativeToolCall[] | null {
  const fb = parseFallbackToolCalls(content, descriptors)
  if (!fb || fb.isFinalAnswer || fb.calls.length === 0) return null
  return fb.calls.map((fc) => ({
    id: fc.id,
    type: 'function' as const,
    function: { name: fc.name, arguments: JSON.stringify(fc.arguments) }
  }))
}

/**
 * The knob-set that lets one dispatcher serve both the main /agui loop and the
 * nested subagent loop. Behavioural differences live here, not in a second copied
 * code path.
 */
export interface AguiDispatchPolicy {
  /** Frame sink — main: sseFrame(res, …); subagent: noop (returns text only). */
  emit: (frame: Record<string, unknown>) => void
  notesDir: string
  threadId: string
  /** Turn abort signal (R3/Phase-2). Threaded end-to-end so that AFTER the turn deadline (or a
   *  cancel) queued/in-flight tool work STOPS instead of draining: dispatchAguiTool short-circuits
   *  when it's set, and it flows into the executor ctx (web_search honors it). Optional so existing
   *  callers/tests that don't thread a signal keep today's behaviour. */
  signal?: AbortSignal
  /** F2 (bounded-context): the turn query + on-device embedder, threaded into the executor ctx so an
   *  over-budget tool output is relevance-bounded rather than blind head-sliced. Main supplies both;
   *  the subagent omits them (⇒ head-slice, byte-identical). */
  query?: string
  embed?: EmbedFn
  /** Is this tool offered under this policy? Main: everything. Subagent: SUBAGENT_TOOLS. */
  allowsTool: (name: string) => boolean
  /** Model-facing message when a tool isn't offered under this policy. */
  notAvailable: (name: string) => string
  /** Per-action gate (main: resolveAguiGate posture-aware; subagent: SUBAGENT_GATED+execOk). */
  gate: (tc: any) => Promise<{ allow: boolean; reason?: string }>
  enableRenderArtifact: boolean
  enableMcp: boolean
  /** May this context spawn a subagent right now (false = at/over the depth cap)? */
  allowSpawn: boolean
  /** Message when spawn is refused by the depth cap (subagent-only path). */
  spawnDenied: string
  /** Launch a subagent for `task` → its final text. Encapsulates the execOk/depth
   *  differences (main: parent execOk at depth 0; child: read-only at depth+1). */
  runSpawn: (task: string, args: Record<string, unknown>) => Promise<string>
  /** Validate + render an artifact (main only). Injected so this module stays
   *  free of the heavy artifact-sandbox import. */
  renderArtifact?: (type: string, source: string) => Promise<{ ok: boolean; errors: string[] }>
  /** Call an MCP tool (main only). Injected so this module stays free of the
   *  heavy mcp-manager import. */
  callMcp?: (serverId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>
}

export function parseToolArgs(tc: any): Record<string, unknown> {
  try {
    return JSON.parse(tc?.function?.arguments || '{}') as Record<string, unknown>
  } catch {
    return {} // malformed args → the executor reports the missing field
  }
}

/** Outcome of racing a simple tool's execute() against its wall-clock budget. Settling the tool's
 *  own promise into this tagged shape BEFORE the race is what keeps a genuine throw distinguishable
 *  from an expiry (withToolTimeout treats a rejection as an expiry). */
type ToolSettled =
  | { kind: 'ok'; value: unknown }
  | { kind: 'threw'; error: unknown }
  | { kind: 'expired' }

/**
 * Dispatch ONE tool call under `policy` → its model-facing result string. Emits
 * TOOL_CALL_START/END (and ARTIFACT) frames through `policy.emit`, so the main
 * loop streams cards and the subagent stays silent — one routing table, two
 * policies. Simple tools resolve through the shared AGUI_TOOLS table (golden-
 * locked out/end strings); render_artifact / MCP stay inline (main only).
 */
export async function dispatchAguiTool(tc: any, p: AguiDispatchPolicy): Promise<string> {
  const name = tc?.function?.name as string
  // One golden string for both signal reads below — they must never drift apart.
  const abortedOut = `Error: tool "${name}" aborted (turn ended)`
  // R3/Phase-2 — the ONE seam every tool call (main parallel windows + subagent loop) funnels
  // through. After the turn deadline/cancel aborts `signal`, queued and just-started tool work must
  // STOP rather than drain (the "dispatch agents" fan-out that ran past the 180s deadline). Emits no
  // frame — the aborted turn is already tearing down its terminal frame elsewhere.
  if (p.signal?.aborted) return abortedOut
  // Per-action gate first (deny-first). A refusal emits START+END denial frames
  // (noop for a subagent) and threads the reason back as the tool result.
  const gate = await p.gate(tc)
  // Read the signal AGAIN, because `await p.gate(tc)` is not instantaneous: resolveAguiGate blocks
  // on a HUMAN for an unbounded time — the interactive approval modal has no timeout at all, and the
  // AFK channel roundtrip is bounded only by approvalTimeoutMs (5 min) — while the brain's 90s stall
  // watchdog cuts the turn underneath it (the gate never calls markProgress). What made this
  // invisible is that the single pre-await check READS as "abort is handled" for the whole function;
  // but an approval that lands after the cut returns `allow: true`, and with only that one check it
  // still reached spawn / spec.execute / render_artifact / MCP. Nothing downstream would have caught
  // it either: delete_file and run_command take no signal of their own (only web_search consumes
  // ctx.signal), so a late "approve" on a dead turn really did delete the file. Placed BEFORE the
  // !gate.allow branch so a late allow can never fall through, and so a dead turn emits no frames.
  if (p.signal?.aborted) return abortedOut
  if (!gate.allow) {
    const cid = randomUUID()
    p.emit({ type: 'TOOL_CALL_START', toolCallId: cid, toolName: name, args: parseToolArgs(tc) })
    const out = gate.reason ?? deniedResult(name)
    p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: out })
    return out
  }
  // W1 — Rule-of-Two profile accrual for the /agui face (main loop AND subagents funnel
  // through this one seam). Marked post-allow / pre-dispatch: a gate-allowed call that later
  // errors may still have made its request, so over-marking is the safe direction. Legs derive
  // from the agui tier vocabulary (same source the gate itself uses).
  noteExecutedTool(p.threadId, {
    name,
    providerKind: isMcpToolName(name) ? 'mcp' : 'native',
    risks: tierRisks(aguiTier(name))
  })
  // spawn_agent — bounded recursion. Main is always under the cap (depth 0); a
  // subagent at/over the cap is refused here even if it echoes a spawn call.
  if (name === 'spawn_agent') {
    if (!p.allowSpawn) return p.spawnDenied
    const args = parseToolArgs(tc)
    const task = String(args.task ?? '').trim()
    const cid = randomUUID()
    p.emit({ type: 'TOOL_CALL_START', toolCallId: cid, toolName: 'spawn_agent', args })
    const out = task ? await p.runSpawn(task, args) : 'Error: task is required'
    p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: task ? 'subagent finished' : 'Error: task is required' })
    return out
  }
  // Simple tools (the 16 in AGUI_TOOLS) — shared execute → out/end formatter.
  if (isSimpleAguiTool(name)) {
    if (!p.allowsTool(name)) return p.notAvailable(name)
    const args = parseToolArgs(tc)
    const cid = randomUUID()
    p.emit({ type: 'TOOL_CALL_START', toolCallId: cid, toolName: name, args })
    const spec = AGUI_TOOLS[name]
    // Wall-clock backstop. Only run_command (30s) and web_fetch (15s) bound themselves; every other
    // simple tool was a bare `await` that could hang the turn forever. The inner promise is settled
    // into a tagged result FIRST so `withToolTimeout`'s rejection branch cannot fire on a genuine
    // tool throw — a real error must stay a real error, not be relabelled as a timeout.
    const budgetMs = toolTimeoutMs()
    const settled = await withToolTimeout<ToolSettled>(
      // Promise.resolve, not `.then` on the return value: an executor may be synchronous (several
      // AGUI_TOOLS entries are, and a test stub certainly can be), and a bare `.then` throws on
      // a plain value. A sync throw is caught by the surrounding try/catch as before.
      Promise.resolve(
        spec.execute(
          { notesDir: p.notesDir, threadId: p.threadId, signal: p.signal, query: p.query, embed: p.embed },
          args
        )
      ).then(
        (v): ToolSettled => ({ kind: 'ok', value: v }),
        (e): ToolSettled => ({ kind: 'threw', error: e })
      ),
      budgetMs,
      p.signal,
      (): ToolSettled => ({ kind: 'expired' })
    )
    if (settled.kind === 'expired') {
      const out = toolTimeoutMessage(name, budgetMs)
      p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: out })
      return out
    }
    if (settled.kind === 'threw') throw settled.error
    const r = settled.value
    const out = spec.out(r as never)
    p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: spec.end(r as never) })
    return out
  }
  // render_artifact — validate in a sandbox + (on success) emit an ARTIFACT frame. Main only.
  if (name === 'render_artifact' && p.enableRenderArtifact && p.renderArtifact) {
    const args = parseToolArgs(tc) as { type?: unknown; source?: unknown; title?: unknown }
    const atype = ARTIFACT_TYPES.has(String(args.type ?? '').toLowerCase()) ? String(args.type).toLowerCase() : 'html'
    const asource = typeof args.source === 'string' ? args.source : String(args.source ?? '')
    const title = typeof args.title === 'string' ? args.title : undefined
    const cid = randomUUID()
    p.emit({ type: 'TOOL_CALL_START', toolCallId: cid, toolName: 'render_artifact', args: { type: atype, ...(title ? { title } : {}) } })
    const v = await p.renderArtifact(atype, asource)
    let out: string
    if (v.ok) {
      p.emit({ type: 'ARTIFACT', artifactType: atype, source: asource, ...(title ? { title } : {}) })
      out = `Rendered the ${atype} artifact successfully (no errors) — it is now shown in the artifact panel.`
    } else {
      out =
        `The ${atype} artifact FAILED validation with ${v.errors.length} error(s):\n- ` +
        v.errors.join('\n- ') +
        '\nFix the source and call render_artifact again.'
    }
    p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: out })
    return out
  }
  // MCP tool — already passed the mcp-external gate above. Main only.
  if (isMcpToolName(name) && p.enableMcp && p.callMcp) {
    const margs = parseToolArgs(tc)
    const cid = randomUUID()
    p.emit({ type: 'TOOL_CALL_START', toolCallId: cid, toolName: name, args: margs })
    const split = splitMcpToolName(name)
    let out: string
    if (!split) {
      out = `Error: malformed MCP tool name '${name}'`
    } else {
      try {
        const r = await p.callMcp(split.serverId, split.toolName, margs)
        out = typeof r === 'string' ? r : JSON.stringify(r)
      } catch (err) {
        out = `Error: ${(err as Error)?.message ?? String(err)}`
      }
    }
    p.emit({ type: 'TOOL_CALL_END', toolCallId: cid, result: out.length > 200 ? out.slice(0, 200) + '…' : out })
    return out
  }
  return p.notAvailable(name)
}
