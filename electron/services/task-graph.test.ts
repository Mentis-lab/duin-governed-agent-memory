import { describe, it, expect } from 'vitest'
import {
  buildTaskGraph,
  collectTaskDescendants,
  type TaskGraphInput
} from './task-graph'
import type { AgentRunRow } from './agent-run-store'

type Conv = TaskGraphInput['conversations'][number]

function conv(over: Partial<Conv> & { id: string }): Conv {
  return {
    id: over.id,
    title: over.title ?? 'Untitled',
    model: over.model ?? 'test-model',
    createdAt: over.createdAt ?? 1000,
    updatedAt: over.updatedAt ?? 1000,
    messageCount: over.messageCount ?? 0,
    kind: over.kind ?? 'local',
    worktreePath: over.worktreePath ?? null,
    projectId: over.projectId ?? null,
    archived: over.archived ?? false,
    pinnedAt: over.pinnedAt ?? null,
    forkedFromId: over.forkedFromId ?? null,
    forkedFromMessageId: over.forkedFromMessageId ?? null,
    closedAt: over.closedAt ?? null,
    seedBlob: over.seedBlob ?? null,
    seedSourceKind: over.seedSourceKind ?? 'none'
  } as Conv
}

function run(over: Partial<AgentRunRow> & { id: string }): AgentRunRow {
  return {
    id: over.id,
    parentConvId: over.parentConvId ?? null,
    parentRunId: over.parentRunId ?? null,
    agentType: over.agentType ?? 'coder',
    label: over.label ?? 'run',
    status: over.status ?? 'done',
    startedAt: over.startedAt ?? 1000,
    finishedAt: over.finishedAt ?? 2000,
    resultText: over.resultText ?? null,
    error: over.error ?? null,
    worktreePath: over.worktreePath ?? null,
    background: over.background ?? false
  }
}

const empty: Pick<TaskGraphInput, 'identities' | 'turns'> = { identities: [], turns: [] }

describe('buildTaskGraph (DUIN adaptation)', () => {
  it('emits only conversation + agent-run kinds', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'c1' })],
      runs: [run({ id: 'r1', parentConvId: 'c1' })],
      ...empty
    })
    const kinds = new Set(graph.nodes.map((n) => n.kind))
    expect(kinds).toEqual(new Set(['conversation', 'agent-run']))
  })

  it('derives conversation running-state from a running agent run', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'c1' }), conv({ id: 'c2' })],
      runs: [run({ id: 'r1', parentConvId: 'c1', status: 'running' })],
      ...empty
    })
    const c1 = graph.nodes.find((n) => n.id === 'conversation:c1')
    const c2 = graph.nodes.find((n) => n.id === 'conversation:c2')
    expect(c1?.status).toBe('running')
    expect(c2?.status).toBe('idle')
  })

  it('reports closed and archived status when no run is live', () => {
    const graph = buildTaskGraph({
      conversations: [
        conv({ id: 'closed', closedAt: 5000 }),
        conv({ id: 'arch', archived: true })
      ],
      runs: [],
      ...empty
    })
    expect(graph.nodes.find((n) => n.id === 'conversation:closed')?.status).toBe('closed')
    expect(graph.nodes.find((n) => n.id === 'conversation:arch')?.status).toBe('archived')
  })

  it('a running fork wins over a closed flag on the owner', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'c1', closedAt: 5000 })],
      runs: [run({ id: 'r1', parentConvId: 'c1', status: 'running' })],
      ...empty
    })
    expect(graph.nodes.find((n) => n.id === 'conversation:c1')?.status).toBe('running')
  })

  it('links a fork child to its parent with a fork edge', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'root' }), conv({ id: 'child', forkedFromId: 'root' })],
      runs: [],
      ...empty
    })
    expect(graph.edges).toContainEqual({
      from: 'conversation:root',
      to: 'conversation:child',
      relation: 'fork'
    })
    expect(graph.nodes.find((n) => n.id === 'conversation:child')?.rootConversationId).toBe('root')
  })

  it('adds run/child-run edges for owned + nested runs', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'c1' })],
      runs: [
        run({ id: 'r1', parentConvId: 'c1' }),
        run({ id: 'r2', parentRunId: 'r1' })
      ],
      ...empty
    })
    expect(graph.edges).toContainEqual({
      from: 'conversation:c1',
      to: 'agent-run:r1',
      relation: 'run'
    })
    expect(graph.edges).toContainEqual({
      from: 'agent-run:r1',
      to: 'agent-run:r2',
      relation: 'child-run'
    })
    // Nested run owner resolves through the parent chain to the conversation.
    expect(graph.nodes.find((n) => n.id === 'agent-run:r2')?.ownerConversationId).toBe('c1')
  })

  it('paginates with a stable cursor', () => {
    const conversations = Array.from({ length: 5 }, (_, i) =>
      conv({ id: `c${i}`, updatedAt: 1000 + i })
    )
    const page1 = buildTaskGraph({ conversations, runs: [], ...empty }, { limit: 2 })
    expect(page1.nodes).toHaveLength(2)
    expect(page1.total).toBe(5)
    expect(page1.nextCursor).toBeTruthy()
    const page2 = buildTaskGraph(
      { conversations, runs: [], ...empty },
      { limit: 2, cursor: page1.nextCursor }
    )
    const ids1 = new Set(page1.nodes.map((n) => n.id))
    for (const n of page2.nodes) expect(ids1.has(n.id)).toBe(false)
  })

  it('collectTaskDescendants walks the fork + run tree', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'root' }), conv({ id: 'child', forkedFromId: 'root' })],
      runs: [run({ id: 'r1', parentConvId: 'root' })],
      ...empty
    })
    const desc = collectTaskDescendants(graph, 'conversation:root', 100)
    const ids = new Set(desc.map((n) => n.id))
    expect(ids.has('conversation:child')).toBe(true)
    expect(ids.has('agent-run:r1')).toBe(true)
  })

  it('drops tokensEst/toolCalls from agent-run metadata (DUIN columns only)', () => {
    const graph = buildTaskGraph({
      conversations: [conv({ id: 'c1' })],
      runs: [run({ id: 'r1', parentConvId: 'c1', agentType: 'reviewer', background: true })],
      ...empty
    })
    const meta = graph.nodes.find((n) => n.id === 'agent-run:r1')?.metadata
    expect(meta).toMatchObject({ entityId: 'r1', agentType: 'reviewer', background: true })
    expect(meta).not.toHaveProperty('tokensEst')
    expect(meta).not.toHaveProperty('toolCalls')
  })
})
