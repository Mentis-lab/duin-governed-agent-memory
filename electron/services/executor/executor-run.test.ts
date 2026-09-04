import { describe, it, expect, beforeAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { EventEmitter } from 'events'
import { PassThrough, Writable } from 'stream'
import type { ChildProcess } from 'child_process'
import { runDshExecutor, dshModelFor, splitForkMessages, localBrainPort } from './executor-run'
import type { SpawnFn } from './dsh-adapter'
import { dshRuntimeRequirements, dshRuntimeBin } from './executor-runtime'
import { DEFAULT_EXECUTOR_CEILINGS } from './executor-types'
import { liveExecutorRunIds } from './executor-callbacks'

// One delegated run end to end against the fake runtime: preflight refusals, the happy path,
// and each ceiling ending the run as `aborted` with its reason. Principal minting and the key
// are injected; the child really is spawned (process.execPath = node here, DUIN.exe in the app).

const FIXTURE = join(__dirname, '__fixtures__', 'fake-dsh-runtime.cjs')
let runtimeDir: string
let worktree: string

beforeAll(() => {
  runtimeDir = mkdtempSync(join(tmpdir(), 'dsh-runtime-'))
  for (const r of dshRuntimeRequirements(runtimeDir)) {
    if (r.kind !== 'file') continue
    mkdirSync(dirname(r.path), { recursive: true })
    writeFileSync(r.path, '')
  }
  // the entry IS the fake runtime
  copyFileSync(FIXTURE, dshRuntimeBin(runtimeDir))
  worktree = mkdtempSync(join(tmpdir(), 'dsh-wt-'))
})

const principals: string[] = []
const revoked: string[] = []
function deps(extra: Record<string, string> = {}, over: Record<string, unknown> = {}) {
  return {
    runtimeDir,
    getKey: () => 'sk-test',
    execPath: process.execPath,
    brainPort: 8799,
    mintPrincipal: (runId: string) => {
      principals.push(runId)
      return { id: `prin-${runId}`, token: 'tok' }
    },
    revokePrincipal: (id: string) => {
      revoked.push(id)
    },
    extraChildEnv: extra,
    ...over
  }
}
function req(runId: string, ceilings = DEFAULT_EXECUTOR_CEILINGS) {
  return { runId, task: 'write hello.txt', brief: null, worktreePath: worktree, model: 'deepseek-v4-flash', allowedTools: '*' as const, ceilings, signal: new AbortController().signal, label: 'test' }
}

describe('runDshExecutor', () => {
  it('refuses before spawning when the runtime is not staged or the key is missing', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
    const r1 = await runDshExecutor(req('r-unstaged'), deps({}, { runtimeDir: empty }))
    expect(r1.status).toBe('error')
    expect(r1.reason).toMatch(/not staged/)
    const r2 = await runDshExecutor(req('r-nokey'), deps({}, { getKey: () => null }))
    expect(r2.status).toBe('error')
    expect(r2.reason).toMatch(/DeepSeek API key/)
    expect(principals).not.toContain('r-unstaged')
  })

  it('happy path: done, final text, usage summed, tools counted, principal minted then revoked, run unregistered', async () => {
    const res = await runDshExecutor(req('r-happy'), deps({ FAKE_DSH_MODE: 'happy' }))
    expect(res.status).toBe('done')
    expect(res.outputText).toBe('Done: wrote hello.txt')
    expect(res.usage).toMatchObject({ steps: 1, inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, reasoningTokens: 5 })
    expect(res.toolCalls).toBe(1)
    expect(res.sessionId).toBe('r-happy')
    expect(principals).toContain('r-happy')
    expect(revoked).toContain('prin-r-happy')
    expect(liveExecutorRunIds()).not.toContain('r-happy')
  }, 30_000)

  it('a silent child trips the stall ceiling and ends aborted', async () => {
    const res = await runDshExecutor(req('r-stall', { ...DEFAULT_EXECUTOR_CEILINGS, stallMs: 400, wallclockMs: 20_000 }), deps({ FAKE_DSH_MODE: 'stall' }))
    expect(res.status).toBe('aborted')
    expect(res.reason).toMatch(/stalled/)
    expect(revoked).toContain('prin-r-stall')
  }, 30_000)

  it('too many steps trips the step ceiling', async () => {
    const res = await runDshExecutor(req('r-steps', { ...DEFAULT_EXECUTOR_CEILINGS, maxSteps: 2 }), deps({ FAKE_DSH_MODE: 'chatty', FAKE_DSH_STEPS: '6' }))
    expect(res.status).toBe('aborted')
    expect(res.reason).toMatch(/max-steps/)
  }, 30_000)

  it('the wall clock trips on a child that never goes idle', async () => {
    const res = await runDshExecutor(req('r-wall', { ...DEFAULT_EXECUTOR_CEILINGS, wallclockMs: 500, stallMs: 60_000 }), deps({ FAKE_DSH_MODE: 'stall' }))
    expect(res.status).toBe('aborted')
    expect(res.reason).toMatch(/wallclock/)
  }, 30_000)

  it('a parent abort ends the run as aborted and stops the child', async () => {
    const ac = new AbortController()
    const p = runDshExecutor({ ...req('r-abort', { ...DEFAULT_EXECUTOR_CEILINGS, stallMs: 60_000 }), signal: ac.signal }, deps({ FAKE_DSH_MODE: 'stall' }))
    setTimeout(() => ac.abort('user-cancel'), 300)
    const res = await p
    expect(res.status).toBe('aborted')
    expect(res.reason).toMatch(/aborted: user-cancel/)
  }, 30_000)

  it('an initialize error is reported as error, not a hang', async () => {
    const res = await runDshExecutor(req('r-badinit'), deps({ FAKE_DSH_BAD_INIT: '1' }))
    expect(res.status).toBe('error')
    expect(res.reason).toMatch(/init failed on purpose/)
  }, 30_000)

  it('F5: a completed turn with NO trailing idle still finishes done, keeping the output', async () => {
    const res = await runDshExecutor(req('r-noidle', { ...DEFAULT_EXECUTOR_CEILINGS, stallMs: 60_000 }), deps({ FAKE_DSH_MODE: 'noidle' }))
    expect(res.status).toBe('done')
    expect(res.outputText).toBe('Done: wrote hello.txt')
  }, 30_000)

  it('F6: a USD-budget breach ends the run ABORTED (not error) with a cost-budget reason', async () => {
    // A tiny budget the first step's usage exceeds. The fixture reports real token counts, so the
    // meter accrues and the ceiling fires.
    const res = await runDshExecutor(
      req('r-budget', { ...DEFAULT_EXECUTOR_CEILINGS, budgetUsd: 1e-9, stallMs: 60_000 }),
      deps({ FAKE_DSH_MODE: 'chatty', FAKE_DSH_STEPS: '4' })
    )
    expect(res.status).toBe('aborted')
    expect(res.reason).toMatch(/cost-budget/)
  }, 30_000)

  it('a prompt receipt that shares ONE stdout chunk with turn/end + idle still finishes done', async () => {
    // The CI race (A7 F3). The real child writes its receipt first and the events later, but the
    // parent can read them in one pipe chunk when it was busy in between (a fresh vitest worker,
    // a stalled main process). readline then emits every line of that chunk synchronously, so
    // `turn/end` and `status: idle` are handled BEFORE the `await child.prompt()` continuation
    // runs. With `promptAcked` set only after the await, both handlers ignored the completion
    // and the run sat until the stall ceiling. This fake child makes the coalescing deterministic
    // through the `deps.spawn` seam — no timing luck, no real process.
    const res = await runDshExecutor(
      req('r-coalesced', { ...DEFAULT_EXECUTOR_CEILINGS, stallMs: 1_000, wallclockMs: 10_000 }),
      deps({}, { spawn: coalescedSpawn })
    )
    expect({ status: res.status, reason: res.reason }).toEqual({ status: 'done', reason: undefined })
    expect(res.outputText).toBe('Done: coalesced')
    expect(res.usage.steps).toBe(1)
    expect(revoked).toContain('prin-r-coalesced')
  }, 30_000)
})

