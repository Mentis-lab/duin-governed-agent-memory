import { describe, it, expect } from 'vitest'
import { elideMiddle, elideMiddleBytes, keepTail } from './elide-middle'

describe('elideMiddle', () => {
  it('returns short text untouched, allocating nothing on the common path', () => {
    expect(elideMiddle('short', 100)).toBe('short')
    const exact = 'x'.repeat(50)
    expect(elideMiddle(exact, 50)).toBe(exact)
  })

  // THE POINT OF THE FUNCTION. A head-slice deletes how the text ended, which is what a
  // follow-up needs and what a report exists to deliver.
  it('keeps BOTH ends and respects the cap exactly', () => {
    const text = 'HEAD-MARKER' + 'x'.repeat(5000) + 'TAIL-MARKER'
    const out = elideMiddle(text, 500)
    expect(out.length).toBe(500)
    expect(out.startsWith('HEAD-MARKER')).toBe(true)
    expect(out.endsWith('TAIL-MARKER')).toBe(true)
  })

  // A silent cut is worse than a lossy one: nothing distinguishes "this is all of it" from
  // "this is the first 4% of it", and a model cannot ask.
  it('states that a middle was dropped, and how much', () => {
    const out = elideMiddle('y'.repeat(10_000), 1000)
    expect(out).toContain('characters elided from the middle')
    expect(out).toContain('9000')
  })

  it('degrades to a plain head-slice when the cap cannot hold the marker', () => {
    const out = elideMiddle('z'.repeat(500), 20)
    expect(out.endsWith('…')).toBe(true)
    // NEVER exceeds the cap. Callers do budget arithmetic against the returned length
    // (`remaining -= piece.length`), so a cap+1 result silently overruns their total —
    // which is exactly what loop-context's bounded stack caught.
    expect(out.length).toBe(20)
  })

  it('never exceeds the cap at any size, including the awkward small ones', () => {
    for (const cap of [1, 2, 5, 20, 60, 61, 62, 100, 999]) {
      expect(elideMiddle('q'.repeat(5000), cap).length).toBeLessThanOrEqual(cap)
      expect(keepTail('q'.repeat(5000), cap).length).toBeLessThanOrEqual(cap)
    }
  })

  it('treats a non-positive cap as no cap rather than erasing the text', () => {
    expect(elideMiddle('keep me', 0)).toBe('keep me')
    expect(elideMiddle('keep me', -5)).toBe('keep me')
  })

  // A lone surrogate half renders as U+FFFD and can corrupt a JSON round-trip.
  it('never cuts a surrogate pair in half', () => {
    const emoji = '😀'.repeat(2000) // each is a surrogate PAIR
    const out = elideMiddle(emoji, 500)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })
})

describe('keepTail', () => {
  // The right shape when the text is ordered oldest-first and the reader needs the newest
  // part: a rolling progress summary, a log tail, recent output from a long-running process.
  it('keeps the END, which is where the newest entries are', () => {
    const log = ['old-1', 'old-2', 'old-3', 'NEWEST-ENTRY'].join('\n'.repeat(200))
    const out = keepTail(log, 300)
    expect(out).toContain('NEWEST-ENTRY')
    expect(out).not.toContain('old-1')
    expect(out.length).toBeLessThanOrEqual(300)
  })

  it('says that earlier content was dropped', () => {
    const out = keepTail('z'.repeat(5000), 400)
    expect(out).toContain('earlier characters dropped')
    expect(out).toContain('4600')
  })

  it('returns short text untouched', () => {
    expect(keepTail('brief', 100)).toBe('brief')
    expect(keepTail('brief', 0)).toBe('brief')
  })
})

describe('elideMiddleBytes', () => {
  // The bug this exists for: a budget checked in UTF-8 BYTES but cut in UTF-16 units.
  // 1,000 CJK characters are 3,000 bytes, so a char-capped cut silently overflows the very
  // limit it was measured against — on exactly the text this operator writes most.
  it('actually bounds BYTES for CJK, not just characters', () => {
    const cjk = '一'.repeat(50_000) // 150,000 UTF-8 bytes
    const out = elideMiddleBytes(cjk, 10_000)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(10_000)
    expect(out).toContain('elided from the middle')
  })

  it('bounds bytes for Latin too, and keeps both ends', () => {
    const text = 'START' + 'x'.repeat(100_000) + 'END'
    const out = elideMiddleBytes(text, 2_000)
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(2_000)
    expect(out.startsWith('START')).toBe(true)
    expect(out.endsWith('END')).toBe(true)
  })

  it('leaves text that already fits completely untouched', () => {
    const s = '短文本 with mixed script'
    expect(elideMiddleBytes(s, 10_000)).toBe(s)
  })
})
