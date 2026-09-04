// executor-run — one delegated dsh run, end to end.
//
//   preflight (runtime staged, key present, shell probed)
//   → mint a per-run principal (context.read only) and register the run for /exec/hook
//   → write the composition, spawn the runtime under DUIN's own Node with an allowlisted env
//   → initialize, prompt once, consume events until the session goes idle
//   → ceilings: wall clock, stall, steps (each ends the run as `aborted` with its reason)
//   → stop ladder, revoke the principal, journal the outcome
//
// It is also a `ForkAgentRunner`, so `forkAgent` gives it a run id, an abort handle, the
// `agent_runs` row and the notify fan-out — the run appears in every existing surface with no
// new UI. Governance of the child's tool calls is NOT here: it happens synchronously per call
// in executor-callbacks.ts while the child waits.

import { join } from 'path'
import { getKey } from '../keychain'
import { openTurnJournal } from '../local-brain/agui-journal'
import { SAFE_CHILD_ENV_KEYS } from '../mcp-manager'
import { createPrincipal, setPrincipalStatus } from '../executive-api/principal-store'
import type { ForkAgentRunner, ForkAgentRunnerInput } from '../subagent-runner'
import type { AllowedTools } from '../subagent-types'
import { messageOf } from '../guarded'
import { DshChild, type SpawnFn } from './dsh-adapter'
import { EXEC_HOOK_PATH, registerExecutorRun, unregisterExecutorRun } from './executor-callbacks'
import {
  childPersona,
  composeDshCordisYml,
  describeRuntime,
  dshRuntimeBin,
  dshRuntimeDir,
  probeChildShell,
  probeDshRuntime,
  writeRunComposition
} from './executor-runtime'
import {
  DEFAULT_EXECUTOR_CEILINGS,
  emptyExecutorUsage,
  type ExecutorCeilings,
  type ExecutorEvent,
  type ExecutorRunResult,
  type ExecutorUsage
} from './executor-types'
import { describeMissing } from '../capability-requires'
import { costLine, executorCostOf, readExecutorBudgetUsd, shouldStopForBudget } from './executor-cost'
import { isUsableModel, resolveModel, routeWithinProvider } from '../providers/registry'

export const DSH_PROVIDER = 'deepseek-official'

/** The local brain's port, as server.ts binds it (DUIN_BRAIN_PORT, default 8799). Read here
 *  rather than imported so a tool pack never loads the 2,900-line server module at startup. */
export function localBrainPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.DUIN_BRAIN_PORT) || 8799
}

export interface DshRunRequest {
  runId: string
  task: string
  /** DUIN's operator context for the child's persona, or null. */
  brief: string | null
  worktreePath: string
  /** The DeepSeek model dsh initializes with — already mapped by `dshModelFor`. */
  model: string
  allowedTools: AllowedTools
  ceilings: ExecutorCeilings
  signal: AbortSignal
  conversationId?: string
  label: string
}

export interface DshRunDeps {
  spawn?: SpawnFn
  runtimeDir?: string
  getKey?: (provider: string) => string | null
  brainPort?: number
  execPath?: string
  env?: NodeJS.ProcessEnv
  /** Test seam: mint the run's principal. */
  mintPrincipal?: (runId: string) => { id: string; token: string }
  revokePrincipal?: (id: string) => void
  now?: () => number
  /** Test seam: extra variables for the child (a fake runtime's mode switch). Merged last. */
  extraChildEnv?: Record<string, string>
}

/** Registry view `dshModelFor` reads — injectable so the mapping is testable without keys. */
export interface DshModelView {
  usable: (modelId: string) => boolean
  providerOf: (modelId: string) => string
  /** The first keyed DeepSeek catalog model for tool-heavy work, or null when none. */
  routeDeepseek: () => string | null
}

const liveDshModelView: DshModelView = {
  usable: isUsableModel,
  providerOf: (id) => resolveModel(id).provider,
  routeDeepseek: () => routeWithinProvider('deepseek', 'agentic')
}

/** DUIN model id → the model dsh initializes with. The dsh runtime speaks only DeepSeek's API,
 *  so the requested engine is kept when it is a usable DeepSeek model and otherwise the
 *  `agentic` role is resolved WITHIN the DeepSeek family. Null when no DeepSeek model is
 *  usable — there is no shipped fallback id; the caller reports "add a DeepSeek key". */
export function dshModelFor(modelId: string | undefined, view: DshModelView = liveDshModelView): string | null {
  if (modelId && view.usable(modelId) && view.providerOf(modelId) === 'deepseek') return modelId
  return view.routeDeepseek()
}

function childEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const k of SAFE_CHILD_ENV_KEYS) {
    const v = base[k]
    if (typeof v === 'string') env[k] = v
  }
  return { ...env, ...extra }
}

export async function runDshExecutor(req: DshRunRequest, deps: DshRunDeps = {}): Promise<ExecutorRunResult> {
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()
  const env = deps.env ?? process.env
  const journal = openTurnJournal(req.runId, { kind: 'dsh', label: req.label, worktree: req.worktreePath })
  const usage: ExecutorUsage = emptyExecutorUsage()
  const finish = async (status: ExecutorRunResult['status'], reason: string | undefined, outputText: string, tally: { calls: number; denied: number }, sessionId: string): Promise<ExecutorRunResult> => {
    const result: ExecutorRunResult = { status, reason, outputText, usage, sessionId, toolCalls: tally.calls, deniedToolCalls: tally.denied, elapsedMs: Math.max(0, now() - startedAt) }
    await journal.close({ status, reason: reason ?? null, usage, toolCalls: tally.calls, deniedToolCalls: tally.denied, elapsedMs: result.elapsedMs })
    return result
  }
  const tally = { calls: 0, denied: 0 }
  const sessionId = req.runId

  // ── preflight ──────────────────────────────────────────────────────────────────────
  const runtimeDir = deps.runtimeDir ?? dshRuntimeDir(env)
  const runtime = probeDshRuntime(runtimeDir)
  if (!runtime.satisfied) {
    return finish('error', `dsh runtime is not staged: ${describeMissing(runtime)}`, '', tally, sessionId)
  }
  const keyOf = deps.getKey ?? getKey
  const apiKey = keyOf('deepseek')
  if (!apiKey) {
    return finish('error', 'no DeepSeek API key — add one in Settings → API Keys (provider: deepseek)', '', tally, sessionId)
  }
  const shell = probeChildShell(env)

  // ── principal + registration ──────────────────────────────────────────────────────
  const mint =
    deps.mintPrincipal ??
    ((runId: string) => {
      const r = createPrincipal({ name: `executor:${runId.slice(0, 8)}`, kind: 'cli-agent', planes: ['context.read'] })
      if (!r.ok) throw new Error(`could not mint the run's principal: ${r.reason}`)
      return { id: r.principal.id, token: r.token }
    })
  const revoke = deps.revokePrincipal ?? ((id: string) => void setPrincipalStatus(id, 'revoked'))
  let principal: { id: string; token: string }
  try {
    principal = mint(req.runId)
  } catch (err) {
    return finish('error', messageOf(err), '', tally, sessionId)
  }
  registerExecutorRun(req.runId, {
    principalId: principal.id,
    worktreePath: req.worktreePath,
    allowedTools: req.allowedTools,
    conversationId: req.conversationId,
    label: req.label,
    onDecision: (d) => {
      if (d.decision === 'deny') tally.denied++
      journal.note({ type: 'gate', toolName: d.toolName, decision: d.decision, classId: d.classId, source: d.source })
    }
  })

  // ── composition + spawn ───────────────────────────────────────────────────────────
  const port = deps.brainPort ?? localBrainPort(env)
  const hookUrl = `http://127.0.0.1:${port}${EXEC_HOOK_PATH}`
  const mcpUrl = `http://127.0.0.1:${port}/exec/mcp`
  // Writing the composition can throw (mkdir/writeFile on a locked dir, AV, disk full). It runs
  // AFTER the principal is minted and the run registered, so a throw here must clean BOTH up —
  // otherwise every failure strands an active credential and a live /exec/hook registration.
  let configPath: string
  let sessionRoot: string
  try {
    const yml = composeDshCordisYml({ shell, mcpUrl })
    const written = writeRunComposition(req.runId, yml)
    configPath = written.configPath
    sessionRoot = written.sessionRoot
  } catch (err) {
    unregisterExecutorRun(req.runId)
    revoke(principal.id)
    return finish('error', `could not prepare the delegated run: ${messageOf(err)}`, '', tally, sessionId)
  }
  const execPath = deps.execPath ?? process.execPath
  const spawnEnv = childEnv(env, {
    ELECTRON_RUN_AS_NODE: '1',
    DEEPSEEK_API_KEY: apiKey,
    DSH_CWD: req.worktreePath,
    DSH_SESSION_ROOT: sessionRoot,
    DSH_SYSTEM_PROMPT: childPersona(shell, req.brief),
    DSH_MODEL: req.model,
    DSH_CORDIS_CONFIG: configPath,
    DUIN_EXEC_URL: hookUrl,
    DUIN_EXEC_TOKEN: principal.token,
    DUIN_EXEC_RUN_ID: req.runId,
    ...(deps.extraChildEnv ?? {})
  })
  journal.note({ type: 'spawn', runtime: describeRuntime(runtimeDir), shell: shell.kind, model: req.model, hookUrl })

  let lastEventAt = now()
  let lastText = ''
  let promptAcked = false
  let idleAfterPrompt = false
  let endReason: string | null = null
  let resolveIdle: (() => void) | null = null
  const idle = new Promise<void>((r) => {
    resolveIdle = r
  })
  const onEvent = (ev: ExecutorEvent): void => {
    lastEventAt = now()
    journal.note({ type: 'event', ev })
    switch (ev.type) {
      case 'assistant.text':
        if (ev.sessionId === sessionId) lastText = ev.text
        break
      case 'usage':
        if (ev.sessionId === sessionId) {
          usage.steps++
          usage.inputTokens += ev.usage.inputTokens ?? 0
          usage.outputTokens += ev.usage.outputTokens ?? 0
          usage.cacheReadTokens += ev.usage.cacheReadTokens ?? 0
          usage.cacheWriteTokens += ev.usage.cacheWriteTokens ?? 0
          usage.reasoningTokens += ev.usage.reasoningTokens ?? 0
          if (usage.steps > req.ceilings.maxSteps && !endReason) {
            endReason = `max-steps (${req.ceilings.maxSteps})`
            resolveIdle?.()
          }
          // USD ceiling (off unless set). The child has already produced this step; the ceiling
          // stops the NEXT one, and the stop ladder ends the child. Meter always runs.
          const budgetUsd = req.ceilings.budgetUsd ?? readExecutorBudgetUsd(env)
          if (budgetUsd > 0 && !endReason) {
            const { spentUsd } = executorCostOf(req.model, usage)
            const b = shouldStopForBudget(spentUsd, budgetUsd)
            if (b.stop) {
              endReason = b.reason ?? 'cost-budget'
              resolveIdle?.()
            }
          }
        }
        break
      case 'tool.call':
        if (ev.sessionId === sessionId) tally.calls++
        break
      case 'turn.end':
        if (ev.sessionId === sessionId) {
          if (ev.reason !== 'completed' && !endReason) endReason = `turn ended: ${ev.reason}`
          // A completed turn IS the end of the work for our one prompt (one prompt → one turn on
          // this session; subagents are child sessions). Resolve on it rather than waiting only
          // for `status: idle` — if that trailing idle is delayed or dropped, the stall ceiling
          // would otherwise fire and THROW AWAY the child's real final text.
          else if (ev.reason === 'completed' && promptAcked && !endReason) {
            idleAfterPrompt = true
            resolveIdle?.()
          }
        }
        break
      case 'status':
        if (ev.sessionId === sessionId && ev.status === 'idle' && promptAcked) {
          idleAfterPrompt = true
          resolveIdle?.()
        }
        break
      case 'child.exit':
        if (!endReason && !idleAfterPrompt) endReason = `runtime exited (code ${ev.code ?? 'null'})`
        resolveIdle?.()
        break
      default:
        break
    }
  }

  let child: DshChild
  try {
    child = DshChild.launch({
      spec: { command: execPath, args: [dshRuntimeBin(runtimeDir), configPath], cwd: req.worktreePath, env: spawnEnv },
      onEvent,
      // A request (initialize / prompt / shutdown) may not outlive the run's own clock.
      requestTimeoutMs: Math.max(5_000, Math.min(60_000, req.ceilings.wallclockMs)),
      spawn: deps.spawn
    })
  } catch (err) {
    unregisterExecutorRun(req.runId)
    revoke(principal.id)
    return finish('error', `could not spawn the dsh runtime: ${messageOf(err)}`, '', tally, sessionId)
  }

  // ── ceilings ──────────────────────────────────────────────────────────────────────
  const onAbort = (): void => {
    if (!endReason) endReason = `aborted: ${String(req.signal.reason ?? 'parent')}`
    resolveIdle?.()
  }
  if (req.signal.aborted) onAbort()
  else req.signal.addEventListener('abort', onAbort, { once: true })
  const wallclock = setTimeout(() => {
    if (!endReason) endReason = `wallclock (${req.ceilings.wallclockMs} ms)`
    resolveIdle?.()
  }, req.ceilings.wallclockMs)
  // Checked at half the stall ceiling (bounded 50 ms .. 5 s) so a short ceiling is honoured
  // promptly and a long one costs nothing.
  const stall = setInterval(() => {
    if (!endReason && now() - lastEventAt > req.ceilings.stallMs) {
      endReason = `stalled (no event for ${req.ceilings.stallMs} ms)`
      resolveIdle?.()
    }
  }, Math.max(50, Math.min(5_000, Math.floor(req.ceilings.stallMs / 2))))

  // ── drive ─────────────────────────────────────────────────────────────────────────
  try {
    if (!endReason) {
      await child.initialize({ cwd: req.worktreePath, provider: DSH_PROVIDER, model: req.model, maxTokens: req.ceilings.maxTokens })
      journal.note({ type: 'initialized' })
    }
    if (!endReason) {
      // Mark the prompt in flight BEFORE awaiting its receipt. The receipt and the child's
      // `turn/end` + `status: idle` can arrive in ONE stdout chunk, and readline delivers every
      // line of a chunk synchronously — so with the flag set only after `await`, both completion
      // handlers ran while it was still false and the run waited out the stall ceiling for an
      // idle that had already passed (reproduced on Windows and Linux under a busy parent). A
      // rejected receipt still lands in the catch below and sets endReason.
      const receipt = child.prompt(sessionId, req.task)
      promptAcked = true
      await receipt
      journal.note({ type: 'prompted' })
    }
    if (!endReason) await idle
  } catch (err) {
    if (!endReason) endReason = `runtime error: ${messageOf(err)}`
  } finally {
    clearTimeout(wallclock)
    clearInterval(stall)
    req.signal.removeEventListener('abort', onAbort)
    await child.stop()
    unregisterExecutorRun(req.runId)
    revoke(principal.id)
  }

  if (idleAfterPrompt && !endReason) return finish('done', undefined, lastText, tally, sessionId)
  const reason = endReason ?? 'ended without going idle'
  // A ceiling breach is a deliberate stop (aborted), not a failure (error). `cost-budget` is one
  // of them — it was missing here, so a budget stop mislabeled itself as an error.
  const status: ExecutorRunResult['status'] = /^(aborted|wallclock|stalled|max-steps|cost-budget)/.test(reason) ? 'aborted' : 'error'
  return finish(status, reason, lastText, tally, sessionId)
}

