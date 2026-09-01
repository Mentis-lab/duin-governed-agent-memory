// headless-agent.ts — the autonomy primitive: run a prompt through a REAL
// agentic loop (model → tool_calls → execute → feed back → repeat) with NO
// human present. This is the one thing the codebase lacked; loops/automations/
// subagents can now do actual work (write files, fetch web) instead of just
// generating text.
//
// Safety is structural, not incidental:
//   - tools are restricted to `spec.allowedTools` (capability allow-list)
//   - approval runs in fail-closed CAPABILITY mode (permissions-store): a tool
//     not granted, or any sandbox-bypass tool, is DENIED — never a modal, never
//     a hang. Each call still passes the preToolUse hooks.
//   - writes are jailed to `spec.workspacePath` (apply_patch enforces in-root).
//   - bounded by maxTurns / maxToolCalls / timeoutMs so a run can't loop or
//     cost forever.
// All of that lives in executeToolCall (tool-exec.ts); this module is just the
// model loop + bounds + bookkeeping.

import { chatStream, resolveModel, type ToolCallAccumulator } from './providers/registry'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import { toolRegistry } from './tool-registry'
import { executeToolCall } from './tool-exec'
import { messageOf } from './guarded'

export interface HeadlessAgentSpec {
  prompt: string
  system?: string
  /** Root the run is scoped to (vault for a loop). Tools anchor here. */
  workspacePath: string
  /** Exact tool ids this run may call. Empty = no tools (text only). */
  allowedTools: string[]
  /** Model id. Falls back to a tool-capable model if this one can't call tools. */
  model: string
  maxTurns?: number
  maxToolCalls?: number
  timeoutMs?: number
  label?: string
  signal?: AbortSignal
}

export interface HeadlessToolUse {
  name: string
  status: string
  approvalSource: string
}

/** Which budget ran out. Only meaningful on a `truncated` result. */
export type HeadlessStopReason = 'max-tool-calls' | 'max-turns'

export interface HeadlessAgentResult {
  /**
   * `truncated` exists because the agent RAN OUT OF BUDGET mid-task, which is neither a
   * success nor an error and used to be reported as the former.
   *
   * Both budget exits returned `status: 'ok'`. The tool-call exit at least carried an
   * `error` string, which callers branching on `status === 'error'` never looked at; the
   * turn exit carried no marker whatsoever and was byte-identical to a clean finish. An
   * automation that stopped halfway therefore recorded `automation.completed` at severity
   * info, fired its success hook, and settled its ledger row as completed.
   *
   * Fixed here rather than at each call site so every consumer inherits it: a caller that
   * checks `!== 'ok'` is now correct by default, which is the safer way to be wrong.
   */
  status: 'ok' | 'truncated' | 'error' | 'aborted'
  output: string
  turns: number
  toolUses: HeadlessToolUse[]
  error?: string
  stopReason?: HeadlessStopReason
}

const DEFAULTS = { maxTurns: 8, maxToolCalls: 24, timeoutMs: 120_000 }

/** One non-streaming model turn: collect final content + tool calls. */
function modelTurn(
  messages: ChatCompletionMessageParam[],
  modelId: string,
  tools: ChatCompletionTool[],
  signal: AbortSignal
): Promise<{ content: string; toolCalls: ToolCallAccumulator[] }> {
  return new Promise((resolve, reject) => {
    chatStream(
      messages,
      modelId,
      tools.length ? tools : undefined,
      {
        onChunk: () => {},
        onDone: (content, toolCalls) => {
          // onDone fires whenever the stream ENDS — including when it ended because the
          // turn was aborted. Resolving unconditionally meant an abort that routes here
          // rather than through onError looked like a normal completion: the outer catch
          // never ran, `aborted` was never consulted, and a cancelled headless run
          // reported status 'ok' with whatever partial text had arrived.
          if (signal.aborted) {
            reject(new Error('aborted'))
            return
          }
          resolve({ content: content || '', toolCalls: toolCalls ?? [] })
        },
        onError: (err) => reject(new Error(err))
      },
      signal
    ).catch(reject)
  })
}

