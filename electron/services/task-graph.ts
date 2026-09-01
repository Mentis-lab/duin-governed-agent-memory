import * as conversationStore from './conversation-store'
import * as agentRunStore from './agent-run-store'
import { listPendingAsyncEvents } from './async-event-bridge'

// Canonical task graph over DUIN's conversation + agent-run substrate.
//
// DUIN adaptation of the upstream lamprey task-graph:
//   1. Node kinds are limited to 'conversation' and 'agent-run'. The upstream
//      'identity' and 'turn' branches are KEPT structurally (so the shape and
//      the pagination/cursor code match) but are always fed EMPTY arrays —
//      DUIN has no agent-identity table and no turn-control layer.
//   2. A conversation's running-state is derived from agent_runs.status ===
//      'running' (a live background fork owned by that conversation), because
//      DUIN has no turn records to read a running turn off of.
//   3. agent-run metadata carries only the columns DUIN's agent_runs table
//      actually has (no tokensEst / toolCalls).
//   4. Conversations carry no forked_from_turn_id in DUIN, so that metadata
//      field is omitted.

export type TaskNodeKind = 'conversation' | 'agent-run' | 'identity' | 'turn'
export type TaskNodeStatus =
  | 'idle'
  | 'running'
  | 'done'
  | 'error'
  | 'aborted'
  | 'archived'
  | 'closed'
  | 'pending'
  | 'active'
  | 'revoked'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'recovered'
  | 'cancelled'

export interface TaskGraphNode {
  id: string
  kind: TaskNodeKind
  title: string
  status: TaskNodeStatus
  ownerConversationId: string | null
  rootConversationId: string | null
  parentId: string | null
  createdAt: number
  updatedAt: number
  metadata: Record<string, string | number | boolean | null>
}

export interface TaskGraphEdge {
  from: string
  to: string
  relation: 'fork' | 'run' | 'child-run' | 'identity' | 'turn'
}

export interface TaskGraphSnapshot {
  nodes: TaskGraphNode[]
  edges: TaskGraphEdge[]
  nextCursor: string | null
  total: number
}

// Stub shapes for the structurally-preserved (but always-empty in DUIN)
// identity / turn branches. Declared locally because the upstream stores that
// produced them do not exist in DUIN.
export interface AgentIdentityRow {
  id: string
  label: string
  status: TaskNodeStatus
  scopeKind: string
  scopeId: string
  agentType: string
  tokensSpent: number
  wallMsSpent: number
  createdAt: number
  revokedAt: number | null
}

export interface ConversationTurnRecord {
  id: string
  conversationId: string
  kind: string
  status: TaskNodeStatus
  correlationId: string | null
  activeAgentRunId: string | null
  recoveryReason: string | null
  startedAt: number
  updatedAt: number
  completedAt: number | null
}

export interface TaskGraphInput {
  conversations: ReturnType<typeof conversationStore.listConversations>
  runs: agentRunStore.AgentRunRow[]
  identities: AgentIdentityRow[]
  turns: ConversationTurnRecord[]
  unreadCounts?: Record<string, number>
}

export interface TaskGraphQuery {
  cursor?: string | null
  limit?: number
  rootConversationId?: string | null
  includeKinds?: TaskNodeKind[]
}

interface CursorValue {
  updatedAt: number
  id: string
}

function nodeId(kind: TaskNodeKind, id: string): string {
  return `${kind}:${id}`
}

function encodeCursor(node: TaskGraphNode): string {
  return Buffer.from(JSON.stringify({ updatedAt: node.updatedAt, id: node.id }), 'utf8').toString(
    'base64url'
  )
}

function decodeCursor(cursor: string): CursorValue {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorValue
    if (!Number.isFinite(value.updatedAt) || typeof value.id !== 'string' || !value.id)
      throw new Error()
    return value
  } catch {
    throw new Error('task-graph: invalid cursor')
  }
}

