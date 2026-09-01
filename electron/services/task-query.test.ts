import { describe, it, expect } from 'vitest'
import { waitForTasks, type TaskReadSnapshot } from './task-query'
import type { TaskChangeSignal } from './task-wait-signal'
import type { TaskGraphNode } from './task-graph'

function node(id: string, owner: string): TaskGraphNode {
  return {
    id: `conversation:${id}`,
    kind: 'conversation',
    title: id,
    status: 'idle',
    ownerConversationId: owner,
    rootConversationId: owner,
    parentId: null,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: { entityId: id }
  }
}

function snap(taskId: string, owner: string, cursor: string): TaskReadSnapshot {
  return { taskId, cursor, node: node(taskId, owner), descendants: [], childCount: 0 }
}

describe('waitForTasks (DUIN adaptation)', () => {
  it('requires 1 to 8 targets', async () => {
    await expect(waitForTasks([])).rejects.toThrow(/1 to 8/)
    await expect(
      waitForTasks(Array.from({ length: 9 }, (_, i) => ({ taskId: `t${i}` })))
    ).rejects.toThrow(/1 to 8/)
  })

  it('returns immediately when afterCursor differs from the current cursor', async () => {
    const result = await waitForTasks([{ taskId: 'conversation:c1', afterCursor: 'old' }], {
      read: () => snap('conversation:c1', 'c1', 'new'),
      subscribe: () => () => {}
    })
    expect(result.reason).toBe('changed')
    expect(result.changedTaskIds).toEqual(['conversation:c1'])
  })

  it('times out when nothing changes', async () => {
    const result = await waitForTasks([{ taskId: 'conversation:c1' }], {
      timeoutMs: 0,
      read: () => snap('conversation:c1', 'c1', 'same'),
      subscribe: () => () => {}
    })
    expect(result.reason).toBe('timeout')
  })

  it('wakes on a matching signal once the cursor moves', async () => {
    let cursor = 'v1'
    const holder: { fn: ((s: TaskChangeSignal) => void) | null } = { fn: null }
    const promise = waitForTasks([{ taskId: 'conversation:c1' }], {
      timeoutMs: 5000,
      read: () => snap('conversation:c1', 'c1', cursor),
      subscribe: (listener) => {
        holder.fn = listener
        return () => {}
      }
    })
    // Move the underlying state, then fire a signal that matches the owner.
    cursor = 'v2'
    holder.fn?.({ conversationId: 'c1', entityId: null, kind: 'agent-run', occurredAt: Date.now() })
    const result = await promise
    expect(result.reason).toBe('changed')
    expect(result.changedTaskIds).toEqual(['conversation:c1'])
  })

  it('ignores a signal that does not move the cursor', async () => {
    const holder: { fn: ((s: TaskChangeSignal) => void) | null } = { fn: null }
    const result = await waitForTasks([{ taskId: 'conversation:c1' }], {
      timeoutMs: 0,
      read: () => snap('conversation:c1', 'c1', 'stable'),
      subscribe: (listener) => {
        holder.fn = listener
        return () => {}
      }
    })
    // Fire after the fact — it must not throw; the wait already timed out.
    holder.fn?.({ conversationId: 'c1', entityId: null, kind: 'metadata', occurredAt: Date.now() })
    expect(result.reason).toBe('timeout')
  })

  it('resolves cancelled when the abort signal is already aborted', async () => {
    const ac = new AbortController()
    ac.abort()
    const result = await waitForTasks([{ taskId: 'conversation:c1' }], {
      signal: ac.signal,
      read: () => snap('conversation:c1', 'c1', 'x'),
      subscribe: () => () => {}
    })
    expect(result.reason).toBe('cancelled')
  })
})