/** Resolve a tool-capable model: prefer the requested one; else fall back. */
function toolCapableModel(modelId: string): string {
  try {
    if (resolveModel(modelId).supportsTools) return modelId
  } catch (e) { console.debug('[headless-agent] unknown id  fall through:', messageOf(e)) }
  for (const fallback of ['deepseek-v4-flash', 'deepseek-v4-pro']) {
    try {
      if (resolveModel(fallback).supportsTools) return fallback
    } catch (e) { console.debug('[headless-agent] keep trying:', messageOf(e)) }
  }
  return modelId
}

export async function runHeadlessAgent(spec: HeadlessAgentSpec): Promise<HeadlessAgentResult> {
  const maxTurns = spec.maxTurns ?? DEFAULTS.maxTurns
  const maxToolCalls = spec.maxToolCalls ?? DEFAULTS.maxToolCalls
  const timeoutMs = spec.timeoutMs ?? DEFAULTS.timeoutMs
  const model = toolCapableModel(spec.model)

  const allow = new Set(spec.allowedTools)
  const tools = toolRegistry
    .getOpenAITools()
    .filter((t) => t.type === 'function' && allow.has(t.function.name))

  const messages: ChatCompletionMessageParam[] = []
  if (spec.system) messages.push({ role: 'system', content: spec.system })
  messages.push({ role: 'user', content: spec.prompt })

  const toolUses: HeadlessToolUse[] = []
  let turns = 0
  let lastContent = ''
  /** True only when the model itself decided to stop. Everything else is a budget exit. */
  let finished = false

  const controller = new AbortController()
  const onParentAbort = (): void => controller.abort()
  spec.signal?.addEventListener('abort', onParentAbort, { once: true })
  // addEventListener on an already-aborted signal NEVER fires, so a run handed a
  // pre-aborted parent (its controller aborted before we were reached) would leave
  // `controller` live: the aborted-check inside modelTurn never trips, tools run,
  // files get written, and the cancelled run returns ok. Propagate it here.
  if (spec.signal?.aborted) controller.abort()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    while (turns < maxTurns) {
      turns++
      const { content, toolCalls } = await modelTurn(messages, model, tools, controller.signal)
      if (content) lastContent = content
      if (!toolCalls.length) {
        finished = true // the model chose to stop — the ONLY clean exit from this loop
        break
      }

      messages.push({
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: tc.function }))
      } as ChatCompletionMessageParam)

      for (const tc of toolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments || '{}')
        } catch (e) { console.debug('[headless-agent] malformed args  empty; the tool will reject and the model self-corrects:', messageOf(e)) }
        const r = await executeToolCall(tc.function.name, args, {
          workspacePath: spec.workspacePath,
          capabilityAllowedTools: spec.allowedTools,
          model,
          signal: controller.signal
        })
        toolUses.push({ name: tc.function.name, status: r.status, approvalSource: r.approvalSource })
        messages.push({ role: 'tool', tool_call_id: tc.id, content: r.result } as ChatCompletionMessageParam)

        if (toolUses.length >= maxToolCalls) {
          return {
            status: 'truncated',
            stopReason: 'max-tool-calls',
            output: lastContent,
            turns,
            toolUses,
            error: `stopped after ${maxToolCalls} tool calls — the task was not finished`
          }
        }
      }
    }
    // Falling out of the while condition means `turns` hit `maxTurns` with the model still
    // asking for tools. Distinguished from the clean break above by `finished`, because the
    // two used to share this return — and `lastContent` holds the last NON-EMPTY content,
    // so an exhausted run could hand back a stale intermediate message as its final answer.
    if (!finished) {
      return {
        status: 'truncated',
        stopReason: 'max-turns',
        output: lastContent,
        turns,
        toolUses,
        error: `stopped after ${maxTurns} turns — the task was not finished`
      }
    }
    return { status: 'ok', output: lastContent, turns, toolUses }
  } catch (err) {
    const aborted = controller.signal.aborted
    return {
      status: aborted ? 'aborted' : 'error',
      output: lastContent,
      turns,
      toolUses,
      error: (err as Error)?.message ?? String(err)
    }
  } finally {
    clearTimeout(timer)
    spec.signal?.removeEventListener('abort', onParentAbort)
  }
}
