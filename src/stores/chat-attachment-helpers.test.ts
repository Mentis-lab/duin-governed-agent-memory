// Backlog findings 40 and 62, both in chat-store's oversized-file (RAG) path.
// Tested through the extracted pure helpers because importing chat-store pulls the
// renderer store graph, which needs browser globals this repo's node-only vitest env
// does not provide.

import { describe, it, expect, vi } from 'vitest'
import { shouldUnlinkCollection, singleFlight } from './chat-attachment-helpers'

const chip = (kind: string, collectionId?: string) => ({ kind, collectionId })

describe('shouldUnlinkCollection — finding 40', () => {
  it('does NOT unlink while another chip still shares the collection', () => {
    // The whole defect: three oversized files share ONE auto-collection, so removing
    // the one you did not want stripped RAG grounding from the other two.
    const remaining = [chip('rag-pending', 'col-1'), chip('rag-pending', 'col-1')]
    expect(shouldUnlinkCollection(remaining, 'col-1')).toBe(false)
  })

  it('unlinks when the removed chip was the last one using it', () => {
    expect(shouldUnlinkCollection([], 'col-1')).toBe(true)
    expect(shouldUnlinkCollection([chip('image')], 'col-1')).toBe(true)
  })

  it('ignores chips pointing at a different collection', () => {
    expect(shouldUnlinkCollection([chip('rag-pending', 'col-2')], 'col-1')).toBe(true)
  })

  it('ignores non-rag chips that happen to carry the same id', () => {
    expect(shouldUnlinkCollection([chip('image', 'col-1')], 'col-1')).toBe(true)
  })

  it('never unlinks without a collection id', () => {
    expect(shouldUnlinkCollection([], undefined)).toBe(false)
    expect(shouldUnlinkCollection([], '')).toBe(false)
  })
})

describe('singleFlight — finding 62', () => {
  it('runs the factory ONCE for concurrent callers and gives them all the same value', async () => {
    // Dropping N oversized files with nothing open ran N independent
    // check-then-create pairs, so all N observed null and created N conversations.
    let calls = 0
    let release: (v: string) => void = () => undefined
    const gate = new Promise<string>((res) => {
      release = res
    })
    const ensure = singleFlight(async () => {
      calls++
      return gate
    })

    const all = Promise.all([ensure(), ensure(), ensure()])
    release('conv-1')
    expect(await all).toEqual(['conv-1', 'conv-1', 'conv-1'])
    expect(calls).toBe(1)
  })

  it('a later caller reuses the resolved value rather than re-running', async () => {
    const factory = vi.fn(async () => 'conv-1')
    const ensure = singleFlight(factory)
    expect(await ensure()).toBe('conv-1')
    expect(await ensure()).toBe('conv-1')
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('does not cache a rejection — the next caller retries', async () => {
    let n = 0
    const ensure = singleFlight(async () => {
      n++
      if (n === 1) throw new Error('createConversation failed')
      return 'conv-2'
    })
    await expect(ensure()).rejects.toThrow(/createConversation failed/)
    expect(await ensure()).toBe('conv-2')
    expect(n).toBe(2)
  })
})