/**
 * A fake dsh child that answers `session/prompt` with the receipt, `status: running`, one
 * assistant step, `turn/end` and `status: idle` in a SINGLE stdout write. Speaks just enough of
 * the wire (initialize / session/prompt / shutdown) for the run loop and the stop ladder.
 */
const coalescedSpawn: SpawnFn = () => {
  const child = new EventEmitter() as EventEmitter & ChildProcess
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let exited = false
  const exit = (code: number): void => {
    if (exited) return
    exited = true
    stdout.end()
    stderr.end()
    child.emit('exit', code, null)
    child.emit('close', code, null)
  }
  const frame = (o: unknown): string => JSON.stringify(o)
  // A real child answers on its own clock: the parent's stdin.write returns first and the
  // reply lands in a later I/O callback. A PassThrough would otherwise emit the reply
  // synchronously INSIDE stdin.write, which no pipe can do and which the drive loop is not
  // written for. setImmediate keeps the fake honest: one chunk, one later turn of the loop.
  const reply = (text: string): void => {
    setImmediate(() => stdout.write(text))
  }
  let buffered = ''
  const stdin = new Writable({
    write(chunk, _enc, cb) {
      buffered += chunk.toString()
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        let msg: { id?: number; method?: string; params?: { sessionId?: string } }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        if (msg.method === 'initialize') {
          reply(frame({ jsonrpc: '2.0', id: msg.id, result: { serverInfo: { name: 'fake-coalesced', version: '0' } } }) + '\n')
        } else if (msg.method === 'session/prompt') {
          const sid = msg.params?.sessionId ?? ''
          const ev = (type: string, data: unknown): string =>
            frame({ jsonrpc: '2.0', method: 'session.event', params: { sessionId: sid, event: { type, seq: 0, time: 0, data } } })
          const lines = [
            frame({ jsonrpc: '2.0', id: msg.id, result: { messageId: 'msg-1' } }),
            frame({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'running' } }),
            ev('assistant/message', {
              turn: 1,
              step: 1,
              message: { role: 'assistant', content: [{ type: 'text', text: 'Done: coalesced' }] },
              usage: { inputTokens: 1, outputTokens: 1 }
            }),
            ev('turn/end', { turn: 1, reason: { kind: 'completed' } }),
            frame({ jsonrpc: '2.0', method: 'session.status', params: { sessionId: sid, status: 'idle' } })
          ]
          // ONE chunk: the receipt and the whole completion land in the same readline burst.
          reply(lines.join('\n') + '\n')
        } else if (msg.method === 'shutdown') {
          reply(frame({ jsonrpc: '2.0', id: msg.id, result: {} }) + '\n')
          setImmediate(() => setImmediate(() => exit(0)))
        }
      }
      cb()
    },
    final(cb) {
      setImmediate(() => exit(0))
      cb()
    }
  })
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    pid: 424242,
    exitCode: null,
    kill: () => {
      exit(0)
      return true
    }
  })
  return child
}

