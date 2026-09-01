import { describe, expect, it } from 'vitest'
import { validateChatSendRequest } from './chat-validation'

// Pure validation tests for the chat:send request shape. The helper lives
// in its own file (chat-validation.ts) so the test doesn't have to import
// the rest of chat.ts's module graph — skill-loader, electron-toolkit,
// providers — none of which initialize cleanly under headless vitest.

describe('validateChatSendRequest', () => {
  it('rejects null', () => {
    const r = validateChatSendRequest(null)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/request object/i)
  })

  it('rejects undefined', () => {
    const r = validateChatSendRequest(undefined)
    expect(r.ok).toBe(false)
  })

  it('rejects a string', () => {
    const r = validateChatSendRequest('hello')
    expect(r.ok).toBe(false)
  })

  it('rejects an array', () => {
    const r = validateChatSendRequest(['hello'])
    expect(r.ok).toBe(false)
  })

  it('rejects empty content', () => {
    const r = validateChatSendRequest({ content: '', model: 'm' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/content/i)
  })

  it('rejects whitespace-only content', () => {
    const r = validateChatSendRequest({ content: '   ', model: 'm' })
    expect(r.ok).toBe(false)
  })

  it('accepts a valid reasoningEffort and drops an invalid one', () => {
    const ok = validateChatSendRequest({ content: 'hi', model: 'm', reasoningEffort: 'high' })
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.value.reasoningEffort).toBe('high')

    const bad = validateChatSendRequest({ content: 'hi', model: 'm', reasoningEffort: 'extreme' })
    expect(bad.ok).toBe(true)
    if (bad.ok) expect(bad.value.reasoningEffort).toBeUndefined()

    // 'max' is a valid tier (maps to the provider ceiling at the wire).
    const max = validateChatSendRequest({ content: 'hi', model: 'm', reasoningEffort: 'max' })
    expect(max.ok).toBe(true)
    if (max.ok) expect(max.value.reasoningEffort).toBe('max')
  })

  it('rejects non-string content', () => {
    const r = validateChatSendRequest({ content: 42, model: 'm' })
    expect(r.ok).toBe(false)
  })

  it('rejects missing model', () => {
    const r = validateChatSendRequest({ content: 'hi' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/model/i)
  })

  it('rejects non-string model', () => {
    const r = validateChatSendRequest({ content: 'hi', model: 42 })
    expect(r.ok).toBe(false)
  })

  it('rejects non-string conversationId', () => {
    const r = validateChatSendRequest({
      content: 'hi',
      model: 'm',
      conversationId: { id: 'X' }
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/conversationId/i)
  })

  it('accepts a minimal valid request, defaults conversationId to "new"', () => {
    const r = validateChatSendRequest({ content: 'hi', model: 'm' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.content).toBe('hi')
      expect(r.value.model).toBe('m')
      expect(r.value.conversationId).toBe('new')
      expect(r.value.activeSkillIds).toEqual([])
    }
  })

  it('filters activeSkillIds to strings only (mixed types dropped)', () => {
    const r = validateChatSendRequest({
      content: 'hi',
      model: 'm',
      activeSkillIds: ['valid', 42, null, undefined, '', 'also-valid', {}]
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.activeSkillIds).toEqual(['valid', 'also-valid'])
    }
  })

  it('UB-7: a stale agentMode field from old callers is ignored, not rejected', () => {
    const r = validateChatSendRequest({
      content: 'hi',
      model: 'm',
      agentMode: 'multi'
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect('requestedAgentMode' in r.value).toBe(false)
    }
  })

  it('passes through a real conversationId verbatim', () => {
    const r = validateChatSendRequest({
      content: 'hi',
      model: 'm',
      conversationId: 'conv-XYZ'
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.conversationId).toBe('conv-XYZ')
  })

  it('accepts a well-formed pinned context and passes it through', () => {
    const r = validateChatSendRequest({
      content: 'fix the bug',
      model: 'm',
      context: { id: 'notes/Tasks.md', label: 'Tasks', kind: 'note' }
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.context).toEqual({
        id: 'notes/Tasks.md',
        label: 'Tasks',
        kind: 'note'
      })
    }
  })

  it('omits context entirely when absent (unscoped chat)', () => {
    const r = validateChatSendRequest({ content: 'hi', model: 'm' })
    expect(r.ok).toBe(true)
    if (r.ok) expect('context' in r.value).toBe(false)
  })

  it('accepts the three known permissionsMode values and passes them through', () => {
    for (const mode of ['default', 'auto-review', 'full'] as const) {
      const r = validateChatSendRequest({ content: 'hi', model: 'm', permissionsMode: mode })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.permissionsMode).toBe(mode)
    }
  })

  it('DROPS a stale/garbage permissionsMode so the gate falls back to env (env-floor invariant)', () => {
    for (const bad of ['yolo', '', 42, null, {}, ['full']]) {
      const r = validateChatSendRequest({ content: 'hi', model: 'm', permissionsMode: bad })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.permissionsMode).toBeUndefined()
    }
  })

  it('omits permissionsMode entirely when absent (old client / channel turn)', () => {
    const r = validateChatSendRequest({ content: 'hi', model: 'm' })
    expect(r.ok).toBe(true)
    if (r.ok) expect('permissionsMode' in r.value).toBe(false)
  })

  it('drops a malformed context (missing kind / empty id / non-object) rather than half-forwarding it', () => {
    for (const bad of [
      { id: 'x', label: 'X' }, // missing kind
      { id: '', label: 'X', kind: 'note' }, // empty id
      { id: 42, label: 'X', kind: 'note' }, // non-string id
      'notes/Tasks.md', // not an object
      ['notes/Tasks.md'] // array
    ]) {
      const r = validateChatSendRequest({ content: 'hi', model: 'm', context: bad })
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value.context).toBeUndefined()
    }
  })
})
