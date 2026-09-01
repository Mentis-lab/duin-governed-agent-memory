import { createHash } from 'crypto'
import { buildTaskGraph, collectTaskDescendants, type TaskGraphNode } from './task-graph'
import * as conversationStore from './conversation-store'
import * as agentRunStore from './agent-run-store'
import { subscribeTaskChanges, type TaskChangeSignal } from './task-wait-signal'

// Read + wait surface over the DUIN task graph.
//
// DUIN adaptation: identities + turns are always empty (no such stores), so the
// read graph is built from conversations + agent runs only, and typed task-ids
// accept only the `conversation:` / `agent-run:` prefixes. `waitForTasks` wakes
// off task-change signals bridged from broadcastAgentRunEvent (agent-run) and
// the lifecycle service (metadata / fork) — there is no turn-control 'steer'.

export interface TaskReadSnapshot {
  taskId: string
  cursor: string
  node: TaskGraphNode
  descendants: TaskGraphNode[]
  childCount: number
}

export interface WaitTaskTarget {
  taskId: string
  afterCursor?: string | null
}

export interface WaitTasksResult {
  reason: 'changed' | 'timeout' | 'cancelled'
  tasks: TaskReadSnapshot[]
  changedTaskIds: string[]
}

function graphForRead() {
  return buildTaskGraph(
    {
      conversations: conversationStore.listConversations(),
      runs: agentRunStore.listRuns(),
      identities: [],
      turns: []
    },
    { limit: 200 }
  )
}

function normalizeTaskId(taskId: string): string {
  const trimmed = taskId.trim()
  if (!trimmed) throw new Error('task id is required')
  if (/^(conversation|agent-run):/.test(trimmed)) return trimmed
  return `conversation:${trimmed}`
}

function snapshotCursor(node: TaskGraphNode, descendants: TaskGraphNode[]): string {
  const value = [node, ...descendants]
    .map((item) => `${item.id}:${item.status}:${item.updatedAt}`)
    .sort()
    .join('|')
  return createHash('sha256').update(value).digest('base64url').slice(0, 24)
}

export function listTaskSnapshots(
  input: {
    cursor?: string | null
    limit?: number
    rootConversationId?: string | null
  } = {}
) {
  return buildTaskGraph(
    {
      conversations: conversationStore.listConversations(),
      runs: agentRunStore.listRuns(),
      identities: [],
      turns: []
    },
    {
      cursor: input.cursor,
      limit: input.limit,
      rootConversationId: input.rootConversationId,
      includeKinds: ['conversation']
    }
  )
}

export function readTaskSnapshot(taskId: string, descendantLimit = 100): TaskReadSnapshot {
  const graph = graphForRead()
  const normalized = normalizeTaskId(taskId)
  const node = graph.nodes.find((candidate) => candidate.id === normalized)
  if (!node) throw new Error(`task not found: ${taskId}`)
  const descendants = collectTaskDescendants(
    graph,
    normalized,
    Math.min(Math.max(descendantLimit, 0), 200)
  )
  return {
    taskId: normalized,
    cursor: snapshotCursor(node, descendants),
    node,
    descendants,
    childCount: descendants.length
  }
}

function signalMatches(signal: TaskChangeSignal, snapshots: TaskReadSnapshot[]): boolean {
  return snapshots.some((snapshot) => {
    if (
      signal.entityId &&
      (snapshot.node.id.endsWith(`:${signal.entityId}`) ||
        snapshot.descendants.some((node) => node.id.endsWith(`:${signal.entityId}`)))
    )
      return true
    return (
      signal.conversationId !== null &&
      (snapshot.node.ownerConversationId === signal.conversationId ||
        snapshot.descendants.some((node) => node.ownerConversationId === signal.conversationId))
    )
  })
}

export async function waitForTasks(
  targets: WaitTaskTarget[],
  options: {
    timeoutMs?: number
    signal?: AbortSignal
    read?: typeof readTaskSnapshot
    subscribe?: typeof subscribeTaskChanges
  } = {}
): Promise<WaitTasksResult> {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 8) {
    throw new Error('wait_tasks requires 1 to 8 targets')
  }
  const read = options.read ?? readTaskSnapshot
  const subscribe = options.subscribe ?? subscribeTaskChanges
  const initial = targets.map((target) => read(target.taskId))
  const changedImmediately = initial.filter((snapshot, index) => {
    const after = targets[index].afterCursor
    return typeof after === 'string' && after.length > 0 && after !== snapshot.cursor
  })
  if (changedImmediately.length) {
    return {
      reason: 'changed',
      tasks: initial,
      changedTaskIds: changedImmediately.map((task) => task.taskId)
    }
  }
  const timeoutMs = Math.min(Math.max(Math.floor(options.timeoutMs ?? 30_000), 0), 300_000)
  if (options.signal?.aborted) return { reason: 'cancelled', tasks: initial, changedTaskIds: [] }

  return new Promise<WaitTasksResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const finish = (reason: WaitTasksResult['reason'], changedTaskIds: string[] = []): void => {
      if (settled) return
      settled = true
      unsubscribe()
      if (timer) clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      // `read` throws for a task that no longer exists, and finish() runs AFTER
      // `settled = true` inside a raw setTimeout / event-listener callback with no local
      // try/catch. A task deleted mid-wait therefore threw out of a timer, the promise
      // was neither resolved nor rejected, and wait_tasks hung until the caller's own
      // deadline killed it — surfaced as a timeout, which points at the wrong thing.
      //
      // An unreadable task is DROPPED rather than synthesised: TaskReadSnapshot requires
      // a real graph node, and inventing one would put fabricated state in the answer.
      // The caller asked about several tasks; the ones that still exist keep their real
      // snapshots, and a caller can see which id is absent.
      const tasks = targets.flatMap((target) => {
        try {
          return [read(target.taskId)]
        } catch (err) {
          console.warn(
            `[task-query] task ${target.taskId} vanished mid-wait; omitting it from the result:`,
            (err as Error)?.message
          )
          return []
        }
      })
      resolve({ reason, tasks, changedTaskIds })
    }
    const onAbort = (): void => finish('cancelled')
    const unsubscribe = subscribe((signal) => {
      if (!signalMatches(signal, initial)) return
      const next = targets.map((target) => read(target.taskId))
      const changed = next.filter((snapshot, index) => snapshot.cursor !== initial[index].cursor)
      if (changed.length) {
        finish(
          'changed',
          changed.map((task) => task.taskId)
        )
      }
    })
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
}
