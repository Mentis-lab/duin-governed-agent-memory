// dsh-adapter — DUIN's client for the DeepSeek Harness headless runtime.
//
// The child speaks newline-delimited JSON-RPC 2.0 over stdio (`@deepseek-ai/dsh-sdk-protocol`
// 0.1.1-rc.2): `initialize` / `session/prompt` / `shutdown` requests from us, and
// `session.event` / `session.status` / `subagent.*` notifications from it. This module owns the
// wire and nothing else: it maps the harness's session vocabulary onto `ExecutorEvent` and it
// knows how to stop the child. Governance, ceilings and the record live in executor-run.ts.
//
// Two facts about the runtime shape everything here (verified against the source, 2026-08-27):
//   · there is NO cancel on the wire — a run is abandoned by stopping the process, in a ladder:
//     `shutdown` → stdin EOF → SIGTERM → SIGKILL (the runtime did not exit on `shutdown`
//     alone in the boot spike, so the ladder is required, not optional);
//   · the session vocabulary IS the wire contract and carries no version — unknown event types
//     are surfaced as `other`, never fatal, and the first frame's shape is what a reader gets.

import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'child_process'
import { createInterface } from 'readline'
import type { ExecutorEvent, ExecutorUsage } from './executor-types'

export interface DshSpawnSpec {
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
}

export type SpawnFn = (command: string, args: string[], opts: SpawnOptions) => ChildProcess

export interface DshInitializeParams {
  cwd: string
  provider: string
  model: string
  maxTokens?: number
}

export interface DshChildOptions {
  spec: DshSpawnSpec
  onEvent: (event: ExecutorEvent) => void
  /** Per-request timeout for `initialize` / `session/prompt` / `shutdown`. The caller sets it
   *  from the run's own clock; there is no default to forget. */
  requestTimeoutMs: number
  /** Test seam. */
  spawn?: SpawnFn
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: NodeJS.Timeout
}

/** The stop ladder's waits, in order: after `shutdown`, after stdin EOF, after SIGTERM. */
export const STOP_LADDER_MS = { shutdown: 1_500, eof: 3_000, term: 3_000 } as const

// ── event mapping ───────────────────────────────────────────────────────────────────

interface ContentBlock {
  type?: string
  text?: string
  toolCallId?: string
  isError?: boolean
  content?: ContentBlock[]
}

function textOf(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return (blocks as ContentBlock[])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('')
}

function usageOf(u: unknown): Partial<ExecutorUsage> | null {
  if (!u || typeof u !== 'object') return null
  const r = u as Record<string, unknown>
  const num = (k: string): number | undefined => (typeof r[k] === 'number' ? (r[k] as number) : undefined)
  return {
    inputTokens: num('inputTokens') ?? 0,
    outputTokens: num('outputTokens') ?? 0,
    cacheReadTokens: num('cacheReadTokens') ?? 0,
    cacheWriteTokens: num('cacheWriteTokens') ?? 0,
    reasoningTokens: num('reasoningTokens') ?? 0
  }
}

/**
 * One dsh `session.event` → zero or more `ExecutorEvent`s. Pure; exported for tests.
 * `assistant/message` yields the step's text AND its usage (dsh reports usage per step on that
 * event — "there is no separate usage record").
 */
export function mapSessionEvent(sessionId: string, ev: unknown): ExecutorEvent[] {
  if (!ev || typeof ev !== 'object') return []
  const e = ev as { type?: unknown; data?: unknown }
  const type = typeof e.type === 'string' ? e.type : ''
  const data = (e.data && typeof e.data === 'object' ? e.data : {}) as Record<string, unknown>
  const step = typeof data.step === 'number' ? data.step : 0
  switch (type) {
    case 'assistant/message': {
      const out: ExecutorEvent[] = []
      const message = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>
      const text = textOf(message.content)
      if (text) out.push({ type: 'assistant.text', sessionId, step, text })
      const usage = usageOf(data.usage)
      if (usage) out.push({ type: 'usage', sessionId, step, usage })
      return out
    }
    case 'tool/call':
      return [
        {
          type: 'tool.call',
          sessionId,
          callId: String(data.callId ?? ''),
          name: String(data.name ?? ''),
          args: typeof data.arguments === 'string' ? data.arguments : JSON.stringify(data.arguments ?? {})
        }
      ]
    case 'tool/result': {
      const message = (data.message && typeof data.message === 'object' ? data.message : {}) as Record<string, unknown>
      const blocks = Array.isArray(message.content) ? (message.content as ContentBlock[]) : []
      const tr = blocks.find((b) => b && b.type === 'tool-result')
      const ok = !data.error && !(tr && tr.isError)
      return [
        {
          type: 'tool.result',
          sessionId,
          callId: String(tr?.toolCallId ?? data.callId ?? ''),
          ok,
          text: tr ? textOf(tr.content) : textOf(message.content)
        }
      ]
    }
    case 'turn/end': {
      const reason = data.reason && typeof data.reason === 'object' ? (data.reason as { kind?: unknown }).kind : undefined
      return [{ type: 'turn.end', sessionId, reason: typeof reason === 'string' ? reason : 'unknown' }]
    }
    default:
      return [{ type: 'other', sessionId, eventType: type || 'unknown' }]
  }
}

// ── the child ───────────────────────────────────────────────────────────────────────

