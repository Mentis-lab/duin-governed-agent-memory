import { randomUUID } from 'crypto'
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions'
import { runAutomation } from './automations-runner'
import { getAutomation } from './automations-store'
import { buildApiMessagesFromStoredMessages } from './chat-history'
import { getConversation, getMessages, saveMessage } from './conversation-store'
import { buildMemoryBlock, buildMemoryIndexBlock } from './memory-store'
import { chatOnce } from './providers/registry'
import { applyRuntimeSnapshotToApiMessages } from './runtime-context-snapshot'
import { buildSystemPrompt } from './system-prompt-builder'

export interface HeadlessRunOptions {
  conversationId?: string
  automationId?: string
  json: boolean
}

export type HeadlessRunResult =
  | {
      success: true
      mode: 'conversation'
      conversationId: string
      messageId: string
      model: string
      output: string
      durationMs: number
    }
  | {
      success: true
      mode: 'automation'
      automationId: string
      label: string
      lastResult: string | null
      durationMs: number
    }
  | {
      success: false
      error: string
    }

export function parseHeadlessArgs(argv: string[]): HeadlessRunOptions {
  const runIdx = argv.indexOf('run')
  const args = runIdx >= 0 ? argv.slice(runIdx + 1) : argv.slice()
  const opts: HeadlessRunOptions = { json: false }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--json') {
      opts.json = true
    } else if (arg === '--conv' || arg === '--conversation' || arg === '--conversationId') {
      opts.conversationId = args[++i]
    } else if (arg.startsWith('--conv=')) {
      opts.conversationId = arg.slice('--conv='.length)
    } else if (arg === '--automation') {
      opts.automationId = args[++i]
    } else if (arg.startsWith('--automation=')) {
      opts.automationId = arg.slice('--automation='.length)
    }
  }
  if (!opts.conversationId && !opts.automationId) {
    throw new Error('run requires --conv <conversationId> or --automation <id>')
  }
  if (opts.conversationId && opts.automationId) {
    throw new Error('choose one: --conv or --automation')
  }
  return opts
}

export function isHeadlessCliArgv(argv: string[]): boolean {
  // `--lamprey-headless` is the pre-rename spelling; kept so existing shell aliases and
  // scheduled tasks keep working. `--duin-headless` is the documented flag.
  return (
    argv.includes('--duin-headless') || argv.includes('--lamprey-headless') || argv.includes('run')
  )
}

export async function runHeadlessFromArgv(argv: string[]): Promise<{
  result: HeadlessRunResult
  json: boolean
}> {
  const opts = parseHeadlessArgs(argv)
  const result = await runHeadless(opts)
  return { result, json: opts.json }
}

export async function runHeadless(opts: HeadlessRunOptions): Promise<HeadlessRunResult> {
  try {
    if (opts.conversationId) return await runConversationTurn(opts.conversationId)
    if (opts.automationId) return await runAutomationOnce(opts.automationId)
    return { success: false, error: 'missing headless target' }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function formatHeadlessResult(result: HeadlessRunResult, json: boolean): string {
  if (json) return JSON.stringify(result, null, 2)
  if (!result.success) return `Error: ${result.error}`
  if (result.mode === 'automation') {
    return [
      `Automation: ${result.label}`,
      'Status: success',
      `Duration: ${result.durationMs} ms`,
      result.lastResult ? `Result:\n${result.lastResult}` : 'Result: (no output recorded)'
    ].join('\n')
  }
  return [
    `Conversation: ${result.conversationId}`,
    `Model: ${result.model}`,
    `Duration: ${result.durationMs} ms`,
    '',
    result.output
  ].join('\n')
}

async function runConversationTurn(conversationId: string): Promise<HeadlessRunResult> {
  const conv = getConversation(conversationId)
  if (!conv) throw new Error('conversation not found')
  const startedAt = Date.now()
  const storedMessages = getMessages(conversationId)
  if (storedMessages.length === 0) {
    throw new Error('conversation has no messages to continue')
  }
  // Match the chat loop's DUIN_STABLE_PREFIX layout: headless turns on the
  // same conversation must produce the same message[0] bytes or they bust
  // the very cache the flag protects (A2b review fix, 2026-08-15).
  const stablePrefixLayout = process.env.DUIN_STABLE_PREFIX === '1'
  const memoryIndexBlock = buildMemoryIndexBlock()
  const systemPrompt = buildSystemPrompt(
    [],
    buildMemoryBlock(),
    undefined,
    '',
    conv.model,
    undefined,
    stablePrefixLayout ? undefined : memoryIndexBlock
  )
  const apiMessages = buildApiMessagesFromStoredMessages(
    systemPrompt,
    storedMessages,
    conv.model
  ) as ChatCompletionMessageParam[]
  if (stablePrefixLayout) {
    applyRuntimeSnapshotToApiMessages(
      apiMessages as Array<{ role: string; content?: unknown }>,
      { memoryIndexBlock }
    )
  }
  const result = await chatOnce(apiMessages, conv.model, undefined, {
    correlationId: randomUUID(),
    conversationId,
    purpose: 'main',
    role: 'headless'
  })
  const output = result.content
  const message = saveMessage({
    id: randomUUID(),
    conversationId,
    role: 'assistant',
    content: output,
    model: conv.model,
    // R2: headless runs preserve reasoning the model emitted on this call,
    // so the audit trail is consistent with interactive runs. Composer
    // pass + per-stage chips don't apply in headless mode.
    reasoning: result.reasoning
  })
  return {
    success: true,
    mode: 'conversation',
    conversationId,
    messageId: message.id,
    model: conv.model,
    output,
    durationMs: Date.now() - startedAt
  }
}

async function runAutomationOnce(automationId: string): Promise<HeadlessRunResult> {
  const before = getAutomation(automationId)
  if (!before) throw new Error('automation not found')
  const startedAt = Date.now()
  const outcome = await runAutomation(automationId)
  const after = getAutomation(automationId)
  // A FAILED AUTOMATION MUST NOT EXIT 0.
  //
  // runAutomation used to return void: runHeadlessAgent catches everything and RETURNS
  // {status:'error'}, so no exception ever reached here and this function reported
  // success:true unconditionally. formatHeadlessResult then printed 'Status: success' and
  // main.ts derived the exit code purely from result.success — so `duin run --automation`
  // wired into a scheduler or CI step stayed green forever while the job produced nothing
  // but a '[error] …' line only a human reading the Result block would ever see.
  if (outcome.status !== 'ok') {
    const detail = after?.lastResult ? `${outcome.error}\n${after.lastResult}` : outcome.error
    return { success: false, error: `automation ${outcome.status}: ${detail}` }
  }
  return {
    success: true,
    mode: 'automation',
    automationId,
    label: after?.label ?? before.label,
    lastResult: after?.lastResult ?? null,
    durationMs: Date.now() - startedAt
  }
}
