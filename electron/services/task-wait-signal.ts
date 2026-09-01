// Process-local pub/sub used by `wait_tasks` to wake without polling.
//
// DUIN adaptation of the upstream lamprey task-wait-signal: DUIN has no
// turn-control layer, so the change kinds are trimmed to the ones that actually
// fire here — `agent-run` (a tracked background fork started/finished, bridged
// from broadcastAgentRunEvent), `metadata` (a lifecycle mutation: rename / pin /
// archive / close / restore), and `fork` (a child task was spawned). The upstream
// 'turn' and 'steer' kinds are dropped along with turn-control.
export type TaskChangeKind = 'agent-run' | 'metadata' | 'fork'

export interface TaskChangeSignal {
  conversationId: string | null
  entityId: string | null
  kind: TaskChangeKind
  occurredAt: number
}

type Listener = (signal: TaskChangeSignal) => void
const listeners = new Set<Listener>()

export function notifyTaskChange(
  signal: Omit<TaskChangeSignal, 'occurredAt'> & { occurredAt?: number }
): void {
  const value: TaskChangeSignal = { ...signal, occurredAt: signal.occurredAt ?? Date.now() }
  for (const listener of [...listeners]) listener(value)
}

export function subscribeTaskChanges(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
