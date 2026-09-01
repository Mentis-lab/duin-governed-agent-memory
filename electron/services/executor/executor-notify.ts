// executor-notify — the run-event fan-out, as a seam.
//
// `broadcastAgentRunEvent` lives in electron/ipc/tasks.ts (it needs webContents), and services
// never import ipc. So the ipc layer registers the fan-out here at startup, and the executor's
// runs reach BackgroundTasksPanel, the task graph, `wait_tasks` and the next turn's
// <task-notifications> block through exactly the path every other agent run uses. Until it is
// registered (tests, headless), events are dropped, never thrown.

import type { AgentRunNotifyEvent } from '../subagent-runner'

let sink: ((event: AgentRunNotifyEvent) => void) | null = null

export function setExecutorNotify(fn: ((event: AgentRunNotifyEvent) => void) | null): void {
  sink = fn
}

export function executorNotify(event: AgentRunNotifyEvent): void {
  if (!sink) return
  try {
    sink(event)
  } catch (err) {
    console.error('[executor-notify] sink threw (continuing):', err)
  }
}
