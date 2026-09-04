// delegate_task — the agent-facing door to the external executor.
//
// Gated as spawn-recursive (agui-guard / agui-approval) and floored for unattended runs by its
// own descriptor (`requiresApproval: true`, `risks: ['sandboxBypass']` — a child harness is
// shell access by definition), so: `interactive` prompts, `review` prompts, `trusted-afk`
// refuses. That is the decided CAP stance made concrete; nothing here loosens a gate.
//
// The run goes through `forkAgent` so it gets a run id, an abort handle, the `agent_runs`
// row and the notify fan-out — it appears in BackgroundTasksPanel, the task graph and the
// next turn's <task-notifications> block with no new UI. Isolation is a git worktree, always
// (plan Q4): the child never touches the operator's live tree; what it produces is a branch.

import { join } from 'path'
import { app } from 'electron'
import { toolRegistry } from '../tool-registry'
import { forkAgent, SUBAGENT_MAX_TIMEOUT_MS } from '../subagent-runner'
import type { SubagentTypeDef } from '../subagent-types'
import { realAgentRunStore } from '../agent-run-store'
import { createAgentWorktreeManager } from '../worktree-runner'
import { getKey } from '../keychain'
import { describeMissing } from '../capability-requires'
import { messageOf } from '../guarded'
import { dshForkRunner, dshModelFor } from './executor-run'
import { probeDshRuntime } from './executor-runtime'
import { isExecutorKind } from './executor-types'
import { executorNotify } from './executor-notify'
import { onExecutorRunSettled } from './executor-review'
import type { AgentRunNotifyEvent } from '../subagent-runner'

/** The subagent type a delegated run wears. Its systemPrompt becomes the child's brief. */
export const DSH_SUBAGENT_TYPE: SubagentTypeDef = {
  name: 'dsh',
  description: 'DeepSeek Harness executor: a coding harness run as a governed child process in an isolated worktree.',
  allowedTools: ['read_file', 'write_file', 'edit_file', 'run_command', 'update_plan'],
  systemPrompt: 'You are completing one bounded engineering task for the operator. Prefer small, verifiable changes; run the project\'s own checks when a shell is available; report what you changed and what you could not verify.',
  source: 'builtin'
}

export function executorWorktreesRoot(): string {
  try {
    return join(app.getPath('userData'), 'executor-worktrees')
  } catch {
    return join(process.cwd(), '.executor-worktrees')
  }
}

toolRegistry.registerNative(
  {
    id: 'delegate_task',
    name: 'delegate_task',
    title: 'Delegate task to an executor',
    description:
      'Delegate one bounded coding task to an external executor (currently the DeepSeek Harness, "dsh") that runs as a governed child process in an isolated git worktree of the workspace. DUIN decides every tool call the executor makes. Returns the result text, usage, and the worktree branch when the executor left changes. Use for self-contained implementation or verification work; keep the task specific.',
    providerKind: 'native',
    providerId: 'internal',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete task for the executor, with acceptance criteria.' },
        executor: { type: 'string', enum: ['dsh'], description: 'Which executor. Only "dsh" exists.' },
        cwd: { type: 'string', description: 'Repository to fork the worktree from. Defaults to the active workspace.' },
        background: { type: 'boolean', description: 'Return immediately with the run id; the result arrives as a task notification.' },
        timeoutMs: { type: 'number', description: `Wall clock for the run in ms (max ${SUBAGENT_MAX_TIMEOUT_MS}).` }
      },
      required: ['task'],
      additionalProperties: false
    },
    risks: ['sandboxBypass'],
    requiresApproval: true,
    enabled: true,
    mutates: true,
    parallelizable: false
  },
  async (args, ctx) => {
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) throw new Error('delegate_task: task is required')
    const kind = args.executor ?? 'dsh'
    if (!isExecutorKind(kind)) throw new Error(`delegate_task: unknown executor '${String(kind)}'`)
    const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : ctx.workspacePath
    if (!cwd) throw new Error('delegate_task: no workspace to fork a worktree from')

    const runtime = probeDshRuntime()
    if (!runtime.satisfied) throw new Error(`delegate_task: the dsh runtime is not staged — ${describeMissing(runtime)}`)
    if (!getKey('deepseek')) throw new Error('delegate_task: no DeepSeek API key (Settings → API Keys, provider: deepseek)')
    // The child's engine: the parent turn's model when it is a usable DeepSeek model, else the
    // `agentic` role resolved within the DeepSeek family (the only family dsh can drive).
    const model = dshModelFor(ctx.model)
    if (!model) throw new Error('delegate_task: no usable DeepSeek model for the agentic role')

    const timeoutMs = typeof args.timeoutMs === 'number' && args.timeoutMs > 0 ? Math.min(args.timeoutMs, SUBAGENT_MAX_TIMEOUT_MS) : SUBAGENT_MAX_TIMEOUT_MS
    const background = args.background === true
    const handle = forkAgent(
      {
        prompt: task,
        agentType: 'dsh',
        label: `dsh: ${task.slice(0, 60)}`,
        parentConvId: ctx.conversationId ?? null,
        runInBackground: background,
        isolation: 'worktree',
        timeoutMs,
        signal: background ? undefined : ctx.signal
      },
      {
        runner: dshForkRunner,
        model,
        loadType: (name) => (name === 'dsh' ? DSH_SUBAGENT_TYPE : null),
        agentRunStore: realAgentRunStore,
        // The app fan-out AND the review raise. A settled run whose worktree still holds changes
        // (forkAgent's finalize stamped worktreePath) becomes a keep/discard decision the operator
        // gets — the review needs baseCwd, which is `cwd` here, so this is the seam that has both.
        notify: (ev: AgentRunNotifyEvent) => {
          executorNotify(ev)
          if (ev.status !== 'running' && ev.worktreePath) {
            void onExecutorRunSettled({ runId: ev.runId, label: ev.label, worktreePath: ev.worktreePath, baseCwd: cwd })
          }
        },
        worktreeManager: createAgentWorktreeManager({ baseCwd: cwd, workspacesRoot: executorWorktreesRoot() })
      }
    )

    if (background) {
      handle.promise.catch(() => {
        /* recorded on agent_runs + notified; nothing to do here */
      })
      return JSON.stringify({ runId: handle.runId, status: 'running', background: true })
    }
    try {
      const result = await handle.promise
      return JSON.stringify({ runId: result.runId, status: 'done', output: result.rawOutput, elapsedMs: result.elapsedMs })
    } catch (err) {
      return { result: `Error: delegated run ${handle.runId} failed: ${messageOf(err)}`, status: 'error' }
    }
  }
)