function rootOwners(conversations: TaskGraphInput['conversations']): Map<string, string> {
  const parents = new Map(conversations.map((row) => [row.id, row.forkedFromId ?? null]))
  const roots = new Map<string, string>()
  for (const conversation of conversations) {
    const seen = new Set<string>()
    let current = conversation.id
    while (true) {
      if (seen.has(current)) {
        roots.set(conversation.id, conversation.id)
        break
      }
      seen.add(current)
      const parent = parents.get(current)
      if (!parent || !parents.has(parent)) {
        roots.set(conversation.id, current)
        break
      }
      current = parent
    }
  }
  return roots
}

function conversationStatus(
  row: TaskGraphInput['conversations'][number],
  active: Set<string>
): TaskNodeStatus {
  if (active.has(row.id)) return 'running'
  if (row.closedAt != null) return 'closed'
  if (row.archived) return 'archived'
  return 'idle'
}

export function buildTaskGraph(
  input: TaskGraphInput,
  query: TaskGraphQuery = {}
): TaskGraphSnapshot {
  const roots = rootOwners(input.conversations)
  const nodes: TaskGraphNode[] = []
  const edges: TaskGraphEdge[] = []

  const runById = new Map(input.runs.map((run) => [run.id, run]))
  const runOwner = (run: agentRunStore.AgentRunRow): string | null => {
    const seen = new Set<string>()
    let current: agentRunStore.AgentRunRow | undefined = run
    while (current) {
      if (seen.has(current.id)) return null
      seen.add(current.id)
      if (current.parentConvId) return current.parentConvId
      current = current.parentRunId ? runById.get(current.parentRunId) : undefined
    }
    return null
  }

  // DUIN: a conversation is "running" when it owns a live background fork.
  // (Upstream read this off running turn records; DUIN has none.)
  const activeConversations = new Set<string>()
  for (const run of input.runs) {
    if (run.status !== 'running') continue
    const owner = runOwner(run)
    if (owner) activeConversations.add(owner)
  }

  for (const row of input.conversations) {
    const id = nodeId('conversation', row.id)
    const parentId = row.forkedFromId ? nodeId('conversation', row.forkedFromId) : null
    nodes.push({
      id,
      kind: 'conversation',
      title: row.title,
      status: conversationStatus(row, activeConversations),
      ownerConversationId: row.id,
      rootConversationId: roots.get(row.id) ?? row.id,
      parentId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      metadata: {
        entityId: row.id,
        model: row.model,
        messageCount: row.messageCount,
        worktreePath: row.worktreePath ?? null,
        forkedFromMessageId: row.forkedFromMessageId ?? null,
        pinned: row.pinnedAt != null,
        archived: row.archived === true,
        closed: row.closedAt != null,
        unreadCount: input.unreadCounts?.[row.id] ?? 0
      }
    })
    if (parentId) edges.push({ from: parentId, to: id, relation: 'fork' })
  }

  for (const run of input.runs) {
    const owner = runOwner(run)
    const parentId = run.parentRunId
      ? nodeId('agent-run', run.parentRunId)
      : run.parentConvId
        ? nodeId('conversation', run.parentConvId)
        : null
    const id = nodeId('agent-run', run.id)
    nodes.push({
      id,
      kind: 'agent-run',
      title: run.label,
      status: run.status,
      ownerConversationId: owner,
      rootConversationId: owner ? (roots.get(owner) ?? owner) : null,
      parentId,
      createdAt: run.startedAt,
      updatedAt: run.finishedAt ?? run.startedAt,
      metadata: {
        entityId: run.id,
        agentType: run.agentType,
        background: run.background,
        worktreePath: run.worktreePath
      }
    })
    if (parentId) {
      edges.push({ from: parentId, to: id, relation: run.parentRunId ? 'child-run' : 'run' })
    }
  }

  // Identity + turn branches: structurally preserved, always empty in DUIN.
  for (const identity of input.identities) {
    const owner = identity.scopeKind === 'conversation' ? identity.scopeId : null
    const parentId = owner ? nodeId('conversation', owner) : null
    const id = nodeId('identity', identity.id)
    nodes.push({
      id,
      kind: 'identity',
      title: identity.label,
      status: identity.status,
      ownerConversationId: owner,
      rootConversationId: owner ? (roots.get(owner) ?? owner) : null,
      parentId,
      createdAt: identity.createdAt,
      updatedAt: identity.revokedAt ?? identity.createdAt,
      metadata: {
        entityId: identity.id,
        agentType: identity.agentType,
        scopeKind: identity.scopeKind,
        scopeId: identity.scopeId,
        tokensSpent: identity.tokensSpent,
        wallMsSpent: identity.wallMsSpent
      }
    })
    if (parentId) edges.push({ from: parentId, to: id, relation: 'identity' })
  }

  for (const turn of input.turns) {
    const id = nodeId('turn', turn.id)
    const parentId = nodeId('conversation', turn.conversationId)
    nodes.push({
      id,
      kind: 'turn',
      title: `${turn.kind} turn`,
      status: turn.status,
      ownerConversationId: turn.conversationId,
      rootConversationId: roots.get(turn.conversationId) ?? turn.conversationId,
      parentId,
      createdAt: turn.startedAt,
      updatedAt: turn.completedAt ?? turn.updatedAt,
      metadata: {
        entityId: turn.id,
        kind: turn.kind,
        correlationId: turn.correlationId,
        activeAgentRunId: turn.activeAgentRunId,
        recoveryReason: turn.recoveryReason
      }
    })
    edges.push({ from: parentId, to: id, relation: 'turn' })
  }

  let filtered = nodes.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
  if (query.rootConversationId)
    filtered = filtered.filter((node) => node.rootConversationId === query.rootConversationId)
  if (query.includeKinds?.length) {
    const kinds = new Set(query.includeKinds)
    filtered = filtered.filter((node) => kinds.has(node.kind))
  }
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor)
    filtered = filtered.filter(
      (node) =>
        node.updatedAt < cursor.updatedAt ||
        (node.updatedAt === cursor.updatedAt && node.id > cursor.id)
    )
  }
  const total = filtered.length
  const limit = Math.min(Math.max(Math.floor(query.limit ?? 50), 1), 200)
  const page = filtered.slice(0, limit)
  const pageIds = new Set(page.map((node) => node.id))
  return {
    nodes: page,
    edges: edges.filter((edge) => pageIds.has(edge.from) || pageIds.has(edge.to)),
    nextCursor:
      filtered.length > page.length && page.length > 0 ? encodeCursor(page.at(-1)!) : null,
    total
  }
}

export function collectTaskDescendants(
  graph: Pick<TaskGraphSnapshot, 'nodes' | 'edges'>,
  startId: string,
  limit = 500
): TaskGraphNode[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const children = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const bucket = children.get(edge.from) ?? []
    bucket.push(edge.to)
    children.set(edge.from, bucket)
  }
  const result: TaskGraphNode[] = []
  const seen = new Set([startId])
  const queue = [...(children.get(startId) ?? [])]
  while (queue.length && result.length < Math.max(0, limit)) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const node = nodes.get(id)
    if (node) result.push(node)
    queue.push(...(children.get(id) ?? []))
  }
  return result
}

/** DUIN production loader: conversations + agent runs, empty identity/turn
 *  arrays, per-conversation unread counts from the async-event bridge. */
export function loadTaskGraph(query: TaskGraphQuery = {}): TaskGraphSnapshot {
  const conversations = conversationStore.listConversations()
  const runs = agentRunStore.listRuns()
  const unreadCounts = Object.fromEntries(
    conversations.map((conversation) => [
      conversation.id,
      listPendingAsyncEvents(conversation.id, 100).length
    ])
  )
  return buildTaskGraph(
    { conversations, runs, identities: [], turns: [], unreadCounts },
    query
  )
}
