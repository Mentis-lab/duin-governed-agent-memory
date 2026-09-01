import { describe, it, expect } from 'vitest'
import { buildConversationTaskRows, type TaskGraphNodeView } from './task-control-presentation'

function node(id: string, parentId: string | null, updatedAt = 1000): TaskGraphNodeView {
  return {
    id: `conversation:${id}`,
    kind: 'conversation',
    title: id,
    status: 'idle',
    ownerConversationId: id,
    parentId: parentId ? `conversation:${parentId}` : null,
    updatedAt,
    metadata: { entityId: id }
  }
}

describe('buildConversationTaskRows', () => {
  it('keeps only conversation nodes', () => {
    const rows = buildConversationTaskRows([
      node('c1', null),
      {
        id: 'agent-run:r1',
        kind: 'agent-run',
        title: 'r1',
        status: 'done',
        ownerConversationId: 'c1',
        parentId: 'conversation:c1',
        updatedAt: 1000,
        metadata: {}
      }
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].node.id).toBe('conversation:c1')
  })

  it('computes fork depth from the parent chain', () => {
    const rows = buildConversationTaskRows([
      node('root', null),
      node('child', 'root'),
      node('grandchild', 'child')
    ])
    const depth = new Map(rows.map((r) => [r.node.id, r.depth]))
    expect(depth.get('conversation:root')).toBe(0)
    expect(depth.get('conversation:child')).toBe(1)
    expect(depth.get('conversation:grandchild')).toBe(2)
  })

  it('orders shallower-first, then most-recent', () => {
    const rows = buildConversationTaskRows([
      node('a', null, 100),
      node('b', null, 200),
      node('a-child', 'a', 300)
    ])
    expect(rows[0].node.id).toBe('conversation:b') // depth 0, newest
    expect(rows[1].node.id).toBe('conversation:a') // depth 0, older
    expect(rows[2].node.id).toBe('conversation:a-child') // depth 1
  })

  it('tolerates a cyclic parent link without hanging', () => {
    const rows = buildConversationTaskRows([node('x', 'y'), node('y', 'x')])
    expect(rows).toHaveLength(2)
  })
})
