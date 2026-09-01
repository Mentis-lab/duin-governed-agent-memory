import { describe, it, expect } from 'vitest'
import {
  buildRuntimeContextSnapshot,
  applyRuntimeSnapshotToApiMessages
} from './runtime-context-snapshot'

describe('buildRuntimeContextSnapshot', () => {
  it('combines non-empty blocks in a fixed order with the supersedes framing', () => {
    const s = buildRuntimeContextSnapshot({
      retrievedContextBlock: 'ctx here',
      memoryIndexBlock: 'mem idx',
      taskNotificationsBlock: '',
      chaptersBlock: undefined
    })
    expect(s).toContain('<runtime_context>')
    expect(s).toContain('supersedes any earlier runtime-context snapshot')
    expect(s!.indexOf('MEMORY INDEX')).toBeLessThan(s!.indexOf('RETRIEVED CONTEXT'))
    expect(s).toContain('mem idx')
    expect(s).toContain('ctx here')
    expect(s).not.toContain('TASK NOTIFICATIONS')
  })

  it('returns undefined when every block is empty — no prefix-noise message', () => {
    expect(buildRuntimeContextSnapshot({})).toBeUndefined()
    expect(
      buildRuntimeContextSnapshot({ retrievedContextBlock: '  ', chaptersBlock: '' })
    ).toBeUndefined()
  })

  it('is deterministic: same blocks, same bytes', () => {
    const blocks = { retrievedContextBlock: 'a', memoryIndexBlock: 'b' }
    expect(buildRuntimeContextSnapshot(blocks)).toBe(buildRuntimeContextSnapshot(blocks))
  })
})

describe('applyRuntimeSnapshotToApiMessages — placement', () => {
  const blocks = { memoryIndexBlock: 'mem idx' }

  it('PREPENDS into the last user message (no separate message, alternation preserved)', () => {
    const msgs = [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }
    ]
    expect(applyRuntimeSnapshotToApiMessages(msgs, blocks)).toBe(true)
    expect(msgs).toHaveLength(4) // no message inserted
    expect(msgs[3].content).toMatch(/^<runtime_context>/)
    expect(msgs[3].content).toContain('q2')
    // The message BEFORE the last user message (Anthropic breakpoint-2
    // slot) is untouched stable history.
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'a1' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'q1' })
  })

  it('vision-parts array: snapshot becomes a leading text part', () => {
    const msgs = [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:x' } }] }
    ]
    expect(applyRuntimeSnapshotToApiMessages(msgs, blocks)).toBe(true)
    const parts = msgs[0].content as Array<{ type: string }>
    expect(parts[0].type).toBe('text')
    expect(parts[1].type).toBe('image_url')
  })

  it('degenerate no-user case: trailing SYSTEM message, never a fake user prompt', () => {
    const msgs: Array<{ role: string; content?: unknown }> = [
      { role: 'system', content: 'SYS' },
      { role: 'assistant', content: 'a1' }
    ]
    expect(applyRuntimeSnapshotToApiMessages(msgs, blocks)).toBe(true)
    expect(msgs[2].role).toBe('system')
    expect(msgs[2].content).toMatch(/^<runtime_context>/)
  })

  it('all blocks empty: untouched, returns false', () => {
    const msgs = [{ role: 'user', content: 'q' }]
    expect(applyRuntimeSnapshotToApiMessages(msgs, {})).toBe(false)
    expect(msgs).toEqual([{ role: 'user', content: 'q' }])
  })
})
