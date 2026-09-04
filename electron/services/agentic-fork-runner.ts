// agentic-fork-runner.ts — the missing tool-executing ForkAgentRunner (M5).
//
// forkAgent (subagent-runner.ts) delegates generation to a ForkAgentRunner, but
// `setWorkflowChatRunner` was NEVER called → the Workflow tool threw "runner not
// yet registered", and the only other runner (multi_agent_run) drops tools and
// returns text. So nothing using forkAgent could actually run tools — the agent
// abstraction never earned its name.
//
// This runner closes that: a real model → tool_calls → execute → feed-back loop
// (the same primitive as headless-agent.ts), reusing executeToolCall so the
// run's `allowedTools` ARE the capability allow-list — fail-closed, sandbox-bypass
// tools denied, preToolUse hooks honored. Registered at startup, it makes the
// whole workflow/subagent stack genuinely agentic. Additive: an agent type with
// no tools offers none and behaves like a plain completion (today's behavior).

import { chatStream, resolveModel, routeModel, type ToolCallAccumulator } from './providers/registry'
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool
} from 'openai/resources/chat/completions'
import { toolRegistry } from './tool-registry'
import { executeToolCall } from './tool-exec'
import { getActiveWorkspace } from './workspace-state'
import type {
  ForkAgentRunner,
  ForkAgentRunnerInput,
  ForkAgentRunnerOutput
} from './subagent-runner'
import { messageOf } from './guarded'

const MAX_TURNS = 12
const MAX_TOOL_CALLS = 40

/** Tool execution needs a tool-capable model; if the requested one can't call
 *  tools, resolve the `agentic` role from the provider policy (no hardcoded
 *  fallback id). Keeps the requested id when nothing tool-capable routes, so the
 *  provider's own error names the problem. */
function toolCapableModel(modelId: string): string {
  try {
    if (resolveModel(modelId).supportsTools) return modelId
  } catch (e) { console.debug('[agentic-fork-runner] unknown id  fall through:', messageOf(e)) }
  try {
    const routed = routeModel('agentic')
    if (routed && resolveModel(routed).supportsTools) return routed
  } catch (e) { console.debug('[agentic-fork-runner] agentic route failed:', messageOf(e)) }
  return modelId
}

/** One non-streaming model turn: final content + any tool calls. */
const MODEL_TURN_TIMEOUT_MS = 120_000

function modelTurn(
  messages: ChatCompletionMessageParam[],
  modelId: string,
  tools: ChatCompletionTool[],
  signal: AbortSignal
): Promise<{ content: string; toolCalls: ToolCallAccumulator[] }> {
  return new Promise((resolve, reject) => {
    // Link the parent signal + a hard turn timeout into a local controller, so a
    // provider that streams nothing but never errors can't stall a workflow agent.
    const ctl = new AbortController()
    const onAbort = (): void => ctl.abort()
    if (signal.aborted) ctl.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      ctl.abort()
      cleanup()
      reject(new Error('model turn timed out'))
    }, MODEL_TURN_TIMEOUT_MS)
    const cleanup = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    }
    chatStream(
      messages,
      modelId,
      tools.length ? tools : undefined,
      {
        onChunk: () => {},
        onDone: (content, toolCalls) => {
          cleanup()
          resolve({ content: content || '', toolCalls: toolCalls ?? [] })
        },
        onError: (err) => {
          cleanup()
          reject(new Error(err))
        }
      },
      ctl.signal
    ).catch((e) => {
      cleanup()
      reject(e)
    })
  })
}

export const agenticForkRunner: ForkAgentRunner = async (
  input: ForkAgentRunnerInput
): Promise<ForkAgentRunnerOutput> => {
  const wildcard = input.allowedTools === '*'
  const allow = wildcard ? null : new Set(input.allowedTools)
  const tools = toolRegistry
    .getOpenAITools()
    .filter((t) => t.type === 'function' && (allow === null || allow.has(t.function.name)))
  // Capability allow-list for the gate. '*' grants every registered tool id; the
  // gate still denies sandbox-bypass tools unattended, so '*' ≠ shell access.
  const capabilityAllowedTools = wildcard
    ? toolRegistry.getDescriptors().map((d) => d.id)
    : (input.allowedTools as string[])
  const workspacePath =
    input.worktreePath ||
    (() => {
      try {
        return getActiveWorkspace()
      } catch {
        return process.cwd()
      }
    })()

  const model = tools.length ? toolCapableModel(input.modelId) : input.modelId
  const messages: ChatCompletionMessageParam[] = [...input.messages]
  let lastContent = ''
  const lastReasoning: string | undefined = undefined
  let toolCalls = 0

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const { content, toolCalls: tcs } = await modelTurn(messages, model, tools, input.signal)
    if (content) lastContent = content
    if (!tcs.length) break // model is done — no tools requested

    messages.push({
      role: 'assistant',
      content: content || null,
      tool_calls: tcs.map((tc) => ({ id: tc.id, type: 'function', function: tc.function }))
    } as ChatCompletionMessageParam)

    for (const tc of tcs) {
      // Stop executing the rest of this round's tool calls if the parent aborted
      // — otherwise queued (possibly destructive) tools still run after cancel.
      if (input.signal.aborted) break
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(tc.function.arguments || '{}')
      } catch (e) { console.debug('[agentic-fork-runner] malformed  empty; the tool rejects and the model self-corrects:', messageOf(e)) }
      const r = await executeToolCall(tc.function.name, args, {
        workspacePath,
        capabilityAllowedTools,
        model: input.modelId,
        signal: input.signal
      })
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: r.result
      } as ChatCompletionMessageParam)
      if (++toolCalls >= MAX_TOOL_CALLS) return { output: lastContent, reasoning: lastReasoning }
    }
  }
  void lastReasoning
  return lastContent
}