export class DshChild {
  private readonly child: ChildProcess
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private readonly requestTimeoutMs: number
  private readonly onEvent: (event: ExecutorEvent) => void
  private exitInfo: { code: number | null; signal: string | null } | null = null
  readonly exited: Promise<{ code: number | null; signal: string | null }>

  private constructor(child: ChildProcess, opts: DshChildOptions) {
    this.child = child
    this.onEvent = opts.onEvent
    this.requestTimeoutMs = opts.requestTimeoutMs

    this.exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        this.exitInfo = { code, signal: signal ?? null }
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error(`dsh runtime exited (code ${code ?? 'null'}, signal ${signal ?? 'none'}) before replying`))
        }
        this.pending.clear()
        this.safeEmit({ type: 'child.exit', code, signal: signal ?? null })
        resolve({ code, signal: signal ?? null })
      })
    })
    child.once('error', (err) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(err)
      }
      this.pending.clear()
      this.safeEmit({ type: 'child.stderr', line: `spawn error: ${err.message}` })
    })

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => this.onLine(line))
    }
    if (child.stderr) {
      const rl = createInterface({ input: child.stderr })
      rl.on('line', (line) => this.safeEmit({ type: 'child.stderr', line }))
    }
  }

  static launch(opts: DshChildOptions): DshChild {
    const spawnFn = opts.spawn ?? nodeSpawn
    const child = spawnFn(opts.spec.command, opts.spec.args, {
      cwd: opts.spec.cwd,
      env: opts.spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    return new DshChild(child, opts)
  }

  get pid(): number | undefined {
    return this.child.pid ?? undefined
  }

  get hasExited(): boolean {
    return this.exitInfo !== null
  }

  private safeEmit(event: ExecutorEvent): void {
    try {
      this.onEvent(event)
    } catch (err) {
      console.error('[dsh-adapter] onEvent threw (continuing):', err)
    }
  }

  private onLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // Not a frame. The runtime promises stdout is protocol-only; anything else is a
      // misbehaving sibling logger — keep it visible, never fatal.
      this.safeEmit({ type: 'child.stderr', line: `[stdout, not JSON] ${trimmed.slice(0, 300)}` })
      return
    }
    if (typeof msg.id === 'number' && !msg.method) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) {
        const e = msg.error as { code?: unknown; message?: unknown }
        p.reject(new Error(`dsh ${String(e.code ?? '')}: ${String(e.message ?? 'error')}`.trim()))
      } else {
        p.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string' && msg.id === undefined) {
      this.onNotification(msg.method, msg.params)
    }
  }

  private onNotification(method: string, params: unknown): void {
    const p = (params && typeof params === 'object' ? params : {}) as Record<string, unknown>
    const sessionId = typeof p.sessionId === 'string' ? p.sessionId : ''
    if (method === 'session.event') {
      for (const ev of mapSessionEvent(sessionId, p.event)) this.safeEmit(ev)
      return
    }
    if (method === 'session.status') {
      const status = p.status === 'idle' || p.status === 'running' ? p.status : null
      if (status) this.safeEmit({ type: 'status', sessionId, status })
      return
    }
    this.safeEmit({ type: 'other', sessionId: typeof p.parentSessionId === 'string' ? p.parentSessionId : sessionId, eventType: method })
  }

  private request<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    if (this.exitInfo) return Promise.reject(new Error('dsh runtime has exited'))
    const id = this.nextId++
    const frame = params === undefined ? { jsonrpc: '2.0', id, method } : { jsonrpc: '2.0', id, method, params }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`dsh ${method} timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer })
      const ok = this.child.stdin?.write(JSON.stringify(frame) + '\n')
      if (ok === false) {
        // Backpressure is fine; a closed stdin is not.
        if (this.child.stdin?.destroyed) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new Error('dsh runtime stdin is closed'))
        }
      }
    })
  }

  initialize(params: DshInitializeParams): Promise<{ serverInfo: { name: string; version: string } }> {
    return this.request('initialize', params)
  }

  /** Enqueue one user message; the reply is only a receipt — the work streams as events. */
  prompt(sessionId: string, text: string): Promise<{ messageId: string }> {
    return this.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text }] })
  }

  /** The polite half of the ladder: returns true when the runtime acknowledged. */
  async shutdown(timeoutMs = STOP_LADDER_MS.shutdown): Promise<boolean> {
    try {
      await this.request('shutdown', undefined, timeoutMs)
      return true
    } catch {
      return false
    }
  }

  private waitExit(ms: number): Promise<boolean> {
    if (this.exitInfo) return Promise.resolve(true)
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms)
      void this.exited.then(() => {
        clearTimeout(t)
        resolve(true)
      })
    })
  }

  /**
   * The stop ladder. Each rung is skipped once the child is gone. Always resolves; the child
   * is dead when it does (or SIGKILL was sent, which on Windows is TerminateProcess).
   */
  async stop(): Promise<void> {
    if (this.exitInfo) return
    await this.shutdown()
    if (await this.waitExit(STOP_LADDER_MS.shutdown)) return
    try {
      this.child.stdin?.end()
    } catch {
      /* already closed */
    }
    if (await this.waitExit(STOP_LADDER_MS.eof)) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      /* already gone */
    }
    if (await this.waitExit(STOP_LADDER_MS.term)) return
    try {
      this.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
    await this.waitExit(2_000)
  }
}
