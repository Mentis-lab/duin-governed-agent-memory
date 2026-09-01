import { describe, it, expect, vi } from 'vitest'
import {
  createTaskLifecycleService,
  type DeleteTaskPreview,
  type TaskLifecycleDependencies
} from './task-lifecycle'
import type { TaskGraphSnapshot, TaskGraphNode } from './task-graph'

function convNode(id: string, over: Partial<TaskGraphNode> = {}): TaskGraphNode {
  return {
    id: `conversation:${id}`,
    kind: 'conversation',
    title: over.title ?? id,
    status: over.status ?? 'idle',
    ownerConversationId: id,
    rootConversationId: id,
    parentId: over.parentId ?? null,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: { entityId: id, ...(over.metadata ?? {}) }
  }
}

function runNode(id: string, owner: string, status: TaskGraphNode['status'] = 'done'): TaskGraphNode {
  return {
    id: `agent-run:${id}`,
    kind: 'agent-run',
    title: id,
    status,
    ownerConversationId: owner,
    rootConversationId: owner,
    parentId: `conversation:${owner}`,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: { entityId: id }
  }
}

function makeDeps(graph: TaskGraphSnapshot, over: Partial<TaskLifecycleDependencies> = {}) {
  let token = 0
  const conversations = new Set(
    graph.nodes.filter((n) => n.kind === 'conversation').map((n) => String(n.metadata.entityId))
  )
  const deps: TaskLifecycleDependencies = {
    graph: () => graph,
    getConversation: vi.fn((id: string) => (conversations.has(id) ? ({ id } as never) : null)),
    updateTitle: vi.fn(),
    setPinned: vi.fn(),
    setArchived: vi.fn(),
    setClosed: vi.fn(),
    deleteConversation: vi.fn(),
    deleteAuxiliary: vi.fn(),
    record: vi.fn(() => ({}) as never),
    now: () => 10_000,
    newToken: () => `tok-${token++}`,
    ...over
  }
  return deps
}

describe('task-lifecycle (DUIN adaptation)', () => {
  it('rename requires a non-empty title', () => {
    const graph = { nodes: [convNode('c1')], edges: [], nextCursor: null, total: 1 }
    const svc = createTaskLifecycleService(makeDeps(graph))
    expect(() => svc.update('c1', 'rename', '   ')).toThrow(/rename requires a title/)
  })

  it('close routes through setClosed and records an event', () => {
    const graph = { nodes: [convNode('c1')], edges: [], nextCursor: null, total: 1 }
    const deps = makeDeps(graph)
    const svc = createTaskLifecycleService(deps)
    svc.update('c1', 'close')
    expect(deps.setClosed).toHaveBeenCalledWith('c1', true)
    expect(deps.record).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task.metadata.updated' })
    )
  })

  it('restore clears both closed and archived', () => {
    const graph = { nodes: [convNode('c1')], edges: [], nextCursor: null, total: 1 }
    const deps = makeDeps(graph)
    const svc = createTaskLifecycleService(deps)
    svc.update('c1', 'restore')
    expect(deps.setClosed).toHaveBeenCalledWith('c1', false)
    expect(deps.setArchived).toHaveBeenCalledWith('c1', false)
  })

  it('update on a missing task throws', () => {
    const graph = { nodes: [], edges: [], nextCursor: null, total: 0 }
    const svc = createTaskLifecycleService(makeDeps(graph))
    expect(() => svc.update('ghost', 'pin')).toThrow(/task not found/)
  })

  it('preview lists conversation + run descendants and a token', () => {
    const graph: TaskGraphSnapshot = {
      nodes: [
        convNode('root'),
        convNode('child', { parentId: 'conversation:root' }),
        runNode('r1', 'root')
      ],
      edges: [
        { from: 'conversation:root', to: 'conversation:child', relation: 'fork' },
        { from: 'conversation:root', to: 'agent-run:r1', relation: 'run' }
      ],
      nextCursor: null,
      total: 3
    }
    const svc = createTaskLifecycleService(makeDeps(graph))
    const preview = svc.previewDelete('root')
    expect(preview.conversationIds.sort()).toEqual(['child', 'root'])
    expect(preview.agentRunIds).toEqual(['r1'])
    expect(preview.previewToken).toBeTruthy()
  })

  it('delete removes aux runs then conversations after a matching preview', () => {
    const graph: TaskGraphSnapshot = {
      nodes: [convNode('root'), runNode('r1', 'root')],
      edges: [{ from: 'conversation:root', to: 'agent-run:r1', relation: 'run' }],
      nextCursor: null,
      total: 2
    }
    const deps = makeDeps(graph)
    const svc = createTaskLifecycleService(deps)
    const preview = svc.previewDelete('root')
    const res = svc.delete('root', preview.previewToken)
    expect(res.deleted).toBe(true)
    expect(deps.deleteAuxiliary).toHaveBeenCalledWith(
      expect.objectContaining({ agentRunIds: ['r1'] }) as DeleteTaskPreview
    )
    expect(deps.deleteConversation).toHaveBeenCalledWith('root')
    expect(deps.record).toHaveBeenCalledWith(expect.objectContaining({ type: 'task.deleted' }))
  })

  it('delete rejects a stale/missing token', () => {
    const graph = { nodes: [convNode('root')], edges: [], nextCursor: null, total: 1 }
    const svc = createTaskLifecycleService(makeDeps(graph))
    expect(() => svc.delete('root', 'nope')).toThrow(/fresh matching preview token/)
  })

  it('delete is blocked by an active (running) descendant', () => {
    const graph: TaskGraphSnapshot = {
      nodes: [convNode('root'), runNode('r1', 'root', 'running')],
      edges: [{ from: 'conversation:root', to: 'agent-run:r1', relation: 'run' }],
      nextCursor: null,
      total: 2
    }
    const svc = createTaskLifecycleService(makeDeps(graph))
    const preview = svc.previewDelete('root')
    expect(preview.activeNodeIds).toContain('agent-run:r1')
    expect(() => svc.delete('root', preview.previewToken)).toThrow(/active descendants/)
  })
})
