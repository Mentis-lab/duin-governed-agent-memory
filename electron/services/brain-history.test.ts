import { describe, it, expect } from 'vitest'
import { buildBrainHistory, HISTORY_MAX_MSGS } from './brain-history'

const u = (c: string) => ({ role: 'user', content: c })
const a = (c: string) => ({ role: 'assistant', content: c })

describe('buildBrainHistory', () => {
  it('returns a short thread in full, oldest→newest', () => {
    const h = buildBrainHistory([u('make a note'), a('made it; save?'), u('yes')])
    expect(h.map((m) => m.content)).toEqual(['make a note', 'made it; save?', 'yes'])
  })

  it('the note-follow-up bug: the prior assistant turn is included so "yes" has context', () => {
    const h = buildBrainHistory([u('make me a note for today'), a('Here is the note markdown…'), u('yes save it')])
    expect(h.some((m) => m.role === 'assistant' && m.content.includes('note markdown'))).toBe(true)
    expect(h[h.length - 1]).toEqual({ role: 'user', content: 'yes save it' }) // latest is last
  })

  it('drops system/tool/reasoning + empty turns', () => {
    const h = buildBrainHistory([
      { role: 'system', content: 'sys' },
      u('hi'),
      { role: 'tool', content: 'tool out' },
      a('   '),
      a('hello')
    ])
    expect(h.map((m) => m.content)).toEqual(['hi', 'hello'])
  })

  it('DURABILITY: caps a very long chat to the most recent HISTORY_MAX_MSGS, keeping the latest', () => {
    const many = Array.from({ length: 200 }, (_, i) => u(`m${i}`))
    const h = buildBrainHistory(many)
    expect(h.length).toBe(HISTORY_MAX_MSGS)
    expect(h[h.length - 1].content).toBe('m199') // newest kept
    expect(h[0].content).toBe(`m${200 - HISTORY_MAX_MSGS}`) // oldest of the recent window
  })

  it('DURABILITY: honors the char budget, keeping most-recent within it', () => {
    const msgs = [u('x'.repeat(5000)), u('y'.repeat(5000)), u('z'.repeat(5000))]
    const h = buildBrainHistory(msgs, { maxChars: 11000 }) // fits 2 of the 5000-char msgs (10000), not 3
    expect(h.map((m) => m.content[0])).toEqual(['y', 'z']) // dropped the oldest to fit budget
  })

  it('DURABILITY: always keeps ≥ the latest turn even if it alone exceeds the budget', () => {
    const h = buildBrainHistory([u('short'), u('B'.repeat(50000))], { maxChars: 1000, perMsgCap: 100000 })
    expect(h).toHaveLength(1)
    expect(h[0].content.startsWith('B')).toBe(true)
  })

  it('DURABILITY: bounds a single huge message to the per-message cap', () => {
    const h = buildBrainHistory([u('Q'.repeat(20000))], { perMsgCap: 8000 })
    expect(h[0].content.length).toBe(8000)
    expect(h[0].content).toContain('characters elided from the middle')
  })

  // REGRESSION PIN (2026-08-05). Bounding a message by slicing its HEAD throws away the one
  // part a follow-up needs most: where it stopped. The real failure — the assistant emitted a
  // 15,564-char document inline, the operator typed "resume", and the model was handed its own
  // document cut at char 8,000 (mid-word inside `### 16. \`lamprey.db\``). It reported the cut
  // accurately and then could not continue, because the rest was no longer in its context.
  describe('a long answer survives well enough to be continued', () => {
    const DOC = `# Title\n${'body '.repeat(3000)}\n## Summary\nThe honest position: pending validation.`

    it('keeps the END of a message, not just the start', () => {
      // Force the small cap onto the newest assistant turn too, so this pins the
      // shape of a BOUNDED message rather than the exemption tested below.
      const h = buildBrainHistory([u('write the doc'), a(DOC), u('resume')], {
        perMsgCap: 8000,
        lastAssistantCap: 8000
      })
      const doc = h.find((m) => m.role === 'assistant')!.content
      expect(doc.startsWith('# Title')).toBe(true)
      expect(doc).toContain('The honest position: pending validation.')
      expect(doc).toContain('characters elided from the middle')
    })

    it('carries the NEWEST assistant turn whole, up to the larger cap', () => {
      const h = buildBrainHistory([u('write the doc'), a(DOC), u('resume')])
      const doc = h.find((m) => m.role === 'assistant')!.content
      expect(doc).toBe(DOC) // 15.5k < HISTORY_LAST_ASSISTANT_CAP — nothing elided at all
      expect(doc).not.toContain('elided')
    })

    it('still bounds an OLDER assistant turn at the normal per-message cap', () => {
      const h = buildBrainHistory([a(DOC), u('and again'), a('short reply'), u('resume')])
      const older = h.find((m) => m.role === 'assistant' && m.content !== 'short reply')!.content
      expect(older.length).toBeLessThanOrEqual(8000)
      expect(older).toContain('characters elided from the middle')
    })
  })

  // ── cache-aligned eviction (efficiency campaign §5.1) ──
  // The prefill cache is prefix-anchored, so what matters is whether the FRONT of the window is
  // byte-stable from turn to turn. The default window slides by one message per turn once the
  // budget binds, which destroys the shared prefix on every request past the cap.
  describe('cache-aligned eviction', () => {
    /** Simulate a growing thread: turn n has n messages, each ~1000 chars. */
    const threadAt = (n: number) => Array.from({ length: n }, (_, i) => u(`m${i}-` + 'x'.repeat(1000)))
    const front = (h: { content: string }[]) => h[0]?.content.slice(0, 8)

    it('default (evictChunk 0) shifts the window front EVERY turn once the cap binds', () => {
      const opts = { maxChars: 10_000 }
      const fronts = [12, 13, 14, 15].map((n) => front(buildBrainHistory(threadAt(n), opts)))
      expect(new Set(fronts).size).toBe(4) // a different first message every single turn
    })

    it('chunked eviction holds the front STABLE across a run of turns', () => {
      const opts = { maxChars: 10_000, evictChunk: 8 }
      const fronts = [12, 13, 14, 15].map((n) => front(buildBrainHistory(threadAt(n), opts)))
      expect(new Set(fronts).size).toBe(1) // same prefix reused for the whole run
    })

    it('still respects the char budget when aligning (snaps forward, never backward)', () => {
      const h = buildBrainHistory(threadAt(20), { maxChars: 10_000, evictChunk: 8 })
      const chars = h.reduce((n, m) => n + m.content.length, 0)
      expect(chars).toBeLessThanOrEqual(10_000)
    })

    it('always keeps the newest message', () => {
      const h = buildBrainHistory(threadAt(20), { maxChars: 10_000, evictChunk: 8 })
      expect(h[h.length - 1].content.startsWith('m19-')).toBe(true)
    })

    it('is inert on a thread that fits — no eviction, no alignment', () => {
      const msgs = [u('a'), a('b'), u('c')]
      expect(buildBrainHistory(msgs, { evictChunk: 8 })).toEqual(buildBrainHistory(msgs))
    })
  })
})