/** The task is the fork's user message; the system prompt (subagent type) becomes DUIN's brief. */
export function splitForkMessages(messages: ForkAgentRunnerInput['messages']): { task: string; brief: string | null } {
  let task = ''
  let brief: string | null = null
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p) => ('text' in p && typeof p.text === 'string' ? p.text : '')).join('') : ''
    if (m.role === 'user') task = content
    else if (m.role === 'system' && content.trim()) brief = content
  }
  return { task, brief }
}

export function summarize(res: ExecutorRunResult, model: string): string {
  const u = res.usage
  const usageLine = `usage: ${u.steps} steps, ${u.inputTokens} in (+${u.cacheReadTokens} cached), ${u.outputTokens} out, ${u.reasoningTokens} reasoning; tools: ${res.toolCalls} called, ${res.deniedToolCalls} denied; ${costLine(model, u)}; ${Math.round(res.elapsedMs / 1000)}s`
  return `${res.outputText || '(the executor produced no final text)'}\n\n[dsh executor · ${res.status}${res.reason ? ` · ${res.reason}` : ''} · ${usageLine}]`
}

/**
 * `forkAgent`-compatible runner. Requires worktree isolation: a delegated child never works in
 * the operator's live tree. A run that ends `aborted`/`error` is thrown so `agent_runs` and the
 * notify fan-out record it as such (forkAgent maps the throw).
 */
export const dshForkRunner: ForkAgentRunner = async (input) => {
  if (!input.worktreePath) throw new Error('dsh executor requires isolation: "worktree" (no worktreePath on the run)')
  const { task, brief } = splitForkMessages(input.messages)
  if (!task.trim()) throw new Error('dsh executor: empty task')
  // The fork's engine mapped into the DeepSeek family the dsh runtime can drive.
  const model = dshModelFor(input.modelId)
  if (!model) throw new Error('dsh executor: no usable DeepSeek model — add a DeepSeek API key (Settings → API Keys)')
  const res = await runDshExecutor({
    runId: input.runId,
    task,
    brief,
    worktreePath: input.worktreePath,
    model,
    allowedTools: input.allowedTools,
    ceilings: DEFAULT_EXECUTOR_CEILINGS,
    signal: input.signal,
    label: input.agentType
  })
  if (res.status !== 'done') throw new Error(summarize(res, model))
  return { output: summarize(res, model) }
}