describe('helpers', () => {
  it('dshModelFor keeps a usable DeepSeek id, otherwise routes the agentic role WITHIN DeepSeek, and never invents a fallback', () => {
    const providers: Record<string, string> = { 'deepseek-v4-pro': 'deepseek', 'glm-5.3': 'zhipu', 'deepseek-dead': 'deepseek' }
    const view = {
      usable: (id: string) => id !== 'deepseek-dead',
      providerOf: (id: string) => providers[id] ?? 'deepseek',
      routeDeepseek: () => 'deepseek-routed'
    }
    expect(dshModelFor('deepseek-v4-pro', view)).toBe('deepseek-v4-pro') // usable DeepSeek pin is kept
    expect(dshModelFor('glm-5.3', view)).toBe('deepseek-routed') // other family → routed within DeepSeek
    expect(dshModelFor('deepseek-dead', view)).toBe('deepseek-routed') // unusable DeepSeek id → routed
    expect(dshModelFor(undefined, view)).toBe('deepseek-routed')
    // No key → nothing usable in the family → null (the caller reports "add a DeepSeek key").
    expect(dshModelFor('glm-5.3', { ...view, routeDeepseek: () => null })).toBeNull()
  })
  it('splitForkMessages takes the user turn as the task and the system prompt as the brief', () => {
    expect(splitForkMessages([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'do X' }])).toEqual({ task: 'do X', brief: 'be brief' })
  })
  it('localBrainPort follows DUIN_BRAIN_PORT', () => {
    expect(localBrainPort({})).toBe(8799)
    expect(localBrainPort({ DUIN_BRAIN_PORT: '9001' })).toBe(9001)
  })
})
